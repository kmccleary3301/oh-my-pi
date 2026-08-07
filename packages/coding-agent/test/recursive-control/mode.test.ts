import { describe, expect, test } from "bun:test";
import {
	applyRecursiveMode,
	type RecursiveModeSession,
	resolveRecursiveMode,
	resolveStrictRootTools,
} from "../../src/recursive-control/mode";

function baseInput(overrides: Partial<Parameters<typeof resolveRecursiveMode>[0]> = {}) {
	return {
		requested: "strict",
		enabled: true,
		modelId: "vendor/model-a",
		allowlist: ["vendor/model-a"],
		allowAnyModel: false,
		...overrides,
	};
}

function fakeSession(initial: string[]): RecursiveModeSession & { slate: string[] } {
	return {
		slate: [...initial],
		getActiveToolNames() {
			return [...this.slate];
		},
		async setActiveToolsByName(names: string[]) {
			this.slate = [...names];
		},
	};
}

describe("recursive work mode", () => {
	test("defaults to hybrid when nothing is requested", () => {
		expect(resolveRecursiveMode(baseInput({ requested: undefined })).mode).toBe("hybrid");
		expect(resolveRecursiveMode(baseInput({ requested: "nonsense" })).mode).toBe("hybrid");
	});

	test("grants strict for an allowlisted model", () => {
		const resolution = resolveRecursiveMode(baseInput());

		expect(resolution.mode).toBe("strict");
		expect(resolution.downgradeReason).toBeUndefined();
	});

	test("refuses strict for a model outside the allowlist", () => {
		const resolution = resolveRecursiveMode(baseInput({ modelId: "vendor/model-b" }));

		expect(resolution.mode).toBe("hybrid");
		expect(resolution.requested).toBe("strict");
		expect(resolution.downgradeReason).toContain("vendor/model-b");
	});

	test("refuses strict when the allowlist is empty rather than guessing capability", () => {
		const resolution = resolveRecursiveMode(baseInput({ allowlist: [] }));

		expect(resolution.mode).toBe("hybrid");
		expect(resolution.downgradeReason).toContain("recursive.strictModels");
	});

	test("honors the explicit any-model override", () => {
		const resolution = resolveRecursiveMode(baseInput({ allowlist: [], allowAnyModel: true }));

		expect(resolution.mode).toBe("strict");
	});

	test("refuses strict while recursive control is disabled", () => {
		const resolution = resolveRecursiveMode(baseInput({ enabled: false, allowAnyModel: true }));

		expect(resolution.mode).toBe("hybrid");
		expect(resolution.downgradeReason).toContain("disabled");
	});

	test("always keeps eval in the strict slate", () => {
		// Without eval the model cannot reach omp.* and the session could not act.
		expect(resolveStrictRootTools(["read"])).toContain("eval");
		expect(resolveStrictRootTools([])).toEqual(["eval"]);
		expect(resolveStrictRootTools(undefined)).toEqual(["eval"]);
	});
});

describe("recursive mode slate", () => {
	test("narrows the slate on strict and restores the original on hybrid", async () => {
		const session = fakeSession(["read", "edit", "eval", "bash"]);

		await applyRecursiveMode(session, "strict", ["eval"]);
		expect(session.slate).toEqual(["eval"]);

		await applyRecursiveMode(session, "hybrid", ["eval"]);
		expect(session.slate).toEqual(["read", "edit", "eval", "bash"]);
	});

	test("re-entering strict does not overwrite the original capture", async () => {
		const session = fakeSession(["read", "eval"]);

		await applyRecursiveMode(session, "strict", ["eval"]);
		await applyRecursiveMode(session, "strict", ["eval"]);
		await applyRecursiveMode(session, "hybrid", ["eval"]);

		// A second capture would have recorded ["eval"] and lost "read" forever.
		expect(session.slate).toEqual(["read", "eval"]);
	});

	test("leaving strict without a capture leaves the slate untouched", async () => {
		const session = fakeSession(["read", "eval"]);

		const result = await applyRecursiveMode(session, "hybrid", ["eval"]);

		expect(result.changed).toBe(false);
		expect(session.slate).toEqual(["read", "eval"]);
	});
});
