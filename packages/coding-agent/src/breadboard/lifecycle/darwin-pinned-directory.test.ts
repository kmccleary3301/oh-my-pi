import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DARWIN_PINNED_DIRECTORY_LIMITS,
	DarwinPinnedDirectoryError,
	openPinnedDirectory,
	type PinnedDirectory,
} from "./darwin-pinned-directory";

const roots: string[] = [];
const handles: PinnedDirectory[] = [];

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "darwin-pinned-directory-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(handles.splice(0).map(async handle => await handle.close().catch(() => {})));
	await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin")("Darwin pinned directory", () => {
	test("whole-root rename, substitution, and restoration cannot redirect reads or enumeration", async () => {
		const root = await temporaryDirectory();
		const parked = `${root}.parked`;
		roots.push(parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "original.txt"), "original dirty bytes");

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const identity = await pinned.stat();
		const descriptorStat = fstatSync(pinned.fd, { bigint: true });
		expect(identity.dev).toBe(descriptorStat.dev);
		expect(identity.ino).toBe(descriptorStat.ino);
		expect(BigInt(identity.mode)).toBe(descriptorStat.mode);
		await rename(root, parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "replacement.txt"), "replacement bytes");

		expect(await pinned.readFile("nested/original.txt", 64)).toEqual(Buffer.from("original dirty bytes"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["nested/original.txt"]);
		expect((await pinned.stat()).dev).toBe(identity.dev);
		expect((await pinned.stat()).ino).toBe(identity.ino);

		await rm(root, { recursive: true });
		await rename(parked, root);
		expect(await pinned.readFile("nested/original.txt", 64)).toEqual(Buffer.from("original dirty bytes"));
	});

	test("reads nested regular bytes and mode, symlink targets, active Git exclude, and untracked leaves", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".git", "info"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, ".git", "info", "exclude"), "ignored.tmp\n");
		await writeFile(join(root, "src", "tracked.ts"), "export {};\n");
		await chmod(join(root, "src", "tracked.ts"), 0o640);
		await writeFile(join(root, "untracked.txt"), "dirty\n");
		await symlink("src/tracked.ts", join(root, "tracked-link"));

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const file = await pinned.openFile("src/tracked.ts");
		try {
			expect(await file.read(64)).toEqual(Buffer.from("export {};\n"));
			expect((await file.stat()).mode & 0o777).toBe(0o640);
		} finally {
			await file.close();
		}
		expect(await pinned.readFile(".git/info/exclude", 64)).toEqual(Buffer.from("ignored.tmp\n"));
		expect(await pinned.readlink("tracked-link", 64)).toEqual(Buffer.from("src/tracked.ts"));
		expect(await pinned.listLeaves({ maxEntries: 16, maxPathBytes: 128 })).toEqual([
			".git/info/exclude",
			"src/tracked.ts",
			"tracked-link",
			"untracked.txt",
		]);
	});

	test("rejects symlinked directory components and symlink terminal reads", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "real"));
		await writeFile(join(root, "real", "value"), "secret");
		await symlink("real", join(root, "alias"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await expect(pinned.readFile("alias/value", 64)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readFile("alias", 64)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		expect(await pinned.readlink("alias", 64)).toEqual(Buffer.from("real"));
	});

	test("rejects unsafe and oversized relative paths before native traversal", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "file"), "ok");
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		for (const path of ["", ".", "..", "/file", "a//b", "a/./b", "a/../b", "nul\0tail"]) {
			await expect(pinned.readFile(path, 16)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		}
		await expect(
			pinned.readFile(`${"a".repeat(DARWIN_PINNED_DIRECTORY_LIMITS.maxComponentBytes + 1)}/file`, 16),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
	});

	test("enforces file, symlink, entry, path, and total-output caps", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "large"), "12345");
		await writeFile(join(root, "nested", "leaf"), "x");
		await symlink("target-name", join(root, "link"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await expect(pinned.readFile("large", 4)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readlink("link", 4)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.listLeaves({ maxEntries: 2, maxPathBytes: 128 })).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
		await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 8 })).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
		await expect(
			pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128, maxTotalPathBytes: 8 }),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readFile("large", DARWIN_PINNED_DIRECTORY_LIMITS.maxFileBytes + 1)).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
	});

	test("rejects special directory entries during enumeration", async () => {
		const root = await temporaryDirectory();
		const socketPath = join(root, "special.sock");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		try {
			await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).rejects.toBeInstanceOf(
				DarwinPinnedDirectoryError,
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close(error => (error === undefined ? resolve() : reject(error))),
			);
		}
	});

	test("closes file and directory descriptors idempotently", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "file"), "ok");
		const pinned = await openPinnedDirectory(root);
		const file = await pinned.openFile("file");
		const fileFd = file.fd;
		const rootFd = pinned.fd;

		await file.close();
		await file.close();
		expect(() => fstatSync(fileFd)).toThrow();
		await pinned.close();
		await pinned.close();
		expect(() => fstatSync(rootFd)).toThrow();
	});

	test("rejects a symlink as the opened root", async () => {
		const parent = await temporaryDirectory();
		await mkdir(join(parent, "real"));
		await symlink("real", join(parent, "alias"));
		await expect(openPinnedDirectory(join(parent, "alias"))).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
	});
});
