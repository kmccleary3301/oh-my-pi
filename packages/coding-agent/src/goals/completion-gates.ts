import { executeBash } from "../exec/bash-executor";
import { boundedRecursiveText } from "../recursive-control/canonical";
import type { QualityGateDefinition, QualityGateResult } from "../recursive-control/contracts";
import { QualityGateRunner } from "../recursive-control/quality-gates";

/** Outcome of evaluating every configured completion gate for a goal. */
export interface GoalCompletionGateReport {
	passed: boolean;
	results: QualityGateResult[];
}

export type GoalCompletionGateEvaluator = (signal?: AbortSignal) => Promise<GoalCompletionGateReport>;

interface ParsedGoalGate {
	definition: QualityGateDefinition;
	command: string;
}

const DEFAULT_GATE_TIMEOUT_MS = 300_000;
const MAX_GATE_OUTPUT_CHARS = 4096;

/**
 * Parse the `goal.gates` setting.
 *
 * Malformed entries are dropped rather than thrown: a bad gate definition must
 * not make an otherwise valid session unable to complete any goal.
 */
export function parseGoalGates(raw: unknown): ParsedGoalGate[] {
	if (!Array.isArray(raw)) return [];
	const parsed: ParsedGoalGate[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const command = typeof record.command === "string" ? record.command.trim() : "";
		if (!command) continue;
		const rawId = typeof record.id === "string" ? record.id.trim() : "";
		const id = rawId || `gate-${parsed.length + 1}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const timeout = typeof record.timeoutMs === "number" ? record.timeoutMs : DEFAULT_GATE_TIMEOUT_MS;
		parsed.push({
			command,
			definition: {
				id,
				label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
				// Gates are required unless explicitly advisory; a gate nobody enforces
				// is documentation, not evidence.
				required: record.required !== false,
				timeoutMs: Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_GATE_TIMEOUT_MS,
			},
		});
	}
	return parsed;
}

/**
 * Fingerprint the workspace so an unchanged failing gate is not paid for twice.
 *
 * Covers HEAD, the porcelain status, and the full tracked diff, so edits to
 * tracked files always move the fingerprint. Content edits to *untracked* files
 * are not captured; that only costs a stale "workspace has not changed" note,
 * never a false pass. Outside a git worktree the fingerprint is unique per call,
 * which disables suppression rather than risking a permanent block.
 */
async function fingerprintWorkspace(cwd: string, signal?: AbortSignal): Promise<string> {
	const probe = await executeBash(
		"git rev-parse HEAD 2>/dev/null; git status --porcelain=v1 -uall 2>/dev/null; git diff HEAD 2>/dev/null",
		{ cwd, timeout: 30_000, ...(signal ? { signal } : {}) },
	);
	if (probe.cancelled || !probe.output.trim()) {
		return `omp-goal-workspace/v1:unavailable:${crypto.randomUUID()}`;
	}
	return `omp-goal-workspace/v1:sha256:${Bun.SHA256.hash(probe.output, "hex")}`;
}

/** Human-readable rejection text naming each gate that did not pass. */
export function formatGoalGateFailure(results: readonly QualityGateResult[]): string {
	const blocking = results.filter(result => result.status !== "passed");
	const lines = blocking.map(result => {
		const detail = result.message ? `\n    ${result.message.replaceAll("\n", "\n    ")}` : "";
		return `  - ${result.gateId} [${result.status}]${detail}`;
	});
	return [
		"Goal completion blocked: required evidence gates did not pass.",
		...lines,
		"",
		"Fix the underlying problem and call goal complete again. A gate that already",
		"failed on an unchanged workspace is reported as skipped, not passed.",
	].join("\n");
}

export interface GoalCompletionGateOptions {
	cwd: string;
	/** Reads the current `goal.gates` setting; re-read per call so config edits take effect. */
	readGates: () => unknown;
}

/**
 * Build the evaluator wired into `GoalRuntime`, or `undefined` when the feature
 * is unused. One `QualityGateRunner` is retained per session so unchanged-failure
 * suppression survives repeated completion attempts.
 */
export function createGoalCompletionGateEvaluator(options: GoalCompletionGateOptions): GoalCompletionGateEvaluator {
	let runner: QualityGateRunner | undefined;
	const commandByGate = new Map<string, string>();

	return async (signal?: AbortSignal): Promise<GoalCompletionGateReport> => {
		const gates = parseGoalGates(options.readGates());
		if (gates.length === 0) return { passed: true, results: [] };

		commandByGate.clear();
		for (const gate of gates) commandByGate.set(gate.definition.id, gate.command);

		runner ??= new QualityGateRunner({
			fingerprintWorkspace: async innerSignal => await fingerprintWorkspace(options.cwd, innerSignal),
			execute: async (gate, executionSignal) => {
				const command = commandByGate.get(gate.id);
				if (!command) return { passed: false, message: `no command configured for gate ${gate.id}` };
				const result = await executeBash(command, {
					cwd: options.cwd,
					timeout: gate.timeoutMs,
					signal: executionSignal,
				});
				const passed = result.exitCode === 0 && !result.cancelled && !result.timedOut;
				const output = boundedRecursiveText(result.output.trim(), MAX_GATE_OUTPUT_CHARS).text;
				const reason = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`;
				return {
					passed,
					evidenceRefs: [`command:${command}`, `exit:${result.exitCode ?? "unknown"}`],
					...(passed ? {} : { message: `${reason}\n${output}`.trim() }),
				};
			},
		});

		const results = await runner.run(
			gates.map(gate => gate.definition),
			signal,
		);
		const requiredIds = new Set(gates.filter(gate => gate.definition.required).map(gate => gate.definition.id));
		// A required gate that never ran (the runner stops after the first blocking
		// failure) is still missing evidence, so absence counts as not passed.
		const passed = [...requiredIds].every(id => results.find(result => result.gateId === id)?.status === "passed");
		return { passed, results };
	};
}
