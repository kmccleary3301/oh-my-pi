import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LinuxPinnedDirectoryError,
	normalizeNodeErrno,
	openLinuxPinnedDirectory,
} from "./linux-pinned-directory";
import {
	PINNED_DIRECTORY_LIMITS,
	PinnedDirectoryUnsupportedPlatformError,
	openPinnedDirectory,
	type PinnedDirectory,
} from "./pinned-directory";

const roots: string[] = [];
const handles: PinnedDirectory[] = [];

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "linux-pinned-directory-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(handles.splice(0).map(async handle => await handle.close().catch(() => {})));
	await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("Linux pinned directory", () => {
	test("reads nested regular bytes and pinned symlinks and enumerates leaves", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "value"), "secret");
		await chmod(join(root, "nested", "value"), 0o640);
		await symlink("nested/value", join(root, "link"));

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const file = await pinned.openFile("nested/value");
		try {
			expect(await file.read(64)).toEqual(Buffer.from("secret"));
			expect((await file.stat()).mode & 0o777).toBe(0o640);
		} finally {
			await file.close();
		}
		expect(await pinned.readlink("link", 64)).toEqual(Buffer.from("nested/value"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["link", "nested/value"]);
	});

	test("pins the opened root across pathname replacement", async () => {
		const root = await temporaryDirectory();
		const parked = `${root}.parked`;
		roots.push(parked);
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "nested", "original"), "original");
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await rename(root, parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "replacement"), "replacement");
		expect(await pinned.readFile("nested/original", 64)).toEqual(Buffer.from("original"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["nested/original"]);
	});

	test("rejects unsafe paths, symlink traversal, and oversized values", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "real"));
		await writeFile(join(root, "real", "value"), "secret");
		await symlink("real", join(root, "alias"));
		await symlink("real/value", join(root, "link"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		for (const relativePath of ["", ".", "..", "/real/value", "real//value", "real/./value", "real/../value", "nul\0tail"]) {
			await expect(pinned.readFile(relativePath, 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		}
		await expect(pinned.readFile("alias/value", 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(pinned.readFile("link", 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(pinned.readFile(`${"a".repeat(PINNED_DIRECTORY_LIMITS.maxComponentBytes + 1)}/value`, 16)).rejects.toBeInstanceOf(
			LinuxPinnedDirectoryError,
		);
		await expect(pinned.readFile("real/value", PINNED_DIRECTORY_LIMITS.maxFileBytes + 1)).rejects.toBeInstanceOf(
			LinuxPinnedDirectoryError,
		);
		await expect(pinned.readlink("link", 4)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
	});

	test("enforces enumeration caps and closes descriptors idempotently", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "a"), "a");
		await writeFile(join(root, "bb"), "b");
		const pinned = await openPinnedDirectory(root);
		const file = await pinned.openFile("a");
		const fileFd = file.fd;
		const rootFd = pinned.fd;
		handles.push(pinned);

		await expect(pinned.listLeaves({ maxEntries: 1, maxPathBytes: 128 })).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 1 })).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await file.close();
		await file.close();
		expect(() => fstatSync(fileFd)).toThrow();
		await pinned.close();
		await pinned.close();
		expect(() => fstatSync(rootFd)).toThrow();
		handles.splice(handles.indexOf(pinned), 1);
	});
});

test("Linux backend fails closed off Linux x64", async () => {
	if (process.platform === "darwin" || (process.platform === "linux" && process.arch === "x64")) return;
	await expect(openLinuxPinnedDirectory(".")).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
	await expect(openPinnedDirectory(".")).rejects.toBeInstanceOf(PinnedDirectoryUnsupportedPlatformError);
});

test("normalizes Node EINTR errno variants", () => {
	expect(normalizeNodeErrno({ errno: -4 })).toBe(4);
	expect(normalizeNodeErrno({ code: "EINTR" })).toBe(4);
	expect(normalizeNodeErrno({ errno: 4 })).toBe(4);
});
