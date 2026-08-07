/**
 * Shadow evaluation for improvement proposals.
 *
 * The ledger stores whatever recommendation a caller supplies, which means an agent
 * can simply assert `promote`. This module derives the recommendation from measured
 * baseline and candidate runs instead, so promotion has to be earned by data.
 *
 * It is deliberately pure: no run execution, no I/O. Callers collect samples however
 * they already run work, then pass them here.
 */

/**
 * The recommendation vocabulary lives here rather than in `contracts` so this module
 * stays a leaf. Consumers that only want the evaluator — the metaharness adapter, for
 * one — must not have to pull the whole control-plane contract surface with it.
 */
export type ImprovementRecommendation = "promote" | "reject" | "collect-more-data";

/** Candidate-minus-baseline deltas. Absent keys were not measured, not zero. */
export interface ImprovementMetricDeltas {
	successDelta?: number;
	costDeltaUsd?: number;
	wallTimeDeltaMs?: number;
	tokenDelta?: number;
	interventionDelta?: number;
}

export interface ShadowSample {
	runId: string;
	/** Did the run meet its own success criterion. */
	success: boolean;
	costUsd?: number;
	wallTimeMs?: number;
	tokens?: number;
	/** Human interventions required. Lower is better. */
	interventions?: number;
}

export interface ShadowEvaluationInput {
	baseline: readonly ShadowSample[];
	candidate: readonly ShadowSample[];
	/**
	 * Run ids reserved as a holdout. Promotion requires candidate coverage here so a
	 * proposal cannot win purely on the tasks it was written against.
	 */
	holdoutRunIds?: readonly string[];
	/** Minimum runs per arm before any verdict beyond `collect-more-data`. */
	minRunsPerArm?: number;
	/** Fractional worsening tolerated on secondary metrics before it counts as a regression. */
	regressionTolerance?: number;
}

export interface ShadowEvaluation {
	recommendation: ImprovementRecommendation;
	/** Why this verdict. Always populated; the ledger stores it as outcome context. */
	reasons: string[];
	metrics: ImprovementMetricDeltas;
	regressions: Array<{ metric: string; delta: number; note?: string }>;
	sampleSizes: { baseline: number; candidate: number };
	holdout: { required: boolean; covered: boolean };
}

export const DEFAULT_MIN_RUNS_PER_ARM = 3;
export const DEFAULT_REGRESSION_TOLERANCE = 0.05;

/** Mean of the defined values only; `undefined` when no sample carried the metric. */
function mean(
	samples: readonly ShadowSample[],
	pick: (sample: ShadowSample) => number | undefined,
): number | undefined {
	let total = 0;
	let count = 0;
	for (const sample of samples) {
		const value = pick(sample);
		if (value === undefined || !Number.isFinite(value)) continue;
		total += value;
		count += 1;
	}
	return count === 0 ? undefined : total / count;
}

/**
 * Relative worsening of a lower-is-better metric, or `undefined` when either arm
 * lacks the metric. A zero baseline has no meaningful ratio, so any increase from
 * zero is reported as a full regression rather than dividing by zero.
 */
function worsening(baseline: number | undefined, candidate: number | undefined): number | undefined {
	if (baseline === undefined || candidate === undefined) return undefined;
	if (baseline === 0) return candidate > 0 ? 1 : 0;
	return (candidate - baseline) / Math.abs(baseline);
}

/**
 * Derive a recommendation from measured runs.
 *
 * Success rate is the primary metric. Cost, wall time, tokens, and interventions are
 * secondary: they can block a promotion but never buy one on their own when success
 * regressed.
 */
