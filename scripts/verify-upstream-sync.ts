#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	type ClassifiedPath,
	classifyPath,
	inspectUpstreamSync,
	loadSyncPolicy,
	type SyncPolicy,
	UPSTREAM_ORACLE_COMMIT,
	type UpstreamSyncInspection,
} from "./inspect-upstream-sync";

export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandRunner = (command: readonly string[], cwd: string) => Promise<CommandResult>;

export interface ProofCommandReceipt {
	readonly command: readonly string[];
	readonly exitCode: number;
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	readonly stdoutSha256: string;
	readonly stderrSha256: string;
}

export interface UpstreamSyncVerification {
	readonly schemaVersion: "p31.upstream-sync-verification.v1";
	readonly mode: "disposable-worktree-rebase";
	readonly status: "pass" | "conflict" | "proof-failed";
	readonly commits: {
		readonly upstream: string;
		readonly candidateBefore: string;
		readonly candidateAfter: string | null;
		readonly treeAfter: string | null;
	};
	readonly rebaseExitCode: number;
	readonly conflicts: readonly ClassifiedPath[];
	readonly unresolvedPaths: readonly string[];
	readonly inspectionPathCount: number;
	readonly proofReceipts: readonly ProofCommandReceipt[];
}

export interface VerifyUpstreamSyncOptions {
	readonly repoRoot?: string;
	readonly upstreamRef?: string;
	readonly candidateRef?: string;
	readonly proofCommands?: readonly (readonly string[])[];
	readonly run?: CommandRunner;
	readonly createTempRoot?: () => Promise<string>;
	readonly policy?: SyncPolicy;
	readonly inspect?: (
		repoRoot: string,
		upstreamRef: string,
		policy: SyncPolicy,
	) => Promise<Pick<UpstreamSyncInspection, "unresolvedPaths" | "summary">>;
	readonly linkNodeModules?: boolean;
}

const DEFAULT_PROOF_COMMANDS: readonly (readonly string[])[] = [
	[
		"bun",
		"test",
		"scripts/inspect-upstream-sync.test.ts",
		"scripts/verify-upstream-sync.test.ts",
		"scripts/generate-third-party-notices.test.ts",
		"scripts/source-identity-generators.test.ts",
	],
	[
		"bun",
		"test",
		"packages/coding-agent/src/breadboard/canonical-e4-session-port.test.ts",
		"packages/coding-agent/src/breadboard/e4-agent-stream.test.ts",
		"packages/coding-agent/src/breadboard/engine-port.test.ts",
		"packages/coding-agent/test/breadboard-native-authority.test.ts",
	],
];

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function createCommandRunner(): CommandRunner {
	return async (command, cwd) => {
		const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	};
}

