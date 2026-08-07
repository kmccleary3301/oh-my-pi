import { describe, expect, test } from "bun:test";
import { compareRecursiveBenchmarks } from "../../src/recursive-control/comparison";

describe("recursive benchmark comparison", () => {
	test("requires a non-regressing strict Pareto improvement", () => {
		const baseline = { id: "direct", score: 0.5, totalTokens: 100, costUsd: 1, wallTimeMs: 1000, interventions: 2 };
		const better = compareRecursiveBenchmarks(baseline, {
			id: "context",
			score: 0.6,
			totalTokens: 90,
			costUsd: 0.9,
			wallTimeMs: 900,
			interventions: 1,
		});
		expect(better.pareto.strictImprovement).toBeTrue();
		const tradeoff = compareRecursiveBenchmarks(baseline, {
			id: "strict",
			score: 0.8,
			totalTokens: 300,
			costUsd: 2,
			wallTimeMs: 2000,
			interventions: 0,
		});
		expect(tradeoff.pareto.strictImprovement).toBeFalse();
		expect(tradeoff.pareto.regressedDimensions).toContain("totalTokens");
	});
});