export function evaluateShadowRuns(input: ShadowEvaluationInput): ShadowEvaluation {
	const minRuns = input.minRunsPerArm ?? DEFAULT_MIN_RUNS_PER_ARM;
	const tolerance = input.regressionTolerance ?? DEFAULT_REGRESSION_TOLERANCE;
	const baseline = input.baseline;
	const candidate = input.candidate;
	const sampleSizes = { baseline: baseline.length, candidate: candidate.length };
	const reasons: string[] = [];

	const baselineSuccess = baseline.length === 0 ? undefined : baseline.filter(s => s.success).length / baseline.length;
	const candidateSuccess =
		candidate.length === 0 ? undefined : candidate.filter(s => s.success).length / candidate.length;
	const successDelta =
		baselineSuccess === undefined || candidateSuccess === undefined ? undefined : candidateSuccess - baselineSuccess;

	const costDeltaUsd = mean(candidate, s => s.costUsd);
	const baselineCost = mean(baseline, s => s.costUsd);
	const wallCandidate = mean(candidate, s => s.wallTimeMs);
	const wallBaseline = mean(baseline, s => s.wallTimeMs);
	const tokenCandidate = mean(candidate, s => s.tokens);
	const tokenBaseline = mean(baseline, s => s.tokens);
	const interventionCandidate = mean(candidate, s => s.interventions);
	const interventionBaseline = mean(baseline, s => s.interventions);

	const metrics: ImprovementMetricDeltas = {
		...(successDelta !== undefined ? { successDelta } : {}),
		...(costDeltaUsd !== undefined && baselineCost !== undefined
			? { costDeltaUsd: costDeltaUsd - baselineCost }
			: {}),
		...(wallCandidate !== undefined && wallBaseline !== undefined
			? { wallTimeDeltaMs: wallCandidate - wallBaseline }
			: {}),
		...(tokenCandidate !== undefined && tokenBaseline !== undefined
			? { tokenDelta: tokenCandidate - tokenBaseline }
			: {}),
		...(interventionCandidate !== undefined && interventionBaseline !== undefined
			? { interventionDelta: interventionCandidate - interventionBaseline }
			: {}),
	};

	const regressions: ShadowEvaluation["regressions"] = [];
	const secondary: Array<[string, number | undefined, number | undefined, number | undefined]> = [
		["costUsd", baselineCost, costDeltaUsd, metrics.costDeltaUsd],
		["wallTimeMs", wallBaseline, wallCandidate, metrics.wallTimeDeltaMs],
		["tokens", tokenBaseline, tokenCandidate, metrics.tokenDelta],
		["interventions", interventionBaseline, interventionCandidate, metrics.interventionDelta],
	];
	for (const [metric, base, cand, delta] of secondary) {
		const ratio = worsening(base, cand);
		if (ratio === undefined || delta === undefined || ratio <= tolerance) continue;
		regressions.push({ metric, delta, note: `${(ratio * 100).toFixed(1)}% worse than baseline` });
	}

	const holdoutRunIds = input.holdoutRunIds ?? [];
	const holdoutRequired = holdoutRunIds.length > 0;
	const holdoutCovered = holdoutRequired && candidate.some(sample => holdoutRunIds.includes(sample.runId));
	const holdout = { required: holdoutRequired, covered: holdoutCovered };

	if (baseline.length < minRuns || candidate.length < minRuns) {
		reasons.push(`needs ${minRuns} runs per arm; have baseline=${baseline.length} candidate=${candidate.length}`);
		return { recommendation: "collect-more-data", reasons, metrics, regressions, sampleSizes, holdout };
	}
	if (successDelta === undefined) {
		reasons.push("no success signal in either arm");
		return { recommendation: "collect-more-data", reasons, metrics, regressions, sampleSizes, holdout };
	}
	if (successDelta < 0) {
		reasons.push(`success rate fell by ${(Math.abs(successDelta) * 100).toFixed(1)} points`);
		return { recommendation: "reject", reasons, metrics, regressions, sampleSizes, holdout };
	}
	if (successDelta === 0 && regressions.length > 0) {
		reasons.push(`no success gain and ${regressions.length} secondary regression(s)`);
		return { recommendation: "reject", reasons, metrics, regressions, sampleSizes, holdout };
	}
	if (holdoutRequired && !holdoutCovered) {
		reasons.push("no candidate run covered the holdout set");
		return { recommendation: "collect-more-data", reasons, metrics, regressions, sampleSizes, holdout };
	}
	if (successDelta === 0) {
		// A neutral change is not evidence of improvement, only of harmlessness.
		reasons.push("success rate unchanged; no measured improvement to promote");
		return { recommendation: "collect-more-data", reasons, metrics, regressions, sampleSizes, holdout };
	}
	reasons.push(`success rate rose by ${(successDelta * 100).toFixed(1)} points`);
	if (regressions.length > 0) {
		reasons.push(`accepted despite ${regressions.length} secondary regression(s)`);
	}
	return { recommendation: "promote", reasons, metrics, regressions, sampleSizes, holdout };
}
