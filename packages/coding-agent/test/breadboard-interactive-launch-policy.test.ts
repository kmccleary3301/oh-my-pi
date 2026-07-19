import { describe, expect, test } from "bun:test";
import { validateBreadboardInteractiveLaunch } from "../src/breadboard/interactive-launch-policy";
import { parseArgs } from "../src/cli/args";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

describe("BreadBoard interactive launch policy", () => {
	test("accepts direct create and opaque full-ID attach launches", () => {
		expect(validateBreadboardInteractiveLaunch(parseArgs([]), undefined)).toBeNull();
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--resume", sessionId]), undefined)).toBeNull();
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--resume", "opaque-session-id"]), undefined)).toBeNull();
	});

	test("rejects ambiguous and donor session selectors", () => {
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--resume"]), undefined)).toContain("full canonical");
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--continue"]), undefined)).toContain("continue");
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--fork", sessionId]), undefined)).toContain("fork");
	});

	test("rejects initial input, files, piped input, and unknown flags", () => {
		expect(validateBreadboardInteractiveLaunch(parseArgs(["hello"]), undefined)).toContain("Initial-message");
		expect(validateBreadboardInteractiveLaunch(parseArgs(["@prompt.md"]), undefined)).toContain(
			"File and attachment",
		);
		expect(validateBreadboardInteractiveLaunch(parseArgs([]), "piped input")).toContain("Piped input");
		expect(validateBreadboardInteractiveLaunch(parseArgs(["--not-a-product-flag"]), undefined)).not.toBeNull();
	});
});
