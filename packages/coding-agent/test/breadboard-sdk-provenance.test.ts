import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	type BackendGitInspection,
	type BreadboardSdkProvenance,
	openVerifiedBackendSnapshot,
	type VerifiedBackendSnapshot,
	verifyBackendIdentity,
	verifyBreadboardSdkProvenance,
	verifyPinnedReferences,
} from "../scripts/verify-breadboard-sdk-provenance";

const packageRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(
	await readFile(resolve(packageRoot, "breadboard-sdk-provenance.json"), "utf8"),
) as BreadboardSdkProvenance;
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
	dependencies: Record<string, string>;
	scripts: Record<string, string>;
};
const workspaceRoot = resolve(packageRoot, "../..");
const lockText = await readFile(resolve(workspaceRoot, "bun.lock"), "utf8");

describe("BreadBoard SDK provenance", () => {
	test("verifies immutable artifact, lock, installed bytes, and type entry with no backend environment", async () => {
		const environmentName = manifest.backendRootEnvironmentVariable;
		const previous = process.env[environmentName];
		delete process.env[environmentName];
		const clean: BackendGitInspection = async root => {
			expect(root).toBe(packageRoot);
			return {
				root,
				commit: manifest.backendCommit,
				tree: manifest.backendTree,
				status: "",
			};
		};
		try {
			await expect(verifyBreadboardSdkProvenance(packageRoot, packageRoot, clean)).resolves.toMatchObject({
				packageName: "@breadboard/sdk",
				packageVersion: "0.2.5",
				artifactSha256: "10d0ad86df39c8a7972073efb274c15c24bc9aa86d2c663123e1deef91489782",
			});
		} finally {
			if (previous === undefined) delete process.env[environmentName];
			else process.env[environmentName] = previous;
		}
	});

	test("runs SDK provenance and notice gates before build or publication", () => {
		expect(packageJson.scripts["gate:distribution"]).toBe("bun run gate:breadboard-sdk && bun run gate:notices");
		expect(packageJson.scripts.build).toStartWith("bun run gate:distribution && ");
		expect(packageJson.scripts.prepack).toStartWith("bun run gate:distribution && ");
	});

	test("fails closed when package.json drifts from the pinned artifact", () => {
		expect(() =>
			verifyPinnedReferences(
				manifest,
				{
					dependencies: { ...packageJson.dependencies, "@breadboard/sdk": "file:/tmp/foreign-sdk.tgz" },
				},
				lockText,
			),
		).toThrow("package.json dependency is not the pinned artifact");
	});

	test("fails closed when lock integrity drifts", () => {
		const hostileLock = lockText.replace(`sha512-${manifest.artifactSha512Base64}`, `sha512-${"A".repeat(88)}`);
		expect(() => verifyPinnedReferences(manifest, packageJson, hostileLock)).toThrow(
			"lockfile integrity does not match the manifest",
		);
	});

	test("rejects expected lock strings outside the coding-agent SDK binding", () => {
		const hostileLock = `{
			"workspaces": {
				"packages/coding-agent": {
					"dependencies": {
						"${manifest.packageName}": "file:./vendor/foreign-sdk.tgz"
					},
					"unrelated": "${manifest.artifactPath}"
				}
			},
			"packages": {
				"${manifest.packageName}": [
					"${manifest.packageName}@./vendor/foreign-sdk.tgz",
					{},
					"sha512-${"A".repeat(88)}"
				],
				"unrelated-integrity": "sha512-${manifest.artifactSha512Base64}"
			}
			// ${manifest.artifactPath}
		}`;
		expect(() => verifyPinnedReferences(manifest, packageJson, hostileLock)).toThrow(
			"lockfile coding-agent dependency is not the pinned artifact",
		);
	});

	test("requires a supplied clean backend at the exact approved commit and tree", async () => {
		const clean: BackendGitInspection = async root => ({
			root,
			commit: manifest.backendCommit,
			tree: manifest.backendTree,
			status: "",
		});
		await expect(verifyBackendIdentity(manifest, packageRoot, clean)).resolves.toBeUndefined();
		await expect(verifyBackendIdentity(manifest, undefined, clean)).rejects.toThrow("backend root is required");
		await expect(
			verifyBackendIdentity(manifest, packageRoot, async root => ({
				root,
				commit: "0".repeat(40),
				tree: manifest.backendTree,
				status: "",
			})),
		).rejects.toThrow("backend commit does not match");
		await expect(
			verifyBackendIdentity(manifest, packageRoot, async root => ({
				root,
				commit: manifest.backendCommit,
				tree: "0".repeat(40),
				status: "",
			})),
		).rejects.toThrow("backend tree does not match");
		await expect(
			verifyBackendIdentity(manifest, packageRoot, async root => ({
				root,
				commit: manifest.backendCommit,
				tree: manifest.backendTree,
				status: " M registry.py",
			})),
		).rejects.toThrow("backend worktree is dirty");
	});

	test("rejects a one-way backend root swap between Git identity and status probes", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-backend-swap-"));
		const root = resolve(parent, "backend");
		const replacement = resolve(parent, "replacement");
		const retired = resolve(parent, "retired");
		await mkdir(root);
		await mkdir(replacement);
		const swappingInspection = (async (inspectedRoot: string, assertPinned?: () => Promise<void>) => {
			await assertPinned?.();
			await rename(inspectedRoot, retired);
			await rename(replacement, inspectedRoot);
			await assertPinned?.();
			return {
				root: inspectedRoot,
				commit: manifest.backendCommit,
				tree: manifest.backendTree,
				status: "",
			};
		}) as unknown as BackendGitInspection;
		try {
			await expect(verifyBackendIdentity(manifest, root, swappingInspection)).rejects.toThrow(
				"backend root identity changed",
			);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("ignores a hostile first-PATH Git executable", async () => {
		const hostileBin = await mkdtemp(resolve(tmpdir(), "breadboard-hostile-git-"));
		const fakeGit = resolve(hostileBin, "git");
		await writeFile(
			fakeGit,
			`#!/bin/sh
case "$*" in
	*"rev-parse"*)
		printf '%s\\n' ${JSON.stringify(packageRoot)} ${JSON.stringify(manifest.backendCommit)} ${JSON.stringify(manifest.backendTree)}
		;;
	*"status"*)
		exit 0
		;;
	*)
		exit 1
		;;
esac
`,
		);
		await chmod(fakeGit, 0o755);
		const verifierPath = resolve(packageRoot, "scripts/verify-breadboard-sdk-provenance.ts");
		const childScript = `
			const { verifyBackendIdentity } = await import(${JSON.stringify(verifierPath)});
			try {
				await verifyBackendIdentity(${JSON.stringify({
					backendCommit: manifest.backendCommit,
					backendTree: manifest.backendTree,
				})}, ${JSON.stringify(packageRoot)});
				process.stdout.write("accepted\\n");
			} catch (error) {
				process.stderr.write(String(error) + "\\n");
				process.exitCode = 2;
			}
		`;
		try {
			const probe = Bun.spawn([process.execPath, "-e", childScript], {
				env: {
					...process.env,
					PATH: `${hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(probe.stdout).text(),
				new Response(probe.stderr).text(),
				probe.exited,
			]);
			expect({ exitCode, stdout, stderr }).toMatchObject({
				exitCode: 2,
				stdout: "",
				stderr: expect.stringContaining("backend Git root does not match"),
			});
		} finally {
			await rm(hostileBin, { recursive: true, force: true });
		}
	});
	test("disables repository-local Git executors before identity and status probes", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-local-git-config-"));
		const root = resolve(parent, "backend");
		await mkdir(root);
		const marker = resolve(parent, "fsmonitor-executed");
		const fsmonitor = resolve(parent, "fsmonitor.sh");
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) {
				throw new Error(new TextDecoder().decode(result.stderr));
			}
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await writeFile(resolve(root, "tracked.txt"), "clean\n");
			git("add", "tracked.txt");
			git("commit", "-qm", "fixture");
			await writeFile(
				fsmonitor,
				`#!/bin/sh
touch ${JSON.stringify(marker)}
printf 'token\\n'
`,
			);
			await chmod(fsmonitor, 0o755);
			git("config", "core.fsmonitor", fsmonitor);
			let [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).resolves.toBeUndefined();
			expect(await Bun.file(marker).exists()).toBe(false);
			await writeFile(resolve(root, "tracked.txt"), "dirty\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend worktree is dirty");
			expect(await Bun.file(marker).exists()).toBe(false);
			git("checkout", "-q", "--", "tracked.txt");
			await rm(marker, { force: true });

			await writeFile(resolve(root, "untracked.txt"), "untracked\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend worktree is dirty");
			expect(await Bun.file(marker).exists()).toBe(false);
			await rm(resolve(root, "untracked.txt"));

			await chmod(resolve(root, "tracked.txt"), 0o755);
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend worktree is dirty");
			expect(await Bun.file(marker).exists()).toBe(false);
			await chmod(resolve(root, "tracked.txt"), 0o644);

			const submoduleOrigin = resolve(parent, "submodule-origin");
			await mkdir(submoduleOrigin);
			const submoduleGit = (...args: string[]) => {
				const result = Bun.spawnSync(["/usr/bin/git", "-C", submoduleOrigin, ...args], {
					env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			};
			submoduleGit("init", "-q");
			submoduleGit("config", "user.name", "BreadBoard Test");
			submoduleGit("config", "user.email", "breadboard-test@example.invalid");
			await writeFile(resolve(submoduleOrigin, "child.txt"), "clean\n");
			submoduleGit("add", "child.txt");
			submoduleGit("commit", "-qm", "fixture");
			git("-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleOrigin, "nested");
			git("commit", "-qam", "add submodule");
			[commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await rm(marker, { force: true });
			await writeFile(resolve(root, "nested/child.txt"), "dirty\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend worktree is dirty");
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
	test.each(["clean", "process"] as const)("does not execute repository-local %s filters", async filterKind => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-local-filter-"));
		const root = resolve(parent, "backend");
		const marker = resolve(parent, "filter-executed");
		const filter = resolve(parent, filterKind === "clean" ? "filter.sh" : "filter.ts");
		await mkdir(root);
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await writeFile(resolve(root, "tracked.txt"), "clean\n");
			git("add", "tracked.txt");
			git("commit", "-qm", "fixture");
			const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await writeFile(resolve(root, ".git/info/attributes"), "tracked.txt filter=pwn\n");
			if (filterKind === "clean") {
				await writeFile(
					filter,
					`#!/bin/sh
cat
touch ${JSON.stringify(marker)}
`,
				);
				await chmod(filter, 0o755);
				git("config", "filter.pwn.clean", filter);
			} else {
				await writeFile(
					filter,
					`import { readSync, writeFileSync, writeSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
function readExact(length) {
	const bytes = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const count = readSync(0, bytes, offset, length - offset, null);
		if (count === 0) throw new Error("eof");
		offset += count;
	}
	return bytes;
}
function readPacket() {
	const length = Number.parseInt(readExact(4).toString("ascii"), 16);
	return length === 0 ? null : readExact(length - 4);
}
function readList() {
	const packets = [];
	for (;;) {
		const packet = readPacket();
		if (packet === null) return packets;
		packets.push(packet);
	}
}
function writePacket(bytes) {
	writeSync(1, Buffer.from((bytes.length + 4).toString(16).padStart(4, "0"), "ascii"));
	writeSync(1, bytes);
}
function flush() { writeSync(1, Buffer.from("0000", "ascii")); }
readList();
writePacket(Buffer.from("git-filter-server\\n"));
writePacket(Buffer.from("version=2\\n"));
flush();
readList();
writePacket(Buffer.from("capability=clean\\n"));
flush();
for (;;) {
	try {
		readList();
		const content = readList();
		writeFileSync(marker, "executed\\n");
		writePacket(Buffer.from("status=success\\n"));
		flush();
		for (const packet of content) writePacket(packet);
		flush();
		flush();
	} catch {
		break;
	}
}
`,
				);
				git("config", "filter.pwn.process", `${process.execPath} ${filter}`);
			}
			git("config", "filter.pwn.required", "true");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).resolves.toBeUndefined();
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test.each(["assume-unchanged", "skip-worktree"] as const)("rejects tracked bytes hidden by %s", async flag => {
		const root = await mkdtemp(resolve(tmpdir(), "breadboard-hidden-index-state-"));
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await writeFile(resolve(root, "tracked.txt"), "clean\n");
			git("add", "tracked.txt");
			git("commit", "-qm", "fixture");
			const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			git("update-index", `--${flag}`, "tracked.txt");
			await writeFile(resolve(root, "tracked.txt"), "hidden dirty bytes\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a substituted backend root despite hostile Git discovery environment", async () => {
		const identityProcess = Bun.spawnSync(
			["git", "-C", workspaceRoot, "rev-parse", "--absolute-git-dir", "HEAD^{commit}", "HEAD^{tree}"],
			{
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(identityProcess.exitCode).toBe(0);
		const [gitDir, commit, tree] = new TextDecoder().decode(identityProcess.stdout).trim().split("\n");
		if (!gitDir || !commit || !tree) throw new Error("test Git identity is unavailable");
		const substitutedRoot = resolve(workspaceRoot, "packages");
		const verifierPath = resolve(packageRoot, "scripts/verify-breadboard-sdk-provenance.ts");
		// This child process is the hostile environment boundary under test, so its verifier path is runtime-selected.
		const childScript = `
			const { verifyBackendIdentity } = await import(${JSON.stringify(verifierPath)});
			try {
				await verifyBackendIdentity(${JSON.stringify({
					backendCommit: commit,
					backendTree: tree,
				})}, ${JSON.stringify(substitutedRoot)});
				process.stdout.write("accepted\\n");
			} catch (error) {
				process.stderr.write(String(error) + "\\n");
				process.exitCode = 2;
			}
		`;
		const probe = Bun.spawn([process.execPath, "-e", childScript], {
			cwd: substitutedRoot,
			env: {
				...process.env,
				GIT_DIR: gitDir,
				GIT_WORK_TREE: workspaceRoot,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect({ exitCode, stdout, stderr }).toMatchObject({
			exitCode: 2,
			stderr: expect.stringContaining("backend Git root does not match"),
		});
	});
	test.each(["info-exclude", "core-excludes-file"] as const)(
		"does not let %s hide an untracked source executable",
		async exclusion => {
			const parent = await mkdtemp(resolve(tmpdir(), "breadboard-local-exclude-"));
			const root = resolve(parent, "backend");
			const excludes = resolve(parent, "local-excludes");
			await mkdir(root);
			const git = (...args: string[]) => {
				const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
					env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
				return new TextDecoder().decode(result.stdout).trim();
			};
			try {
				git("init", "-q");
				git("config", "user.name", "BreadBoard Test");
				git("config", "user.email", "breadboard-test@example.invalid");
				await writeFile(resolve(root, "tracked.txt"), "clean\n");
				git("add", "tracked.txt");
				git("commit", "-qm", "fixture");
				const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
				await writeFile(resolve(root, "payload.ts"), "process.stdout.write('executed')\n");
				await chmod(resolve(root, "payload.ts"), 0o755);
				if (exclusion === "info-exclude") {
					await writeFile(resolve(root, ".git/info/exclude"), "payload.ts\n");
				} else {
					await writeFile(excludes, "payload.ts\n");
					git("config", "core.excludesFile", excludes);
				}
				await expect(
					verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
				).rejects.toThrow("backend worktree is dirty");
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	test("compares nested tracked bytes and tracked symlink targets directly with HEAD", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "breadboard-nested-symlink-"));
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await mkdir(resolve(root, "nested"));
			await writeFile(resolve(root, "nested/tracked.txt"), "clean\n");
			await symlink("nested/tracked.txt", resolve(root, "tracked-link"));
			git("add", "nested/tracked.txt", "tracked-link");
			git("commit", "-qm", "fixture");
			const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).resolves.toBeUndefined();
			await writeFile(resolve(root, "nested/tracked.txt"), "dirty\n");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend worktree is dirty");
			git("checkout", "-q", "--", "nested/tracked.txt");
			await rm(resolve(root, "tracked-link"));
			await symlink("other-target", resolve(root, "tracked-link"));
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("backend tracked symlink target does not match");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("does not lazy-fetch a missing promisor blob through repository SSH configuration", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-promisor-"));
		const origin = resolve(parent, "origin");
		const root = resolve(parent, "partial");
		const marker = resolve(parent, "ssh-command-executed");
		const sshCommand = resolve(parent, "ssh-command.sh");
		await mkdir(origin);
		const git = (cwd: string, ...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git(origin, "init", "-q");
			git(origin, "config", "user.name", "BreadBoard Test");
			git(origin, "config", "user.email", "breadboard-test@example.invalid");
			git(origin, "config", "uploadpack.allowFilter", "true");
			await writeFile(resolve(origin, "tracked.txt"), "promised bytes\n");
			git(origin, "add", "tracked.txt");
			git(origin, "commit", "-qm", "fixture");
			const clone = Bun.spawnSync(
				[
					"/usr/bin/git",
					"-c",
					"protocol.file.allow=always",
					"clone",
					"-q",
					"--filter=blob:none",
					"--no-checkout",
					`file://${origin}`,
					root,
				],
				{
					env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (clone.exitCode !== 0) throw new Error(new TextDecoder().decode(clone.stderr));
			const [commit, tree] = git(root, "rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await writeFile(resolve(root, "tracked.txt"), "promised bytes\n");
			await writeFile(
				sshCommand,
				`#!/bin/sh
touch ${JSON.stringify(marker)}
exit 1
`,
			);
			await chmod(sshCommand, 0o755);
			git(root, "config", "core.sshCommand", sshCommand);
			git(root, "remote", "set-url", "origin", "ssh://example.invalid/promisor");
			await expect(
				verifyBackendIdentity({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow();
			expect(await Bun.file(marker).exists()).toBe(false);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("rejects a root pathname swapped to a clean clone after the last inode check", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-root-swap-"));
		const root = resolve(parent, "backend");
		const clean = resolve(parent, "clean");
		const held = resolve(parent, "held");
		await mkdir(root);
		const git = (cwd: string, ...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git(root, "init", "-q");
			git(root, "config", "user.name", "BreadBoard Test");
			git(root, "config", "user.email", "breadboard-test@example.invalid");
			await writeFile(resolve(root, "tracked.txt"), "clean\n");
			git(root, "add", "tracked.txt");
			git(root, "commit", "-qm", "fixture");
			const clone = Bun.spawnSync(["/usr/bin/git", "clone", "-q", root, clean], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (clone.exitCode !== 0) throw new Error(new TextDecoder().decode(clone.stderr));
			const [commit, tree] = git(root, "rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await writeFile(resolve(root, "tracked.txt"), "dirty pinned inode\n");
			let swapped = false;
			const swappingInspection = (async (inspectedRoot: string, assertRootIdentity: () => Promise<void>) => {
				await assertRootIdentity();
				return {
					get root() {
						if (!swapped) {
							renameSync(root, held);
							renameSync(clean, root);
							swapped = true;
						}
						return inspectedRoot;
					},
					commit: commit as string,
					tree: tree as string,
					status: "",
				};
			}) as BackendGitInspection;
			await expect(
				verifyBackendIdentity(
					{ backendCommit: commit as string, backendTree: tree as string },
					root,
					swappingInspection,
				),
			).rejects.toThrow("backend root identity changed");
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
	test.each([
		["different tree", true, "backend worktree is dirty"],
		["captured tree", false, "backend Git identity changed"],
	] as const)(
		"rejects HEAD advancing between identity capture and tree enumeration: %s",
		async (_scenario, mutateTree, expectedRejection) => {
			const root = await mkdtemp(resolve(tmpdir(), "breadboard-head-race-"));
			const originalSpawn = Bun.spawn;
			const git = (...args: string[]) => {
				const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
					env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
				return new TextDecoder().decode(result.stdout).trim();
			};
			let snapshot: VerifiedBackendSnapshot | undefined;
			try {
				git("init", "-q");
				git("config", "user.name", "BreadBoard Test");
				git("config", "user.email", "breadboard-test@example.invalid");
				await writeFile(resolve(root, "tracked.txt"), "captured bytes\n");
				git("add", "tracked.txt");
				git("commit", "-qm", "captured");
				const [capturedCommit, capturedTree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n") as [
					string,
					string,
				];
				if (mutateTree) {
					await writeFile(resolve(root, "tracked.txt"), "advanced bytes\n");
					git("commit", "-qam", "advanced");
				} else {
					git("commit", "--allow-empty", "-qm", "advanced");
				}
				const advancedCommit = git("rev-parse", "HEAD^{commit}");
				const headRefPath = resolve(root, ".git", git("symbolic-ref", "HEAD"));
				await writeFile(headRefPath, `${capturedCommit}\n`);

				let advanced = false;
				Bun.spawn = ((...args: unknown[]) => {
					const child = Reflect.apply(originalSpawn, Bun, args);
					const command = args[0];
					if (
						!advanced &&
						Array.isArray(command) &&
						command.includes("rev-parse") &&
						command.includes("HEAD^{commit}") &&
						command.includes("HEAD^{tree}")
					) {
						const exited = child.exited.then(async (exitCode: number) => {
							advanced = true;
							await writeFile(headRefPath, `${advancedCommit}\n`);
							return exitCode;
						});
						Object.defineProperty(child, "exited", { value: exited });
					}
					return child;
				}) as typeof Bun.spawn;

				let rejection: unknown;
				try {
					snapshot = await openVerifiedBackendSnapshot(
						{ backendCommit: capturedCommit, backendTree: capturedTree },
						root,
					);
				} catch (error) {
					rejection = error;
				}
				expect(advanced).toBe(true);
				expect(snapshot).toBeUndefined();
				expect(String(rejection)).toContain(expectedRejection);
			} finally {
				Bun.spawn = originalSpawn;
				await snapshot?.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test("execution snapshot contains only tracked HEAD bytes and survives original mutation and replacement", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "breadboard-execution-snapshot-"));
		const root = resolve(parent, "backend");
		const held = resolve(parent, "held");
		await mkdir(root);
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		let snapshot: Awaited<ReturnType<typeof openVerifiedBackendSnapshot>> | undefined;
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await mkdir(resolve(root, "nested"));
			await writeFile(resolve(root, "nested/tracked.txt"), "verified bytes\n");
			git("add", "nested/tracked.txt");
			git("commit", "-qm", "fixture");
			const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			snapshot = await openVerifiedBackendSnapshot(
				{ backendCommit: commit as string, backendTree: tree as string },
				root,
			);
			expect({ commit: snapshot.commit, tree: snapshot.tree }).toEqual({ commit, tree });
			expect((await lstat(snapshot.root)).mode & 0o777).toBe(0o700);
			expect(await Bun.file(resolve(snapshot.root, ".git")).exists()).toBe(false);
			await writeFile(resolve(root, "nested/tracked.txt"), "mutated original\n");
			renameSync(root, held);
			await mkdir(root);
			await mkdir(resolve(root, "nested"));
			await writeFile(resolve(root, "nested/tracked.txt"), "replacement root\n");
			expect(await readFile(resolve(snapshot.root, "nested/tracked.txt"), "utf8")).toBe("verified bytes\n");
			expect(await Bun.file(resolve(snapshot.root, ".git")).exists()).toBe(false);
		} finally {
			await snapshot?.close();
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("execution snapshot rejects a tracked symlink that could escape the private root", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "breadboard-snapshot-symlink-"));
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "BreadBoard Test");
			git("config", "user.email", "breadboard-test@example.invalid");
			await symlink("../outside", resolve(root, "escape"));
			git("add", "escape");
			git("commit", "-qm", "fixture");
			const [commit, tree] = git("rev-parse", "HEAD^{commit}", "HEAD^{tree}").split("\n");
			await expect(
				openVerifiedBackendSnapshot({ backendCommit: commit as string, backendTree: tree as string }, root),
			).rejects.toThrow("execution snapshot cannot contain tracked symlinks");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
