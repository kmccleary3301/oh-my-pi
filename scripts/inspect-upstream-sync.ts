import * as path from "node:path";

export const UPSTREAM_ORACLE_COMMIT = "7b141199d524b859c357fc89654f10b62b9f3df1";
export const DEFAULT_UPSTREAM_REF = UPSTREAM_ORACLE_COMMIT;
export const POLICY_PATH = path.join(import.meta.dir, "p31", "upstream-sync-policy.json");

export const SYNC_CLASSES = ["breadboard-owned", "upstream-owned", "generated", "manual-review"] as const;

export type SyncClass = (typeof SYNC_CLASSES)[number];
export type ChangeSide = "upstream" | "candidate";

export interface PolicyRule {
	id: string;
	class: SyncClass;
	description: string;
	patterns: string[];
	fallback?: boolean;
}

export interface SyncPolicy {
	schemaVersion: string;
	classes: SyncClass[];
	rules: PolicyRule[];
}

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

export interface ClassifiedPath {
	path: string;
	sides: ChangeSide[];
	class: SyncClass;
	rule: string;
}

export interface UpstreamSyncInspection {
	schemaVersion: "p31.upstream-sync-inspection.v1";
	mode: "read-only";
	upstreamRef: string;
	commits: {
		upstream: string;
		head: string;
		base: string | null;
		mergeBase: string | null;
	};
	ancestry: {
		relation: "same" | "upstream-ancestor" | "head-ancestor" | "diverged" | "unrelated";
		upstreamIsAncestorOfHead: boolean;
		headIsAncestorOfUpstream: boolean;
	};
	changedPaths: {
		upstream: string[];
		candidate: string[];
	};
	paths: ClassifiedPath[];
	unresolvedPaths: string[];
	manualReviewPaths: string[];
	summary: {
		pathCount: number;
		byClass: Record<SyncClass, number>;
	};
}

export interface InspectOptions {
	upstreamRef?: string;
	repoRoot?: string;
	git?: GitRunner;
	policy?: SyncPolicy;
	policyPath?: string;
}

const SCHEMA_VERSION = "p31.upstream-sync-inspection.v1" as const;
const MANUAL_REVIEW_RULE = "manual-review-unknown";

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:.*/)?";
					index += 2;
				} else {
					source += ".*";
					index++;
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			continue;
		}
		source += /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character;
	}
	return new RegExp(`${source}$`);
}

function normalizePath(rawPath: string): string {
	return rawPath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

export function matchesPolicyPattern(filePath: string, pattern: string): boolean {
	return globToRegExp(normalizePath(pattern)).test(normalizePath(filePath));
}

function validatePolicy(policy: SyncPolicy): void {
	if (!Array.isArray(policy.classes) || !Array.isArray(policy.rules) || policy.rules.length === 0) {
		throw new Error("sync policy must contain classes and ordered rules");
	}
	for (const expectedClass of SYNC_CLASSES) {
		if (!policy.classes.includes(expectedClass)) {
			throw new Error(`sync policy is missing class ${expectedClass}`);
		}
	}
	for (const rule of policy.rules) {
		if (!SYNC_CLASSES.includes(rule.class) || !Array.isArray(rule.patterns) || rule.patterns.length === 0) {
			throw new Error(`sync policy rule ${rule.id} is invalid`);
		}
	}
}

export async function loadSyncPolicy(policyPath = POLICY_PATH): Promise<SyncPolicy> {
	const policy = (await Bun.file(policyPath).json()) as SyncPolicy;
	validatePolicy(policy);
	return policy;
}

export function classifyPath(filePath: string, policy: SyncPolicy): Omit<ClassifiedPath, "path" | "sides"> {
	const normalizedPath = normalizePath(filePath);
	for (const rule of policy.rules) {
		if (rule.patterns.some(pattern => matchesPolicyPattern(normalizedPath, pattern))) {
			return { class: rule.class, rule: rule.id };
		}
	}
	return { class: "manual-review", rule: MANUAL_REVIEW_RULE };
}

export function createGitRunner(repoRoot = process.cwd()): GitRunner {
	return async (args: readonly string[]): Promise<GitResult> => {
		const process = Bun.spawn(["git", ...args], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			process.stdout ? new Response(process.stdout).text() : Promise.resolve(""),
			process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
			process.exited,
		]);
		return { stdout, stderr, exitCode };
	};
}

