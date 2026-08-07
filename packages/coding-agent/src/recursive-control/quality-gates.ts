import { boundedRecursiveText } from "./canonical";
import type { QualityGateDefinition, QualityGateResult } from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";

export interface QualityGateExecution {
	passed: boolean;
	evidenceRefs?: string[];
	message?: string;
}

export type QualityGateExecutor = (gate: QualityGateDefinition, signal: AbortSignal) => Promise<QualityGateExecution>;

export interface QualityGateRunnerOptions {
	fingerprintWorkspace(signal?: AbortSignal): Promise<string>;
	execute: QualityGateExecutor;
}

/** Evidence-gated continuation with unchanged-workspace failure suppression. */
export class QualityGateRunner {
	readonly #fingerprintWorkspace: QualityGateRunnerOptions["fingerprintWorkspace"];
	readonly #execute: QualityGateExecutor;
	readonly #lastExecutionByGate = new Map<string, QualityGateResult>();
	readonly #lastResultByGate = new Map<string, QualityGateResult>();

	constructor(options: QualityGateRunnerOptions) {
		this.#fingerprintWorkspace = options.fingerprintWorkspace;
		this.#execute = options.execute;
	}

	lastResult(gateId: string): QualityGateResult | undefined {
		const result = this.#lastResultByGate.get(gateId);
		return result ? { ...result, evidenceRefs: [...result.evidenceRefs] } : undefined;
	}

	async run(gates: readonly QualityGateDefinition[], signal?: AbortSignal): Promise<QualityGateResult[]> {
		const results: QualityGateResult[] = [];
		for (const gate of gates) {
			if (signal?.aborted) throw signal.reason;
			const result = await this.#runOne(gate, signal);
			results.push(result);
			// Skipping an unchanged prior failure avoids redundant compute; it does
			// not convert that failure into evidence that the gate passed.
			if (gate.required && result.status !== "passed") break;
		}
		return results;
	}

	async #runOne(gate: QualityGateDefinition, signal?: AbortSignal): Promise<QualityGateResult> {
		if (!gate.id.trim()) throw new Error("quality gate id must not be empty");
		if (!Number.isFinite(gate.timeoutMs) || gate.timeoutMs < 0) {
			throw new Error(`quality gate ${gate.id} timeoutMs must be a non-negative finite number`);
		}
		const workspaceFingerprint = await this.#fingerprintWorkspace(signal);
		const previous = this.#lastExecutionByGate.get(gate.id);
		if (previous && previous.workspaceFingerprint === workspaceFingerprint && previous.status === "failed") {
			const now = new Date().toISOString();
			const skipped: QualityGateResult = {
				version: RECURSIVE_CONTROL_VERSION,
				gateId: gate.id,
				status: "skipped",
				workspaceFingerprint,
				startedAt: now,
				completedAt: now,
				evidenceRefs: [...previous.evidenceRefs],
				message: "Skipped: this gate already failed and the workspace has not changed.",
			};
			this.#lastResultByGate.set(gate.id, skipped);
			return skipped;
		}
		const startedAt = new Date().toISOString();
		const timeoutSignal = gate.timeoutMs > 0 ? AbortSignal.timeout(gate.timeoutMs) : undefined;
		const executionSignal =
			signal && timeoutSignal
				? AbortSignal.any([signal, timeoutSignal])
				: (signal ?? timeoutSignal ?? new AbortController().signal);
		let result: QualityGateResult;
		try {
			const execution = await this.#execute(gate, executionSignal);
			result = {
				version: RECURSIVE_CONTROL_VERSION,
				gateId: gate.id,
				status: execution.passed ? "passed" : "failed",
				workspaceFingerprint,
				startedAt,
				completedAt: new Date().toISOString(),
				evidenceRefs: [...(execution.evidenceRefs ?? [])],
				...(execution.message ? { message: execution.message } : {}),
			};
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			result = {
				version: RECURSIVE_CONTROL_VERSION,
				gateId: gate.id,
				status: "error",
				workspaceFingerprint,
				startedAt,
				completedAt: new Date().toISOString(),
				evidenceRefs: [],
				message: boundedRecursiveText(error instanceof Error ? error.message : String(error), 2048).text,
			};
		}
		result = {
			...result,
			evidenceRefs: result.evidenceRefs.slice(0, 64).map(ref => boundedRecursiveText(ref, 1024).text),
			...(result.message ? { message: boundedRecursiveText(result.message, 2048).text } : {}),
		};
		this.#lastExecutionByGate.set(gate.id, result);
		this.#lastResultByGate.set(gate.id, result);
		return result;
	}
}
