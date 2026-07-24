import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { JSONC, YAML } from "bun";

export const BREADBOARD_ENGINE_MODES = ["local-owned", "local-external", "remote", "off"] as const;
export type BreadboardEngineMode = (typeof BREADBOARD_ENGINE_MODES)[number];
export type ConfigSource = "cli" | "environment" | "selected-config" | "derived-default";
export type OwnerExitPolicy = "attached" | "detached";

export type BreadboardAuth =
	| { readonly kind: "process-secret"; readonly value: string }
	| { readonly kind: "keychain-reference"; readonly reference: string }
	| { readonly kind: "mtls-reference"; readonly reference: string };

export type BreadboardTls =
	| { readonly kind: "local-loopback" }
	| { readonly kind: "system-trust"; readonly spkiPin?: string };

export interface EngineArtifact {
	readonly executablePath: string;
	readonly argv: readonly string[];
	readonly argvSha256: `sha256:${string}`;
	readonly executableSha256: `sha256:${string}`;
	readonly engineSourceSha256: `sha256:${string}`;
	readonly servedBackendCommit: string;
}

export interface BreadboardRunConfig {
	readonly mode: BreadboardEngineMode;
	readonly endpoint?: string;
	readonly auth?: BreadboardAuth;
	readonly tls?: BreadboardTls;
	readonly engineArtifact?: EngineArtifact;
	readonly sessionConfigPath?: string;
	readonly workspaceId: `workspace:v1:sha256:${string}`;
	readonly startupTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly ownerExitPolicy?: OwnerExitPolicy;
	readonly sources: Readonly<Record<RunConfigField, ConfigSource>>;
	readonly configDigest: `sha256:${string}`;
}

export type RunConfigField =
	| "mode"
	| "endpoint"
	| "auth"
	| "tls"
	| "engineArtifact"
	| "workspaceId"
	| "startupTimeoutMs"
	| "requestTimeoutMs"
	| "ownerExitPolicy"
	| "sessionConfigPath";

export interface SelectedBreadboardConfig {
	readonly engineMode?: unknown;
	readonly baseUrl?: unknown;
	readonly auth?: unknown;
	readonly tls?: unknown;
	readonly engineArtifact?: unknown;
	readonly workspaceId?: unknown;
	readonly startupTimeoutMs?: unknown;
	readonly requestTimeoutMs?: unknown;
	readonly ownerExitPolicy?: unknown;
	readonly sessionConfigPath?: unknown;
}

export interface ResolveBreadboardRunConfigInput {
	readonly cli?: { readonly engineMode?: string; readonly engineUrl?: string; readonly ownerExitPolicy?: string };
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly selectedConfig?: SelectedBreadboardConfig;
	readonly workspacePath: string;
	readonly derivedOwnerExitPolicy?: OwnerExitPolicy;
	readonly canonicalizeWorkspace?: (path: string) => string;
}

export type RunConfigErrorCode =
	| "invalid_selected_config"
	| "invalid_mode"
	| "invalid_url"
	| "invalid_auth"
	| "invalid_tls"
	| "invalid_artifact"
	| "missing_engine_artifact"
	| "invalid_workspace"
	| "invalid_timeout"
	| "invalid_exit_policy"
	| "invalid_session_config"
	| "mode_endpoint_conflict"
	| "mode_auth_conflict"
	| "missing_endpoint"
	| "missing_auth";

