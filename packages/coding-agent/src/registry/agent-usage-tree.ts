import type { SessionEntry } from "../session/session-entries";
import type { AgentKind, AgentRef, AgentRegistry } from "./agent-registry";

/**
 * Cumulative totals for a single agent or for an agent subtree.
 *
 * `cost` is provider-reported spend. For subscription-backed providers it is a
 * catalog-equivalent estimate, not an amount billed; `premiumRequests` is the
 * separate subscription meter. Never present either as money charged.
 */
export interface AgentUsageTotals {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	premiumRequests: number;
	requests: number;
	tools: number;
	durationMs: number;
}

/**
 * One node of the agent lineage usage tree.
 *
 * `own` is this agent's spend with every descendant removed, `descendants` is
 * the summed subtree beneath it, and `total` is the two combined. Root token
 * counts alone understate a recursive run, so callers that report cost should
 * prefer `total`.
 */
export interface AgentUsageNode {
	agentId: string;
	displayName?: string;
	kind?: AgentKind;
	/** Last resolved model for this agent, when the registry recorded one. */
	model?: string;
	status: string;
	own: AgentUsageTotals;
	descendants: AgentUsageTotals;
	total: AgentUsageTotals;
	/** Number of agents beneath this node, at any depth. */
	descendantCount: number;
	children: AgentUsageNode[];
}

/** Minimal session surface the tree builder reads; both `ToolSession` and `AgentSession` satisfy it. */
export interface AgentUsageTreeSession {
	sessionManager?: {
		getBranch?: () => readonly SessionEntry[];
		getEntries?: () => readonly SessionEntry[];
	};
	getUsageStatistics?: () => {
		input: number;
		output: number;
		reasoning?: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
		premiumRequests?: number;
	};
}

export const ZERO_AGENT_USAGE: AgentUsageTotals = {
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	premiumRequests: 0,
	requests: 0,
	tools: 0,
	durationMs: 0,
};

export function addAgentUsage(left: AgentUsageTotals, right: AgentUsageTotals): AgentUsageTotals {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		reasoning: left.reasoning + right.reasoning,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: left.cost + right.cost,
		premiumRequests: left.premiumRequests + right.premiumRequests,
		requests: left.requests + right.requests,
		tools: left.tools + right.tools,
		durationMs: left.durationMs + right.durationMs,
	};
}

/**
 * Remove an already-counted descendant subtree from an aggregate.
 *
 * Session-level statistics fold task tool-result usage into the parent, so a
 * node whose basis already includes children must have the reconstructed child
 * tree subtracted before it can be reported as `own`. Clamped at zero because
 * the two sources are sampled independently and can disagree transiently.
 */
export function subtractAgentUsage(total: AgentUsageTotals, descendants: AgentUsageTotals): AgentUsageTotals {
	const clamp = (value: number): number => (value > 0 ? value : 0);
	return {
		input: clamp(total.input - descendants.input),
		output: clamp(total.output - descendants.output),
		reasoning: clamp(total.reasoning - descendants.reasoning),
		cacheRead: clamp(total.cacheRead - descendants.cacheRead),
		cacheWrite: clamp(total.cacheWrite - descendants.cacheWrite),
		totalTokens: clamp(total.totalTokens - descendants.totalTokens),
		cost: clamp(total.cost - descendants.cost),
		premiumRequests: clamp(total.premiumRequests - descendants.premiumRequests),
		requests: clamp(total.requests - descendants.requests),
		tools: clamp(total.tools - descendants.tools),
		durationMs: clamp(total.durationMs - descendants.durationMs),
	};
}

interface UsageBasis {
	usage: AgentUsageTotals;
	includesDescendants: boolean;
}

function ownUsageFromEntries(entries: readonly SessionEntry[]): AgentUsageTotals {
	let result = ZERO_AGENT_USAGE;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		const tools = entry.message.content.filter(block => block.type === "toolCall").length;
		result = addAgentUsage(result, {
			input: usage.input,
			output: usage.output,
			reasoning: usage.reasoningTokens ?? 0,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: usage.cost.total,
			premiumRequests: usage.premiumRequests ?? 0,
			requests: 1,
			tools,
			durationMs: 0,
		});
	}
	return result;
}

