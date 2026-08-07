import { describe, expect, it } from "bun:test";
import {
	armSamples,
	experimentShadowArms,
	resolveShadowArms,
	type ShadowRunSource,
	shadowEvaluateArms,
	shadowEvaluateExperiment,
} from "../src/shadow";
import type { RunRole, RunRow, TraceRow } from "../src/store";

/**
 * Contracts under test:
 *  - only decided trials become evidence; undecided ones are dropped, never failed.
 *  - arms resolve from the `role` column, and ambiguity refuses rather than guesses.
 *  - `-fix`/`-backfill` re-runs merge into their base arm so a retry counts once.
 */

function runRow(jobName: string, role: RunRole, overrides: Partial<RunRow> = {}): RunRow {
	return {
		benchmark: "harbor",
		jobName,
		dataset: "d",
		agent: "omp",
		models: "m",
		label: "",
		prewalk: null,
		config: {},
		role,
		note: "",
		status: "complete",
		pid: null,
		exitCode: null,
		createdAt: 1,
		finishedAt: 2,
		nTotal: 0,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		score: null,
		metrics: {},
	} as RunRow;
}

function trace(jobName: string, task: string, status: string, overrides: Partial<TraceRow> = {}): TraceRow {
	return {
		jobName,
		name: task,
		task,
		status,
		reward: status === "pass" ? 1 : 0,
		costUsd: 1,
		durationMs: 1000,
		detail: "",
		updatedAt: 1,
		tracePath: null,
		...overrides,
	};
}

/** Recorded rows standing in for the store; only two reads are needed. */
function source(runs: RunRow[], traces: Record<string, TraceRow[]>): ShadowRunSource {
	return {
		listRuns: () => runs,
		listTraces: (jobName: string) => traces[jobName] ?? [],
	} as ShadowRunSource;
}

describe("arm samples", () => {
	it("drops undecided trials instead of scoring them as failures", () => {
		const { samples, undecided } = armSamples([
			trace("j", "t1", "pass"),
			trace("j", "t2", "running"),
			trace("j", "t3", "pending"),
		]);

		// Counting an unfinished trial as a failure would penalise the slower arm.
		expect(samples.map(s => s.runId)).toEqual(["t1"]);
		expect(undecided).toBe(2);
	});

	it("treats error as a decided non-pass", () => {
		const { samples, undecided } = armSamples([trace("j", "t1", "error")]);

		expect(undecided).toBe(0);
		expect(samples).toEqual([{ runId: "t1", success: false, costUsd: 1, wallTimeMs: 1000 }]);
	});

	it("carries cost and duration through as shadow metrics", () => {
		const { samples } = armSamples([trace("j", "t1", "pass", { costUsd: 2.5, durationMs: 7 })]);

		expect(samples[0]).toMatchObject({ costUsd: 2.5, wallTimeMs: 7 });
	});
});

describe("arm comparison", () => {
	const baseline = [trace("b", "t1", "fail"), trace("b", "t2", "fail"), trace("b", "t3", "pass")];
	const candidate = [trace("c", "t1", "pass"), trace("c", "t2", "pass"), trace("c", "t3", "pass")];

	it("promotes a candidate that wins on decided trials", () => {
		const { evaluation } = shadowEvaluateArms(baseline, candidate);

		expect(evaluation.recommendation).toBe("promote");
		expect(evaluation.metrics.successDelta).toBeCloseTo(2 / 3);
	});

	it("reports how many trials were excluded per arm", () => {
		const { undecided } = shadowEvaluateArms([...baseline, trace("b", "t4", "running")], candidate);

		expect(undecided).toEqual({ baseline: 1, candidate: 0 });
	});

	it("uses task ids as holdout run ids", () => {
		const { evaluation } = shadowEvaluateArms(baseline, candidate, { holdoutTasks: ["t9"] });

		// No candidate trial covers t9, so the win is not promotable.
		expect(evaluation.recommendation).toBe("collect-more-data");
		expect(evaluation.holdout).toEqual({ required: true, covered: false });
	});

	it("promotes once a holdout task is actually covered", () => {
		const { evaluation } = shadowEvaluateArms(baseline, candidate, { holdoutTasks: ["t3"] });

		expect(evaluation.recommendation).toBe("promote");
		expect(evaluation.holdout.covered).toBe(true);
	});
});

