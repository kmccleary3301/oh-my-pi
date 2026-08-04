import { createHash } from "node:crypto";
import { constants, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { JSONC } from "bun";
import {
	PINNED_DIRECTORY_LIMITS,
	openPinnedDirectory,
	type PinnedDirectory,
} from "../src/breadboard/lifecycle/pinned-directory";

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

export interface VerifiedBackendSnapshot {
	readonly root: string;
	readonly commit: string;
	readonly tree: string;
	close(): Promise<void>;
}

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
	const executable =
		process.platform === "darwin" ? "/usr/bin/git" : process.platform === "linux" ? "/usr/bin/git" : undefined;
	invariant(executable !== undefined, `unsupported platform ${process.platform}`);
	const metadata = await lstat(executable).catch(() => undefined);
	invariant(metadata !== undefined, "trusted Git executable does not exist");
	invariant(metadata.isFile() && !metadata.isSymbolicLink(), "trusted Git executable is not a regular file");
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
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
	};
}

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const MAX_TREE_PATH_BYTES = 4096;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

async function collectLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of stream) {
		length += chunk.byteLength;
		invariant(length <= limit, "backend Git output exceeds the verification limit");
		chunks.push(chunk);
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function runGit(
	executable: string,
	root: string,
	args: readonly string[],
	input?: Uint8Array,
	maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
	acceptedExitCodes: readonly number[] = [0],
): Promise<Uint8Array> {
	const child = Bun.spawn([executable, "--no-replace-objects", ...GIT_CONFIG_OVERRIDES, "-C", root, ...args], {
		env: gitEnvironment(),
		stdin: input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined) {
		const stdin = child.stdin;
		invariant(stdin !== undefined, "backend Git input pipe is unavailable");
		stdin.write(input);
		stdin.end();
	}
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			collectLimited(child.stdout, maxOutputBytes),
			collectLimited(child.stderr, 64 * 1024),
			child.exited,
		]);
		invariant(acceptedExitCodes.includes(exitCode) && stderr.byteLength === 0, "backend Git inspection failed");
		return stdout;
	} catch (error) {
		child.kill();
		throw error;
	}
}
const GIT_CONFIG_OVERRIDES = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.filemode=true",
	"-c",
	"core.ignoreStat=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"core.excludesFile=/dev/null",
] as const;

interface HeadTreeEntry {
	readonly mode: "100644" | "100755" | "120000";
	readonly objectId: string;
	readonly path: string;
}

function splitNullTerminated(bytes: Uint8Array): Uint8Array[] {
	const records: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index++) {
		if (bytes[index] !== 0) continue;
		records.push(bytes.subarray(start, index));
		start = index + 1;
	}
	invariant(start === bytes.byteLength, "backend Git listing is not NUL terminated");
	return records;
}

function parseHeadTree(bytes: Uint8Array): HeadTreeEntry[] {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const entries: HeadTreeEntry[] = [];
	const seenPaths = new Set<string>();
	for (const record of splitNullTerminated(bytes)) {
		invariant(entries.length < MAX_TREE_ENTRIES, "backend tree has too many entries");
		const tab = record.indexOf(0x09);
		invariant(tab > 0, "backend tree entry is malformed");
		const header = decoder.decode(record.subarray(0, tab));
		const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})$/.exec(header);
		invariant(match !== null, "backend worktree is dirty");
		const pathBytes = record.subarray(tab + 1);
		invariant(
			pathBytes.byteLength > 0 && pathBytes.byteLength <= MAX_TREE_PATH_BYTES,
			"backend tree path is invalid",
		);
		const path = decoder.decode(pathBytes);
		invariant(
			!isAbsolute(path) &&
				!path.startsWith(`.${sep}`) &&
				path.split(sep).every(component => component !== "" && component !== "." && component !== ".."),
			"backend tree path is unsafe",
		);
		invariant(!seenPaths.has(path), "backend tree contains a duplicate path");
		seenPaths.add(path);
		entries.push({ mode: match[1] as HeadTreeEntry["mode"], objectId: match[2] as string, path });
	}
	return entries;
}

