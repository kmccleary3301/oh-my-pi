import { describe, expect, it } from "bun:test";
import {
	classifyPath,
	DEFAULT_UPSTREAM_REF,
	type GitResult,
	type GitRunner,
	inspectUpstreamSync,
	loadSyncPolicy,
	type SyncPolicy,
} from "./inspect-upstream-sync";

const V17_COMMIT = "7b141199d524b859c357fc89654f10b62b9f3df1";
const CURRENT_COMMIT = "8954758812a482ea40d1fb3e53a730081b73df66";

interface FixtureGit {
	run: GitRunner;
	calls: string[][];
}

function fixtureGit(policy: SyncPolicy): FixtureGit {
	const calls: string[][] = [];
	const run: GitRunner = async args => {
		const command = [...args];
		calls.push(command);
		if (command[0] === "rev-parse" && command.includes(`${DEFAULT_UPSTREAM_REF}^{commit}`)) {
			return { exitCode: 0, stdout: `${V17_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "rev-parse" && command.includes("HEAD^{commit}")) {
			return { exitCode: 0, stdout: `${CURRENT_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "merge-base" && command[1] === "--is-ancestor") {
			const isUpstreamToHead = command[2] === V17_COMMIT && command[3] === CURRENT_COMMIT;
			return { exitCode: isUpstreamToHead ? 0 : 1, stdout: "", stderr: "" } satisfies GitResult;
		}
		if (command[0] === "merge-base") {
			return { exitCode: 0, stdout: `${V17_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "diff") {
			const commits = command.slice(-3, -1).join("..");
			if (commits === `${V17_COMMIT}..${V17_COMMIT}`) {
				return { exitCode: 0, stdout: "", stderr: "" } satisfies GitResult;
			}
			return {
				exitCode: 0,
				stdout: [
					"packages/coding-agent/src/generated/compiled.generated.ts",
					"unknown/future-boundary.txt",
					"packages/coding-agent/src/breadboard/session-port.ts",
					"unknown/future-boundary.txt",
				].join("\0"),
				stderr: "",
			} satisfies GitResult;
		}
		throw new Error(`unexpected git command for ${policy.schemaVersion}: ${command.join(" ")}`);
	};
	return { run, calls };
}

const policy = await loadSyncPolicy();

describe("upstream sync policy", () => {
	it("uses ordered precedence for authority, generated, and boundary paths", () => {
		expect(classifyPath("packages/coding-agent/src/breadboard/generated/runtime.ts", policy)).toEqual({
			class: "breadboard-owned",
			rule: "breadboard-authority-adapters-provenance",
		});
		expect(classifyPath("packages/coding-agent/src/generated/runtime.generated.ts", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("dist/coding-agent.js", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("build/output.js", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("docs/conformance/p31/e4-canonical-tui-evidence.md", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("packages/coding-agent/package.json", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-boundaries",
		});
		expect(classifyPath("packages/coding-agent/src/cli.ts", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-boundaries",
		});
	});

	it("fails closed for an unknown path", () => {
		expect(classifyPath("future/authority-boundary.txt", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-unknown",
		});
	});
});

describe("upstream sync inspection", () => {
	it("sorts changed paths and classified records deterministically", async () => {
		const fixture = fixtureGit(policy);
		const result = await inspectUpstreamSync({ upstreamRef: DEFAULT_UPSTREAM_REF, git: fixture.run, policy });
		expect(result.changedPaths.upstream).toEqual([]);
		expect(result.changedPaths.candidate).toEqual([
			"packages/coding-agent/src/breadboard/session-port.ts",
			"packages/coding-agent/src/generated/compiled.generated.ts",
			"unknown/future-boundary.txt",
		]);
		expect(result.paths.map(entry => entry.path)).toEqual([
			"packages/coding-agent/src/breadboard/session-port.ts",
			"packages/coding-agent/src/generated/compiled.generated.ts",
			"unknown/future-boundary.txt",
		]);
		expect(result.unresolvedPaths).toEqual(["unknown/future-boundary.txt"]);
	});

	it("reports exact v17.0.7 ancestry with base equal to merge-base", async () => {
		const fixture = fixtureGit(policy);
		const result = await inspectUpstreamSync({ git: fixture.run, policy });
		expect(result.upstreamRef).toBe(DEFAULT_UPSTREAM_REF);
		expect(result.commits.upstream).toBe(V17_COMMIT);
		expect(result.commits.head).toBe(CURRENT_COMMIT);
		expect(result.commits.base).toBe(V17_COMMIT);
		expect(result.commits.base).toBe(result.commits.mergeBase);
		expect(result.ancestry).toEqual({
			relation: "upstream-ancestor",
			upstreamIsAncestorOfHead: true,
			headIsAncestorOfUpstream: false,
		});
		expect(result.mode).toBe("read-only");
		expect(fixture.calls.every(([command]) => !["fetch", "merge", "rebase", "reset"].includes(command))).toBe(true);
	});
});
