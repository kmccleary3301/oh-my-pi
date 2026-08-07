import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { OmpRetainedAgentBackend, RetainedAgentHandleManager } from "./agent-handles";
import { RecursiveBudgetLedger } from "./budget";
import type { RecursiveControlConfig } from "./config";
import { resolveRecursiveControlConfig } from "./config";
import { ContextWorkspace } from "./context-workspace";
import { ImprovementLedger } from "./improvement-ledger";
import { RecursiveStateStore } from "./state-store";

interface RuntimeRecord {
	key: string;
	runtime: RecursiveControlRuntime;
}

const runtimes = new WeakMap<ToolSession, RuntimeRecord>();
const runtimeSessions = new WeakMap<RecursiveControlRuntime, ToolSession>();
const settingsRuntimes = new WeakMap<ToolSession["settings"], Set<RecursiveControlRuntime>>();

function trackRuntime(session: ToolSession, runtime: RecursiveControlRuntime): void {
	runtimeSessions.set(runtime, session);
	const tracked = settingsRuntimes.get(session.settings) ?? new Set<RecursiveControlRuntime>();
	tracked.add(runtime);
	settingsRuntimes.set(session.settings, tracked);
}

function untrackRuntime(session: ToolSession, runtime: RecursiveControlRuntime): void {
	runtimeSessions.delete(runtime);
	const tracked = settingsRuntimes.get(session.settings);
	if (!tracked) return;
	tracked.delete(runtime);
	if (tracked.size === 0) settingsRuntimes.delete(session.settings);
}

function configKey(config: RecursiveControlConfig): string {
	return JSON.stringify(config);
}

/**
 * OMP-owned recursive-control composition root.
 *
 * This object projects canonical OMP state into a bounded programming surface;
 * it never creates a second transcript, provider stack, permission system, or
 * agent registry.
 */
export class RecursiveControlRuntime {
	readonly session: ToolSession;
	readonly config: RecursiveControlConfig;
	readonly context: ContextWorkspace;
	readonly agents: RetainedAgentHandleManager;
	readonly state: RecursiveStateStore;
	readonly improvements: ImprovementLedger;
	readonly budget: RecursiveBudgetLedger;
	#disposed = false;

	constructor(session: ToolSession, config: RecursiveControlConfig) {
		if (!config.enabled)
			throw new Error("Recursive control is disabled. Enable recursive.enabled to use omp.* from eval.");
		this.session = session;
		this.config = config;
		this.context = new ContextWorkspace(session, {
			maxItems: config.contextMaxItems,
			maxChars: config.contextMaxChars,
			maxMaterializeChars: config.contextMaterializeMaxChars,
		});
		this.agents = new RetainedAgentHandleManager(new OmpRetainedAgentBackend(session, this.context), {
			maxHandles: config.maxHandles,
			maxObservationChars: config.contextMaxChars,
		});
		this.state = new RecursiveStateStore(session, { maxValueBytes: config.stateMaxBytes });
		this.improvements = new ImprovementLedger(session);
		this.budget = new RecursiveBudgetLedger(session, config, this.agents);
		this.agents.setAdmissionCheck(() => this.budget.assertCanSpawn());
	}

	assertActive(): void {
		if (this.#disposed) throw new Error("Recursive control runtime is disposed");
		if (this.session.settings.get("recursive.enabled") !== true) {
			throw new Error("Recursive control is disabled. Enable recursive.enabled to use omp.* from eval.");
		}
		if (this.session.isDisposed?.()) throw new Error("Recursive control session is disposing");
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.agents.dispose();
	}
}

/** Return the session-owned runtime, recreating it when material settings change. */
export function getRecursiveControlRuntime(session: ToolSession): RecursiveControlRuntime {
	const config = resolveRecursiveControlConfig(session);
	const current = runtimes.get(session);
	if (!config.enabled) {
		if (current) {
			runtimes.delete(session);
			untrackRuntime(session, current.runtime);
			void current.runtime
				.dispose()
				.catch(error => logger.warn("recursive control runtime disposal failed", { error }));
		}
		throw new Error("Recursive control is disabled. Enable recursive.enabled to use omp.* from eval.");
	}
	const key = configKey(config);
	if (current?.key === key) {
		current.runtime.assertActive();
		return current.runtime;
	}
	if (current) {
		runtimes.delete(session);
		untrackRuntime(session, current.runtime);
		void current.runtime
			.dispose()
			.catch(error => logger.warn("recursive control runtime disposal failed", { error }));
	}
	const runtime = new RecursiveControlRuntime(session, config);
	runtimes.set(session, { key, runtime });
	trackRuntime(session, runtime);
	const dispose = (): void => {
		const active = runtimes.get(session);
		if (active?.runtime !== runtime) return;
		runtimes.delete(session);
		untrackRuntime(session, runtime);
		void runtime.dispose().catch(error => logger.warn("recursive control runtime disposal failed", { error }));
	};
	session.registerDisposeCallback?.(dispose);
	session.registerSessionChangeCallback?.(dispose);
	return runtime;
}

/** Test-only cleanup for a synthetic ToolSession. */
export async function disposeRecursiveControlRuntime(session: ToolSession): Promise<void> {
	const record = runtimes.get(session);
	if (!record) return;
	runtimes.delete(session);
	untrackRuntime(session, record.runtime);
	await record.runtime.dispose();
}

/** Dispose every recursive runtime sharing one Settings authority. */
export async function disposeRecursiveControlForSettings(settings: ToolSession["settings"]): Promise<void> {
	const tracked = [...(settingsRuntimes.get(settings) ?? [])];
	settingsRuntimes.delete(settings);
	await Promise.allSettled(
		tracked.map(async runtime => {
			const session = runtimeSessions.get(runtime);
			if (session) {
				const record = runtimes.get(session);
				if (record?.runtime === runtime) runtimes.delete(session);
				runtimeSessions.delete(runtime);
			}
			await runtime.dispose();
		}),
	);
}
