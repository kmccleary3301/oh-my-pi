import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { JSONC } from "bun";

export interface BreadboardSdkProvenance {
	readonly schemaVersion: "p30.breadboard-sdk-provenance.v1";
	readonly packageName: "@breadboard/sdk";
	readonly packageVersion: string;
	readonly artifactPath: string;
	readonly artifactSha256: string;
	readonly artifactSha512Base64: string;
	readonly artifactSizeBytes: number;
	readonly backendCommit: string;
	readonly backendTree: string;
	readonly backendRootEnvironmentVariable: "BREADBOARD_P30_BACKEND_ROOT";
	readonly installedFilesSha256: Readonly<Record<string, string>>;
}

export type BackendGitInspection = (
	root: string,
	assertRootIdentity: () => Promise<void>,
) => Promise<{
	readonly root: string;
	readonly commit: string;
	readonly tree: string;
	readonly status: string;
}>;

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`BreadBoard SDK provenance gate failed: ${message}`);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function trustedGitExecutable(): Promise<string> {
	const executable = process.platform === "darwin"
		? "/usr/bin/git"
		: process.platform === "linux"
			? "/usr/bin/git"
			: undefined;
	invariant(executable !== undefined, `unsupported platform ${process.platform}`);
	const metadata = await lstat(executable).catch(() => undefined);
	invariant(metadata !== undefined && metadata.isFile() && !metadata.isSymbolicLink(), "trusted Git executable is not a regular file");
	invariant(metadata.uid === 0, "trusted Git executable is not root-owned");
	invariant((metadata.mode & 0o022) === 0, "trusted Git executable is group- or other-writable");
	return executable;
}


function gitEnvironment(): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin",
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
}

const inspectBackendGit: BackendGitInspection = async (root, assertRootIdentity) => {
	const executable = await trustedGitExecutable();
	const environment = gitEnvironment();
	await assertRootIdentity();
	const identity = Bun.spawn([executable, "-C", root, "rev-parse", "--show-toplevel", "HEAD^{commit}", "HEAD^{tree}"], {
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [identityOutput, identityError, identityExit] = await Promise.all([
		new Response(identity.stdout).text(),
		new Response(identity.stderr).text(),
		identity.exited,
	]);
	invariant(identityExit === 0 && identityError === "", "backend Git identity is unavailable");
	const [inspectedRoot, commit, tree, ...extra] = identityOutput.trim().split("\n");
	invariant(extra.length === 0 && inspectedRoot !== undefined && commit !== undefined && tree !== undefined, "backend Git identity is malformed");
	await assertRootIdentity();
	const statusProcess = Bun.spawn([executable, "-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [status, statusError, statusExit] = await Promise.all([
		new Response(statusProcess.stdout).text(),
		new Response(statusProcess.stderr).text(),
		statusProcess.exited,
	]);
	invariant(statusExit === 0 && statusError === "", "backend Git status is unavailable");
	await assertRootIdentity();
	return { root: inspectedRoot, commit, tree, status };
};

export async function verifyBackendIdentity(
	manifest: Pick<BreadboardSdkProvenance, "backendCommit" | "backendTree">,
	backendRoot: string | undefined,
	inspect: BackendGitInspection = inspectBackendGit,
): Promise<void> {
	invariant(backendRoot !== undefined && backendRoot !== "", "backend root is required");
	const root = resolve(backendRoot);
	const metadata = await lstat(root);
	invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "backend root is not a real directory");
	const canonicalRoot = await realpath(root);
	const pinned = {
		dev: metadata.dev,
		ino: metadata.ino,
		canonicalRoot,
	};
	const assertRootIdentity = async (): Promise<void> => {
		const current = await lstat(root).catch(() => undefined);
		invariant(
			current !== undefined &&
				current.isDirectory() &&
				!current.isSymbolicLink() &&
				current.dev === pinned.dev &&
				current.ino === pinned.ino,
			"backend root identity changed",
		);
		const currentCanonicalRoot = await realpath(root).catch(() => undefined);
		invariant(currentCanonicalRoot === pinned.canonicalRoot, "backend root identity changed");
	};
	await assertRootIdentity();
	const identity = await inspect(root, assertRootIdentity);
	await assertRootIdentity();
	const inspectedRoot = await realpath(identity.root);
	invariant(inspectedRoot === canonicalRoot, "backend Git root does not match");
	invariant(identity.commit === manifest.backendCommit, "backend commit does not match");
	invariant(identity.tree === manifest.backendTree, "backend tree does not match");
	invariant(identity.status === "", "backend worktree is dirty");
}
export function verifyPinnedReferences(
	manifest: BreadboardSdkProvenance,
	packageJson: { readonly dependencies?: Readonly<Record<string, string>> },
	lockText: string,
): void {
	invariant(manifest.artifactPath.startsWith("./") && !isAbsolute(manifest.artifactPath), "artifact path must be repository-relative");
	const dependency = `file:${manifest.artifactPath}`;
	invariant(packageJson.dependencies?.[manifest.packageName] === dependency, "package.json dependency is not the pinned artifact");
	let parsed: unknown;
	try {
		parsed = JSONC.parse(lockText);
	} catch {
		invariant(false, "lockfile is not valid JSONC");
	}
	invariant(isRecord(parsed), "lockfile root is malformed");
	const workspaces = parsed.workspaces;
	invariant(isRecord(workspaces), "lockfile workspaces are malformed");
	const codingAgent = workspaces["packages/coding-agent"];
	invariant(isRecord(codingAgent), "lockfile coding-agent workspace is malformed");
	const dependencies = codingAgent.dependencies;
	invariant(isRecord(dependencies), "lockfile coding-agent dependencies are malformed");
	invariant(dependencies[manifest.packageName] === dependency, "lockfile coding-agent dependency is not the pinned artifact");
	const packages = parsed.packages;
	invariant(isRecord(packages), "lockfile packages are malformed");
	const packageRecord = packages[manifest.packageName];
	invariant(
		Array.isArray(packageRecord) && packageRecord.length === 3 && isRecord(packageRecord[1]),
		"lockfile SDK package record is malformed",
	);
	invariant(
		packageRecord[0] === `${manifest.packageName}@${manifest.artifactPath}`,
		"lockfile SDK package resolution is not the pinned artifact",
	);
	invariant(packageRecord[2] === `sha512-${manifest.artifactSha512Base64}`, "lockfile integrity does not match the manifest");
}

async function installedFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(join(root, prefix), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		invariant(!entry.isSymbolicLink(), `installed package contains symlink ${relative}`);
		if (entry.isDirectory()) files.push(...await installedFiles(root, relative));
		else {
			invariant(entry.isFile(), `installed package contains non-file ${relative}`);
			files.push(relative);
		}
	}
	return files.sort();
}

