import type { RecursiveJsonValue } from "./contracts";

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: RecursiveJsonValue): RecursiveJsonValue {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, RecursiveJsonValue> = {};
	for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]!);
	return result;
}

export function canonicalRecursiveJson(value: unknown): string {
	return JSON.stringify(canonicalize(normalizeRecursiveJson(value)));
}

export function recursiveFingerprint(namespace: string, value: unknown): string {
	const digest = Bun.SHA256.hash(canonicalRecursiveJson(value), "hex");
	return `omp-${namespace}/v1:sha256:${digest}`;
}

export function recursiveId(prefix: string, value: unknown): string {
	return `${prefix}_${Bun.SHA256.hash(canonicalRecursiveJson(value), "hex").slice(0, 24)}`;
}

export function normalizeRecursiveJson(value: unknown, path = "$", depth = 0): RecursiveJsonValue {
	return normalizeRecursiveJsonInner(value, path, depth, new Set<object>());
}

function normalizeRecursiveJsonInner(
	value: unknown,
	path: string,
	depth: number,
	seen: Set<object>,
): RecursiveJsonValue {
	if (depth > 64) throw new Error(`${path} exceeds the recursive-control JSON depth limit`);
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error(`${path} contains a cyclic array`);
		seen.add(value);
		try {
			return value.map((item, index) => {
				if (item === undefined) throw new Error(`${path}[${index}] contains undefined`);
				return normalizeRecursiveJsonInner(item, `${path}[${index}]`, depth + 1, seen);
			});
		} finally {
			seen.delete(value);
		}
	}
	if (typeof value === "object") {
		if (!isPlainObject(value)) {
			throw new Error(`${path} must be a plain JSON object, not ${value.constructor?.name ?? "an opaque object"}`);
		}
		if (seen.has(value)) throw new Error(`${path} contains a cyclic object`);
		seen.add(value);
		const result: Record<string, RecursiveJsonValue> = {};
		try {
			for (const [key, item] of Object.entries(value)) {
				if (item === undefined) continue;
				result[key] = normalizeRecursiveJsonInner(item, `${path}.${key}`, depth + 1, seen);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	}
	throw new Error(`${path} contains a non-JSON value (${typeof value})`);
}

export function sanitizeRecursiveText(value: string): string {
	return value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function boundedRecursiveText(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive finite number");
	const limit = Math.trunc(maxChars);
	const sanitized = sanitizeRecursiveText(value);
	if (sanitized.length <= limit) return { text: sanitized, truncated: false };
	const omitted = sanitized.length - limit;
	const suffix = `\n[…${omitted} characters omitted…]`;
	const prefixChars = Math.max(0, limit - suffix.length);
	return {
		text: `${sanitized.slice(0, prefixChars)}${suffix.slice(0, limit - prefixChars)}`,
		truncated: true,
	};
}
