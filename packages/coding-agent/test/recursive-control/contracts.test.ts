import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { type RetainedAgentBackend, RetainedAgentHandleManager } from "../../src/recursive-control/agent-handles";
import { ContextWorkspace } from "../../src/recursive-control/context-workspace";
import type {
	RetainedAgentHandle,
	RetainedAgentObservation,
	RetainedAgentSendRequest,
	RetainedAgentSpawnRequest,
	RetainedAgentWaitRequest,
} from "../../src/recursive-control/contracts";
import { RECURSIVE_CONTROL_VERSION } from "../../src/recursive-control/contracts";
import { disposeRecursiveControlRuntime, getRecursiveControlRuntime } from "../../src/recursive-control/runtime";
import type { SessionEntry } from "../../src/session/session-entries";
import type { ToolSession } from "../../src/tools";

class TrackingBackend implements RetainedAgentBackend {
	released: string[] = [];
	cancelled: string[] = [];
	statusValue: RetainedAgentHandle["status"] = "idle";

	async spawn(request: RetainedAgentSpawnRequest): Promise<RetainedAgentHandle> {
		return {
			version: RECURSIVE_CONTROL_VERSION,
			handle: "agent-handle:Child",
			agentId: "Child",
			agent: request.agent ?? "task",
			status: "idle",
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T00:00:00.000Z",
		};
	}
	status(): RetainedAgentHandle["status"] {
		return this.statusValue;
	}
	async send(_request: RetainedAgentSendRequest): Promise<void> {
		this.statusValue = "running";
	}
	async observe(agentId: string): Promise<RetainedAgentObservation> {
		return {
			version: RECURSIVE_CONTROL_VERSION,
			handle: { ...(await this.spawn({ prompt: agentId })), status: this.statusValue },
		};
	}
	async wait(_request: RetainedAgentWaitRequest): Promise<RetainedAgentHandle["status"]> {
		this.statusValue = "idle";
		return "idle";
	}
	async cancel(): Promise<void> {
		this.cancelled.push("Child");
		this.statusValue = "aborted";
	}
	async release(agentId: string): Promise<void> {
		this.released.push(agentId);
	}
}

let roots: string[] = [];
let sessions: ToolSession[] = [];

afterEach(async () => {
	await Promise.all(sessions.map(disposeRecursiveControlRuntime));
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
	sessions = [];
});

function entry(content: string, id = "entry-1"): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-08-06T00:00:00.000Z",
		customType: "fixture",
		content,
		display: true,
	};
}

describe("recursive-control contract seams", () => {
	test("mutating conversation content invalidates a prior context fingerprint", async () => {
		const entries = [entry("authentication failure details")];
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			sessionManager: {
				getBranch: () => entries,
				getEntries: () => entries,
			} as unknown as NonNullable<ToolSession["sessionManager"]>,
		};
		const workspace = new ContextWorkspace(session, { maxItems: 10, maxChars: 64, maxMaterializeChars: 128 });
		const first = await workspace.read({ ref: "conversation:entry-1", limit: 32 });
		entries[0] = entry("authentication failure details — updated diagnosis");
		await expect(
			workspace.read({
				ref: "conversation:entry-1",
				expectedFingerprint: first.fingerprint,
				limit: 32,
			}),
		).rejects.toThrow("Stale recursive context reference");
		const second = await workspace.read({ ref: "conversation:entry-1", limit: 32 });
		expect(second.fingerprint).not.toBe(first.fingerprint);
	});

	test("handle manager dispose releases owned agents and leaves no residual records", async () => {
		const backend = new TrackingBackend();
		const manager = new RetainedAgentHandleManager(backend, { maxHandles: 2, maxObservationChars: 1000 });
		const handle = await manager.spawn({ prompt: "review" });
		expect(manager.listHandles()).toHaveLength(1);
		await manager.dispose();
		expect(backend.released).toEqual(["Child"]);
		expect(manager.listHandles()).toHaveLength(0);
		expect(() => manager.status(handle.handle)).toThrow("Unknown retained agent handle");
	});

	test("runtime dispose after enable leaves subsequent construction able to fail closed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recursive-contract-"));
		roots.push(root);
		const settings = Settings.isolated();
		settings.set("recursive.enabled", true);
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "contract-session",
			getAgentId: () => "Main",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		};
		sessions.push(session);
		const runtime = getRecursiveControlRuntime(session);
		expect(runtime.config.enabled).toBeTrue();
		await disposeRecursiveControlRuntime(session);
		settings.set("recursive.enabled", false);
		expect(() => getRecursiveControlRuntime(session)).toThrow("disabled");
	});
});
