import { expect, test } from "bun:test";
import { LifecycleE4ClientError } from "@breadboard/sdk";
import { retryAmbiguousReplay } from "./helpers/retry-ambiguous-replay";

const statusZero = (): LifecycleE4ClientError =>
	new LifecycleE4ClientError({
		kind: "http",
		status: 0,
		code: null,
		correlation: {},
		body: "[redacted]",
	});

test("retries two ambiguous status-zero losses and succeeds on exactly the third attempt", async () => {
	let attempts = 0;
	const result = await retryAmbiguousReplay(async () => {
		attempts++;
		if (attempts < 3) throw statusZero();
		return "recovered";
	});
	expect(result).toBe("recovered");
	expect(attempts).toBe(3);
});

test("does not retry a non-ambiguous failure", async () => {
	let attempts = 0;
	const definitive = new LifecycleE4ClientError({
		kind: "auth",
		status: 401,
		code: "unauthorized",
		correlation: {},
		body: "[redacted]",
	});
	await expect(
		retryAmbiguousReplay(async () => {
			attempts++;
			throw definitive;
		}),
	).rejects.toBe(definitive);
	expect(attempts).toBe(1);
});

test("stops after exactly three ambiguous failures and throws the final error", async () => {
	let attempts = 0;
	const failures = [
		new LifecycleE4ClientError({ kind: "timeout" }),
		new LifecycleE4ClientError({ kind: "caller-abort" }),
		statusZero(),
	];
	await expect(
		retryAmbiguousReplay(async () => {
			const failure = failures[attempts];
			attempts++;
			throw failure;
		}),
	).rejects.toBe(failures[2]);
	expect(attempts).toBe(3);
});
