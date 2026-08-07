import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	type AgentUsageTreeSession,
	buildAgentUsageTree,
	formatAgentUsageTree,
} from "../../src/registry/agent-usage-tree";

/** Root session whose statistics already fold in every descendant, as real sessions do. */
function rootSessionWithTotals(totalTokens: number, cost: number): AgentUsageTreeSession {
	return {
		getUsageStatistics: () => ({
			input: 0,
			output: totalTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost,
			premiumRequests: 0,
		}),
	};
}

function registerPersisted(
	registry: AgentRegistry,
	id: string,
	parentId: string | undefined,
	tokens: number,
	cost: number,
): void {
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		...(parentId ? { parentId } : {}),
		session: null,
		status: "idle",
		history: { metrics: { tokens, requests: 1, tools: 0, cost, durationMs: 0 } },
	});
}

describe("agent usage tree", () => {
	test("reconciles root own, descendants, and total against the full lineage", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "Child", "Main", 300, 3);
		registerPersisted(registry, "Grandchild", "Child", 100, 1);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(1000, 10), "Main");

		expect(tree.total.totalTokens).toBe(1000);
		expect(tree.descendants.totalTokens).toBe(300);
		expect(tree.own.totalTokens).toBe(700);
		expect(tree.total.cost).toBeCloseTo(10, 6);
		expect(tree.descendants.cost).toBeCloseTo(3, 6);
		// own + descendants must equal total at every node, not just the root.
		expect(tree.own.totalTokens + tree.descendants.totalTokens).toBe(tree.total.totalTokens);
	});

	test("materializes grandchildren as nested nodes rather than flattening them", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "Child", "Main", 300, 3);
		registerPersisted(registry, "Grandchild", "Child", 100, 1);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(1000, 10), "Main");
		const child = tree.children.find(node => node.agentId === "Child");

		// A depth-1-only walk would leave Child childless and lose the grandchild entirely.
		expect(tree.children.map(node => node.agentId)).toEqual(["Child"]);
		expect(child?.children.map(node => node.agentId)).toEqual(["Grandchild"]);
		expect(child?.children[0]?.total.totalTokens).toBe(100);
	});

	test("subtracts an already-counted child subtree from the parent's own usage", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "Child", "Main", 300, 3);
		registerPersisted(registry, "Grandchild", "Child", 100, 1);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(1000, 10), "Main");
		const child = tree.children.find(node => node.agentId === "Child");

		// Child's persisted metrics (300) already include the grandchild (100).
		expect(child?.own.totalTokens).toBe(200);
		expect(child?.descendants.totalTokens).toBe(100);
		expect(child?.total.totalTokens).toBe(300);
	});

	test("counts descendants at every depth, not just direct children", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "Child", "Main", 300, 3);
		registerPersisted(registry, "Grandchild", "Child", 100, 1);
		registerPersisted(registry, "Sibling", "Main", 50, 0.5);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(1000, 10), "Main");

		expect(tree.descendantCount).toBe(3);
		expect(tree.children).toHaveLength(2);
	});

	test("own usage never goes negative when sources disagree", () => {
		const registry = new AgentRegistry();
		// Child reports more than the root aggregate, which can happen transiently.
		registerPersisted(registry, "Child", "Main", 900, 9);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(100, 1), "Main");

		expect(tree.own.totalTokens).toBe(0);
		expect(tree.own.cost).toBe(0);
	});

	test("terminates on a parent cycle instead of recursing forever", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "A", "B", 10, 0.1);
		registerPersisted(registry, "B", "A", 10, 0.1);

		const tree = buildAgentUsageTree(registry, rootSessionWithTotals(100, 1), "A");
		const flatten = (node: typeof tree): string[] => [node.status, ...node.children.flatMap(child => flatten(child))];

		expect(flatten(tree)).toContain("cycle");
	});

	test("reports a root with no descendants as a leaf", () => {
		const tree = buildAgentUsageTree(new AgentRegistry(), rootSessionWithTotals(500, 5), "Main");

		expect(tree.descendantCount).toBe(0);
		expect(tree.descendants.totalTokens).toBe(0);
		expect(tree.own.totalTokens).toBe(500);
		expect(tree.total.totalTokens).toBe(500);
	});

	test("formats nested agents with one indent level per depth", () => {
		const registry = new AgentRegistry();
		registerPersisted(registry, "Child", "Main", 300, 3);
		registerPersisted(registry, "Grandchild", "Child", 100, 1);

		const lines = formatAgentUsageTree(buildAgentUsageTree(registry, rootSessionWithTotals(1000, 10), "Main"));

		expect(lines).toHaveLength(3);
		expect(lines[0]?.startsWith(" ")).toBe(false);
		expect(lines[1]?.startsWith("  Child")).toBe(true);
		expect(lines[2]?.startsWith("    Grandchild")).toBe(true);
	});
});
