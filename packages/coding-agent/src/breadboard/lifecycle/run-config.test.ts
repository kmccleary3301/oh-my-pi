import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { EngineArtifact } from "./run-config";
import {
	BreadboardRunConfigError,
	loadSelectedBreadboardConfig,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "./run-config";

const workspaceId: `workspace:v1:sha256:${string}` = `workspace:v1:sha256:${"a".repeat(64)}`;
const artifact: EngineArtifact = {
	executablePath: "/usr/bin/false",
	argv: ["--serve"],
	argvSha256: "sha256:b76470afe32d50ae8194866d39a872e4dc846e89ac409f390884db522242a6b4",
	executableSha256: `sha256:${"b".repeat(64)}`,
	engineSourceSha256: `sha256:${"c".repeat(64)}`,
	servedBackendCommit: "d".repeat(40),
};
const baseInput = {
	workspacePath: "/workspace",
	canonicalizeWorkspace: () => "/canonical/workspace",
	environment: {} as Record<string, string | undefined>,
};

function configError(run: () => unknown): BreadboardRunConfigError {
	try {
		run();
	} catch (error) {
		if (error instanceof BreadboardRunConfigError) return error;
		throw error;
	}
	throw new Error("expected BreadboardRunConfigError");
}

describe("parseSelectedBreadboardConfig", () => {
	test("preserves supported own enumerable settings", () => {
		const selected = {
			engineMode: "local-external",
			baseUrl: "http://127.0.0.1:7777",
			auth: { kind: "keychain-reference", reference: "breadboard-test" },
			tls: { kind: "local-loopback" },
			engineArtifact: artifact,
			workspaceId,
			startupTimeoutMs: 5000,
			requestTimeoutMs: 9000,
			ownerExitPolicy: "attached",
			sessionConfigPath: "/tmp/session.yaml",
		};

		expect(parseSelectedBreadboardConfig(selected)).toEqual(selected);
	});

	test("rejects an unsupported own enumerable field before reading supported values", () => {
		let engineModeRead = false;
		const selected = {
			get engineMode() {
				engineModeRead = true;
				return "off";
			},
			engineMod: "off",
		};

		const error = configError(() => parseSelectedBreadboardConfig(selected));
		expect(error).toMatchObject({ code: "invalid_selected_config", field: "mode" });
		expect(error.message).toContain('"engineMod"');
		expect(engineModeRead).toBe(false);
	});

	test("ignores inherited fields rather than rejecting or promoting them", () => {
		const selected = Object.assign(
			Object.create({
				engineMode: "remote",
				engineMod: "remote",
			}) as Record<string, unknown>,
			{ baseUrl: "http://127.0.0.1:7777" },
		);

		expect(parseSelectedBreadboardConfig(selected)).toEqual({ baseUrl: "http://127.0.0.1:7777" });
	});

	test("rejects arrays and own enumerable symbol fields", () => {
		expect(configError(() => parseSelectedBreadboardConfig([])).code).toBe("invalid_selected_config");

		const unsupported = Symbol('engineMod"\n');
		const error = configError(() => parseSelectedBreadboardConfig({ engineMode: "off", [unsupported]: true }));
		expect(error.code).toBe("invalid_selected_config");
		expect(error.message).toContain(JSON.stringify(String(unsupported)));
	});

	test("ignores non-enumerable fields", () => {
		const selected = { engineMode: "off" };
		Object.defineProperties(selected, {
			engineMod: { enumerable: false, value: "remote" },
			requestTimeoutMs: { enumerable: false, value: 9000 },
		});

		expect(parseSelectedBreadboardConfig(selected)).toEqual({ engineMode: "off" });
	});
});

describe("resolveBreadboardRunConfig", () => {
	test("applies independent CLI, environment, selected-config, and derived precedence", () => {
		const config = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "local-external", engineUrl: "http://LOCALHOST:8080/v1/" },
			environment: {
				BREADBOARD_ENGINE_MODE: "remote",
				BREADBOARD_API_URL: "https://environment.example/v1",
				BREADBOARD_STARTUP_TIMEOUT_MS: "4000",
			},
			selectedConfig: {
				engineMode: "remote",
				baseUrl: "https://selected.example/v1",
				startupTimeoutMs: 5000,
				requestTimeoutMs: 9000,
				workspaceId,
				sessionConfigPath: "/usr/bin/false",
			},
		});
		expect(config.mode).toBe("local-external");
		expect(config.endpoint).toBe("http://localhost:8080/v1");
		expect(config.startupTimeoutMs).toBe(4000);
		expect(config.requestTimeoutMs).toBe(9000);
		expect(config.workspaceId).toBe(workspaceId);
		expect(config.sessionConfigPath).toBe("/usr/bin/false");
		expect(config.sources).toMatchObject({
			mode: "cli",
			endpoint: "cli",
			startupTimeoutMs: "environment",
			requestTimeoutMs: "selected-config",
			workspaceId: "selected-config",
			sessionConfigPath: "selected-config",
		});
	});

	test("infers only the three governed defaults and requires explicit local-external endpoint", () => {
		const localExternal = resolveBreadboardRunConfig({ ...baseInput, cli: { engineUrl: "http://127.0.0.2:9000" } });
		expect(localExternal.mode).toBe("local-external");
		const remote = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineUrl: "https://engine.example" },
			environment: { BREADBOARD_API_TOKEN: "synthetic-secret-value" },
		});
		expect(remote.mode).toBe("remote");
		expect(
			configError(() => resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "local-external" } })).code,
		).toBe("missing_endpoint");
	});

	test("requires explicit typed artifact identity for local-owned", () => {
		const missing = configError(() => resolveBreadboardRunConfig(baseInput));
		expect(missing.code).toBe("missing_engine_artifact");
		const config = resolveBreadboardRunConfig({ ...baseInput, selectedConfig: { engineArtifact: artifact } });
		expect(config.mode).toBe("local-owned");
		expect(config.endpoint).toBe("http://127.0.0.1:7777");
		expect(config.engineArtifact).toEqual(artifact);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.engineArtifact?.argv)).toBe(true);
	});

	test("rejects aliases, URL credentials, conflicts, and wrong field types", () => {
		expect(
			configError(() => resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "external" } })).code,
		).toBe("invalid_mode");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineUrl: "https://user:pass@example.test" },
					environment: { BREADBOARD_API_TOKEN: "synthetic-secret-value" },
				}),
			).code,
		).toBe("invalid_url");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "off", engineUrl: "http://127.0.0.1" } }),
			).code,
		).toBe("mode_endpoint_conflict");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "remote", engineUrl: "http://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "synthetic-secret-value" },
				}),
			).code,
		).toBe("mode_endpoint_conflict");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "too-short" },
				}),
			).code,
		).toBe("invalid_auth");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "synthetic secret value" },
				}),
			).code,
		).toBe("invalid_auth");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "off" },
					selectedConfig: { requestTimeoutMs: "nope" },
				}),
			).code,
		).toBe("invalid_timeout");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "off" },
					selectedConfig: { engineMod: "remote" } as never,
				}),
			).code,
		).toBe("invalid_selected_config");
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "off" },
					selectedConfig: { sessionConfigPath: " unsafe " },
				}),
			).code,
		).toBe("invalid_session_config");
	});

	test("binds remote HTTPS authentication and fails unsupported trust inputs closed", () => {
		const config = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "remote", engineUrl: "https://ENGINE.example:443/api/" },
			environment: { BREADBOARD_API_TOKEN: "synthetic-secret-value" },
			selectedConfig: { tls: { kind: "system-trust" } },
		});
		expect(config.endpoint).toBe("https://engine.example/api");
		expect(config.auth?.kind).toBe("process-secret");
		expect(config.tls).toEqual({ kind: "system-trust" });
		expect(JSON.stringify({ digest: config.configDigest, sources: config.sources })).not.toContain(
			"synthetic-secret-value",
		);
		const differentCredential = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "remote", engineUrl: "https://ENGINE.example:443/api/" },
			environment: { BREADBOARD_API_TOKEN: "different-synthetic-secret" },
			selectedConfig: { tls: { kind: "system-trust" } },
		});
		expect(differentCredential.configDigest).toBe(config.configDigest);
		expect(
			configError(() =>
				resolveBreadboardRunConfig({
					...baseInput,
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					selectedConfig: { auth: { kind: "process-secret", value: "stored-secret" } },
				}),
			).code,
		).toBe("invalid_auth");
	});

	test("config digest excludes raw credential references while retaining auth kind and source", () => {
		const first = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example" },
			selectedConfig: { auth: { kind: "keychain-reference", reference: "account/sentinel-alpha" } },
		});
		const changedReference = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example" },
			selectedConfig: { auth: { kind: "keychain-reference", reference: "account/sentinel-beta" } },
		});
		const changedKind = resolveBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example" },
			selectedConfig: { auth: { kind: "mtls-reference", reference: "account/sentinel-alpha" } },
		});
		expect(changedReference.configDigest).toBe(first.configDigest);
		expect(changedKind.configDigest).not.toBe(first.configDigest);
	});

	test("off resolves without endpoint, auth, TLS, artifact, or owner policy", () => {
		const config = resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "off" } });
		expect(config).toMatchObject({ mode: "off" });
		expect(config.endpoint).toBeUndefined();
		expect(config.auth).toBeUndefined();
		expect(config.tls).toBeUndefined();
		expect(config.engineArtifact).toBeUndefined();
		expect(config.ownerExitPolicy).toBeUndefined();
	});
	test("canonicalizes executable paths and binds immutable length-delimited argv identity", () => {
		const argv = ["--serve"];
		const canonical = resolveBreadboardRunConfig({
			...baseInput,
			selectedConfig: { engineArtifact: { ...artifact, executablePath: "/var/../usr/bin/false", argv } },
		});
		const distinct = resolveBreadboardRunConfig({
			...baseInput,
			selectedConfig: { engineArtifact: { ...artifact, argv: ["--ser", "ve"] } },
		});
		const direct = resolveBreadboardRunConfig({
			...baseInput,
			selectedConfig: { engineArtifact: artifact },
		});
		argv[0] = "--mutated";
		expect(canonical.engineArtifact).toMatchObject({
			executablePath: "/usr/bin/false",
			argv: ["--serve"],
			argvSha256: "sha256:b76470afe32d50ae8194866d39a872e4dc846e89ac409f390884db522242a6b4",
		});
		expect(canonical.configDigest).toBe(direct.configDigest);
		expect(distinct.engineArtifact?.argvSha256).not.toBe(canonical.engineArtifact?.argvSha256);
		expect(distinct.configDigest).not.toBe(canonical.configDigest);
	});

	test("loads the BreadBoard namespace from OMP's canonical YAML config", async () => {
		using tempDir = TempDir.createSync("@breadboard-run-config-");
		const configPath = `${tempDir.path()}/config.yml`;
		await Bun.write(
			configPath,
			"breadboard:\n  engineMode: local-external\n  baseUrl: http://127.0.0.1:7777\n  sessionConfigPath: /tmp/session.yaml\n",
		);

		await expect(loadSelectedBreadboardConfig(configPath)).resolves.toMatchObject({
			engineMode: "local-external",
			baseUrl: "http://127.0.0.1:7777",
			sessionConfigPath: "/tmp/session.yaml",
		});
	});
});
