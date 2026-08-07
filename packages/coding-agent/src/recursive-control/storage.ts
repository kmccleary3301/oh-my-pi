import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

const writeChains = new Map<string, Promise<void>>();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	if (process.platform !== "win32") await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export function encodeRecursiveProjectKey(cwd: string): string {
	if (typeof cwd !== "string" || cwd.trim() === "") {
		throw new Error("recursive-control requires a non-empty session cwd");
	}
	const normalized = path.resolve(cwd).replaceAll("\\", "/");
	const readable = normalized
		.replace(/^\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-72);
	return `${readable || "project"}-${Bun.SHA256.hash(normalized, "hex").slice(0, 12)}`;
}

export function recursiveControlProjectDir(cwd: string, rootOverride?: string): string {
	const root = rootOverride ?? path.join(getAgentDir(), "recursive-control");
	return path.join(root, encodeRecursiveProjectKey(cwd));
}

export async function readPrivateJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return fallback;
		throw new Error(
			`Failed to read recursive-control state ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
	await ensurePrivateDirectory(path.dirname(filePath));
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: PRIVATE_FILE_MODE,
			flag: "wx",
		});
		if (process.platform !== "win32") await fs.chmod(tempPath, PRIVATE_FILE_MODE);
		try {
			await fs.rename(tempPath, filePath);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String(error.code) : "";
			if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) throw error;
			await fs.rm(filePath, { force: true });
			await fs.rename(tempPath, filePath);
		}
		if (process.platform !== "win32") await fs.chmod(filePath, PRIVATE_FILE_MODE);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export async function withSerializedPath<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(filePath) ?? Promise.resolve();
	const { promise: gate, resolve } = Promise.withResolvers<void>();
	const chain = previous.then(() => gate);
	writeChains.set(filePath, chain);
	await previous;
	try {
		await ensurePrivateDirectory(path.dirname(filePath));
		return await withFileLock(filePath, operation, { retries: 200, retryDelayMs: 50 });
	} finally {
		resolve();
		if (writeChains.get(filePath) === chain) writeChains.delete(filePath);
	}
}
