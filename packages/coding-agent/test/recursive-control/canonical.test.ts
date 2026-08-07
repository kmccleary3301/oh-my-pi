import { describe, expect, test } from "bun:test";
import {
	boundedRecursiveText,
	canonicalRecursiveJson,
	normalizeRecursiveJson,
	recursiveFingerprint,
	sanitizeRecursiveText,
} from "../../src/recursive-control/canonical";

describe("recursive canonical values", () => {
	test("stabilizes object ordering and fingerprints", () => {
		expect(canonicalRecursiveJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
		expect(recursiveFingerprint("fixture", { b: 2, a: 1 })).toBe(recursiveFingerprint("fixture", { a: 1, b: 2 }));
	});

	test("rejects cycles, opaque objects, undefined array members, and non-finite numbers", () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(() => normalizeRecursiveJson(cyclic)).toThrow("cyclic");
		expect(() => normalizeRecursiveJson(new Date())).toThrow("plain JSON object");
		expect(() => normalizeRecursiveJson([undefined])).toThrow("undefined");
		expect(() => normalizeRecursiveJson(Number.POSITIVE_INFINITY)).toThrow("finite");
	});

	test("strips terminal control sequences before content reaches the model", () => {
		expect(sanitizeRecursiveText("ok\u001b[31m red\u0000")).toBe("ok red");
		expect(boundedRecursiveText("x".repeat(100), 24).text.length).toBeLessThanOrEqual(24);
	});
});
