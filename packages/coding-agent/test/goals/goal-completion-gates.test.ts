import { describe, expect, it } from "bun:test";
import {
	formatGoalGateFailure,
	type GoalCompletionGateReport,
	parseGoalGates,
} from "@oh-my-pi/pi-coding-agent/goals/completion-gates";
import { GoalRuntime, type GoalRuntimeHost } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { QualityGateResult } from "@oh-my-pi/pi-coding-agent/recursive-control/contracts";
import { RECURSIVE_CONTROL_VERSION } from "@oh-my-pi/pi-coding-agent/recursive-control/contracts";

function gateResult(gateId: string, status: QualityGateResult["status"], message?: string): QualityGateResult {
	return {
		version: RECURSIVE_CONTROL_VERSION,
		gateId,
		status,
		workspaceFingerprint: "workspace-v1",
		startedAt: "2026-08-06T00:00:00.000Z",
		completedAt: "2026-08-06T00:00:01.000Z",
		evidenceRefs: [],
		...(message ? { message } : {}),
	};
}

function activeState(): GoalModeState {
	const goal: Goal = {
		id: "goal-1",
		objective: "Ship the thing",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
	return { enabled: true, mode: "active", goal };
}

function createHarness(report?: GoalCompletionGateReport) {
	let state: GoalModeState | undefined = activeState();
	let gateCalls = 0;
	const host: GoalRuntimeHost = {
		getState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		setState: next => {
			state = next ? { ...next, goal: { ...next.goal } } : undefined;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 0,
		...(report
			? {
					evaluateCompletionGates: async (): Promise<GoalCompletionGateReport> => {
						gateCalls++;
						return report;
					},
				}
			: {}),
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => state,
		gateCalls: () => gateCalls,
	};
}

describe("goal completion gates", () => {
	it("completes normally when no gates are configured", async () => {
		const harness = createHarness();

		const completed = await harness.runtime.completeGoalFromTool();

		expect(completed.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
	});

	it("completes when every required gate passes", async () => {
		const harness = createHarness({ passed: true, results: [gateResult("tests", "passed")] });

		const completed = await harness.runtime.completeGoalFromTool();

		expect(completed.status).toBe("complete");
		expect(harness.gateCalls()).toBe(1);
	});

	it("refuses completion and leaves the goal active when a required gate fails", async () => {
		const harness = createHarness({
			passed: false,
			results: [gateResult("tests", "failed", "3 failing specs")],
		});

		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("Goal completion blocked");

		// The goal must survive a rejected completion so the agent keeps working on it.
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.mode).toBe("active");
	});

	it("treats a suppressed unchanged-workspace failure as still unproven", async () => {
		const harness = createHarness({
			passed: false,
			results: [
				gateResult("tests", "skipped", "Skipped: this gate already failed and the workspace has not changed."),
			],
		});

		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("skipped");
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("names the blocking gate and its status in the rejection", () => {
		const text = formatGoalGateFailure([
			gateResult("tests", "failed", "3 failing specs"),
			gateResult("lint", "passed"),
		]);

		expect(text).toContain("tests");
		expect(text).toContain("[failed]");
		expect(text).toContain("3 failing specs");
		// A passing gate is not evidence of a problem and must not be listed.
		expect(text).not.toContain("lint");
	});
});

describe("goal gate parsing", () => {
	it("defaults gates to required so an unenforced gate cannot masquerade as evidence", () => {
		const [gate] = parseGoalGates([{ id: "tests", command: "bun test" }]);

		expect(gate?.definition.required).toBe(true);
		expect(gate?.definition.timeoutMs).toBeGreaterThan(0);
		expect(gate?.command).toBe("bun test");
	});

	it("honors an explicit advisory gate", () => {
		const [gate] = parseGoalGates([{ id: "lint", command: "bun lint", required: false }]);

		expect(gate?.definition.required).toBe(false);
	});

	it("drops entries without a command instead of failing the whole session", () => {
		const gates = parseGoalGates([{ id: "broken" }, { id: "ok", command: "bun test" }, null, "nope", 42]);

		expect(gates.map(gate => gate.definition.id)).toEqual(["ok"]);
	});

	it("keeps the first definition when ids collide", () => {
		const gates = parseGoalGates([
			{ id: "tests", command: "first" },
			{ id: "tests", command: "second" },
		]);

		expect(gates).toHaveLength(1);
		expect(gates[0]?.command).toBe("first");
	});

	it("returns nothing for a missing or non-array setting", () => {
		expect(parseGoalGates(undefined)).toEqual([]);
		expect(parseGoalGates({ id: "tests", command: "bun test" })).toEqual([]);
	});
});
