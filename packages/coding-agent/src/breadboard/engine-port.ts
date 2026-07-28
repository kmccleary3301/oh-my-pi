import { join } from "node:path";
import {
	createBreadboardClient,
	createCanonicalE4Client,
	type EngineFeatureAuditResponse,
	type LifecycleEngineBinding,
	type ModelCatalogResponse,
	type ProviderAuthAttachRequest,
	type ProviderAuthAttachResponse,
	type ProviderAuthDetachRequest,
	type ProviderAuthDetachResponse,
	type ProviderAuthStatusResponse,
} from "@breadboard/sdk";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { CanonicalE4SessionPort } from "./canonical-e4-session-port";
import {
	LIFECYCLE_FAILURE_STATES,
	type LifecycleReadyHandle,
	type LifecycleResult,
	type LifecycleState,
} from "./lifecycle/lifecycle-state";
import {
	LifecycleSupervisor,
	type LifecycleSupervisorDependencies,
	type StopOptions,
} from "./lifecycle/lifecycle-supervisor";
import { LocalAuthorityStore } from "./lifecycle/local-authority-store";
import type { BreadboardRunConfig } from "./lifecycle/run-config";
import type { OpenedSession, OpenSession } from "./session-port";

type BreadboardEngineReadyHandle = Pick<
	LifecycleReadyHandle,
	"mode" | "binding" | "requestFetch" | "registration" | "ownerGeneration"
>;

export type BreadboardLifecycleFailureResult = Extract<LifecycleResult, { readonly kind: "failure" }>;
export type BreadboardEngineConnectionFailure = Exclude<LifecycleResult, { readonly kind: "ready" }>;

export interface BreadboardLifecycleFailureSignal {
	failure(): BreadboardLifecycleFailureResult | undefined;
	subscribe(listener: (state: LifecycleState) => void): () => void;
}

export interface BreadboardEngineAuthorityFacts {
	readonly mode: LifecycleReadyHandle["mode"];
	readonly binding: LifecycleEngineBinding;
	readonly registration: LifecycleReadyHandle["registration"];
	readonly ownerGeneration?: number;
}

export class BreadboardEngineLifecycleError extends Error {
	readonly name = "BreadboardEngineLifecycleError";

	constructor(readonly result: BreadboardLifecycleFailureResult) {
		super(`BreadBoard lifecycle entered ${result.state.name}`);
	}
}