export async function verifyBreadboardSdkProvenance(
	packageRoot = resolve(import.meta.dir, ".."),
	backendRoot?: string,
	inspect: BackendGitInspection = inspectBackendGit,
): Promise<BreadboardSdkProvenance> {
	const manifestPath = join(packageRoot, "breadboard-sdk-provenance.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BreadboardSdkProvenance;
	invariant(manifest.schemaVersion === "p30.breadboard-sdk-provenance.v1", "unexpected manifest schema");
	invariant(manifest.packageName === "@breadboard/sdk", "unexpected package name");
	invariant(manifest.packageVersion === "0.2.2", "unexpected package version");
	invariant(/^([0-9a-f]{64})$/.test(manifest.artifactSha256), "invalid artifact SHA-256");
	invariant(manifest.backendRootEnvironmentVariable === "BREADBOARD_P30_BACKEND_ROOT", "unexpected backend root environment variable");

	const artifactPath = resolve(packageRoot, manifest.artifactPath);
	const artifactRelative = relative(packageRoot, artifactPath);
	invariant(artifactRelative !== "" && !artifactRelative.startsWith("..") && !isAbsolute(artifactRelative), "artifact escapes the package root");
	const artifactStat = await lstat(artifactPath);
	invariant(artifactStat.isFile() && artifactStat.nlink === 1 && !artifactStat.isSymbolicLink(), "artifact is not a single-link regular file");
	invariant(artifactStat.size === manifest.artifactSizeBytes, "artifact size changed");
	const artifact = await readFile(artifactPath);
	invariant(sha256(artifact) === manifest.artifactSha256, "artifact SHA-256 changed");
	invariant(createHash("sha512").update(artifact).digest("base64") === manifest.artifactSha512Base64, "artifact SHA-512 changed");

	const workspaceRoot = resolve(packageRoot, "../..");
	const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	const lockText = await readFile(join(workspaceRoot, "bun.lock"), "utf8");
	verifyPinnedReferences(manifest, packageJson, lockText);
	await verifyBackendIdentity(manifest, backendRoot ?? process.env[manifest.backendRootEnvironmentVariable], inspect);

	const installedRoot = join(workspaceRoot, "node_modules", "@breadboard", "sdk");
	const expectedFiles = Object.keys(manifest.installedFilesSha256).sort();
	const actualFiles = await installedFiles(installedRoot);
	invariant(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), "installed file inventory differs from the artifact manifest");
	for (const relative of expectedFiles) {
		const bytes = await readFile(join(installedRoot, relative));
		invariant(sha256(bytes) === manifest.installedFilesSha256[relative], `installed bytes changed for ${relative}`);
	}
	const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as { name?: string; version?: string; types?: string };
	invariant(installedPackage.name === manifest.packageName, "installed package name changed");
	invariant(installedPackage.version === manifest.packageVersion, "installed package version changed");
	invariant(installedPackage.types === "dist/index.d.ts", "installed package types entry changed");
	return manifest;
}

if (import.meta.main) {
	const manifest = await verifyBreadboardSdkProvenance();
	process.stdout.write(`${JSON.stringify({
		package: `${manifest.packageName}@${manifest.packageVersion}`,
		artifactSha256: manifest.artifactSha256,
		backendCommit: manifest.backendCommit,
		backendTree: manifest.backendTree,
		installedFiles: Object.keys(manifest.installedFilesSha256).length,
	})}\n`);
}