async function checkedText(run: CommandRunner, command: readonly string[], cwd: string): Promise<string> {
	const result = await run(command, cwd);
	if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit ${result.exitCode}`);
	return result.stdout.trim();
}

function proofReceipt(command: readonly string[], result: CommandResult): ProofCommandReceipt {
	return {
		command: [...command],
		exitCode: result.exitCode,
		stdoutBytes: Buffer.byteLength(result.stdout),
		stderrBytes: Buffer.byteLength(result.stderr),
		stdoutSha256: sha256(result.stdout),
		stderrSha256: sha256(result.stderr),
	};
}

export async function verifyUpstreamSync(options: VerifyUpstreamSyncOptions = {}): Promise<UpstreamSyncVerification> {
	const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
	const upstreamRef = options.upstreamRef ?? UPSTREAM_ORACLE_COMMIT;
	const candidateRef = options.candidateRef ?? "HEAD";
	const run = options.run ?? createCommandRunner();
	const policy = options.policy ?? (await loadSyncPolicy());
	const createTempRoot = options.createTempRoot ?? (() => mkdtemp(path.join(tmpdir(), "p31-upstream-sync-")));
	const inspect =
		options.inspect ??
		((worktreeRoot: string, ref: string, syncPolicy: SyncPolicy) =>
			inspectUpstreamSync({ repoRoot: worktreeRoot, upstreamRef: ref, policy: syncPolicy }));
	const proofCommands = options.proofCommands ?? DEFAULT_PROOF_COMMANDS;
	const upstream = await checkedText(run, ["git", "rev-parse", "--verify", `${upstreamRef}^{commit}`], repoRoot);
	const candidateBefore = await checkedText(
		run,
		["git", "rev-parse", "--verify", `${candidateRef}^{commit}`],
		repoRoot,
	);
	const tempRoot = await createTempRoot();
	const worktree = path.join(tempRoot, "candidate");
	let worktreeAdded = false;

	try {
		const added = await run(["git", "worktree", "add", "--detach", worktree, candidateBefore], repoRoot);
		if (added.exitCode !== 0) throw new Error(`git worktree add failed with exit ${added.exitCode}`);
		worktreeAdded = true;
		const rebased = await run(["git", "rebase", upstream], worktree);
		if (rebased.exitCode !== 0) {
			const conflictOutput = await run(["git", "diff", "--name-only", "--diff-filter=U", "-z"], worktree);
			const conflictPaths = conflictOutput.stdout
				.split("\0")
				.filter(value => value.length > 0)
				.sort();
			const conflicts = conflictPaths.map(filePath => ({
				path: filePath,
				sides: ["upstream", "candidate"] as const,
				...classifyPath(filePath, policy),
			}));
			await run(["git", "rebase", "--abort"], worktree);
			return {
				schemaVersion: "p31.upstream-sync-verification.v1",
				mode: "disposable-worktree-rebase",
				status: "conflict",
				commits: { upstream, candidateBefore, candidateAfter: null, treeAfter: null },
				rebaseExitCode: rebased.exitCode,
				conflicts,
				unresolvedPaths: conflicts.filter(item => item.rule === "manual-review-unknown").map(item => item.path),
				inspectionPathCount: 0,
				proofReceipts: [],
			};
		}

		const candidateAfter = await checkedText(run, ["git", "rev-parse", "HEAD^{commit}"], worktree);
		const treeAfter = await checkedText(run, ["git", "rev-parse", "HEAD^{tree}"], worktree);
		const inspection = await inspect(worktree, upstreamRef, policy);
		if (
			options.linkNodeModules !== false &&
			(await Bun.file(path.join(repoRoot, "node_modules", "typescript", "package.json")).exists())
		) {
			await symlink(path.join(repoRoot, "node_modules"), path.join(worktree, "node_modules"), "dir");
		}

		const proofReceipts: ProofCommandReceipt[] = [];
		for (const command of proofCommands) {
			const result = await run(command, worktree);
			proofReceipts.push(proofReceipt(command, result));
			if (result.exitCode !== 0) {
				return {
					schemaVersion: "p31.upstream-sync-verification.v1",
					mode: "disposable-worktree-rebase",
					status: "proof-failed",
					commits: { upstream, candidateBefore, candidateAfter, treeAfter },
					rebaseExitCode: rebased.exitCode,
					conflicts: [],
					unresolvedPaths: inspection.unresolvedPaths,
					inspectionPathCount: inspection.summary.pathCount,
					proofReceipts,
				};
			}
		}
		return {
			schemaVersion: "p31.upstream-sync-verification.v1",
			mode: "disposable-worktree-rebase",
			status: inspection.unresolvedPaths.length === 0 ? "pass" : "conflict",
			commits: { upstream, candidateBefore, candidateAfter, treeAfter },
			rebaseExitCode: rebased.exitCode,
			conflicts: [],
			unresolvedPaths: inspection.unresolvedPaths,
			inspectionPathCount: inspection.summary.pathCount,
			proofReceipts,
		};
	} finally {
		if (worktreeAdded) await run(["git", "worktree", "remove", "--force", worktree], repoRoot);
		await rm(tempRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const result = await verifyUpstreamSync();
		console.log(JSON.stringify(result, null, 2));
		if (result.status !== "pass") process.exitCode = 1;
	} catch (error) {
		console.error(
			JSON.stringify({
				schemaVersion: "p31.upstream-sync-verification.v1",
				mode: "disposable-worktree-rebase",
				status: "proof-failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exitCode = 1;
	}
}