export interface BreadboardEnginePort {
	readonly authority: BreadboardEngineAuthorityFacts;
	readonly lifecycleFailure: BreadboardLifecycleFailureSignal;
	openSession(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession>;
	/** Explicit control-plane calls; native OMP remains provider/UI authority until invoked. */
	getFeatures(): Promise<EngineFeatureAuditResponse>;
	getModelCatalog(configPath: string): Promise<ModelCatalogResponse>;
	getProviderAuthStatus(): Promise<ProviderAuthStatusResponse>;
	attachProviderAuth(request: ProviderAuthAttachRequest): Promise<ProviderAuthAttachResponse>;
	detachProviderAuth(request: ProviderAuthDetachRequest): Promise<ProviderAuthDetachResponse>;
	close(): Promise<void>;
}

export interface BreadboardEngineConnectionOptions {
	readonly onLateSessionCloseError: (error: unknown) => void;
	readonly onLifecycleFailure?: (result: BreadboardLifecycleFailureResult) => void;
	readonly dependencies?: LifecycleSupervisorDependencies;
}

export type BreadboardEngineConnectionResult =
	| { readonly kind: "ready"; readonly port: BreadboardEnginePort }
	| { readonly kind: "failure"; readonly result: BreadboardEngineConnectionFailure };

interface LifecycleMonitor {
	readonly signal: BreadboardLifecycleFailureSignal;
	readonly stateChanged: (state: LifecycleState) => void;
}

function isLifecycleFailureState(state: LifecycleState): state is BreadboardLifecycleFailureResult["state"] {
	return (LIFECYCLE_FAILURE_STATES as readonly LifecycleState["name"][]).includes(state.name);
}

function createLifecycleMonitor(
	onLifecycleFailure?: BreadboardEngineConnectionOptions["onLifecycleFailure"],
): LifecycleMonitor {
	let failure: BreadboardLifecycleFailureResult | undefined;
	const listeners = new Set<(state: LifecycleState) => void>();
	const stateChanged = (state: LifecycleState): void => {
		if (failure === undefined && isLifecycleFailureState(state)) {
			failure = { kind: "failure", state };
			try {
				onLifecycleFailure?.(failure);
			} catch (error) {
				logger.warn("BreadBoard lifecycle failure presentation failed", { error: String(error) });
			}
		}
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (error) {
				logger.warn("BreadBoard lifecycle state listener failed", { error: String(error) });
			}
		}
	};
	return {
		signal: Object.freeze({
			failure: () => failure,
			subscribe: (listener: (state: LifecycleState) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		}),
		stateChanged,
	};
}

function authorityFacts(handle: BreadboardEngineReadyHandle): BreadboardEngineAuthorityFacts {
	return Object.freeze({
		mode: handle.mode,
		binding: Object.freeze({ ...handle.binding }),
		registration: Object.freeze({ ...handle.registration }),
		ownerGeneration: handle.ownerGeneration,
	});
}

function createConnectedPort(
	handle: BreadboardEngineReadyHandle,
	supervisor: LifecycleSupervisor,
	monitor: LifecycleMonitor,
	options: BreadboardEngineConnectionOptions,
): BreadboardEnginePort {
	const clientConfig = {
		baseUrl: handle.binding.endpoint,
		requestTimeoutMs: supervisor.config.requestTimeoutMs,
		fetch: handle.requestFetch,
	};
	const sessionPort = new CanonicalE4SessionPort(createCanonicalE4Client(clientConfig), {
		onLateCloseError: options.onLateSessionCloseError,
	});
	const controlClient = createBreadboardClient(clientConfig);
	const sessions = new Set<OpenedSession>();
	let closed = false;
	let closePromise: Promise<void> | undefined;

	const assertOperational = (): void => {
		const failure = monitor.signal.failure();
		if (failure) throw new BreadboardEngineLifecycleError(failure);
		if (closed) throw new Error("BreadBoard engine port is closed");
	};
	const openSession = async (target: OpenSession, signal?: AbortSignal): Promise<OpenedSession> => {
		assertOperational();
		const runtime = await sessionPort.open(target, signal);
		let sessionClosePromise: Promise<void> | undefined;
		let opened: OpenedSession;
		const adapted: OpenedSession = {
			sessionId: runtime.sessionId,
			snapshot: () => runtime.snapshot(),
			submit: input => runtime.submit(input),
			cancel: request => runtime.cancel(request),
			respondPermission: request => runtime.respondPermission(request),
			events: request => runtime.events(request),
			close: () => {
				sessionClosePromise ??= runtime.close().finally(() => sessions.delete(opened));
				return sessionClosePromise;
			},
		};
		opened = Object.freeze(adapted);
		if (closed || monitor.signal.failure()) {
			await opened.close().catch(() => {});
			const failure = monitor.signal.failure();
			if (failure) throw new BreadboardEngineLifecycleError(failure);
			throw new Error("BreadBoard engine port is closed");
		}
		sessions.add(opened);
		return opened;
	};
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closed = true;
			let sessionError: unknown;
			for (const session of sessions) {
				try {
					await session.close();
				} catch (error) {
					sessionError ??= error;
				}
			}
			sessions.clear();
			let lifecycleError: unknown;
			try {
				const outcome = await supervisor.close({ consumerClosed: true } satisfies StopOptions);
				if (outcome.kind === "failure") monitor.stateChanged(outcome.state);
			} catch (error) {
				lifecycleError = error;
			}
			if (sessionError !== undefined && lifecycleError !== undefined)
				throw new AggregateError([sessionError, lifecycleError], "BreadBoard engine close failed");
			if (sessionError !== undefined) throw sessionError;
			if (lifecycleError !== undefined) throw lifecycleError;
		})();
		return closePromise;
	};
	const port: BreadboardEnginePort = {
		authority: authorityFacts(handle),
		lifecycleFailure: monitor.signal,
		openSession,
		getFeatures: async () => {
			assertOperational();
			return controlClient.getFeatures();
		},
		getModelCatalog: async configPath => {
			assertOperational();
			return controlClient.getModelCatalog(configPath);
		},
		getProviderAuthStatus: async () => {
			assertOperational();
			return controlClient.getProviderAuthStatus();
		},
		attachProviderAuth: async request => {
			assertOperational();
			return controlClient.attachProviderAuth(request);
		},
		detachProviderAuth: async request => {
			assertOperational();
			return controlClient.detachProviderAuth(request);
		},
		close,
	};
	return Object.freeze(port);
}

/**
 * The sole production engine connection entrypoint. It owns lifecycle
 * supervisor construction, local-owned authority storage, canonical session
 * adaptation, control-plane transport, and close/drain/detach handling.
 */
export async function connectCanonicalBreadboardEnginePort(
	config: BreadboardRunConfig,
	options: BreadboardEngineConnectionOptions,
): Promise<BreadboardEngineConnectionResult> {
	const monitor = createLifecycleMonitor(options.onLifecycleFailure);
	const suppliedDependencies = options.dependencies ?? {};
	const store =
		config.mode === "local-owned"
			? (suppliedDependencies.store ?? new LocalAuthorityStore(join(getAgentDir(), "breadboard", "lifecycle")))
			: undefined;
	const supervisor = new LifecycleSupervisor(config, {
		...suppliedDependencies,
		...(store === undefined ? { store: undefined } : { store }),
		stateChanged: monitor.stateChanged,
	});
	const connected = await supervisor.connect();
	if (connected.kind !== "ready") {
		monitor.stateChanged(connected.state);
		await supervisor.close({ consumerClosed: true });
		return { kind: "failure", result: connected };
	}
	return {
		kind: "ready",
		port: createConnectedPort(connected.handle, supervisor, monitor, options),
	};
}
