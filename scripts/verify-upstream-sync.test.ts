import { describe, expect, test } from "bun:test";
import type { SyncPolicy } from "./inspect-upstream-sync";
import { type CommandResult, type CommandRunner, verifyUpstreamSync } from "./verify-upstream-sync";

const policy: SyncPolicy = {
	schemaVersion: "p31.upstream-sync-policy.v1",
	classes: ["breadboard-owned", "upstream-owned", "generated", "manual-review"],
	rules: [
		{
			id: "known",
			class: "breadboard-owned",
			description: "known BreadBoard seam",
			patterns: ["packages/coding-agent/src/breadboard/**"],
		},
		{
			id: "manual-review-unknown",
			class: "manual-review",
			description: "fail closed",
			patterns: ["**"],
			fallback: true,
		},
	],
};

function result(exitCode = 0, stdout = "", stderr = ""): CommandResult {
	return { exitCode, stdout, stderr };
}

function fixtureRunner(options: { rebaseExit?: number; proofExit?: number; conflicts?: string } = {}): {
	run: CommandRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const run: CommandRunner = async command => {
		const args = [...command];
		calls.push(args);
		if (args[0] === "git" && args[1] === "rev-parse" && args.at(-1)?.includes("^{commit}")) {
			return result(
				0,
				args.at(-1)?.startsWith("HEAD")
					? "rebased\n"
					: args.at(-1)?.startsWith("candidate")
						? "candidate\n"
						: "upstream\n",
			);
		}
		if (args[0] === "git" && args[1] === "rev-parse" && args.at(-1) === "HEAD^{tree}") return result(0, "tree\n");
		if (args[0] === "git" && args[1] === "worktree") return result();
		if (args[0] === "git" && args[1] === "rebase" && args[2] !== "--abort") return result(options.rebaseExit ?? 0);
		if (args[0] === "git" && args[1] === "rebase" && args[2] === "--abort") return result();
		if (args[0] === "git" && args[1] === "diff") return result(0, options.conflicts ?? "");
		if (args[0] === "proof") return result(options.proofExit ?? 0, "proof output\n", "");
		throw new Error(`unexpected command: ${args.join(" ")}`);
	};
	return { run, calls };
}

const inspect = async () => ({
	unresolvedPaths: [] as string[],
	summary: {
		pathCount: 59,
		byClass: { "breadboard-owned": 30, "upstream-owned": 16, generated: 2, "manual-review": 11 },
	},
});

describe("verifyUpstreamSync", () => {
	test("rebases in a disposable worktree and records redacted proof receipts", async () => {
		const fixture = fixtureRunner();
		const receipt = await verifyUpstreamSync({
			repoRoot: "/repo",
			candidateRef: "candidate",
			policy,
			run: fixture.run,
			inspect,
			proofCommands: [["proof"]],
			createTempRoot: async () => "/tmp/p31-sync-pass",
			linkNodeModules: false,
		});

		expect(receipt.status).toBe("pass");
		expect(receipt.commits).toEqual({
			upstream: "upstream",
			candidateBefore: "candidate",
			candidateAfter: "rebased",
			treeAfter: "tree",
		});
		expect(receipt.proofReceipts).toHaveLength(1);
		expect(receipt.proofReceipts[0]).toMatchObject({ command: ["proof"], exitCode: 0, stdoutBytes: 13 });
		expect(receipt.proofReceipts[0]?.stdoutSha256).toHaveLength(64);
		expect(fixture.calls).toContainEqual(["git", "worktree", "remove", "--force", "/tmp/p31-sync-pass/candidate"]);
	});

	test("fails closed with classified conflict paths and runs no proofs", async () => {
		const fixture = fixtureRunner({
			rebaseExit: 1,
			conflicts: "packages/coding-agent/src/breadboard/engine-port.ts\0 unknown/future.txt \0",
		});
		const receipt = await verifyUpstreamSync({
			repoRoot: "/repo",
			candidateRef: "candidate",
			policy,
			run: fixture.run,
			inspect,
			proofCommands: [["proof"]],
			createTempRoot: async () => "/tmp/p31-sync-conflict",
			linkNodeModules: false,
		});

		expect(receipt.status).toBe("conflict");
		expect(receipt.conflicts.map(item => [item.path, item.class, item.rule])).toEqual([
			[" unknown/future.txt ", "manual-review", "manual-review-unknown"],
			["packages/coding-agent/src/breadboard/engine-port.ts", "breadboard-owned", "known"],
		]);
		expect(receipt.unresolvedPaths).toEqual([" unknown/future.txt "]);
		expect(receipt.proofReceipts).toEqual([]);
		expect(fixture.calls).not.toContainEqual(["proof"]);
	});

	test("reports the first failed proof without exposing raw output", async () => {
		const fixture = fixtureRunner({ proofExit: 7 });
		const receipt = await verifyUpstreamSync({
			repoRoot: "/repo",
			candidateRef: "candidate",
			policy,
			run: fixture.run,
			inspect,
			proofCommands: [["proof"], ["proof"]],
			createTempRoot: async () => "/tmp/p31-sync-proof",
			linkNodeModules: false,
		});

		expect(receipt.status).toBe("proof-failed");
		expect(receipt.proofReceipts).toHaveLength(1);
		expect(receipt.proofReceipts[0]).toMatchObject({ exitCode: 7, stdoutBytes: 13, stderrBytes: 0 });
		expect(JSON.stringify(receipt)).not.toContain("proof output");
	});
});
