import { describe, expect, test } from "bun:test";
import {
	evaluateShadowRuns,
	type ShadowEvaluationInput,
	type ShadowSample,
} from "../../src/recursive-control/shadow-evaluation";

function arm(prefix: string, successes: number, total: number, extra: Partial<ShadowSample> = {}): ShadowSample[] {
	return Array.from({ length: total }, (_, index) => ({
		runId: `${prefix}-${index}`,
		success: index < successes,
		...extra,
	}));
}

function run(overrides: Partial<ShadowEvaluationInput> = {}) {
	return evaluateShadowRuns({ baseline: arm("b", 1, 4), candidate: arm("c", 3, 4), ...overrides });
}

describe("shadow evaluation", () => {
	test("promotes a measured success gain", () => {
		const result = run();

		expect(result.recommendation).toBe("promote");
		expect(result.metrics.successDelta).toBeCloseTo(0.5);
		expect(result.reasons.join(" ")).toContain("success rate rose");
	});

	test("rejects a success regression", () => {
		const result = run({ baseline: arm("b", 4, 4), candidate: arm("c", 2, 4) });

		expect(result.recommendation).toBe("reject");
		expect(result.metrics.successDelta).toBeCloseTo(-0.5);
	});

	test("withholds a verdict until both arms have enough runs", () => {
		const result = run({ baseline: arm("b", 0, 2), candidate: arm("c", 2, 2) });

		expect(result.recommendation).toBe("collect-more-data");
		expect(result.sampleSizes).toEqual({ baseline: 2, candidate: 2 });
	});

	test("does not promote a merely neutral change", () => {
		const result = run({ baseline: arm("b", 3, 4), candidate: arm("c", 3, 4) });

		expect(result.recommendation).toBe("collect-more-data");
		expect(result.reasons.join(" ")).toContain("unchanged");
	});

	test("rejects a neutral change that costs more", () => {
		const result = run({
			baseline: arm("b", 3, 4, { costUsd: 1 }),
			candidate: arm("c", 3, 4, { costUsd: 2 }),
		});

		expect(result.recommendation).toBe("reject");
		expect(result.regressions.map(entry => entry.metric)).toContain("costUsd");
	});

	test("records but does not veto a secondary regression behind a real success gain", () => {
		const result = run({
			baseline: arm("b", 1, 4, { tokens: 1000 }),
			candidate: arm("c", 3, 4, { tokens: 1400 }),
		});

		expect(result.recommendation).toBe("promote");
		expect(result.regressions.map(entry => entry.metric)).toContain("tokens");
		expect(result.metrics.tokenDelta).toBeCloseTo(400);
	});

	test("ignores secondary movement inside the tolerance band", () => {
		const result = run({
			baseline: arm("b", 3, 4, { costUsd: 1 }),
			candidate: arm("c", 3, 4, { costUsd: 1.02 }),
		});

		expect(result.regressions).toEqual([]);
	});

	test("will not promote without a candidate run on the holdout set", () => {
		const result = run({ holdoutRunIds: ["held-out-1"] });

		expect(result.recommendation).toBe("collect-more-data");
		expect(result.holdout).toEqual({ required: true, covered: false });
	});

	test("promotes once the holdout is actually covered", () => {
		const candidate = [...arm("c", 3, 4), { runId: "held-out-1", success: true }];
		const result = run({ candidate, holdoutRunIds: ["held-out-1"] });

		expect(result.recommendation).toBe("promote");
		expect(result.holdout.covered).toBe(true);
	});

	test("treats an increase from a zero baseline as a full regression, not a divide by zero", () => {
		const result = run({
			baseline: arm("b", 3, 4, { interventions: 0 }),
			candidate: arm("c", 3, 4, { interventions: 2 }),
		});

		expect(result.recommendation).toBe("reject");
		expect(result.regressions.map(entry => entry.metric)).toContain("interventions");
		expect(result.metrics.interventionDelta).toBeCloseTo(2);
	});

	test("omits metrics that no run reported instead of inventing zeros", () => {
		const result = run();

		expect(result.metrics.costDeltaUsd).toBeUndefined();
		expect(result.metrics.tokenDelta).toBeUndefined();
	});
});
