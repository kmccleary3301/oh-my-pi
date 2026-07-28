import { describe, expect, test } from "bun:test";
import { connectCanonicalBreadboardEnginePort } from "./engine-port";
import type { BreadboardRunConfig } from "./lifecycle/run-config";

const offConfig = {
	mode: "off",
	workspaceId: `workspace:v1:sha256:${"0".repeat(64)}` as BreadboardRunConfig["workspaceId"],
	startupTimeoutMs: 1_000,
	requestTimeoutMs: 1_000,
	sources: {
		mode: "derived-default",
		endpoint: "derived-default",
		auth: "derived-default",
		tls: "derived-default",
		engineArtifact: "derived-default",
		workspaceId: "derived-default",
		startupTimeoutMs: "derived-default",
		requestTimeoutMs: "derived-default",
		ownerExitPolicy: "derived-default",
		sessionConfigPath: "derived-default",
	},
	configDigest: `sha256:${"0".repeat(64)}` as BreadboardRunConfig["configDigest"],
} satisfies BreadboardRunConfig;

const unavailableLocalConfig = {
	...offConfig,
	mode: "local-owned",
	endpoint: "http://127.0.0.1:41739",
	ownerExitPolicy: "attached",
} satisfies BreadboardRunConfig;

describe("connectCanonicalBreadboardEnginePort", () => {
	test("connects through the lifecycle supervisor and reports non-ready ownership results", async () => {
		const failures: string[] = [];
		const connection = await connectCanonicalBreadboardEnginePort(offConfig, {
			onLateSessionCloseError: () => {},
			onLifecycleFailure: failure => failures.push(failure.state.name),
		});

		expect(connection.kind).toBe("failure");
		if (connection.kind === "failure") expect(connection.result.kind).toBe("off");
		expect(failures).toEqual([]);
	});

	test("returns synchronous startup failures without invoking the late-failure callback", async () => {
		const failures: string[] = [];
		const connection = await connectCanonicalBreadboardEnginePort(unavailableLocalConfig, {
			onLateSessionCloseError: () => {},
			onLifecycleFailure: failure => failures.push(failure.state.name),
		});

		expect(connection.kind).toBe("failure");
		if (connection.kind === "failure") expect(connection.result.kind).toBe("failure");
		expect(failures).toEqual([]);
	});
});
