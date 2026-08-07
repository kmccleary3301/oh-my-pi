import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { runRecursiveBridge } from "../../src/recursive-control/bridge";
import {
	disposeRecursiveControlForSettings,
	disposeRecursiveControlRuntime,
} from "../../src/recursive-control/runtime";
import type { ToolSession } from "../../src/tools";
import { getEvalToolDescription } from "../../src/tools/eval";

let roots: string[] = [];
let sessions: ToolSession[] = [];
afterEach(async () => {
	await Promise.all(sessions.map(disposeRecursiveControlRuntime));
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
	sessions = [];
});

async function makeSession(enabled: boolean): Promise<ToolSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recursive-bridge-"));
	roots.push(root);
	const settings = Settings.isolated();
	// Use set() (global layer), not isolated overrides — overrides outrank set(),
	// and the product toggle path (/recursive on|off) also uses settings.set().
	settings.set("recursive.enabled", enabled);
	settings.set("recursive.state.maxBytes", 4096);
	const session: ToolSession = {
		cwd: root,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "bridge-session",
		getAgentId: () => "Main",
		getUsageStatistics: () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
		}),
	};
	sessions.push(session);
	return session;
}

describe("recursive eval bridge", () => {
	test("fails closed while disabled", async () => {
		const session = await makeSession(false);
		await expect(
			runRecursiveBridge({ method: "capabilities", params: {} }, { session, invokeTool: async () => null }),
		).rejects.toThrow("disabled");
	});

	test("removes recursive guidance from the eval prompt while disabled", () => {
		expect(getEvalToolDescription({ py: true, recursive: false })).not.toContain("omp.context");
		expect(getEvalToolDescription({ py: true, recursive: true })).toContain("omp.context");
	});

	test("fails closed after the shared settings authority disables and disposes the runtime", async () => {
		const session = await makeSession(true);
		const options = { session, invokeTool: async () => null };
		await runRecursiveBridge({ method: "capabilities", params: {} }, options);
		session.settings.set("recursive.enabled", false);
		await disposeRecursiveControlForSettings(session.settings);
		await expect(runRecursiveBridge({ method: "capabilities", params: {} }, options)).rejects.toThrow("disabled");
	});

	test("dispatches JSON-safe state and native tool calls when enabled", async () => {
		const session = await makeSession(true);
		const options = { session, invokeTool: async (name: string, args: unknown) => ({ name, args }) };
		const capabilities = await runRecursiveBridge({ method: "capabilities", params: {} }, options);
		expect(JSON.stringify(capabilities)).toContain("context.search");
		const stored = await runRecursiveBridge(
			{ method: "state.put", params: { scope: "session", key: "queue", value: ["a", "b"] } },
			options,
		);
		expect(JSON.stringify(stored)).toContain("fingerprint");
		const tool = await runRecursiveBridge(
			{ method: "tools.call", params: { name: "read", args: { path: "README.md" } } },
			options,
		);
		expect(tool).toEqual({ name: "read", args: { path: "README.md" } });
		await expect(
			runRecursiveBridge({ method: "tools.call", params: { name: "eval", args: { code: "1 + 1" } } }, options),
		).rejects.toThrow("cannot invoke eval");
		const proposal = await runRecursiveBridge(
			{
				method: "improvements.propose",
				params: {
					target: "skill",
					scope: "project",
					baseUri: "skill://reviewer",
					baseFingerprint: "sha256:base",
					patch: { operation: "append", text: "Check cleanup." },
					rationale: "Observed cleanup failures",
					expectedEffect: "Reduce leaked resources",
					evidence: [{ uri: "history://Reviewer", label: "review" }],
					validationPlan: { gates: ["tests"], holdouts: ["cleanup-holdout"] },
				},
			},
			options,
		);
		expect(JSON.stringify(proposal)).toContain("cleanup-holdout");
	});
});
