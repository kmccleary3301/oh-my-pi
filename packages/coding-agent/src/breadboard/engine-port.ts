import {
	createBreadboardClient,
	createCanonicalE4Client,
	type EngineFeatureAuditResponse,
	type ModelCatalogResponse,
	type ProviderAuthAttachRequest,
	type ProviderAuthAttachResponse,
	type ProviderAuthDetachRequest,
	type ProviderAuthDetachResponse,
	type ProviderAuthStatusResponse,
} from "@breadboard/sdk";
import { CanonicalE4SessionPort } from "./canonical-e4-session-port";
import type { LifecycleReadyHandle } from "./lifecycle/lifecycle-state";
import type { OpenedSession, OpenSession } from "./session-port";

type BreadboardEngineReadyHandle = Pick<
	LifecycleReadyHandle,
	"mode" | "binding" | "requestFetch" | "registration" | "ownerGeneration"
>;

export interface BreadboardEngineAuthorityFacts {
	readonly mode: LifecycleReadyHandle["mode"];
	readonly binding: LifecycleReadyHandle["binding"];
	readonly registration: LifecycleReadyHandle["registration"];
	readonly ownerGeneration?: number;
}

export interface BreadboardEnginePort {
	readonly authority: BreadboardEngineAuthorityFacts;
	openSession(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession>;
	getFeatures(): Promise<EngineFeatureAuditResponse>;
	getModelCatalog(configPath: string): Promise<ModelCatalogResponse>;
	getProviderAuthStatus(): Promise<ProviderAuthStatusResponse>;
	attachProviderAuth(request: ProviderAuthAttachRequest): Promise<ProviderAuthAttachResponse>;
	detachProviderAuth(request: ProviderAuthDetachRequest): Promise<ProviderAuthDetachResponse>;
}

export interface CanonicalBreadboardEnginePortOptions {
	readonly requestTimeoutMs: number;
	readonly onLateSessionCloseError: (error: unknown) => void;
}

export function createCanonicalBreadboardEnginePort(
	handle: BreadboardEngineReadyHandle,
	options: CanonicalBreadboardEnginePortOptions,
): BreadboardEnginePort {
	const clientConfig = {
		baseUrl: handle.binding.endpoint,
		requestTimeoutMs: options.requestTimeoutMs,
		fetch: handle.requestFetch,
	};
	const sessionPort = new CanonicalE4SessionPort(createCanonicalE4Client(clientConfig), {
		onLateCloseError: options.onLateSessionCloseError,
	});
	const controlClient = createBreadboardClient(clientConfig);
	const authority = Object.freeze({
		mode: handle.mode,
		binding: handle.binding,
		registration: handle.registration,
		ownerGeneration: handle.ownerGeneration,
	});

	const port: BreadboardEnginePort = {
		authority,
		openSession: (target, signal) => sessionPort.open(target, signal),
		getFeatures: () => controlClient.getFeatures(),
		getModelCatalog: configPath => controlClient.getModelCatalog(configPath),
		getProviderAuthStatus: () => controlClient.getProviderAuthStatus(),
		attachProviderAuth: request => controlClient.attachProviderAuth(request),
		detachProviderAuth: request => controlClient.detachProviderAuth(request),
	};
	return Object.freeze(port);
}
