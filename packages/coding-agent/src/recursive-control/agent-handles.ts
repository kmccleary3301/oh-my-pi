import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import {
	buildStructuredSubagentRecoveryHint,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { ContextWorkspace } from "./context-workspace";
import type {
	RetainedAgentHandle,
	RetainedAgentObservation,
	RetainedAgentObserveRequest,
	RetainedAgentSendRequest,
	RetainedAgentSpawnRequest,
	RetainedAgentWaitRequest,
} from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";

const HANDLE_PREFIX = "agent-handle:";
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const RECURSIVE_CANCEL_REASON = "Recursive control cancellation";

function nowIso(): string {
	return new Date().toISOString();
}

function idFromHandle(handle: string): string {
	const normalized = handle.trim();
	if (!normalized.startsWith(HANDLE_PREFIX) || normalized.length <= HANDLE_PREFIX.length) {
		throw new Error(`Invalid retained agent handle: ${handle}`);
	}
	return normalized.slice(HANDLE_PREFIX.length);
}

function statusFromRef(ref: AgentRef | undefined): RetainedAgentHandle["status"] {
	if (!ref) return "released";
	return ref.status;
}

function cleanFailure(value: string): string {
	return value.replace(/<\/?system-notification>/g, "").trim();
}

function waitSatisfied(
	status: RetainedAgentHandle["status"],
	until: NonNullable<RetainedAgentWaitRequest["until"]>,
): boolean {
	if (until === "idle") return status === "idle";
	if (until === "parked") return status === "parked";
	return ["idle", "parked", "aborted", "released", "failed"].includes(status);
}

export interface RetainedAgentBackend {
	spawn(request: RetainedAgentSpawnRequest, signal?: AbortSignal): Promise<RetainedAgentHandle>;
	status(agentId: string): RetainedAgentHandle["status"];
	send(request: RetainedAgentSendRequest, signal?: AbortSignal): Promise<void>;
	observe(agentId: string, maxChars: number, signal?: AbortSignal): Promise<RetainedAgentObservation>;
	wait(request: RetainedAgentWaitRequest, signal?: AbortSignal): Promise<RetainedAgentHandle["status"]>;
	cancel(agentId: string): Promise<void>;
	release(agentId: string): Promise<void>;
}

/** OMP-native adapter over task execution, AgentRegistry, and lifecycle revival. */
interface BackgroundAgentRun {
	initial: RetainedAgentHandle;
	controller: AbortController;
	completion: Promise<RetainedAgentHandle>;
	completed?: RetainedAgentHandle;
}

type StructuredSubagentOutcome = { ok: true; execution: StructuredSubagentResult } | { ok: false; error: unknown };

export class OmpRetainedAgentBackend implements RetainedAgentBackend {
	readonly #session: ToolSession;
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #context: ContextWorkspace;
	readonly #runs = new Map<string, BackgroundAgentRun>();

	constructor(session: ToolSession, context: ContextWorkspace) {
		this.#session = session;
		this.#registry = session.agentRegistry ?? AgentRegistry.global();
		this.#lifecycle = session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		this.#context = context;
	}

	async #completedHandle(id: string, execution: StructuredSubagentResult): Promise<RetainedAgentHandle> {
		const { result, policy, mergeSummary, artifactsDir } = execution;
		if (result.exitCode !== 0 || result.error || result.aborted) {
			const message = cleanFailure(result.error ?? result.stderr ?? result.abortReason ?? "retained agent failed");
			const recovery = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
			return {
				version: RECURSIVE_CONTROL_VERSION,
				handle: `${HANDLE_PREFIX}${id}`,
				agentId: id,
				agent: result.agent,
				status: result.aborted ? "aborted" : "failed",
				createdAt: new Date(this.#registry.get(id)?.createdAt ?? Date.now()).toISOString(),
				updatedAt: nowIso(),
				outputRef: `agent://${id}`,
				error: `${message}${recovery}`,
			};
		}
		const structured = result.structuredOutput?.source !== undefined && result.structuredOutput.source !== "none";
		return {
			version: RECURSIVE_CONTROL_VERSION,
			handle: `${HANDLE_PREFIX}${id}`,
			agentId: id,
			agent: result.agent,
			status: statusFromRef(this.#registry.get(id)),
			createdAt: new Date(this.#registry.get(id)?.createdAt ?? Date.now()).toISOString(),
			updatedAt: nowIso(),
			outputRef: `agent://${id}`,
			text: structured ? result.output : result.output + mergeSummary,
			...(structured && Object.hasOwn(result.structuredOutput ?? {}, "data")
				? { data: result.structuredOutput?.data }
				: {}),
			...((result.resolvedModel ?? policy.modelOverride)
				? { model: result.resolvedModel ?? policy.modelOverride }
				: {}),
		};
	}

	async spawn(request: RetainedAgentSpawnRequest, signal?: AbortSignal): Promise<RetainedAgentHandle> {
		const reservation = Promise.withResolvers<string>();
		const controller = new AbortController();
		const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		let reservedId: string | undefined;
		const outcome: Promise<StructuredSubagentOutcome> = runStructuredSubagent({
			session: this.#session,
			invocationKind: "eval",
			assignment: request.prompt,
			...(request.agent ? { agent: request.agent } : {}),
			...(request.label !== undefined ? { identity: { label: request.label } } : {}),
			...(Object.hasOwn(request, "schema") ? { outputSchema: request.schema } : {}),
			...(request.schemaMode ? { schemaMode: request.schemaMode } : {}),
			retainArtifacts: true,
			keepAlive: true,
			shareEvalSession: false,
			enableIrc: true,
			signal: executionSignal,
			onReserved: id => {
				reservedId = id;
				reservation.resolve(id);
			},
		})
			.then(execution => ({ ok: true as const, execution }))
			.catch((error: unknown) => ({ ok: false as const, error }));
		void outcome.then(result => {
			if (result.ok === false && reservedId === undefined) reservation.reject(result.error);
		});
		let id: string;
		try {
			id = await Promise.race([
				reservation.promise,
				outcome.then(result => {
					if (result.ok === false) throw result.error;
					throw new Error("Structured subagent completed without reserving an agent id");
				}),
			]);
		} catch (error) {
			if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
			throw error;
		}
		const createdAt = nowIso();
		const initial: RetainedAgentHandle = {
			version: RECURSIVE_CONTROL_VERSION,
			handle: `${HANDLE_PREFIX}${id}`,
			agentId: id,
			agent: request.agent ?? request.label ?? "task",
			status: this.#registry.get(id)?.status ?? "starting",
			createdAt,
			updatedAt: createdAt,
			outputRef: `agent://${id}`,
		};
		const record: BackgroundAgentRun = {
			initial,
			controller,
			completion: Promise.resolve(initial),
		};
		const completion = outcome.then(async result => {
			try {
				let completed: RetainedAgentHandle;
				if ("error" in result) {
					completed = {
						...initial,
						status: controller.signal.aborted ? "aborted" : "failed",
						updatedAt: nowIso(),
						error: result.error instanceof Error ? result.error.message : String(result.error),
					};
				} else {
					completed = await this.#completedHandle(id, result.execution);
				}
				record.completed = completed;
				return completed;
			} catch (error) {
				const completed: RetainedAgentHandle = {
					...initial,
					status: controller.signal.aborted ? "aborted" : "failed",
					updatedAt: nowIso(),
					error: error instanceof Error ? error.message : String(error),
				};
				record.completed = completed;
				return completed;
			}
		});
		record.completion = completion;
		this.#runs.set(id, record);
		return { ...initial };
	}

	status(agentId: string): RetainedAgentHandle["status"] {
		const run = this.#runs.get(agentId);
		if (run?.completed) return run.completed.status;
		return this.#registry.get(agentId)?.status ?? (run ? "starting" : "released");
	}

	async #waitForLive(agentId: string, signal?: AbortSignal): Promise<void> {
		if (this.#registry.get(agentId)) return;
		const run = this.#runs.get(agentId);
		if (!run) throw new Error(`Unknown retained agent: ${agentId}`);
		const timeoutSignal = AbortSignal.timeout(DEFAULT_WAIT_TIMEOUT_MS);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const cleanupCallbacks: Array<() => void> = [];
		const cleanup = (): void => {
			for (const callback of cleanupCallbacks.splice(0)) callback();
		};
		const check = (): void => {
			if (!this.#registry.get(agentId)) return;
			cleanup();
			resolve();
		};
		cleanupCallbacks.push(
			this.#registry.onChange(event => {
				if (event.ref.id === agentId) check();
			}),
		);
		void run.completion.then(completed => {
			if (this.#registry.get(agentId)) {
				check();
				return;
			}
			cleanup();
			reject(new Error(completed.error ?? `Retained agent ${agentId} completed before becoming addressable`));
		});
		const bindAbort = (abortSignal: AbortSignal, message: string): void => {
			const onAbort = (): void => {
				cleanup();
				reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error(message));
			};
			if (abortSignal.aborted) onAbort();
			else {
				abortSignal.addEventListener("abort", onAbort, { once: true });
				cleanupCallbacks.push(() => abortSignal.removeEventListener("abort", onAbort));
			}
		};
		if (signal) bindAbort(signal, "retained agent wait aborted");
		bindAbort(timeoutSignal, `retained agent did not become live within ${DEFAULT_WAIT_TIMEOUT_MS} ms`);
		check();
		await promise;
	}

	async send(request: RetainedAgentSendRequest, signal?: AbortSignal): Promise<void> {
		const agentId = idFromHandle(request.handle);
		await this.#waitForLive(agentId, signal);
		const target = await this.#lifecycle.ensureLive(agentId);
		if (signal?.aborted) throw signal.reason;
		const delivery = request.delivery ?? "when-idle";
		if (delivery === "when-idle") {
			await target.waitForIdle();
			if (signal?.aborted) throw signal.reason;
			await target.sendUserMessage(request.message);
			return;
		}
		if (delivery === "steer-now") {
			await target.sendUserMessage(request.message, target.isStreaming ? { deliverAs: "steer" } : undefined);
			return;
		}
		await target.sendUserMessage(request.message, { deliverAs: "followUp" });
	}

	async observe(agentId: string, maxChars: number, signal?: AbortSignal): Promise<RetainedAgentObservation> {
		const run = this.#runs.get(agentId);
		const ref = this.#registry.get(agentId);
		const completed = run?.completed;
		const status = completed?.status ?? (ref ? statusFromRef(ref) : run ? "starting" : "released");
		const createdAt = ref ? new Date(ref.createdAt).toISOString() : (run?.initial.createdAt ?? nowIso());
		const handle: RetainedAgentHandle = completed
			? { ...completed, status }
			: {
					...(run?.initial ?? {
						version: RECURSIVE_CONTROL_VERSION,
						handle: `${HANDLE_PREFIX}${agentId}`,
						agentId,
						agent: ref?.history?.agent ?? ref?.displayName ?? agentId,
						createdAt,
						updatedAt: nowIso(),
					}),
					status,
					updatedAt: ref ? new Date(ref.lastActivity).toISOString() : nowIso(),
					outputRef: `agent://${agentId}`,
					...(ref?.history?.resolvedModel ? { model: ref.history.resolvedModel } : {}),
				};
		if (status === "released" || status === "starting") return { version: RECURSIVE_CONTROL_VERSION, handle };
		try {
			const transcript = await this.#context.read({ ref: `history://${agentId}`, limit: maxChars }, signal);
			return { version: RECURSIVE_CONTROL_VERSION, handle, transcript };
		} catch (error) {
			return {
				version: RECURSIVE_CONTROL_VERSION,
				handle: { ...handle, error: error instanceof Error ? error.message : String(error) },
			};
		}
	}

	async wait(request: RetainedAgentWaitRequest, signal?: AbortSignal): Promise<RetainedAgentHandle["status"]> {
		const agentId = idFromHandle(request.handle);
		const until = request.until ?? "terminal";
		const initial = this.status(agentId);
		if (waitSatisfied(initial, until)) return initial;
		const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error("retained agent timeoutMs must be a non-negative finite number");
		}
		const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
		const { promise, resolve, reject } = Promise.withResolvers<RetainedAgentHandle["status"]>();
		const cleanupCallbacks: Array<() => void> = [];
		const cleanup = (): void => {
			for (const callback of cleanupCallbacks.splice(0)) callback();
		};
		const check = (): void => {
			const current = this.status(agentId);
			if (!waitSatisfied(current, until)) return;
			cleanup();
			resolve(current);
		};
		cleanupCallbacks.push(
			this.#registry.onChange(event => {
				if (event.ref.id === agentId) check();
			}),
		);
		const run = this.#runs.get(agentId);
		if (run) void run.completion.then(check);
		const bindAbort = (abortSignal: AbortSignal | undefined, label: string): void => {
			if (!abortSignal) return;
			const onAbort = (): void => {
				cleanup();
				reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error(label));
			};
			if (abortSignal.aborted) onAbort();
			else {
				abortSignal.addEventListener("abort", onAbort, { once: true });
				cleanupCallbacks.push(() => abortSignal.removeEventListener("abort", onAbort));
			}
		};
		bindAbort(signal, "retained agent wait aborted");
		bindAbort(timeoutSignal, `retained agent wait timed out after ${timeoutMs} ms`);
		check();
		return await promise;
	}

	async cancel(agentId: string): Promise<void> {
		this.#runs.get(agentId)?.controller.abort(new Error(RECURSIVE_CANCEL_REASON));
		const ref = this.#registry.get(agentId);
		if (!ref || ref.status === "aborted") return;
		const target = ref.session ?? (ref.status === "parked" ? await this.#lifecycle.ensureLive(agentId) : null);
		if (target?.isStreaming) await target.abort({ reason: RECURSIVE_CANCEL_REASON });
	}

	async release(agentId: string): Promise<void> {
		const run = this.#runs.get(agentId);
		if (run && !run.completed) run.controller.abort(new Error("Retained agent released"));
		const ref = this.#registry.get(agentId);
		if (ref) await this.#lifecycle.release(agentId, ref);
		this.#runs.delete(agentId);
	}
}

