import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { SessionEntry } from "../session/session-entries";
import type { ToolSession } from "../tools";
import type { RecursiveControlConfig } from "./config";
import type {
	RecursiveBudgetSnapshot,
	RecursiveUsageNode,
	RecursiveUsageTotals,
	RetainedAgentHandle,
} from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";

const ZERO_USAGE: RecursiveUsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	requests: 0,
	tools: 0,
	durationMs: 0,
};

function addUsage(left: RecursiveUsageTotals, right: RecursiveUsageTotals): RecursiveUsageTotals {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: left.cost + right.cost,
		requests: left.requests + right.requests,
		tools: left.tools + right.tools,
		durationMs: left.durationMs + right.durationMs,
	};
}

function subtractUsage(total: RecursiveUsageTotals, descendants: RecursiveUsageTotals): RecursiveUsageTotals {
	return {
		input: Math.max(0, total.input - descendants.input),
		output: Math.max(0, total.output - descendants.output),
		cacheRead: Math.max(0, total.cacheRead - descendants.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - descendants.cacheWrite),
		totalTokens: Math.max(0, total.totalTokens - descendants.totalTokens),
		cost: Math.max(0, total.cost - descendants.cost),
		requests: Math.max(0, total.requests - descendants.requests),
		tools: Math.max(0, total.tools - descendants.tools),
		durationMs: Math.max(0, total.durationMs - descendants.durationMs),
	};
}

interface UsageBasis {
	usage: RecursiveUsageTotals;
	includesDescendants: boolean;
}

function ownUsageFromEntries(entries: readonly SessionEntry[]): RecursiveUsageTotals {
	let result = ZERO_USAGE;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		const tools = entry.message.content.filter(block => block.type === "toolCall").length;
		result = addUsage(result, {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: usage.cost.total,
			requests: 1,
			tools,
			durationMs: 0,
		});
	}
	return result;
}

function directSessionUsage(
	sessionManager: ToolSession["sessionManager"] | undefined,
): RecursiveUsageTotals | undefined {
	if (!sessionManager) return undefined;
	const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries?.();
	return entries ? ownUsageFromEntries(entries) : undefined;
}

function aggregateUsageForRef(ref: AgentRef | undefined, rootSession: ToolSession, rootId: string): UsageBasis {
	if (!ref || ref.id === rootId) {
		const direct = directSessionUsage(rootSession.sessionManager);
		if (direct) return { usage: direct, includesDescendants: false };
		const usage = rootSession.getUsageStatistics?.();
		return {
			includesDescendants: true,
			usage: usage
				? {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						cost: usage.cost,
						requests: 0,
						tools: 0,
						durationMs: 0,
					}
				: ZERO_USAGE,
		};
	}
	const direct = directSessionUsage(ref.session?.sessionManager);
	if (direct) return { usage: direct, includesDescendants: false };
	const liveUsage = ref.session?.sessionManager.getUsageStatistics();
	const metrics = ref.history?.metrics;
	return {
		includesDescendants: true,
		usage: {
			input: liveUsage?.input ?? 0,
			output: liveUsage?.output ?? metrics?.tokens ?? 0,
			cacheRead: liveUsage?.cacheRead ?? 0,
			cacheWrite: liveUsage?.cacheWrite ?? 0,
			totalTokens: liveUsage?.totalTokens ?? metrics?.tokens ?? 0,
			cost: liveUsage?.cost ?? metrics?.cost ?? 0,
			requests: metrics?.requests ?? 0,
			tools: metrics?.tools ?? 0,
			durationMs: metrics?.durationMs ?? 0,
		},
	};
}

function buildUsageTree(
	registry: AgentRegistry | undefined,
	rootSession: ToolSession,
	rootId: string,
): RecursiveUsageNode {
	const refs = registry?.list() ?? [];
	const byParent = new Map<string, AgentRef[]>();
	for (const ref of refs) {
		if (!ref.parentId) continue;
		const children = byParent.get(ref.parentId) ?? [];
		children.push(ref);
		byParent.set(ref.parentId, children);
	}
	const rootRef = refs.find(ref => ref.id === rootId);
	const visit = (id: string, status: string, ref?: AgentRef, seen = new Set<string>()): RecursiveUsageNode => {
		if (seen.has(id)) {
			return {
				agentId: id,
				status: "cycle",
				own: ZERO_USAGE,
				descendants: ZERO_USAGE,
				total: ZERO_USAGE,
				children: [],
			};
		}
		const nextSeen = new Set(seen);
		nextSeen.add(id);
		const children = (byParent.get(id) ?? [])
			.sort((left, right) => left.createdAt - right.createdAt)
			.map(child => visit(child.id, child.status, child, nextSeen));
		const descendants = children.reduce((sum, child) => addUsage(sum, child.total), ZERO_USAGE);
		// SessionManager usage includes task tool-result usage. Child sessions can
		// likewise include their own descendants, so subtract the explicitly
		// reconstructed child tree before reporting this node's own usage.
		const basis = aggregateUsageForRef(ref, rootSession, rootId);
		const own = basis.includesDescendants ? subtractUsage(basis.usage, descendants) : basis.usage;
		return { agentId: id, status, own, descendants, total: addUsage(own, descendants), children };
	};
	return visit(rootId, rootRef?.status ?? "running", rootRef);
}

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
		const usage = buildUsageTree(this.#session.agentRegistry, this.#session, rootId);
		const handles = this.#handles.listHandles();
		const activeHandles = handles.filter(handle =>
			["starting", "running", "idle", "parked"].includes(handle.status),
		).length;
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
