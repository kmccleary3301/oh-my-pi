import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;
interface RpcSubagentIndexFile {
	version: 1;
	records: RpcSubagentSnapshot[];
}

function isSnapshot(value: unknown): value is RpcSubagentSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RpcSubagentSnapshot>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.index === "number" &&
		typeof candidate.agent === "string" &&
		typeof candidate.status === "string" &&
		typeof candidate.lastUpdate === "number"
	);
}

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function isTerminalLifecycleStatus(status: SubagentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile" | "runId">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

/**
 * A task id is not a generation id. Prefer an explicit runId when OMP owns one,
 * but use the child session file as the conservative identity when it is the
 * only authoritative handle available. A payload without either handle can
 * never prove that it belongs to a newer generation.
 */
function hasSameGeneration(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "runId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.runId !== undefined || snapshot.runId !== undefined) {
		if (payload.runId !== undefined && snapshot.runId !== undefined) return payload.runId === snapshot.runId;
		if (payload.runId !== undefined) return false;
		return payload.sessionFile !== undefined && payload.sessionFile === snapshot.sessionFile;
	}
	if (payload.sessionFile !== undefined || snapshot.sessionFile !== undefined) {
		return payload.sessionFile !== undefined && payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function isNewSubagentGeneration(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "runId" | "sessionFile">,
	stale: Pick<RpcSubagentSnapshot, "runId" | "sessionFile">,
): boolean {
	if (stale.runId !== undefined && payload.runId !== undefined) return stale.runId !== payload.runId;
	if (stale.sessionFile !== undefined && payload.sessionFile !== undefined)
		return stale.sessionFile !== payload.sessionFile;
	return payload.runId !== undefined || payload.sessionFile !== undefined;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#terminalSubagents = new Map<string, RpcSubagentSnapshot>();
	#transcriptSessionFilesBySubagentId = new Map<string, string>();
	#staleSubagentIds = new Set<string>();
	#staleGenerations = new Map<string, Pick<RpcSubagentSnapshot, "runId" | "sessionFile">>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "off";
	#persistencePath?: string;
	#persistenceWrite: Promise<void> = Promise.resolve();
	constructor(eventBus: EventBus, output: RpcSubagentOutput, persistencePath?: string) {
		this.#output = output;
		this.#persistencePath = persistencePath;
		this.#unsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
			eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			}),
		);
	}

	async hydrate(): Promise<void> {
		if (!this.#persistencePath) return;
		try {
			const parsed = JSON.parse(await fs.readFile(this.#persistencePath, "utf8")) as Partial<RpcSubagentIndexFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
			for (const snapshot of parsed.records.filter(isSnapshot).slice(-MAX_RETAINED_TRANSCRIPT_REFERENCES)) {
				if (!["completed", "failed", "aborted"].includes(snapshot.status)) continue;
				this.#terminalSubagents.set(snapshot.id, snapshot);
				addPruned(this.#staleSubagentIds, snapshot.id, MAX_RETAINED_TRANSCRIPT_REFERENCES);
				this.#rememberTranscriptSession(snapshot.id, snapshot.sessionFile);
			}
		} catch (error) {
			if (!isEnoent(error)) return;
		}
	}

	async flush(): Promise<void> {
		await this.#persistenceWrite;
	}

	#persistTerminalRecords(): void {
		if (!this.#persistencePath) return;
		const payload: RpcSubagentIndexFile = {
			version: 1,
			records: [...this.#terminalSubagents.values()].slice(-MAX_RETAINED_TRANSCRIPT_REFERENCES),
		};
		this.#persistenceWrite = this.#persistenceWrite
			.catch(() => {})
			.then(async () => {
				const persistencePath = this.#persistencePath!;
				await fs.mkdir(dirname(persistencePath), { recursive: true });
				const lockPath = `${persistencePath}.lock`;
				let locked = false;
				for (let attempt = 0; attempt < 1000; attempt++) {
					try {
						await fs.mkdir(lockPath);
						locked = true;
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						await new Promise(resolve => setTimeout(resolve, 10));
					}
				}
				if (!locked) throw new Error("Timed out waiting for RPC subagent persistence lock");
				try {
					let records = payload.records;
					try {
						const persisted = JSON.parse(
							await fs.readFile(persistencePath, "utf8"),
						) as Partial<RpcSubagentIndexFile>;
						if (persisted.version === 1 && Array.isArray(persisted.records)) {
							const merged = new Map<string, RpcSubagentSnapshot>();
							for (const snapshot of [...persisted.records.filter(isSnapshot), ...records]) {
								const key = `${snapshot.id}\0${snapshot.runId ?? snapshot.sessionFile ?? ""}`;
								const previous = merged.get(key);
								if (!previous || snapshot.lastUpdate >= previous.lastUpdate) merged.set(key, snapshot);
							}
							records = [...merged.values()]
								.sort((a, b) => a.lastUpdate - b.lastUpdate)
								.slice(-MAX_RETAINED_TRANSCRIPT_REFERENCES);
						}
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					const temporaryPath = `${persistencePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
					await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, records })}\n`, "utf8");
					await fs.rename(temporaryPath, persistencePath);
				} finally {
					await fs.rm(lockPath, { recursive: true, force: true });
				}
			});
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#subagents.clear();
		this.#terminalSubagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#staleSubagentIds.clear();
		this.#staleGenerations.clear();
	}

	#markStale(snapshot: Pick<RpcSubagentSnapshot, "id" | "runId" | "sessionFile">): void {
		addPruned(this.#staleSubagentIds, snapshot.id, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		this.#staleGenerations.set(snapshot.id, {
			runId: snapshot.runId,
			sessionFile: snapshot.sessionFile,
		});
	}

	clear(): void {
		if (this.hasLiveSubagents()) return;
		for (const snapshot of this.#subagents.values()) this.#markStale(snapshot);
		for (const snapshot of this.#terminalSubagents.values()) this.#markStale(snapshot);
		for (const [subagentId, sessionFile] of this.#transcriptSessionFilesBySubagentId) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
			this.#staleGenerations.set(subagentId, { sessionFile });
		}
		this.#subagents.clear();
		if (!this.#persistencePath) {
			this.#terminalSubagents.clear();
			this.#transcriptSessionFilesBySubagentId.clear();
		}
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getSubagents(): RpcSubagentSnapshot[] {
		return [...this.#subagents.values(), ...this.#terminalSubagents.values()].sort(
			(a, b) => a.index - b.index || a.id.localeCompare(b.id),
		);
	}

	hasLiveSubagents(): boolean {
		if (this.#subagents.size > 0) return true;
		return AgentRegistry.global()
			.list()
			.some(
				ref =>
					ref.kind !== "main" &&
					(ref.status === "running" ||
						(ref.status === "idle" && ref.session !== null) ||
						ref.session?.isStreaming === true ||
						ref.session?.hasPendingAsyncWork() === true),
			);
	}

	#rememberTranscriptSession(subagentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesBySubagentId.delete(subagentId);
		this.#transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
		while (this.#transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesBySubagentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesBySubagentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#subagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const snapshot of this.#terminalSubagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesBySubagentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	#registryMetadata(id: string): {
		parentId?: string;
		modelRole?: string;
		resolvedModel?: string;
		resolvedModelIsFallback?: boolean;
		outputPath?: string;
		patchPath?: string;
		branchName?: string;
	} {
		const ref = AgentRegistry.global().get(id);
		return {
			parentId: ref?.parentId,
			modelRole: ref?.history?.modelRole,
			resolvedModel: ref?.history?.resolvedModel,
			resolvedModelIsFallback: ref?.history?.resolvedModelIsFallback,
			outputPath: ref?.history?.outputPath,
			patchPath: ref?.history?.patchPath,
			branchName: ref?.history?.branchName,
		};
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const staleGeneration = this.#staleGenerations.get(payload.id);
		if (this.#staleSubagentIds.has(payload.id)) {
			if (payload.status !== "started" || !staleGeneration || !isNewSubagentGeneration(payload, staleGeneration))
				return;
			this.#staleSubagentIds.delete(payload.id);
			this.#staleGenerations.delete(payload.id);
		}
		const existing = this.#subagents.get(payload.id) ?? this.#terminalSubagents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		const sameGeneration = existing ? hasSameGeneration(payload, existing) : false;
		if (existing?.status !== "running" && payload.status === "started" && sameGeneration) return;
		// A lifecycle end event cannot terminate a newer active generation when
		// an older generation arrives out of order.
		if (existing?.status === "running" && isTerminalLifecycleStatus(payload.status) && !sameGeneration) return;
		// A terminal progress snapshot may arrive just before the lifecycle end
		// event. Allow that same generation's lifecycle payload to enrich the
		// terminal tombstone (usage, handles, finishedAt), but reject another
		// generation from mutating a settled record.
		if (existing?.status !== "running" && isTerminalLifecycleStatus(payload.status) && !sameGeneration) return;
		if (payload.status === "started") {
			this.#staleSubagentIds.delete(payload.id);
			this.#terminalSubagents.delete(payload.id);
		}
		const base = sameGeneration ? existing : undefined;
		const metadata = this.#registryMetadata(payload.id);
		const sessionFile = payload.sessionFile ?? base?.sessionFile;
		const runHandles = {
			...(base?.runHandles ?? {}),
			...(payload.runHandles ?? {}),
			...(sessionFile ? { sessionFile } : {}),
		};
		const progress = base?.progress;
		const attempt =
			payload.attempt ?? base?.attempt ?? progress?.retryState?.attempt ?? progress?.retryFailure?.attempt;
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? base?.description,
			status: statusFromLifecycle(payload.status),
			task: base?.task,
			assignment: base?.assignment,
			sessionFile,
			runId: payload.runId ?? base?.runId,
			detached: payload.detached ?? base?.detached,
			startedAt: payload.startedAt ?? base?.startedAt ?? (payload.status === "started" ? Date.now() : undefined),
			parentId: payload.parentId ?? metadata.parentId ?? base?.parentId,
			parentToolCallId: payload.parentToolCallId ?? base?.parentToolCallId,
			lastUpdate: Date.now(),
			progress,
			usage: payload.usage ?? base?.usage ?? progress?.usage,
			role: progress?.agent,
			modelRole: metadata.modelRole ?? progress?.modelRole ?? base?.modelRole,
			resolvedModel: metadata.resolvedModel ?? progress?.resolvedModel ?? base?.resolvedModel,
			resolvedModelIsFallback:
				metadata.resolvedModelIsFallback ?? progress?.resolvedModelIsFallback ?? base?.resolvedModelIsFallback,
			attempt,
			workflow: payload.workflow ?? base?.workflow,
			outputPath: metadata.outputPath ?? base?.outputPath ?? payload.runHandles?.outputPath,
			patchPath: metadata.patchPath ?? base?.patchPath ?? payload.runHandles?.patchPath,
			worktreePath: payload.runHandles?.worktreePath ?? base?.worktreePath,
			branchName:
				metadata.branchName ?? base?.branchName ?? payload.runHandles?.branchName ?? payload.runHandles?.branch,
			jobId: payload.runHandles?.jobId ?? base?.jobId,
			runHandles: Object.keys(runHandles).length > 0 ? runHandles : undefined,
			terminalAt: isTerminalLifecycleStatus(payload.status) ? (payload.finishedAt ?? Date.now()) : undefined,
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (isTerminalLifecycleStatus(payload.status)) {
			this.#subagents.delete(payload.id);
			this.#terminalSubagents.set(payload.id, snapshot);
			while (this.#terminalSubagents.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
				const oldest = this.#terminalSubagents.keys().next();
				if (oldest.done) break;
				this.#terminalSubagents.delete(oldest.value);
			}
			this.#persistTerminalRecords();
		} else {
			this.#terminalSubagents.delete(payload.id);
			this.#subagents.set(payload.id, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({
				type: "subagent_lifecycle",
				payload: { ...payload, parentId: payload.parentId ?? metadata.parentId } as SubagentLifecyclePayload,
			});
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		const terminalProgress =
			progress.status === "completed" || progress.status === "failed" || progress.status === "aborted";
		const subagentId = payload.id ?? progress.id;
		if (this.#staleSubagentIds.has(subagentId)) return;
		const existing = this.#subagents.get(subagentId);
		if (!existing || !hasSameGeneration(payload, existing) || !hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing.sessionFile;
		this.#rememberTranscriptSession(subagentId, sessionFile);
		const runHandles = {
			...(existing.runHandles ?? {}),
			...(payload.runHandles ?? {}),
			...(sessionFile ? { sessionFile } : {}),
		};
		const metadata = this.#registryMetadata(subagentId);
		const snapshot: RpcSubagentSnapshot = {
			...existing,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			runId: payload.runId ?? existing.runId,
			detached: payload.detached ?? existing.detached,
			parentId: payload.parentId ?? metadata.parentId ?? existing.parentId,
			parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
			lastUpdate: Date.now(),
			progress,
			usage: payload.usage ?? progress.usage ?? existing.usage,
			modelRole: metadata.modelRole ?? progress.modelRole ?? existing.modelRole,
			resolvedModel: metadata.resolvedModel ?? progress.resolvedModel ?? existing.resolvedModel,
			resolvedModelIsFallback:
				metadata.resolvedModelIsFallback ?? progress.resolvedModelIsFallback ?? existing.resolvedModelIsFallback,
			attempt: payload.attempt ?? progress.retryState?.attempt ?? progress.retryFailure?.attempt ?? existing.attempt,
			workflow: payload.workflow ?? existing.workflow,
			outputPath: metadata.outputPath ?? existing.outputPath ?? payload.runHandles?.outputPath,
			patchPath: metadata.patchPath ?? existing.patchPath ?? payload.runHandles?.patchPath,
			worktreePath: existing.worktreePath ?? payload.runHandles?.worktreePath,
			branchName:
				metadata.branchName ?? existing.branchName ?? payload.runHandles?.branchName ?? payload.runHandles?.branch,
			terminalAt: terminalProgress ? (existing.terminalAt ?? Date.now()) : undefined,
			runHandles: Object.keys(runHandles).length > 0 ? runHandles : undefined,
		};
		if (terminalProgress) {
			this.#subagents.delete(subagentId);
			this.#terminalSubagents.set(subagentId, snapshot);
			while (this.#terminalSubagents.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
				const oldest = this.#terminalSubagents.keys().next();
				if (oldest.done) break;
				this.#terminalSubagents.delete(oldest.value);
			}
			this.#persistTerminalRecords();
		} else {
			this.#subagents.set(subagentId, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({
				type: "subagent_progress",
				payload: { ...payload, parentId: payload.parentId ?? metadata.parentId } as SubagentProgressPayload,
			});
		}
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#staleSubagentIds.has(payload.id) || this.#terminalSubagents.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId) ?? this.#terminalSubagents.get(selector.subagentId);
			const sessionFile = snapshot?.sessionFile ?? this.#transcriptSessionFilesBySubagentId.get(selector.subagentId);
			if (!sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}