interface HandleRecord {
	handle: RetainedAgentHandle;
	owned: boolean;
}

/** Stable handle registry exposed to eval runtimes. */
export class RetainedAgentHandleManager {
	readonly #backend: RetainedAgentBackend;
	readonly #maxHandles: number;
	readonly #maxObservationChars: number;
	readonly #records = new Map<string, HandleRecord>();
	#pendingSpawns = 0;
	#admissionCheck: (() => void) | undefined;

	constructor(backend: RetainedAgentBackend, options: { maxHandles: number; maxObservationChars: number }) {
		this.#backend = backend;
		this.#maxHandles = Math.max(1, Math.trunc(options.maxHandles));
		this.#maxObservationChars = Math.max(256, Math.trunc(options.maxObservationChars));
	}

	setAdmissionCheck(check: () => void): void {
		this.#admissionCheck = check;
	}

	listHandles(): RetainedAgentHandle[] {
		return [...this.#records.values()].map(record => ({
			...record.handle,
			status: this.#currentStatus(record.handle),
		}));
	}

	#currentStatus(handle: RetainedAgentHandle): RetainedAgentHandle["status"] {
		if (handle.status === "failed" || handle.status === "released") return handle.status;
		return this.#backend.status(handle.agentId);
	}

	#get(handle: string): HandleRecord {
		const record = this.#records.get(handle);
		if (!record) throw new Error(`Unknown retained agent handle: ${handle}`);
		return record;
	}

	async spawn(request: RetainedAgentSpawnRequest, signal?: AbortSignal): Promise<RetainedAgentHandle> {
		if (this.#records.size + this.#pendingSpawns >= this.#maxHandles) {
			throw new Error(`retained agent handle limit reached (${this.#maxHandles})`);
		}
		const prompt = request.prompt.trim();
		if (!prompt) throw new Error("retained agent prompt must not be empty");
		this.#admissionCheck?.();
		this.#pendingSpawns += 1;
		try {
			const result = await this.#backend.spawn({ ...request, prompt }, signal);
			if (this.#records.has(result.handle)) {
				await this.#backend.release(result.agentId);
				throw new Error(`retained agent backend returned duplicate handle ${result.handle}`);
			}
			this.#records.set(result.handle, { handle: result, owned: true });
			return { ...result };
		} finally {
			this.#pendingSpawns -= 1;
		}
	}

	status(handle: string): RetainedAgentHandle {
		const record = this.#get(handle);
		const status = this.#currentStatus(record.handle);
		if (status !== record.handle.status) {
			record.handle = { ...record.handle, status, updatedAt: nowIso() };
		}
		return { ...record.handle };
	}

	async send(request: RetainedAgentSendRequest, signal?: AbortSignal): Promise<RetainedAgentHandle> {
		const record = this.#get(request.handle);
		if (!request.message.trim()) throw new Error("retained agent message must not be empty");
		await this.#backend.send({ ...request, message: request.message.trim() }, signal);
		record.handle = { ...record.handle, status: this.#backend.status(record.handle.agentId), updatedAt: nowIso() };
		return { ...record.handle };
	}

	async observe(request: RetainedAgentObserveRequest, signal?: AbortSignal): Promise<RetainedAgentObservation> {
		const record = this.#get(request.handle);
		const maxChars = Math.min(
			this.#maxObservationChars,
			Math.max(256, Math.trunc(request.maxChars ?? this.#maxObservationChars)),
		);
		return await this.#backend.observe(record.handle.agentId, maxChars, signal);
	}

	async wait(request: RetainedAgentWaitRequest, signal?: AbortSignal): Promise<RetainedAgentHandle> {
		const record = this.#get(request.handle);
		const status = await this.#backend.wait(request, signal);
		record.handle = { ...record.handle, status, updatedAt: nowIso() };
		return { ...record.handle };
	}

	async cancel(handle: string): Promise<RetainedAgentHandle> {
		const record = this.#get(handle);
		await this.#backend.cancel(record.handle.agentId);
		record.handle = { ...record.handle, status: this.#backend.status(record.handle.agentId), updatedAt: nowIso() };
		return { ...record.handle };
	}

	async release(handle: string): Promise<RetainedAgentHandle> {
		const record = this.#get(handle);
		if (record.owned) await this.#backend.release(record.handle.agentId);
		record.handle = { ...record.handle, status: "released", updatedAt: nowIso() };
		this.#records.delete(handle);
		return { ...record.handle };
	}

	async dispose(): Promise<void> {
		const owned = [...this.#records.values()].filter(record => record.owned);
		this.#records.clear();
		await Promise.allSettled(owned.map(record => this.#backend.release(record.handle.agentId)));
	}
}