export class BreadboardRunConfigError extends Error {
	readonly name = "BreadboardRunConfigError";
	constructor(
		readonly code: RunConfigErrorCode,
		readonly field: RunConfigField,
		message: string,
	) {
		super(message);
	}
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:7777";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ID = /^workspace:v1:sha256:[0-9a-f]{64}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const SPKI_PIN = /^sha256\/[A-Za-z0-9+/]{43}=$/;
const SECRET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SELECTED_CONFIG_FIELDS = new Set([
	"engineMode",
	"baseUrl",
	"auth",
	"tls",
	"engineArtifact",
	"workspaceId",
	"startupTimeoutMs",
	"requestTimeoutMs",
	"ownerExitPolicy",
	"sessionConfigPath",
]);

function fail(code: RunConfigErrorCode, field: RunConfigField, message: string): never {
	throw new BreadboardRunConfigError(code, field, message);
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

function pick<T>(
	cli: T | undefined,
	environment: T | undefined,
	selected: T | undefined,
	fallback: T,
): { value: T; source: ConfigSource; explicit: boolean } {
	if (cli !== undefined) return { value: cli, source: "cli", explicit: true };
	if (environment !== undefined) return { value: environment, source: "environment", explicit: true };
	if (selected !== undefined) return { value: selected, source: "selected-config", explicit: true };
	return { value: fallback, source: "derived-default", explicit: false };
}

function parseMode(value: unknown, field: RunConfigField = "mode"): BreadboardEngineMode {
	if (typeof value !== "string" || !BREADBOARD_ENGINE_MODES.includes(value as BreadboardEngineMode)) {
		fail("invalid_mode", field, "engine mode must be local-owned, local-external, remote, or off");
	}
	return value as BreadboardEngineMode;
}

function normalizeEndpoint(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
		fail("invalid_url", "endpoint", "engine endpoint must be a non-empty URL without surrounding whitespace");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("invalid_url", "endpoint", "engine endpoint is not a valid URL");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		fail(
			"invalid_url",
			"endpoint",
			"engine endpoint must use HTTP(S) and contain no credentials, query, or fragment",
		);
	}
	if (!url.hostname || (url.pathname.includes("//") && url.pathname !== "/")) {
		fail("invalid_url", "endpoint", "engine endpoint has an invalid host or path");
	}
	url.hostname = url.hostname.toLowerCase();
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString().replace(/\/$/, "");
}

export function isLoopbackEndpoint(endpoint: string): boolean {
	const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || hostname === "::1") return true;
	const octets = hostname.split(".");
	return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet)) && Number(octets[0]) === 127;
}

function parseAuth(value: unknown): BreadboardAuth | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("invalid_auth", "auth", "authentication must be a typed reference; raw config secrets are forbidden");
	}
	const record = value as Record<string, unknown>;
	if (record.kind === "keychain-reference" || record.kind === "mtls-reference") {
		if (typeof record.reference !== "string" || !SECRET_REFERENCE.test(record.reference)) {
			fail("invalid_auth", "auth", "authentication reference is invalid");
		}
		return { kind: record.kind, reference: record.reference };
	}
	fail("invalid_auth", "auth", "selected config authentication must be a keychain or mTLS reference");
}

function environmentAuth(environment: Readonly<Record<string, string | undefined>>): BreadboardAuth | undefined {
	const candidates = [
		environment.BREADBOARD_API_TOKEN === undefined
			? undefined
			: ({ kind: "process-secret", value: environment.BREADBOARD_API_TOKEN } as const),
		environment.BREADBOARD_API_TOKEN_REF === undefined
			? undefined
			: ({ kind: "keychain-reference", reference: environment.BREADBOARD_API_TOKEN_REF } as const),
		environment.BREADBOARD_MTLS_IDENTITY_REF === undefined
			? undefined
			: ({ kind: "mtls-reference", reference: environment.BREADBOARD_MTLS_IDENTITY_REF } as const),
	].filter((candidate): candidate is BreadboardAuth => candidate !== undefined);
	if (candidates.length > 1) fail("invalid_auth", "auth", "multiple environment authentication sources conflict");
	const candidate = candidates[0];
	if (!candidate) return undefined;
	if (candidate.kind === "process-secret") {
		if (
			candidate.value.length < 16 ||
			candidate.value.length > 8_192 ||
			/[\s\u0000-\u001f\u007f]/u.test(candidate.value)
		) {
			fail("invalid_auth", "auth", "process authentication secret is malformed");
		}
		return candidate;
	}
	if (!SECRET_REFERENCE.test(candidate.reference)) fail("invalid_auth", "auth", "authentication reference is invalid");
	return candidate;
}

function parseTls(value: unknown): { readonly kind: "system-trust"; readonly spkiPin?: string } | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail("invalid_tls", "tls", "TLS must be an object");
	const record = value as Record<string, unknown>;
	if (record.kind !== undefined && record.kind !== "system-trust")
		fail("invalid_tls", "tls", "remote TLS must use system trust");
	if (record.spkiPin !== undefined && (typeof record.spkiPin !== "string" || !SPKI_PIN.test(record.spkiPin))) {
		fail("invalid_tls", "tls", "TLS SPKI pin is invalid");
	}
	return record.spkiPin === undefined
		? { kind: "system-trust" }
		: { kind: "system-trust", spkiPin: record.spkiPin as string };
}

