export interface RecursiveBenchmarkSummary {
	id: string;
	score: number;
	totalTokens: number;
	costUsd: number;
	wallTimeMs: number;
	interventions: number;
	rootTokens?: number;
	childTokens?: number;
}

export interface RecursiveBenchmarkComparison {
	baselineId: string;
	candidateId: string;
	deltas: {
		score: number;
		totalTokens: number;
		costUsd: number;
		wallTimeMs: number;
		interventions: number;
	};
	pareto: {
		strictImprovement: boolean;
		regressedDimensions: string[];
	};
}

function finite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

export function compareRecursiveBenchmarks(
	baseline: RecursiveBenchmarkSummary,
	candidate: RecursiveBenchmarkSummary,
): RecursiveBenchmarkComparison {
	const deltas = {
		score: finite(candidate.score, "candidate.score") - finite(baseline.score, "baseline.score"),
		totalTokens:
			finite(candidate.totalTokens, "candidate.totalTokens") - finite(baseline.totalTokens, "baseline.totalTokens"),
		costUsd: finite(candidate.costUsd, "candidate.costUsd") - finite(baseline.costUsd, "baseline.costUsd"),
		wallTimeMs:
			finite(candidate.wallTimeMs, "candidate.wallTimeMs") - finite(baseline.wallTimeMs, "baseline.wallTimeMs"),
		interventions:
			finite(candidate.interventions, "candidate.interventions") -
			finite(baseline.interventions, "baseline.interventions"),
	};
	const regressedDimensions = [
		...(deltas.score < 0 ? ["score"] : []),
		...(deltas.totalTokens > 0 ? ["totalTokens"] : []),
		...(deltas.costUsd > 0 ? ["costUsd"] : []),
		...(deltas.wallTimeMs > 0 ? ["wallTimeMs"] : []),
		...(deltas.interventions > 0 ? ["interventions"] : []),
	];
	const improved =
		deltas.score > 0 ||
		deltas.totalTokens < 0 ||
		deltas.costUsd < 0 ||
		deltas.wallTimeMs < 0 ||
		deltas.interventions < 0;
	return {
		baselineId: baseline.id,
		candidateId: candidate.id,
		deltas,
		pareto: {
			strictImprovement: regressedDimensions.length === 0 && improved,
			regressedDimensions,
		},
	};
}
