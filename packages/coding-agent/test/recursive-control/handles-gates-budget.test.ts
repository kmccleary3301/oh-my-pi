import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { type RetainedAgentBackend, RetainedAgentHandleManager } from "../../src/recursive-control/agent-handles";
import { RecursiveBudgetLedger } from "../../src/recursive-control/budget";
import type { RecursiveControlConfig } from "../../src/recursive-control/config";
import type {
	RetainedAgentHandle,
	RetainedAgentObservation,
	RetainedAgentSendRequest,
	RetainedAgentSpawnRequest,
	RetainedAgentWaitRequest,
} from "../../src/recursive-control/contracts";
import { RECURSIVE_CONTROL_VERSION } from "../../src/recursive-control/contracts";
import { QualityGateRunner } from "../../src/recursive-control/quality-gates";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { ToolSession } from "../../src/tools";

class FakeBackend implements RetainedAgentBackend {
	statusValue: RetainedAgentHandle["status"] = "idle";
	released: string[] = [];
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
		this.statusValue = "aborted";
	}
	async release(agentId: string): Promise<void> {
		this.released.push(agentId);
	}
}

class DeferredBackend extends FakeBackend {
	readonly reservations: Array<PromiseWithResolvers<RetainedAgentHandle>> = [];
	override async spawn(_request: RetainedAgentSpawnRequest): Promise<RetainedAgentHandle> {
		const reservation = Promise.withResolvers<RetainedAgentHandle>();
		this.reservations.push(reservation);
		return await reservation.promise;
	}
}

const config: RecursiveControlConfig = {
	enabled: true,
	contextMaxItems: 10,
	contextMaxChars: 1024,
	contextMaterializeMaxChars: 4096,
	maxHandles: 1,
	wakeIntervalMs: 30_000,
	maxTotalTokens: 100,
	maxCostUsd: 1,
	maxWallTimeMs: null,
	stateMaxBytes: 4096,
};

describe("retained handles, budgets, and quality gates", () => {
	test("owns retained handles, applies limits, and releases deterministically", async () => {
		const backend = new FakeBackend();
		const manager = new RetainedAgentHandleManager(backend, { maxHandles: 1, maxObservationChars: 1000 });
		const handle = await manager.spawn({ prompt: "review" });
		expect(handle.handle).toBe("agent-handle:Child");
		await expect(manager.spawn({ prompt: "second" })).rejects.toThrow("limit");
		expect((await manager.send({ handle: handle.handle, message: "continue" })).status).toBe("running");
		expect((await manager.cancel(handle.handle)).status).toBe("aborted");
		await manager.release(handle.handle);
		expect(backend.released).toEqual(["Child"]);
	});

	test("counts concurrent pending spawns against the retained handle limit", async () => {
		const backend = new DeferredBackend();
		const manager = new RetainedAgentHandleManager(backend, { maxHandles: 1, maxObservationChars: 1000 });
		const first = manager.spawn({ prompt: "first" });
		await Bun.sleep(0);
		await expect(manager.spawn({ prompt: "second" })).rejects.toThrow("limit");
		backend.reservations[0]!.resolve({
			version: RECURSIVE_CONTROL_VERSION,
			handle: "agent-handle:Child",
			agentId: "Child",
			agent: "task",
			status: "idle",
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T00:00:00.000Z",
		});
		expect((await first).agentId).toBe("Child");
	});

	test("subtracts descendant usage from aggregate parent statistics", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
			history: { metrics: { tokens: 50, requests: 2, tools: 3, cost: 0.2, durationMs: 400 } },
		});
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "task.maxRecursionDepth": 2 }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			agentRegistry: registry,
			getUsageStatistics: () => ({
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0.7,
			}),
		} satisfies ToolSession;
		const ledger = new RecursiveBudgetLedger(session, { ...config, maxTotalTokens: 1000 }, { listHandles: () => [] });
		const usage = ledger.snapshot().usage;
		expect(usage.total.totalTokens).toBe(150);
		expect(usage.descendants.totalTokens).toBe(50);
		expect(usage.own.totalTokens).toBe(100);
		expect(usage.total.cost).toBeCloseTo(0.7);
	});

	test("accounts root usage and blocks new admission at the total-token budget", () => {
		const handles = { listHandles: () => [] };
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "task.maxRecursionDepth": 2 }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getUsageStatistics: () => ({
				input: 70,
				output: 30,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0.5,
			}),
		} satisfies ToolSession;
		const ledger = new RecursiveBudgetLedger(session, config, handles);
		expect(ledger.snapshot().usage.total.totalTokens).toBe(100);
		expect(() => ledger.assertCanSpawn()).toThrow("token budget");
	});

	test("skips an unchanged required gate after a prior failure", async () => {
		let executions = 0;
		const runner = new QualityGateRunner({
			fingerprintWorkspace: async () => "workspace-v1",
			execute: async () => {
				executions++;
				return { passed: false, evidenceRefs: ["artifact://gate"] };
			},
		});
		const gate = { id: "tests", label: "Tests", required: true, timeoutMs: 1000 };
		expect((await runner.run([gate]))[0]?.status).toBe("failed");
		expect((await runner.run([gate]))[0]?.status).toBe("skipped");
		expect((await runner.run([gate]))[0]?.status).toBe("skipped");
		expect(executions).toBe(1);
	});

	test("propagates caller cancellation instead of converting it into a gate error", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled by caller");
		const runner = new QualityGateRunner({
			fingerprintWorkspace: async () => "workspace-v1",
			execute: async (_gate, signal) => {
				controller.abort(reason);
				await Bun.sleep(0);
				if (signal.aborted) throw signal.reason;
				return { passed: true };
			},
		});
		await expect(
			runner.run([{ id: "tests", label: "Tests", required: true, timeoutMs: 1000 }], controller.signal),
		).rejects.toThrow("cancelled by caller");
	});
});
