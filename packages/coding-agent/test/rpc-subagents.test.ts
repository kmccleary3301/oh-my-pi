import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	buildRpcCapabilities,
	getRpcSessionMutationState,
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
	rejectRpcUnsupportedCapability,
	restoreRpcNotifications,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(terminal = false): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	if (terminal) {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);
	}
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) =>
			options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("advertises native checkpoint only when explicitly wired", () => {
		const mutation = getRpcSessionMutationState({
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 1,
			hasPendingAsyncWork: () => true,
		});
		expect(mutation).toEqual({
			stable: false,
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 1,
			pendingAsyncWork: true,
			liveChildTasks: false,
			pendingExtensionRequests: 0,
			reasons: ["queued_messages", "pending_async_work"],
		});

		const capabilities = buildRpcCapabilities(2, true, { nativeCheckpoint: true, targetedCancellation: true });
		expect(capabilities.sessions.nativeCheckpoint).toBe(true);
		expect(buildRpcCapabilities(1, true, { nativeCheckpoint: true }).sessions.nativeCheckpoint).toBe(false);
		expect(buildRpcCapabilities(1, true, { targetedCancellation: true }).tasks.targetedCancellation).toBe(false);
		expect(capabilities.sessions.completeTurnRollback).toBe(false);
		expect(capabilities.protocolVersion).toBe(2);
		expect(capabilities.tasks.targetedCancellation).toBe(true);
		const unavailable = buildRpcCapabilities(2, false, {
			nativeCheckpoint: true,
			targetedCancellation: true,
		});
		expect(unavailable.tasks.nested).toBe(false);
		expect(unavailable.tasks.background).toBe(false);
	});
	test("returns explicit unsupported errors for native RPC operations", () => {
		for (const command of ["checkpoint", "rewind", "cancel_task"]) {
			expect(rejectRpcUnsupportedCapability("req", command, "native.operation", false)).toEqual({
				id: "req",
				type: "response",
				command,
				success: false,
				error: 'RPC capability "native.operation" is unavailable',
				code: "unsupported_capability",
			});
		}
		expect(rejectRpcUnsupportedCapability("req", "checkpoint", "native.operation", true)).toBeUndefined();
	});

	test("keeps run generations isolated when terminal events arrive out of order", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "GenerationTask",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			runId: "run-a",
			parentId: "owner",
			sessionFile: "/tmp/generation-a.jsonl",
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "GenerationTask",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			runId: "run-b",
			parentId: "owner",
			sessionFile: "/tmp/generation-b.jsonl",
		} satisfies SubagentLifecyclePayload);
		expect(registry.getSubagents()).toMatchObject([
			{ id: "GenerationTask", status: "running", runId: "run-a", sessionFile: "/tmp/generation-a.jsonl" },
		]);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "GenerationTask",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			runId: "run-a",
			parentId: "owner",
			sessionFile: "/tmp/generation-a.jsonl",
		} satisfies SubagentLifecyclePayload);
		expect(registry.getSubagents()).toMatchObject([{ id: "GenerationTask", status: "completed", runId: "run-a" }]);
		registry.dispose();
	});
	test("restores PI_NOTIFICATIONS after RPC owns and releases the process setting", () => {
		const previous = process.env.PI_NOTIFICATIONS;
		try {
			process.env.PI_NOTIFICATIONS = "on";
			restoreRpcNotifications("on");
			expect(process.env.PI_NOTIFICATIONS).toBe("on");
			restoreRpcNotifications(undefined);
			expect(process.env.PI_NOTIFICATIONS).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_NOTIFICATIONS;
			else process.env.PI_NOTIFICATIONS = previous;
		}
	});

	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale terminal snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot(true);
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("promotes terminal progress to a durable tombstone before lifecycle cleanup", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent-progress-terminal.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentProgressTerminal",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			id: "SubagentProgressTerminal",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			sessionFile,
			progress: createProgress({ id: "SubagentProgressTerminal", status: "completed" }),
		} satisfies SubagentProgressPayload);

		expect(registry.getSubagents()).toMatchObject([
			{ id: "SubagentProgressTerminal", status: "completed", terminalAt: expect.any(Number) },
		]);
		expect(registry.hasLiveSubagents()).toBe(false);
		registry.dispose();
	});

	test("retains terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA", status: "completed", sessionFile }]);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});
	test("replays bounded terminal records and transcript selectors after registry restart", async () => {
		const eventBus = new EventBus();
		const indexPath = path.join(os.tmpdir(), `omp-rpc-subagent-index-${Date.now()}.json`);
		tempPaths.push(indexPath);
		const sessionFile = "/tmp/subagent-replay.jsonl";
		const registry = new RpcSubagentRegistry(eventBus, () => {}, indexPath);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentReplay",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentReplay",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		await registry.flush();
		registry.dispose();

		const restored = new RpcSubagentRegistry(eventBus, () => {}, indexPath);
		await restored.hydrate();
		expect(restored.getSubagents()).toMatchObject([{ id: "SubagentReplay", status: "completed", sessionFile }]);
		expect(restored.resolveSessionFile({ subagentId: "SubagentReplay" })).toBe(sessionFile);
		restored.dispose();
	});
	test("quiescence clear keeps persisted tombstones but ignores late lifecycle events", async () => {
		const eventBus = new EventBus();
		const indexPath = path.join(os.tmpdir(), `omp-rpc-subagent-clear-${Date.now()}.json`);
		tempPaths.push(indexPath);
		const registry = new RpcSubagentRegistry(eventBus, () => {}, indexPath);
		const sessionFile = "/tmp/subagent-clear.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentClear",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentClear",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		await registry.flush();

		registry.clear();
		expect(registry.getSubagents()).toMatchObject([{ id: "SubagentClear", status: "completed" }]);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentClear",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "failed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
		expect(registry.getSubagents()).toMatchObject([{ id: "SubagentClear", status: "completed" }]);
		registry.dispose();
	});

	test("rejects a late started event for a cleared generation", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const emitLifecycle = (status: "started" | "completed", runId: string, sessionFile: string): void => {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "ClearedGeneration",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status,
				runId,
				sessionFile,
			} satisfies SubagentLifecyclePayload);
		};
		emitLifecycle("started", "run-a", "/tmp/cleared-a.jsonl");
		emitLifecycle("completed", "run-a", "/tmp/cleared-a.jsonl");
		registry.clear();
		emitLifecycle("started", "run-a", "/tmp/cleared-a.jsonl");
		expect(registry.getSubagents()).toHaveLength(0);
		emitLifecycle("started", "run-b", "/tmp/cleared-b.jsonl");
		expect(registry.getSubagents()).toMatchObject([{ id: "ClearedGeneration", runId: "run-b", status: "running" }]);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "get_capabilities") {
		write({
			id: frame.id,
			type: "response",
			command: "get_capabilities",
			success: true,
			data: {
				runtime: "omp",
				contractVersion: 1,
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: 1024 * 1024,
				maxReassembledFrameBytes: 8 * 1024 * 1024,
				models: { discover: true, switch: true },
				thinking: { discover: true, switch: true },
				commands: { discover: true, invokeNative: true },
				sessions: {
					resume: true,
					tree: true,
					fork: true,
					compact: true,
					nativeCheckpoint: false,
					completeTurnRollback: false,
					mutationStability: true,
				},
				ui: {
					select: true,
					confirm: true,
					input: true,
					editor: true,
					notify: true,
					status: true,
					widget: true,
					openUrl: false,
					arbitraryTerminalComponents: false,
				},
				tasks: {
					lifecycle: true,
					nested: true,
					childTranscript: true,
					workflows: false,
					background: true,
					targetedCancellation: true,
					terminalRecords: true,
					replaySelectors: true,
				},
			},
		});
		return;
	}
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});
});
