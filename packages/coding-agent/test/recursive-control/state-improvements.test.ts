import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ImprovementLedger } from "../../src/recursive-control/improvement-ledger";
import { RecursiveStateStore } from "../../src/recursive-control/state-store";
import type { ToolSession } from "../../src/tools";

let roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
});

async function fixture(): Promise<{ root: string; session: ToolSession }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recursive-state-"));
	roots.push(root);
	return {
		root,
		session: {
			cwd: path.join(root, "repo"),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "session-fixture",
			getAgentId: () => "Main",
		},
	};
}

describe("recursive state and Improvement Ledger", () => {
	test("persists JSON state with fingerprints and compare-and-swap", async () => {
		const { root, session } = await fixture();
		const store = new RecursiveStateStore(session, { maxValueBytes: 128, rootDir: root });
		const first = await store.put("session", "remaining", ["a.ts", "b.ts"]);
		expect((await store.get("session", "remaining"))?.fingerprint).toBe(first.fingerprint);
		await expect(store.put("session", "remaining", ["b.ts"], { expectedFingerprint: "wrong" })).rejects.toThrow(
			"conflict",
		);
		const second = await store.put("session", "remaining", ["b.ts"], { expectedFingerprint: first.fingerprint });
		expect(second.fingerprint).not.toBe(first.fingerprint);
		expect(await store.export("session")).toEqual({ remaining: ["b.ts"] });
		await expect(store.delete("session", "missing", { expectedFingerprint: first.fingerprint })).rejects.toThrow(
			"current missing",
		);
		await expect(store.put("project", "too-large", "x".repeat(500))).rejects.toThrow("maximum");
	});

	test("records proposal revisions, guarded transitions, and measured outcomes", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const proposal = await ledger.propose({
			target: "skill",
			scope: "project",
			baseUri: "skill://reviewer",
			baseFingerprint: "sha256:base",
			patch: { operation: "append", text: "Verify cleanup." },
			rationale: "Repeated cleanup regressions",
			expectedEffect: "Reduce leaked resources",
			evidence: [{ uri: "history://Reviewer" }],
		});
		const previewed = await ledger.transition(proposal.id, "previewed", proposal.revision);
		await expect(ledger.transition(proposal.id, "promoted", previewed.revision)).rejects.toThrow("Invalid");
		const validating = await ledger.transition(proposal.id, "validating", previewed.revision);
		await expect(ledger.transition(proposal.id, "applied-project", validating.revision)).rejects.toThrow(
			"promote outcome",
		);
		const outcome = await ledger.recordOutcome(
			{
				proposalId: proposal.id,
				baselineRuns: ["run-base"],
				candidateRuns: ["run-candidate"],
				metrics: { successDelta: 0.2, costDeltaUsd: 0.1 },
				recommendation: "promote",
			},
			validating.revision,
		);
		expect(outcome.recommendation).toBe("promote");
		expect(await ledger.outcomes(proposal.id)).toHaveLength(1);
		const refreshed = await ledger.get(proposal.id);
		expect(refreshed).not.toBeNull();
		const applied = await ledger.transition(proposal.id, "applied-project", refreshed!.revision);
		expect(applied.status).toBe("applied-project");
	});

	test("rejects outcomes before validation and non-finite metrics", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const proposal = await ledger.propose({
			target: "rule",
			scope: "session",
			baseUri: "rule://cleanup",
			baseFingerprint: "sha256:base",
			patch: { operation: "replace" },
			rationale: "Test lifecycle",
			expectedEffect: "No-op fixture",
		});
		const input = {
			proposalId: proposal.id,
			baselineRuns: ["base"],
			candidateRuns: ["candidate"],
			metrics: { successDelta: Number.NaN },
			recommendation: "collect-more-data" as const,
		};
		await expect(ledger.recordOutcome(input, proposal.revision)).rejects.toThrow("status is proposed");
		const validating = await ledger.transition(proposal.id, "validating", proposal.revision);
		await expect(ledger.recordOutcome(input, validating.revision)).rejects.toThrow("finite");
	});
});