class GitCommandError extends Error {
	readonly code = "git-command-failed" as const;

	constructor(
		readonly args: readonly string[],
		readonly exitCode: number,
		operation: string,
	) {
		super(`${operation} failed (git exit ${exitCode})`);
		this.name = "GitCommandError";
	}
}

async function checkedGitText(git: GitRunner, args: readonly string[], operation: string): Promise<string> {
	const result = await git(args);
	if (result.exitCode !== 0) throw new GitCommandError(args, result.exitCode, operation);
	return result.stdout;
}

async function optionalGitText(git: GitRunner, args: readonly string[], operation: string): Promise<string | null> {
	const result = await git(args);
	if (result.exitCode === 0) return result.stdout.trim() || null;
	if (result.exitCode === 1) return null;
	throw new GitCommandError(args, result.exitCode, operation);
}

async function isAncestor(git: GitRunner, ancestor: string, descendant: string): Promise<boolean> {
	const result = await git(["merge-base", "--is-ancestor", ancestor, descendant]);
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new GitCommandError(
		["merge-base", "--is-ancestor", ancestor, descendant],
		result.exitCode,
		"checking ancestry",
	);
}

function parseNameOnlyOutput(output: string): string[] {
	return output
		.split(output.includes("\0") ? "\0" : /\r?\n/)
		.map(normalizePath)
		.filter(filePath => filePath.length > 0);
}

