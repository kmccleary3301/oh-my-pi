#!/usr/bin/env bun
import * as path from "node:path";
import { compareRecursiveBenchmarks, type RecursiveBenchmarkSummary } from "../src/recursive-control/comparison";

async function readSummary(input: string): Promise<RecursiveBenchmarkSummary> {
	return (await Bun.file(path.resolve(input)).json()) as RecursiveBenchmarkSummary;
}

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
	process.stderr.write("Usage: compare-recursive-runs <baseline.json> <candidate.json>\n");
	process.exit(2);
}
const report = compareRecursiveBenchmarks(await readSummary(baselinePath), await readSummary(candidatePath));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
