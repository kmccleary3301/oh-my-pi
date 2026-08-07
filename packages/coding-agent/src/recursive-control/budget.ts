import { buildAgentUsageTree } from "../registry/agent-usage-tree";
import type { ToolSession } from "../tools";
import type { RecursiveControlConfig } from "./config";
import type { RecursiveBudgetSnapshot, RetainedAgentHandle } from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";

const ACTIVE_HANDLE_STATUSES: Record<string, true> = {
	starting: true,
	running: true,
	idle: true,
	parked: true,
};

export interface RetainedAgentHandleSource {
	listHandles(): RetainedAgentHandle[];
}

/** Host-owned accounting and admission checks for recursive work. */
export class RecursiveBudgetLedger {
	readonly #session: ToolSession;
	readonly #config: RecursiveControlConfig;
	readonly #handles: RetainedAgentHandleSource;
	readonly #startedAt = Date.now();

	constructor(session: ToolSession, config: RecursiveControlConfig, handles: RetainedAgentHandleSource) {
		this.#session = session;
		this.#config = config;
		this.#handles = handles;
	}

	snapshot(): RecursiveBudgetSnapshot {
		const rootId = this.#session.getAgentId?.() ?? "Main";
		const usage = buildAgentUsageTree(this.#session.agentRegistry, this.#session, rootId);
		const handles = this.#handles.listHandles();
		const activeHandles = handles.filter(handle => ACTIVE_HANDLE_STATUSES[handle.status] === true).length;
		const elapsedMs = Date.now() - this.#startedAt;
		const violations: string[] = [];
		if (handles.length > this.#config.maxHandles) {
			violations.push(`retained handle limit exceeded (${handles.length}/${this.#config.maxHandles})`);
		}
		if (this.#config.maxTotalTokens !== null && usage.total.totalTokens >= this.#config.maxTotalTokens) {
			violations.push(
				`recursive token budget exhausted (${usage.total.totalTokens}/${this.#config.maxTotalTokens})`,
			);
		}
		if (this.#config.maxCostUsd !== null && usage.total.cost >= this.#config.maxCostUsd) {
			violations.push(
				`recursive cost budget exhausted ($${usage.total.cost.toFixed(4)}/$${this.#config.maxCostUsd})`,
			);
		}
		if (this.#config.maxWallTimeMs !== null && elapsedMs >= this.#config.maxWallTimeMs) {
			violations.push(`recursive wall-time budget exhausted (${elapsedMs}/${this.#config.maxWallTimeMs} ms)`);
		}
		return {
			version: RECURSIVE_CONTROL_VERSION,
			startedAt: new Date(this.#startedAt).toISOString(),
			elapsedMs,
			activeHandles,
			totalHandles: handles.length,
			maxHandles: this.#config.maxHandles,
			maxDepth: this.#session.settings.get("task.maxRecursionDepth") ?? 2,
			maxTotalTokens: this.#config.maxTotalTokens,
			maxCostUsd: this.#config.maxCostUsd,
			maxWallTimeMs: this.#config.maxWallTimeMs,
			usage,
			violations,
		};
	}

	assertCanSpawn(): void {
		const snapshot = this.snapshot();
		if (snapshot.totalHandles >= snapshot.maxHandles) {
			throw new Error(`recursive agent spawn blocked: retained handle limit reached (${snapshot.maxHandles})`);
		}
		if (snapshot.violations.length > 0) {
			throw new Error(`recursive agent spawn blocked: ${snapshot.violations.join("; ")}`);
		}
	}
}