async function diffNames(git: GitRunner, from: string, to: string): Promise<string[]> {
	const output = await checkedGitText(
		git,
		["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, to, "--"],
		"enumerating changed paths",
	);
	return [...new Set(parseNameOnlyOutput(output))].sort(comparePaths);
}

function classifyPaths(
	changedPaths: { upstream: string[]; candidate: string[] },
	policy: SyncPolicy,
): {
	paths: ClassifiedPath[];
	unresolvedPaths: string[];
	manualReviewPaths: string[];
	summary: { pathCount: number; byClass: Record<SyncClass, number> };
} {
	const sidesByPath = new Map<string, Set<ChangeSide>>();
	for (const side of ["upstream", "candidate"] as const) {
		for (const filePath of changedPaths[side]) {
			const normalizedPath = normalizePath(filePath);
			if (!normalizedPath) continue;
			const sides = sidesByPath.get(normalizedPath) ?? new Set<ChangeSide>();
			sides.add(side);
			sidesByPath.set(normalizedPath, sides);
		}
	}

	const paths = [...sidesByPath.keys()].sort(comparePaths).map(filePath => {
		const classification = classifyPath(filePath, policy);
		const sides = ["upstream", "candidate"].filter(side =>
			sidesByPath.get(filePath)?.has(side as ChangeSide),
		) as ChangeSide[];
		return { path: filePath, sides, ...classification };
	});
	const byClass = Object.fromEntries(SYNC_CLASSES.map(syncClass => [syncClass, 0])) as Record<SyncClass, number>;
	for (const entry of paths) byClass[entry.class]++;
	const unresolvedPaths = paths
		.filter(entry => entry.rule === MANUAL_REVIEW_RULE)
		.map(entry => entry.path)
		.sort(comparePaths);
	const manualReviewPaths = paths
		.filter(entry => entry.class === "manual-review")
		.map(entry => entry.path)
		.sort(comparePaths);
	return {
		paths,
		unresolvedPaths,
		manualReviewPaths,
		summary: { pathCount: paths.length, byClass },
	};
}

function relationFor(
	upstream: string,
	head: string,
	mergeBase: string | null,
	upstreamIsAncestorOfHead: boolean,
	headIsAncestorOfUpstream: boolean,
): UpstreamSyncInspection["ancestry"]["relation"] {
	if (upstream === head) return "same";
	if (upstreamIsAncestorOfHead) return "upstream-ancestor";
	if (headIsAncestorOfUpstream) return "head-ancestor";
	return mergeBase ? "diverged" : "unrelated";
}

export async function inspectUpstreamSync(options: InspectOptions = {}): Promise<UpstreamSyncInspection> {
	const upstreamRef = options.upstreamRef ?? DEFAULT_UPSTREAM_REF;
	if (upstreamRef.trim().length === 0) throw new Error("upstream ref must not be empty");
	const git = options.git ?? createGitRunner(options.repoRoot);
	const policy = options.policy ?? (await loadSyncPolicy(options.policyPath));
	validatePolicy(policy);
	const upstream = (
		await checkedGitText(
			git,
			["rev-parse", "--verify", "--end-of-options", `${upstreamRef}^{commit}`],
			"resolving upstream ref",
		)
	).trim();
	const head = (await checkedGitText(git, ["rev-parse", "--verify", "HEAD^{commit}"], "resolving HEAD")).trim();
	const mergeBase = await optionalGitText(git, ["merge-base", upstream, head], "computing merge base");
	const upstreamIsAncestorOfHead = await isAncestor(git, upstream, head);
	const headIsAncestorOfUpstream = await isAncestor(git, head, upstream);

	const changedPaths = mergeBase
		? {
				upstream: await diffNames(git, mergeBase, upstream),
				candidate: await diffNames(git, mergeBase, head),
			}
		: {
				upstream: [],
				candidate: await diffNames(git, upstream, head),
			};
	const classified = classifyPaths(changedPaths, policy);
	return {
		schemaVersion: SCHEMA_VERSION,
		mode: "read-only",
		upstreamRef,
		commits: {
			upstream,
			head,
			base: mergeBase,
			mergeBase,
		},
		ancestry: {
			relation: relationFor(upstream, head, mergeBase, upstreamIsAncestorOfHead, headIsAncestorOfUpstream),
			upstreamIsAncestorOfHead,
			headIsAncestorOfUpstream,
		},
		changedPaths,
		...classified,
	};
}

function parseArgs(argv: readonly string[]): { upstreamRef: string } {
	let upstreamRef: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			console.log("Usage: bun scripts/inspect-upstream-sync.ts [--ref <upstream-ref>]");
			console.log(`Default upstream ref: ${DEFAULT_UPSTREAM_REF}`);
			process.exit(0);
		}
		if (argument === "--ref") {
			upstreamRef = argv[++index];
			if (!upstreamRef) throw new Error("--ref requires an upstream ref");
			continue;
		}
		if (argument?.startsWith("--ref=")) {
			upstreamRef = argument.slice("--ref=".length);
			if (!upstreamRef) throw new Error("--ref requires an upstream ref");
			continue;
		}
		if (argument?.startsWith("-")) throw new Error(`unknown option ${argument}`);
		if (upstreamRef) throw new Error("only one upstream ref may be supplied");
		upstreamRef = argument;
	}
	return { upstreamRef: upstreamRef ?? DEFAULT_UPSTREAM_REF };
}

function errorPayload(error: unknown): {
	schemaVersion: typeof SCHEMA_VERSION;
	mode: "read-only";
	error: { code: string; message: string };
} {
	if (error instanceof GitCommandError) {
		return { schemaVersion: SCHEMA_VERSION, mode: "read-only", error: { code: error.code, message: error.message } };
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		mode: "read-only",
		error: { code: "inspection-failed", message: error instanceof Error ? error.message : String(error) },
	};
}

if (import.meta.main) {
	try {
		const { upstreamRef } = parseArgs(process.argv.slice(2));
		const result = await inspectUpstreamSync({ upstreamRef });
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(JSON.stringify(errorPayload(error), null, 2));
		process.exitCode = 1;
	}
}