function parseBatchBlobs(bytes: Uint8Array, objectIds: readonly string[]): ReadonlyMap<string, Uint8Array> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const blobs = new Map<string, Uint8Array>();
	let offset = 0;
	let totalBytes = 0;
	for (const expectedObjectId of objectIds) {
		const newline = bytes.indexOf(0x0a, offset);
		invariant(newline > offset, "backend blob response is malformed");
		const header = decoder.decode(bytes.subarray(offset, newline));
		const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header);
		invariant(match !== null && match[1] === expectedObjectId, "backend blob response does not match the tree");
		const size = Number(match[2]);
		invariant(
			Number.isSafeInteger(size) && size >= 0 && size <= MAX_BLOB_BYTES,
			"backend blob exceeds the verification limit",
		);
		totalBytes += size;
		invariant(totalBytes <= MAX_TREE_BYTES, "backend tree bytes exceed the verification limit");
		const start = newline + 1;
		const end = start + size;
		invariant(end < bytes.byteLength && bytes[end] === 0x0a, "backend blob response is truncated");
		blobs.set(expectedObjectId, bytes.subarray(start, end));
		offset = end + 1;
	}
	invariant(offset === bytes.byteLength, "backend blob response contains trailing data");
	return blobs;
}

interface VerifiedHeadTree {
	readonly entries: readonly HeadTreeEntry[];
	readonly blobs: ReadonlyMap<string, Uint8Array>;
}

async function writeSnapshotFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await descriptor.writeFile(bytes);
		await descriptor.sync();
		await descriptor.chmod(mode);
	} finally {
		await descriptor.close();
	}
}

