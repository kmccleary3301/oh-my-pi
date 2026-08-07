import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ImprovementProposal, ImprovementScope } from "../../src/recursive-control/contracts";
import { ImprovementLedger } from "../../src/recursive-control/improvement-ledger";
import type { ToolSession } from "../../src/tools";

let roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
});

async function fixture(): Promise<{ root: string; session: ToolSession }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recursive-promo-"));
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

const ROLLBACK = { uri: "file:///rollback.patch", fingerprint: "rb-1" };

async function proposal(ledger: ImprovementLedger, scope: ImprovementScope = "project"): Promise<ImprovementProposal> {
	return await ledger.propose({
		target: "skill",
		scope,
		baseUri: "file:///skill.md",
		baseFingerprint: "base-1",
		patch: { add: "line" },
		rationale: "measured gain",
		expectedEffect: "fewer retries",
	});
}

/** Drive a proposal to `validating` with a recorded promote outcome. */
async function withPromoteOutcome(ledger: ImprovementLedger, scope: ImprovementScope = "project") {
	let current = await proposal(ledger, scope);
	current = await ledger.transition(current.id, "validating", current.revision);
	await ledger.recordOutcome(
		{
			proposalId: current.id,
			baselineRuns: ["b1"],
			candidateRuns: ["c1"],
			metrics: { successDelta: 0.4 },
			recommendation: "promote",
		},
		current.revision,
	);
	return (await ledger.get(current.id)) as ImprovementProposal;
}

describe("improvement preview", () => {
	test("lists every blocker standing between a fresh proposal and promotion", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const created = await proposal(ledger);

		const preview = await ledger.preview(created.id, "base-1");

		expect(preview.stale).toBe(false);
		expect(preview.outcomes).toEqual([]);
		expect(preview.blockers).toEqual([
			"no recorded outcome recommends promote",
			"no independent reviewer or rollback artifact recorded",
		]);
	});

	test("flags a base that moved after the proposal was written", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const created = await proposal(ledger);

		const preview = await ledger.preview(created.id, "base-2");

		expect(preview.stale).toBe(true);
		expect(preview.blockers[0]).toContain("changed since the proposal was written");
	});

	test("treats an unverified base as a blocker rather than assuming freshness", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const created = await proposal(ledger);

		const preview = await ledger.preview(created.id);

		expect(preview.stale).toBe(false);
		expect(preview.blockers).toContain("base freshness unverified: no current fingerprint supplied");
	});

	test("clears blockers once the proposal is fully backed", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger);
		const promoted = await ledger.transition(observing.id, "applied-project", observing.revision, {
			reviewer: "Reviewer",
			rollback: ROLLBACK,
		});

		const preview = await ledger.preview(promoted.id, "base-1");

		expect(preview.blockers).toEqual([]);
		expect(preview.outcomes).toHaveLength(1);
	});

	test("does not mutate the proposal", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const created = await proposal(ledger);

		await ledger.preview(created.id, "base-2");

		expect((await ledger.get(created.id))?.revision).toBe(created.revision);
		expect((await ledger.get(created.id))?.status).toBe("proposed");
	});
});

describe("measured promotion", () => {
	test("requires a reviewer and a rollback artifact", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger);

		await expect(ledger.transition(observing.id, "applied-project", observing.revision)).rejects.toThrow(
			"reviewer and a rollback artifact",
		);
	});

	test("refuses self-promotion by the proposal author", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger);

		await expect(
			ledger.transition(observing.id, "applied-project", observing.revision, {
				reviewer: "Main",
				rollback: ROLLBACK,
			}),
		).rejects.toThrow("must differ from the proposal author");
	});

	test("refuses a rollback artifact with a blank fingerprint", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger);

		await expect(
			ledger.transition(observing.id, "applied-project", observing.revision, {
				reviewer: "Reviewer",
				rollback: { uri: "file:///rollback.patch", fingerprint: "  " },
			}),
		).rejects.toThrow("promotion.rollback.fingerprint");
	});

	test("refuses to widen a session-scoped proposal to project scope", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger, "session");

		await expect(
			ledger.transition(observing.id, "applied-project", observing.revision, {
				reviewer: "Reviewer",
				rollback: ROLLBACK,
			}),
		).rejects.toThrow("requires project or user scope");
	});

	test("records the reviewer and rollback on a valid promotion", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		const observing = await withPromoteOutcome(ledger);

		const promoted = await ledger.transition(observing.id, "applied-project", observing.revision, {
			reviewer: "Reviewer",
			rollback: ROLLBACK,
			note: "two-week soak",
		});

		expect(promoted.status).toBe("applied-project");
		expect(promoted.promotion?.reviewer).toBe("Reviewer");
		expect(promoted.promotion?.rollback).toEqual(ROLLBACK);
		expect(promoted.promotion?.note).toBe("two-week soak");
		expect(promoted.promotion?.at).toBeTruthy();
	});

	test("still requires a promote outcome regardless of reviewer and rollback", async () => {
		const { root, session } = await fixture();
		const ledger = new ImprovementLedger(session, { rootDir: root });
		let current = await proposal(ledger);
		current = await ledger.transition(current.id, "validating", current.revision);
		await ledger.recordOutcome(
			{
				proposalId: current.id,
				baselineRuns: ["b1"],
				candidateRuns: ["c1"],
				metrics: { successDelta: 0 },
				recommendation: "collect-more-data",
			},
			current.revision,
		);
		current = (await ledger.get(current.id)) as ImprovementProposal;
		await expect(
			ledger.transition(current.id, "applied-project", current.revision, {
				reviewer: "Reviewer",
				rollback: ROLLBACK,
			}),
		).rejects.toThrow("requires a recorded promote outcome");
	});
});