function parseTimeout(value: unknown, field: "startupTimeoutMs" | "requestTimeoutMs", fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	const maximum = field === "startupTimeoutMs" ? 120_000 : 60_000;
	if (!Number.isSafeInteger(parsed) || (parsed as number) < 100 || (parsed as number) > maximum) {
		fail("invalid_timeout", field, `${field} must be an integer from 100 through ${maximum}`);
	}
	return parsed as number;
}

function parseExitPolicy(value: unknown): OwnerExitPolicy {
	if (value !== "attached" && value !== "detached")
		fail("invalid_exit_policy", "ownerExitPolicy", "owner exit policy must be attached or detached");
	return value;
}

export function executablePathSha256(canonicalPath: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update("breadboard-engine-executable-path-v1\0").update(canonicalPath).digest("hex")}`;
}

function parseArtifact(value: unknown): EngineArtifact | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail("invalid_artifact", "engineArtifact", "engine artifact must be an object");
	const record = value as Record<string, unknown>;
	if (
		typeof record.executablePath !== "string" ||
		!isAbsolute(record.executablePath) ||
		record.executablePath.includes("\0")
	) {
		fail("invalid_artifact", "engineArtifact", "engine artifact executable path must be absolute");
	}
	if (!Array.isArray(record.argv) || record.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
		fail("invalid_artifact", "engineArtifact", "engine artifact argv must be an array of strings");
	}
	if (typeof record.executableSha256 !== "string" || !SHA256.test(record.executableSha256))
		fail("invalid_artifact", "engineArtifact", "engine executable digest is invalid");
	if (typeof record.engineSourceSha256 !== "string" || !SHA256.test(record.engineSourceSha256))
		fail("invalid_artifact", "engineArtifact", "engine source digest is invalid");
	if (typeof record.servedBackendCommit !== "string" || !COMMIT_ID.test(record.servedBackendCommit))
		fail("invalid_artifact", "engineArtifact", "served backend commit is invalid");
	let executablePath: string;
	try {
		executablePath = realpathSync(record.executablePath);
	} catch {
		fail("invalid_artifact", "engineArtifact", "engine artifact executable path cannot be canonicalized");
	}
	const argv = Object.freeze([...(record.argv as string[])]);
	const argvSha256 =
		`sha256:${createHash("sha256").update("breadboard-engine-argv-v1\0").update(JSON.stringify(argv)).digest("hex")}` as const;
	return Object.freeze({
		executablePath,
		argv,
		argvSha256,
		executableSha256: record.executableSha256 as `sha256:${string}`,
		engineSourceSha256: record.engineSourceSha256 as `sha256:${string}`,
		servedBackendCommit: record.servedBackendCommit,
	});
}

function environmentArtifact(environment: Readonly<Record<string, string | undefined>>): unknown {
	const fields = [
		environment.BREADBOARD_ENGINE_EXECUTABLE,
		environment.BREADBOARD_ENGINE_ARGV_JSON,
		environment.BREADBOARD_ENGINE_EXECUTABLE_SHA256,
		environment.BREADBOARD_ENGINE_SOURCE_SHA256,
		environment.BREADBOARD_ENGINE_BACKEND_COMMIT,
	];
	if (fields.every(value => value === undefined)) return undefined;
	if (fields.some(value => value === undefined))
		fail("invalid_artifact", "engineArtifact", "environment engine artifact identity is incomplete");
	let argv: unknown;
	try {
		argv = JSON.parse(fields[1] as string);
	} catch {
		fail("invalid_artifact", "engineArtifact", "environment engine argv is not valid JSON");
	}
	return {
		executablePath: fields[0],
		argv,
		executableSha256: fields[2],
		engineSourceSha256: fields[3],
		servedBackendCommit: fields[4],
	};
}

function canonicalWorkspace(path: string, canonicalize?: (path: string) => string): `workspace:v1:sha256:${string}` {
	if (!path || path.includes("\0")) fail("invalid_workspace", "workspaceId", "workspace path is invalid");
	let canonical: string;
	try {
		canonical = canonicalize ? canonicalize(path) : realpathSync(resolve(path));
	} catch {
		fail("invalid_workspace", "workspaceId", "workspace path cannot be canonicalized");
	}
	return `workspace:v1:sha256:${createHash("sha256").update("breadboard-workspace-v1\0").update(canonical).digest("hex")}`;
}

function parseSessionConfigPath(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
		fail(
			"invalid_session_config",
			"sessionConfigPath",
			"session config path must be a non-empty path without surrounding whitespace",
		);
	}
	return value;
}

function freezeConfig(config: BreadboardRunConfig): BreadboardRunConfig {
	Object.freeze(config.sources);
	if (config.auth) Object.freeze(config.auth);
	if (config.tls) Object.freeze(config.tls);
	return Object.freeze(config);
}

export function resolveBreadboardRunConfig(input: ResolveBreadboardRunConfigInput): BreadboardRunConfig {
	const environment = input.environment ?? process.env;
	const selected = input.selectedConfig ?? {};
	if (typeof selected !== "object" || selected === null || Array.isArray(selected))
		fail("invalid_selected_config", "mode", "selected config must be an object");
	for (const key of Object.keys(selected)) {
		if (!SELECTED_CONFIG_FIELDS.has(key))
			fail("invalid_selected_config", "mode", "selected BreadBoard configuration contains an unsupported field");
	}

	const sessionConfigPath = parseSessionConfigPath(
		hasOwn(selected, "sessionConfigPath") ? selected.sessionConfigPath : undefined,
	);

	const cliMode = input.cli?.engineMode;
	const envMode = environment.BREADBOARD_ENGINE_MODE;
	const selectedMode = hasOwn(selected, "engineMode") ? selected.engineMode : undefined;
	const endpointChoice = pick(
		input.cli?.engineUrl,
		environment.BREADBOARD_API_URL,
		hasOwn(selected, "baseUrl") ? selected.baseUrl : undefined,
		undefined,
	);
	const normalizedEndpoint = endpointChoice.value === undefined ? undefined : normalizeEndpoint(endpointChoice.value);

	let modeChoice: { value: BreadboardEngineMode; source: ConfigSource; explicit: boolean };
	if (cliMode !== undefined) modeChoice = { value: parseMode(cliMode), source: "cli", explicit: true };
	else if (envMode !== undefined) modeChoice = { value: parseMode(envMode), source: "environment", explicit: true };
	else if (selectedMode !== undefined)
		modeChoice = { value: parseMode(selectedMode), source: "selected-config", explicit: true };
	else if (normalizedEndpoint === undefined)
		modeChoice = { value: "local-owned", source: "derived-default", explicit: false };
	else
		modeChoice = {
			value: isLoopbackEndpoint(normalizedEndpoint) ? "local-external" : "remote",
			source: "derived-default",
			explicit: false,
		};

	const selectedAuth = hasOwn(selected, "auth") ? selected.auth : undefined;
	const envAuth = environmentAuth(environment);
	const authChoice =
		envAuth !== undefined
			? { value: envAuth, source: "environment" as const, explicit: true }
			: selectedAuth !== undefined
				? { value: parseAuth(selectedAuth), source: "selected-config" as const, explicit: true }
				: { value: undefined, source: "derived-default" as const, explicit: false };

	const selectedTls = hasOwn(selected, "tls") ? selected.tls : undefined;
	const environmentTls =
		environment.BREADBOARD_TLS_SPKI_PIN === undefined ? undefined : { spkiPin: environment.BREADBOARD_TLS_SPKI_PIN };
	const tlsChoice =
		environmentTls !== undefined
			? { value: parseTls(environmentTls), source: "environment" as const }
			: selectedTls !== undefined
				? { value: parseTls(selectedTls), source: "selected-config" as const }
				: { value: undefined, source: "derived-default" as const };

	const envArtifact = environmentArtifact(environment);
	const artifactChoice =
		envArtifact !== undefined
			? { value: parseArtifact(envArtifact), source: "environment" as const }
			: hasOwn(selected, "engineArtifact")
				? { value: parseArtifact(selected.engineArtifact), source: "selected-config" as const }
				: { value: undefined, source: "derived-default" as const };

	const workspaceChoice =
		environment.BREADBOARD_WORKSPACE_ID !== undefined
			? { value: environment.BREADBOARD_WORKSPACE_ID, source: "environment" as const }
			: hasOwn(selected, "workspaceId")
				? { value: selected.workspaceId, source: "selected-config" as const }
				: {
						value: canonicalWorkspace(input.workspacePath, input.canonicalizeWorkspace),
						source: "derived-default" as const,
					};
	if (typeof workspaceChoice.value !== "string" || !WORKSPACE_ID.test(workspaceChoice.value))
		fail("invalid_workspace", "workspaceId", "workspace identity must be a versioned SHA-256 value");

	const startupChoice =
		environment.BREADBOARD_STARTUP_TIMEOUT_MS !== undefined
			? { value: environment.BREADBOARD_STARTUP_TIMEOUT_MS, source: "environment" as const, explicit: true }
			: hasOwn(selected, "startupTimeoutMs")
				? { value: selected.startupTimeoutMs, source: "selected-config" as const, explicit: true }
				: { value: DEFAULT_STARTUP_TIMEOUT_MS, source: "derived-default" as const, explicit: false };
	const requestChoice =
		environment.BREADBOARD_REQUEST_TIMEOUT_MS !== undefined
			? { value: environment.BREADBOARD_REQUEST_TIMEOUT_MS, source: "environment" as const, explicit: true }
			: hasOwn(selected, "requestTimeoutMs")
				? { value: selected.requestTimeoutMs, source: "selected-config" as const, explicit: true }
				: { value: DEFAULT_REQUEST_TIMEOUT_MS, source: "derived-default" as const, explicit: false };
	const exitChoice = pick(
		input.cli?.ownerExitPolicy,
		environment.BREADBOARD_OWNER_EXIT_POLICY,
		hasOwn(selected, "ownerExitPolicy") ? selected.ownerExitPolicy : undefined,
		input.derivedOwnerExitPolicy ?? "attached",
	);
	const startupTimeoutMs = parseTimeout(startupChoice.value, "startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS);
	const requestTimeoutMs = parseTimeout(requestChoice.value, "requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS);
	const ownerExitPolicy = parseExitPolicy(exitChoice.value);

	const mode = modeChoice.value;
	let endpoint = normalizedEndpoint;
	let tls: BreadboardTls | undefined;
	if (mode === "off") {
		if (endpointChoice.explicit) fail("mode_endpoint_conflict", "endpoint", "off mode forbids an engine endpoint");
		if (authChoice.explicit) fail("mode_auth_conflict", "auth", "off mode forbids authentication");
		if (artifactChoice.value !== undefined)
			fail("invalid_artifact", "engineArtifact", "off mode forbids an engine artifact");
		if (exitChoice.explicit) fail("invalid_exit_policy", "ownerExitPolicy", "off mode forbids an owner exit policy");
		endpoint = undefined;
	} else if (mode === "local-owned") {
		endpoint ??= DEFAULT_ENDPOINT;
		if (!isLoopbackEndpoint(endpoint))
			fail("mode_endpoint_conflict", "endpoint", "local-owned requires a loopback endpoint");
		if (authChoice.value !== undefined)
			fail("mode_auth_conflict", "auth", "local-owned does not accept endpoint authentication");
		if (!artifactChoice.value)
			fail("missing_engine_artifact", "engineArtifact", "local-owned requires an explicit engine artifact identity");
		tls = { kind: "local-loopback" };
	} else if (mode === "local-external") {
		if (!endpointChoice.explicit || endpoint === undefined)
			fail("missing_endpoint", "endpoint", "local-external requires an explicit loopback endpoint");
		if (!isLoopbackEndpoint(endpoint))
			fail("mode_endpoint_conflict", "endpoint", "local-external requires a loopback endpoint");
		if (artifactChoice.value !== undefined)
			fail("invalid_artifact", "engineArtifact", "local-external forbids an engine artifact");
		if (exitChoice.explicit)
			fail("invalid_exit_policy", "ownerExitPolicy", "local-external forbids an owner exit policy");
		tls = { kind: "local-loopback" };
	} else {
		if (!endpointChoice.explicit || endpoint === undefined)
			fail("missing_endpoint", "endpoint", "remote mode requires an explicit endpoint");
		if (isLoopbackEndpoint(endpoint) || !endpoint.startsWith("https://"))
			fail("mode_endpoint_conflict", "endpoint", "remote requires non-loopback HTTPS");
		if (!authChoice.value) fail("missing_auth", "auth", "remote mode requires authentication");
		if (artifactChoice.value !== undefined)
			fail("invalid_artifact", "engineArtifact", "remote forbids an engine artifact");
		if (exitChoice.explicit) fail("invalid_exit_policy", "ownerExitPolicy", "remote forbids an owner exit policy");
		tls = tlsChoice.value ?? { kind: "system-trust" };
	}

	const sources: Record<RunConfigField, ConfigSource> = {
		mode: modeChoice.source,
		endpoint: endpointChoice.source,
		auth: authChoice.source,
		tls: mode === "remote" ? tlsChoice.source : "derived-default",
		engineArtifact: artifactChoice.source,
		workspaceId: workspaceChoice.source,
		startupTimeoutMs: startupChoice.source,
		requestTimeoutMs: requestChoice.source,
		ownerExitPolicy: mode === "local-owned" ? exitChoice.source : "derived-default",
		sessionConfigPath: sessionConfigPath === undefined ? "derived-default" : "selected-config",
	};
	const safeDigestInput = JSON.stringify({
		mode,
		endpoint,
		auth:
			authChoice.value === undefined
				? undefined
				: {
						kind: authChoice.value.kind,
						source: authChoice.source,
					},
		tls,
		engineArtifact:
			artifactChoice.value === undefined
				? undefined
				: {
						executablePathSha256: executablePathSha256(artifactChoice.value.executablePath),
						argvSha256: artifactChoice.value.argvSha256,
						executableSha256: artifactChoice.value.executableSha256,
						engineSourceSha256: artifactChoice.value.engineSourceSha256,
						servedBackendCommit: artifactChoice.value.servedBackendCommit,
					},
		workspaceId: workspaceChoice.value,
		startupTimeoutMs,
		requestTimeoutMs,
		ownerExitPolicy: mode === "local-owned" ? ownerExitPolicy : undefined,
		sessionConfigPathSha256:
			sessionConfigPath === undefined
				? undefined
				: `sha256:${createHash("sha256").update("breadboard-session-config-path-v1\0").update(sessionConfigPath).digest("hex")}`,
		sources,
	});
	const configHash = createHash("sha256").update("breadboard-run-config-v2\0").update(safeDigestInput);
	return freezeConfig({
		mode,
		...(endpoint === undefined ? {} : { endpoint }),
		...(authChoice.value === undefined ? {} : { auth: authChoice.value }),
		...(tls === undefined ? {} : { tls }),
		...(artifactChoice.value === undefined ? {} : { engineArtifact: artifactChoice.value }),
		...(sessionConfigPath === undefined ? {} : { sessionConfigPath }),
		workspaceId: workspaceChoice.value as `workspace:v1:sha256:${string}`,
		startupTimeoutMs,
		requestTimeoutMs,
		...(mode === "local-owned" ? { ownerExitPolicy } : {}),
		sources,
		configDigest: `sha256:${configHash.digest("hex")}`,
	});
}

export function parseSelectedBreadboardConfig(breadboard: unknown): SelectedBreadboardConfig {
	if (breadboard === undefined) return {};
	if (typeof breadboard !== "object" || breadboard === null || Array.isArray(breadboard)) {
		fail("invalid_selected_config", "mode", "selected OMP breadboard config must be an object");
	}
	return {
		...("engineMode" in breadboard ? { engineMode: breadboard.engineMode } : {}),
		...("baseUrl" in breadboard ? { baseUrl: breadboard.baseUrl } : {}),
		...("auth" in breadboard ? { auth: breadboard.auth } : {}),
		...("tls" in breadboard ? { tls: breadboard.tls } : {}),
		...("engineArtifact" in breadboard ? { engineArtifact: breadboard.engineArtifact } : {}),
		...("workspaceId" in breadboard ? { workspaceId: breadboard.workspaceId } : {}),
		...("startupTimeoutMs" in breadboard ? { startupTimeoutMs: breadboard.startupTimeoutMs } : {}),
		...("requestTimeoutMs" in breadboard ? { requestTimeoutMs: breadboard.requestTimeoutMs } : {}),
		...("ownerExitPolicy" in breadboard ? { ownerExitPolicy: breadboard.ownerExitPolicy } : {}),
		...("sessionConfigPath" in breadboard ? { sessionConfigPath: breadboard.sessionConfigPath } : {}),
	};
}

export async function loadSelectedBreadboardConfig(configFile: string): Promise<SelectedBreadboardConfig> {
	const file = Bun.file(configFile);
	if (!(await file.exists())) return {};
	let parsed: unknown;
	try {
		const text = await file.text();
		parsed = [".yaml", ".yml"].includes(extname(configFile).toLowerCase()) ? YAML.parse(text) : JSONC.parse(text);
	} catch {
		fail("invalid_selected_config", "mode", "selected OMP config is unreadable or malformed");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail("invalid_selected_config", "mode", "selected OMP config must be an object");
	}
	return parseSelectedBreadboardConfig("breadboard" in parsed ? parsed.breadboard : undefined);
}