async function materializeIgnoreRules(
	executable: string,
	verified: VerifiedHeadTree,
): Promise<{ readonly root: string; close(): Promise<void> }> {
	const snapshotRoot = await mkdtemp(join(tmpdir(), "breadboard-ignore-snapshot-"));
	let closed = false;
	try {
		for (const entry of verified.entries) {
			if (entry.mode === "120000" || (entry.path !== ".gitignore" && !entry.path.endsWith(`${sep}.gitignore`)))
				continue;
			const expectedBlob = verified.blobs.get(entry.objectId);
			invariant(expectedBlob !== undefined, "backend tracked blob is missing");
			await writeSnapshotFile(join(snapshotRoot, entry.path), expectedBlob, 0o400);
		}
		await runGit(executable, snapshotRoot, ["init", "-q"]);
		return {
			root: snapshotRoot,
			close: async () => {
				if (closed) return;
				closed = true;
				await rm(snapshotRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(snapshotRoot, { recursive: true, force: true });
		throw error;
	}
}

async function materializeExecutionSnapshot(
	verified: VerifiedHeadTree,
	commit: string,
	tree: string,
): Promise<VerifiedBackendSnapshot> {
	const snapshotRoot = await mkdtemp(join(tmpdir(), "breadboard-backend-snapshot-"));
	let closed = false;
	try {
		for (const entry of verified.entries) {
			invariant(entry.mode !== "120000", "execution snapshot cannot contain tracked symlinks");
			const expectedBlob = verified.blobs.get(entry.objectId);
			invariant(expectedBlob !== undefined, "backend tracked blob is missing");
			await writeSnapshotFile(join(snapshotRoot, entry.path), expectedBlob, entry.mode === "100755" ? 0o500 : 0o400);
		}
		return {
			root: snapshotRoot,
			commit,
			tree,
			close: async () => {
				if (closed) return;
				closed = true;
				await rm(snapshotRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(snapshotRoot, { recursive: true, force: true });
		throw error;
	}
}

async function inspectPinnedBackendGit(
	root: string,
	pinned: PinnedDirectory,
): Promise<{
	readonly identity: Awaited<ReturnType<BackendGitInspection>>;
	readonly verified: VerifiedHeadTree;
	readonly executable: string;
}> {
	const executable = await trustedGitExecutable();
	const promisorConfig = await runGit(
		executable,
		root,
		["config", "--local", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"],
		undefined,
		MAX_GIT_OUTPUT_BYTES,
		[0, 1],
	);
	invariant(promisorConfig.byteLength === 0, "backend repository is partial or promisor");
	const identityOutput = new TextDecoder("utf-8", { fatal: true }).decode(
		await runGit(executable, root, ["rev-parse", "--show-toplevel", "HEAD^{commit}", "HEAD^{tree}"]),
	);
	const [inspectedRoot, commit, tree, ...extra] = identityOutput.trim().split("\n");
	invariant(
		extra.length === 0 && inspectedRoot !== undefined && commit !== undefined && tree !== undefined,
		"backend Git identity is malformed",
	);
	invariant((await realpath(inspectedRoot)) === (await realpath(root)), "backend Git root does not match");
	const treeBytes = await runGit(executable, root, ["ls-tree", "-rz", "--full-tree", "-r", tree]);
	const entries = parseHeadTree(treeBytes);
	const objectIds = [...new Set(entries.map(entry => entry.objectId))];
	const objectInput = new TextEncoder().encode(`${objectIds.join("\n")}\n`);
	const batchBytes =
		objectIds.length === 0
			? new Uint8Array()
			: await runGit(executable, root, ["cat-file", "--batch"], objectInput, MAX_TREE_BYTES + MAX_GIT_OUTPUT_BYTES);
	const blobs = parseBatchBlobs(batchBytes, objectIds);
	for (const entry of entries) {
		const expectedBlob = blobs.get(entry.objectId);
		invariant(expectedBlob !== undefined, "backend tracked blob is missing");
		if (entry.mode === "120000") {
			const target = await pinned.readlink(entry.path, MAX_TREE_PATH_BYTES);
			invariant(target.equals(expectedBlob), "backend tracked symlink target does not match");
			continue;
		}
		const tracked = await pinned.openFile(entry.path);
		try {
			const metadata = await tracked.stat();
			invariant(metadata.type === "regular", "backend tracked file type does not match");
			invariant(((metadata.mode & 0o111) !== 0) === (entry.mode === "100755"), "backend worktree is dirty");
			invariant(
				metadata.size <= BigInt(PINNED_DIRECTORY_LIMITS.maxFileBytes),
				"backend tracked file exceeds the verification limit",
			);
			const bytes = await tracked.read(PINNED_DIRECTORY_LIMITS.maxFileBytes);
			invariant(bytes.equals(expectedBlob), "backend worktree is dirty");
		} finally {
			await tracked.close();
		}
	}
	const trackedPaths = new Set(entries.map(entry => entry.path));
	const leaves = await pinned.listLeaves({
		maxEntries: Math.min(MAX_TREE_ENTRIES * 2, PINNED_DIRECTORY_LIMITS.maxEntries),
		maxPathBytes: Math.min(MAX_TREE_PATH_BYTES, PINNED_DIRECTORY_LIMITS.maxRelativePathBytes),
		maxTotalPathBytes: PINNED_DIRECTORY_LIMITS.maxTotalPathBytes,
	});
	const untracked = leaves.filter(
		path => path !== ".git" && !path.startsWith(`.git${sep}`) && !trackedPaths.has(path),
	);
	const verified = { entries, blobs };
	const classificationSnapshot = await materializeIgnoreRules(executable, verified);
	try {
		if (untracked.length > 0) {
			const input = new TextEncoder().encode(`${untracked.join("\0")}\0`);
			const ignoredBytes = await runGit(
				executable,
				classificationSnapshot.root,
				["check-ignore", "--no-index", "-v", "-z", "--stdin"],
				input,
				MAX_GIT_OUTPUT_BYTES,
				[0, 1],
			);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const records = splitNullTerminated(ignoredBytes).map(bytes => decoder.decode(bytes));
			invariant(records.length % 4 === 0, "backend Git ignore result is malformed");
			const ignoredByCommittedRules = new Set<string>();
			for (let index = 0; index < records.length; index += 4) {
				const source = records[index] as string;
				const line = records[index + 1] as string;
				const pattern = records[index + 2] as string;
				const path = records[index + 3] as string;
				const sourcePath = relative(
					classificationSnapshot.root,
					isAbsolute(source) ? source : resolve(classificationSnapshot.root, source),
				);
				invariant(
					!sourcePath.startsWith(`..${sep}`) &&
						(sourcePath === ".gitignore" || sourcePath.endsWith(`${sep}.gitignore`)) &&
						trackedPaths.has(sourcePath) &&
						/^[1-9][0-9]*$/.test(line) &&
						pattern !== "",
					"backend worktree is dirty",
				);
				ignoredByCommittedRules.add(path);
			}
			invariant(
				untracked.every(path => ignoredByCommittedRules.has(path)),
				"backend worktree is dirty",
			);
		}
	} finally {
		await classificationSnapshot.close();
	}
	const finalIdentityOutput = new TextDecoder("utf-8", { fatal: true }).decode(
		await runGit(executable, root, ["rev-parse", "--show-toplevel", "HEAD^{commit}", "HEAD^{tree}"]),
	);
	const [finalRoot, finalCommit, finalTree, ...finalExtra] = finalIdentityOutput.trim().split("\n");
	invariant(
		finalExtra.length === 0 && finalRoot !== undefined && finalCommit !== undefined && finalTree !== undefined,
		"backend Git identity is malformed",
	);
	invariant(
		(await realpath(finalRoot)) === (await realpath(root)) && finalCommit === commit && finalTree === tree,
		"backend Git identity changed",
	);
	return {
		identity: { root: inspectedRoot, commit, tree, status: "" },
		verified,
		executable,
	};
}

async function verifyCustomInspection(
	manifest: Pick<BreadboardSdkProvenance, "backendCommit" | "backendTree">,
	root: string,
	inspect: BackendGitInspection,
): Promise<void> {
	const metadata = await lstat(root);
	invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "backend root is not a real directory");
	const canonicalRoot = await realpath(root);
	const assertRootIdentity = async (): Promise<void> => {
		const current = await lstat(root).catch(() => undefined);
		invariant(
			current?.isDirectory() &&
				!current.isSymbolicLink() &&
				current.dev === metadata.dev &&
				current.ino === metadata.ino,
			"backend root identity changed",
		);
	};
	await assertRootIdentity();
	const identity = await inspect(root, assertRootIdentity);
	await assertRootIdentity();
	const inspectedRoot = await realpath(identity.root);
	await assertRootIdentity();
	invariant(inspectedRoot === canonicalRoot, "backend Git root does not match");
	invariant(identity.commit === manifest.backendCommit, "backend commit does not match");
	invariant(identity.tree === manifest.backendTree, "backend tree does not match");
	invariant(identity.status === "", "backend worktree is dirty");
}

async function openVerifiedBackend(
	manifest: Pick<BreadboardSdkProvenance, "backendCommit" | "backendTree">,
	backendRoot: string | undefined,
): Promise<VerifiedBackendSnapshot> {
	invariant(backendRoot !== undefined && backendRoot !== "", "backend root is required");
	const root = resolve(backendRoot);
	const pinned = await openPinnedDirectory(root);
	try {
		const { identity, verified } = await inspectPinnedBackendGit(root, pinned);
		invariant(identity.commit === manifest.backendCommit, "backend commit does not match");
		invariant(identity.tree === manifest.backendTree, "backend tree does not match");
		return await materializeExecutionSnapshot(verified, identity.commit, identity.tree);
	} finally {
		await pinned.close();
	}
}

export async function openVerifiedBackendSnapshot(
	manifest: Pick<BreadboardSdkProvenance, "backendCommit" | "backendTree">,
	backendRoot: string | undefined,
): Promise<VerifiedBackendSnapshot> {
	return await openVerifiedBackend(manifest, backendRoot);
}

export async function verifyBackendIdentity(
	manifest: Pick<BreadboardSdkProvenance, "backendCommit" | "backendTree">,
	backendRoot: string | undefined,
	inspect?: BackendGitInspection,
): Promise<void> {
	invariant(backendRoot !== undefined && backendRoot !== "", "backend root is required");
	const root = resolve(backendRoot);
	if (inspect) {
		await verifyCustomInspection(manifest, root, inspect);
		return;
	}
	const pinned = await openPinnedDirectory(root);
	try {
		const { identity } = await inspectPinnedBackendGit(root, pinned);
		invariant(identity.commit === manifest.backendCommit, "backend commit does not match");
		invariant(identity.tree === manifest.backendTree, "backend tree does not match");
	} finally {
		await pinned.close();
	}
}
export function verifyPinnedReferences(
	manifest: BreadboardSdkProvenance,
	packageJson: { readonly dependencies?: Readonly<Record<string, string>> },
	lockText: string,
): void {
	invariant(
		manifest.artifactPath.startsWith("./") && !isAbsolute(manifest.artifactPath),
		"artifact path must be repository-relative",
	);
	const dependency = `file:${manifest.artifactPath}`;
	invariant(
		packageJson.dependencies?.[manifest.packageName] === dependency,
		"package.json dependency is not the pinned artifact",
	);
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
	invariant(
		dependencies[manifest.packageName] === dependency,
		"lockfile coding-agent dependency is not the pinned artifact",
	);
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
	invariant(
		packageRecord[2] === `sha512-${manifest.artifactSha512Base64}`,
		"lockfile integrity does not match the manifest",
	);
}

async function installedFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(join(root, prefix), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		invariant(!entry.isSymbolicLink(), `installed package contains symlink ${relative}`);
		if (entry.isDirectory()) files.push(...(await installedFiles(root, relative)));
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
	inspect?: BackendGitInspection,
): Promise<BreadboardSdkProvenance> {
	const manifestPath = join(packageRoot, "breadboard-sdk-provenance.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BreadboardSdkProvenance;
	invariant(manifest.schemaVersion === "p30.breadboard-sdk-provenance.v1", "unexpected manifest schema");
	invariant(manifest.packageName === "@breadboard/sdk", "unexpected package name");
	invariant(manifest.packageVersion === "0.2.5", "unexpected package version");
	invariant(/^([0-9a-f]{64})$/.test(manifest.artifactSha256), "invalid artifact SHA-256");
	invariant(
		manifest.backendRootEnvironmentVariable === "BREADBOARD_P30_BACKEND_ROOT",
		"unexpected backend root environment variable",
	);

	const artifactPath = resolve(packageRoot, manifest.artifactPath);
	const artifactRelative = relative(packageRoot, artifactPath);
	invariant(
		artifactRelative !== "" && !artifactRelative.startsWith("..") && !isAbsolute(artifactRelative),
		"artifact escapes the package root",
	);
	const artifactStat = await lstat(artifactPath);
	invariant(
		artifactStat.isFile() && artifactStat.nlink === 1 && !artifactStat.isSymbolicLink(),
		"artifact is not a single-link regular file",
	);
	invariant(artifactStat.size === manifest.artifactSizeBytes, "artifact size changed");
	const artifact = await readFile(artifactPath);
	invariant(sha256(artifact) === manifest.artifactSha256, "artifact SHA-256 changed");
	invariant(
		createHash("sha512").update(artifact).digest("base64") === manifest.artifactSha512Base64,
		"artifact SHA-512 changed",
	);

	const workspaceRoot = resolve(packageRoot, "../..");
	const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const lockText = await readFile(join(workspaceRoot, "bun.lock"), "utf8");
	verifyPinnedReferences(manifest, packageJson, lockText);
	await verifyBackendIdentity(manifest, backendRoot ?? process.env[manifest.backendRootEnvironmentVariable], inspect);

	const installedRoot = join(workspaceRoot, "node_modules", "@breadboard", "sdk");
	const expectedFiles = Object.keys(manifest.installedFilesSha256).sort();
	const actualFiles = await installedFiles(installedRoot);
	invariant(
		JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
		"installed file inventory differs from the artifact manifest",
	);
	for (const relative of expectedFiles) {
		const bytes = await readFile(join(installedRoot, relative));
		invariant(sha256(bytes) === manifest.installedFilesSha256[relative], `installed bytes changed for ${relative}`);
	}
	const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
		types?: string;
	};
	invariant(installedPackage.name === manifest.packageName, "installed package name changed");
	invariant(installedPackage.version === manifest.packageVersion, "installed package version changed");
	invariant(installedPackage.types === "dist/index.d.ts", "installed package types entry changed");
	return manifest;
}

if (import.meta.main) {
	const manifest = await verifyBreadboardSdkProvenance();
	process.stdout.write(
		`${JSON.stringify({
			package: `${manifest.packageName}@${manifest.packageVersion}`,
			artifactSha256: manifest.artifactSha256,
			backendCommit: manifest.backendCommit,
			backendTree: manifest.backendTree,
			installedFiles: Object.keys(manifest.installedFilesSha256).length,
		})}\n`,
	);
}