function directSessionUsage(sessionManager: AgentUsageTreeSession["sessionManager"]): AgentUsageTotals | undefined {
	if (!sessionManager) return undefined;
	const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries?.();
	return entries ? ownUsageFromEntries(entries) : undefined;
}

function aggregateUsageForRef(
	ref: AgentRef | undefined,
	rootSession: AgentUsageTreeSession,
	rootId: string,
): UsageBasis {
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
						reasoning: usage.reasoning ?? 0,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						cost: usage.cost,
						premiumRequests: usage.premiumRequests ?? 0,
						requests: 0,
						tools: 0,
						durationMs: 0,
					}
				: ZERO_AGENT_USAGE,
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
			// Neither UsageStatistics nor persisted AgentMetricsSummary carries reasoning
			// tokens; only the per-entry path above can report them.
			reasoning: 0,
			cacheRead: liveUsage?.cacheRead ?? 0,
			cacheWrite: liveUsage?.cacheWrite ?? 0,
			totalTokens: liveUsage?.totalTokens ?? metrics?.tokens ?? 0,
			cost: liveUsage?.cost ?? metrics?.cost ?? 0,
			premiumRequests: liveUsage?.premiumRequests ?? 0,
			requests: metrics?.requests ?? 0,
			tools: metrics?.tools ?? 0,
			durationMs: metrics?.durationMs ?? 0,
		},
	};
}

/**
 * Reconstruct the own/descendant/total usage tree rooted at `rootId` by walking
 * Agent Registry lineage.
 *
 * This is the only complete transitive rollup available: session statistics fold
 * in direct task results but never a grandchild's spend.
 */
export function buildAgentUsageTree(
	registry: AgentRegistry | undefined,
	rootSession: AgentUsageTreeSession,
	rootId: string,
): AgentUsageNode {
	const refs = registry?.list() ?? [];
	const byParent = new Map<string, AgentRef[]>();
	for (const ref of refs) {
		if (!ref.parentId) continue;
		const children = byParent.get(ref.parentId) ?? [];
		children.push(ref);
		byParent.set(ref.parentId, children);
	}
	const rootRef = refs.find(ref => ref.id === rootId);
	const visit = (id: string, status: string, ref?: AgentRef, seen = new Set<string>()): AgentUsageNode => {
		if (seen.has(id)) {
			return {
				agentId: id,
				status: "cycle",
				own: ZERO_AGENT_USAGE,
				descendants: ZERO_AGENT_USAGE,
				total: ZERO_AGENT_USAGE,
				descendantCount: 0,
				children: [],
			};
		}
		const nextSeen = new Set(seen);
		nextSeen.add(id);
		const children = (byParent.get(id) ?? [])
			.sort((left, right) => left.createdAt - right.createdAt)
			.map(child => visit(child.id, child.status, child, nextSeen));
		const descendants = children.reduce((sum, child) => addAgentUsage(sum, child.total), ZERO_AGENT_USAGE);
		const descendantCount = children.reduce((sum, child) => sum + 1 + child.descendantCount, 0);
		const basis = aggregateUsageForRef(ref, rootSession, rootId);
		const own = basis.includesDescendants ? subtractAgentUsage(basis.usage, descendants) : basis.usage;
		return {
			agentId: id,
			...(ref?.displayName ? { displayName: ref.displayName } : {}),
			...(ref?.kind ? { kind: ref.kind } : {}),
			...(ref?.history?.resolvedModel ? { model: ref.history.resolvedModel } : {}),
			status,
			own,
			descendants,
			total: addAgentUsage(own, descendants),
			descendantCount,
			children,
		};
	};
	return visit(rootId, rootRef?.status ?? "running", rootRef);
}

/**
 * Render a usage subtree as plain indented lines.
 *
 * Deliberately unthemed so the TUI, ACP/RPC output, and the stats CLI can share
 * one projection instead of each re-deriving lineage.
 */
export function formatAgentUsageTree(node: AgentUsageNode, indent = ""): string[] {
	const label = node.displayName ?? node.agentId;
	const model = node.model ? ` ${node.model}` : "";
	const tokens = node.total.totalTokens.toLocaleString();
	const lines = [`${indent}${label} (${node.status})${model} — ${tokens} tok`];
	for (const child of node.children) {
		lines.push(...formatAgentUsageTree(child, `${indent}  `));
	}
	return lines;
}
