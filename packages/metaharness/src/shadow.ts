/**
 * Shadow-evaluation adapter: turns recorded benchmark arms into an improvement
 * verdict.
 *
 * `evaluateShadowRuns` in coding-agent decides whether a candidate beat a baseline,
 * but it is pure and takes samples it cannot collect itself. Metaharness already runs
 * arms, already tags them `baseline` vs `variant`, and already stores per-task
 * outcomes — so this is the adapter between the two, not a second run harness.
 */
// Deliberately a narrow subpath import: pulling the coding-agent root barrel drags
// its browser/computer worker DOM types into this package's compilation.
import {
	evaluateShadowRuns,
	type ShadowEvaluation,
	type ShadowSample,
} from "@oh-my-pi/pi-coding-agent/recursive-control/shadow-evaluation";
import { armOf, canonicalArmOf, experimentOf, pickMergedTrials } from "./experiments";
import type { RunRole, RunRow, RunStore, TraceRow } from "./store";

/**
 * The two reads this adapter needs. Narrower than `RunStore` so the dependency is
 * explicit and a caller can supply recorded rows without standing up SQLite.
 */
export type ShadowRunSource = Pick<RunStore, "listRuns" | "listTraces">;

/** A trial only counts once it has decided; `running` is not evidence either way. */
const DECIDED: Readonly<Record<string, true>> = { pass: true, fail: true, error: true };

export interface ShadowArm {
	arm: string;
	role: RunRole;
	traces: readonly TraceRow[];
}

export interface ExperimentShadowResult {
	experimentId: string;
	baselineArm: string;
	candidateArm: string;
	evaluation: ShadowEvaluation;
	/** Trials excluded because they had not decided yet, per arm. */
	undecided: { baseline: number; candidate: number };
}

export interface ShadowEvaluateOptions {
	/** Override arm selection when roles are absent or ambiguous. */
	baselineArm?: string;
	candidateArm?: string;
	/** Task ids reserved as a holdout; promotion requires candidate coverage. */
	holdoutTasks?: readonly string[];
	minRunsPerArm?: number;
	regressionTolerance?: number;
}

/**
 * Decided trials of one arm as shadow samples.
 *
 * `error` is a decided non-pass: the trial ran and did not succeed. Undecided
 * trials are dropped rather than counted as failures, which would bias the verdict
 * against whichever arm is simply slower to finish.
 */
export function armSamples(traces: readonly TraceRow[]): { samples: ShadowSample[]; undecided: number } {
	const samples: ShadowSample[] = [];
	let undecided = 0;
	for (const trace of traces) {
		if (!DECIDED[trace.status]) {
			undecided += 1;
			continue;
		}
		samples.push({
			// Task id doubles as the run id so holdout task ids match directly.
			runId: trace.task,
			success: trace.status === "pass",
			costUsd: trace.costUsd,
			wallTimeMs: trace.durationMs,
		});
	}
	return { samples, undecided };
}

/** Pure comparison of two arms' recorded trials. */
export function shadowEvaluateArms(
	baseline: readonly TraceRow[],
	candidate: readonly TraceRow[],
	options: ShadowEvaluateOptions = {},
): { evaluation: ShadowEvaluation; undecided: { baseline: number; candidate: number } } {
	const base = armSamples(baseline);
	const cand = armSamples(candidate);
	return {
		evaluation: evaluateShadowRuns({
			baseline: base.samples,
			candidate: cand.samples,
			...(options.holdoutTasks ? { holdoutRunIds: options.holdoutTasks } : {}),
			...(options.minRunsPerArm !== undefined ? { minRunsPerArm: options.minRunsPerArm } : {}),
			...(options.regressionTolerance !== undefined ? { regressionTolerance: options.regressionTolerance } : {}),
		}),
		undecided: { baseline: base.undecided, candidate: cand.undecided },
	};
}

/**
 * Resolve the baseline and candidate arms of an experiment.
 *
 * Explicit names win. Otherwise the `role` column decides, and only when it is
 * unambiguous: with two variants and no explicit choice there is no defensible way
 * to guess which one is "the" candidate, so this returns `null` instead of picking.
 */
export function resolveShadowArms(
	arms: readonly ShadowArm[],
	options: ShadowEvaluateOptions = {},
): { baseline: ShadowArm; candidate: ShadowArm } | null {
	const byName = (name: string) => arms.find(arm => arm.arm === name);
	const baseline = options.baselineArm ? byName(options.baselineArm) : pickSole(arms, "baseline");
	const candidate = options.candidateArm ? byName(options.candidateArm) : pickSole(arms, "variant");
	if (!baseline || !candidate || baseline.arm === candidate.arm) return null;
	return { baseline, candidate };
}

function pickSole(arms: readonly ShadowArm[], role: RunRole): ShadowArm | undefined {
	const matches = arms.filter(arm => arm.role === role);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Collect an experiment's canonical arms with their merged trials. */
export function experimentShadowArms(store: ShadowRunSource, experimentId: string): ShadowArm[] {
	const runs = store.listRuns().filter(run => experimentOf(run.jobName) === experimentId);
	const groups = new Map<string, RunRow[]>();
	for (const run of runs) {
		const key = canonicalArmOf(run.jobName);
		const bucket = groups.get(key);
		if (bucket) bucket.push(run);
		else groups.set(key, [run]);
	}
	const arms: ShadowArm[] = [];
	for (const [canonical, members] of groups) {
		members.sort((left, right) => left.createdAt - right.createdAt);
		const base = members.find(member => armOf(member.jobName) === canonical) ?? members[0];
		// Re-runs (`-fix`, `-backfill`) merge into their base arm so a retried task
		// is counted once, matching how the experiment view reports the same arm.
		const merged = pickMergedTrials(members.flatMap(member => store.listTraces(member.jobName)));
		arms.push({ arm: base.label || canonical, role: base.role, traces: merged });
	}
	return arms;
}

/** Evaluate a recorded experiment's baseline against its variant. */
export function shadowEvaluateExperiment(
	store: ShadowRunSource,
	experimentId: string,
	options: ShadowEvaluateOptions = {},
): ExperimentShadowResult | null {
	const resolved = resolveShadowArms(experimentShadowArms(store, experimentId), options);
	if (!resolved) return null;
	const { evaluation, undecided } = shadowEvaluateArms(resolved.baseline.traces, resolved.candidate.traces, options);
	return {
		experimentId,
		baselineArm: resolved.baseline.arm,
		candidateArm: resolved.candidate.arm,
		evaluation,
		undecided,
	};
}