describe("arm resolution", () => {
	const arms = [
		{ arm: "base", role: "baseline" as RunRole, traces: [] },
		{ arm: "treat", role: "variant" as RunRole, traces: [] },
	];

	it("resolves baseline and variant from the role column", () => {
		expect(resolveShadowArms(arms)).toMatchObject({
			baseline: { arm: "base" },
			candidate: { arm: "treat" },
		});
	});

	it("refuses to guess between two variants", () => {
		const ambiguous = [...arms, { arm: "treat2", role: "variant" as RunRole, traces: [] }];

		expect(resolveShadowArms(ambiguous)).toBeNull();
	});

	it("accepts explicit arm names when roles are absent", () => {
		const unroled = [
			{ arm: "a", role: "" as RunRole, traces: [] },
			{ arm: "b", role: "" as RunRole, traces: [] },
		];

		expect(resolveShadowArms(unroled)).toBeNull();
		expect(resolveShadowArms(unroled, { baselineArm: "a", candidateArm: "b" })).toMatchObject({
			baseline: { arm: "a" },
			candidate: { arm: "b" },
		});
	});

	it("refuses to compare an arm against itself", () => {
		expect(resolveShadowArms(arms, { baselineArm: "base", candidateArm: "base" })).toBeNull();
	});
});

describe("experiment evaluation", () => {
	it("merges a -fix re-run into its base arm rather than double counting", () => {
		const runs = [runRow("exp-base", "baseline"), runRow("exp-treat", "variant"), runRow("exp-treat-fix", "variant")];
		const traces = {
			"exp-base": [
				trace("exp-base", "t1", "fail"),
				trace("exp-base", "t2", "fail"),
				trace("exp-base", "t3", "fail"),
			],
			"exp-treat": [
				trace("exp-treat", "t1", "fail"),
				trace("exp-treat", "t2", "pass"),
				trace("exp-treat", "t3", "pass"),
			],
			// The retry of t1 supersedes the failed original.
			"exp-treat-fix": [trace("exp-treat-fix", "t1", "pass", { updatedAt: 9 })],
		};

		const arms = experimentShadowArms(source(runs, traces), "exp");
		const treat = arms.find(arm => arm.arm === "treat");

		expect(arms.map(arm => arm.arm).sort()).toEqual(["base", "treat"]);
		expect(treat?.traces).toHaveLength(3);
		expect(treat?.traces.filter(t => t.status === "pass")).toHaveLength(3);
	});

	it("evaluates a recorded experiment end to end", () => {
		const runs = [runRow("exp-base", "baseline"), runRow("exp-treat", "variant")];
		const traces = {
			"exp-base": [
				trace("exp-base", "t1", "fail"),
				trace("exp-base", "t2", "fail"),
				trace("exp-base", "t3", "pass"),
			],
			"exp-treat": [
				trace("exp-treat", "t1", "pass"),
				trace("exp-treat", "t2", "pass"),
				trace("exp-treat", "t3", "pass"),
			],
		};

		const result = shadowEvaluateExperiment(source(runs, traces), "exp");

		expect(result).toMatchObject({
			experimentId: "exp",
			baselineArm: "base",
			candidateArm: "treat",
		});
		expect(result?.evaluation.recommendation).toBe("promote");
	});

	it("returns null when the experiment has no resolvable pair", () => {
		const runs = [runRow("exp-only", "")];

		expect(shadowEvaluateExperiment(source(runs, { "exp-only": [] }), "exp")).toBeNull();
	});

	it("does not promote an experiment whose arms are still mostly running", () => {
		const runs = [runRow("exp-base", "baseline"), runRow("exp-treat", "variant")];
		const traces = {
			"exp-base": [trace("exp-base", "t1", "fail"), trace("exp-base", "t2", "running")],
			"exp-treat": [trace("exp-treat", "t1", "pass"), trace("exp-treat", "t2", "running")],
		};

		const result = shadowEvaluateExperiment(source(runs, traces), "exp");

		expect(result?.evaluation.recommendation).toBe("collect-more-data");
		expect(result?.undecided).toEqual({ baseline: 1, candidate: 1 });
	});
});
