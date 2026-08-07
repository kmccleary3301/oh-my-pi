import * as path from "node:path";
import type { ToolSession } from "../tools";
import { canonicalRecursiveJson, normalizeRecursiveJson, recursiveFingerprint } from "./canonical";
import type { RecursiveJsonValue, RecursiveStateRecord, RecursiveStateScope } from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";
import { readPrivateJson, recursiveControlProjectDir, withSerializedPath, writePrivateJson } from "./storage";

interface StateFile {
	version: typeof RECURSIVE_CONTROL_VERSION;
	records: Record<string, RecursiveStateRecord>;
}

const EMPTY_STATE: StateFile = { version: RECURSIVE_CONTROL_VERSION, records: {} };
const STATE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

function validateKey(key: string): string {
	const normalized = key.trim();
	if (!STATE_KEY_RE.test(normalized)) {
		throw new Error("recursive state keys must be 1-128 characters and contain only letters, numbers, . _ : / -");
	}
	return normalized;
}

export interface RecursiveStateStoreOptions {
	maxValueBytes: number;
	rootDir?: string;
}

/** JSON-only exact control state. This is not a transcript or arbitrary-object snapshot. */
export class RecursiveStateStore {
	readonly #session: ToolSession;
	readonly #maxValueBytes: number;
	readonly #projectDir: string;

	constructor(session: ToolSession, options: RecursiveStateStoreOptions) {
		this.#session = session;
		this.#maxValueBytes = Math.max(64, Math.trunc(options.maxValueBytes));
		this.#projectDir = recursiveControlProjectDir(session.cwd, options.rootDir);
	}

	#file(scope: RecursiveStateScope): string {
		if (scope === "project") return path.join(this.#projectDir, "project-state.json");
		const sessionId = this.#session.getSessionId?.();
		if (!sessionId) throw new Error("session-scoped recursive state requires a persisted session id");
		const safeId = Bun.SHA256.hash(sessionId, "hex").slice(0, 24);
		return path.join(this.#projectDir, "sessions", `${safeId}.json`);
	}

	async #load(scope: RecursiveStateScope): Promise<StateFile> {
		const loaded = await readPrivateJson<StateFile>(this.#file(scope), EMPTY_STATE);
		if (loaded.version !== RECURSIVE_CONTROL_VERSION || !loaded.records || typeof loaded.records !== "object") {
			throw new Error(`Unsupported or corrupt recursive state file for ${scope} scope`);
		}
		return { version: RECURSIVE_CONTROL_VERSION, records: { ...loaded.records } };
	}

	async get(scope: RecursiveStateScope, key: string): Promise<RecursiveStateRecord | null> {
		const normalized = validateKey(key);
		return (await this.#load(scope)).records[normalized] ?? null;
	}

	async list(scope: RecursiveStateScope): Promise<RecursiveStateRecord[]> {
		return Object.values((await this.#load(scope)).records).sort((left, right) => left.key.localeCompare(right.key));
	}

	async put(
		scope: RecursiveStateScope,
		key: string,
		value: unknown,
		options: { expectedFingerprint?: string } = {},
	): Promise<RecursiveStateRecord> {
		const normalizedKey = validateKey(key);
		const normalizedValue = normalizeRecursiveJson(value);
		const bytes = Buffer.byteLength(canonicalRecursiveJson(normalizedValue), "utf8");
		if (bytes > this.#maxValueBytes) {
			throw new Error(`recursive state value is ${bytes} bytes; maximum is ${this.#maxValueBytes}`);
		}
		const filePath = this.#file(scope);
		return await withSerializedPath(filePath, async () => {
			const file = await this.#load(scope);
			const existing = file.records[normalizedKey];
			if (options.expectedFingerprint !== undefined && existing?.fingerprint !== options.expectedFingerprint) {
				throw new Error(
					`recursive state conflict for ${normalizedKey}: expected ${options.expectedFingerprint}, current ${existing?.fingerprint ?? "missing"}`,
				);
			}
			const record: RecursiveStateRecord = {
				version: RECURSIVE_CONTROL_VERSION,
				scope,
				key: normalizedKey,
				value: normalizedValue,
				fingerprint: recursiveFingerprint("state", { scope, key: normalizedKey, value: normalizedValue }),
				updatedAt: new Date().toISOString(),
			};
			file.records[normalizedKey] = record;
			await writePrivateJson(filePath, file);
			return record;
		});
	}

	async delete(
		scope: RecursiveStateScope,
		key: string,
		options: { expectedFingerprint?: string } = {},
	): Promise<boolean> {
		const normalizedKey = validateKey(key);
		const filePath = this.#file(scope);
		return await withSerializedPath(filePath, async () => {
			const file = await this.#load(scope);
			const existing = file.records[normalizedKey];
			if (!existing) {
				if (options.expectedFingerprint !== undefined) {
					throw new Error(
						`recursive state conflict for ${normalizedKey}: expected ${options.expectedFingerprint}, current missing`,
					);
				}
				return false;
			}
			if (options.expectedFingerprint !== undefined && existing.fingerprint !== options.expectedFingerprint) {
				throw new Error(
					`recursive state conflict for ${normalizedKey}: expected ${options.expectedFingerprint}, current ${existing.fingerprint}`,
				);
			}
			delete file.records[normalizedKey];
			await writePrivateJson(filePath, file);
			return true;
		});
	}

	async export(scope: RecursiveStateScope): Promise<Record<string, RecursiveJsonValue>> {
		return Object.fromEntries((await this.list(scope)).map(record => [record.key, record.value]));
	}
}
