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
});
