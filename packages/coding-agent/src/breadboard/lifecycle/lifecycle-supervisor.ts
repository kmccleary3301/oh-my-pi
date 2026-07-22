import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { checkServerIdentity } from "node:tls";
import {
	type BoundLifecycleE4Client,
	type ClientRegistrationResponse,
	createLifecycleE4Client,
	type HardSignalOutcome,
	type HardSignalPermitResponse,
	type LifecycleE4Client,
	LifecycleE4ClientError,
	type LifecycleEngineBinding,
	P30_SESSION_CONTRACT_ID,
	P30_SESSION_SCHEMA_SHA256,
} from "@breadboard/sdk";
import { DarwinVerifiedSpawnError, darwinProcessStartToken, spawnDarwinVerified } from "./darwin-verified-spawn";
import {
	type LifecycleReadyHandle,
	type LifecycleResult,
	type LifecycleState,
	type LifecycleStateName,
	lifecycleFailure,
	lifecycleState,
} from "./lifecycle-state";
import type { LocalAuthorityRecord, LocalStartClaim } from "./local-authority-store";
import { type LocalAuthorityStore, LocalAuthorityStoreError } from "./local-authority-store";
import {
	type BreadboardAuth,
	type BreadboardRunConfig,
	type EngineArtifact,
	executablePathSha256,
	type OwnerExitPolicy,
} from "./run-config";

export interface SpawnedEngineProcess {
	readonly pid: number;
	readonly startToken: string;
	readonly exited: Promise<number | null>;
	unref(): void;
	sendHardSignal(authorizationExpiresAtUnix: number): Promise<HardSignalOutcome | "authorization_expired">;
	waitForExit(timeoutMs: number): Promise<boolean>;
}

export type ProcessObservation =
	| { readonly kind: "alive"; readonly startToken: string }
	| { readonly kind: "dead" }
	| { readonly kind: "ambiguous" };

export type SpawnVerifiedResult = SpawnedEngineProcess | { readonly kind: "spawn-failed-dead" };

export interface LifecycleProcessAdapter {
	spawnVerified(
		artifact: EngineArtifact,
		launchId: string,
		bootstrap: Buffer,
		bindIdentity: (pid: number, startToken: string) => Promise<void>,
	): Promise<SpawnVerifiedResult>;
	observe(pid: number): Promise<ProcessObservation>;
	controlFor(pid: number, expectedStartToken: string): Promise<SpawnedEngineProcess | null>;
}

export interface LifecycleClock {
	now(): number;
	sleep(milliseconds: number): Promise<void>;
}

export interface ResolvedRemoteSecurity {
	readonly bearerToken?: string;
	readonly certificatePem?: string;
	readonly privateKeyPem?: string;
}

function createAuthenticatedRequestFetch(security: {
	readonly bearerToken?: string;
	readonly fetch?: typeof fetch;
}): typeof fetch {
	const transport = security.fetch ?? globalThis.fetch;
	if (security.bearerToken === undefined) return transport;
	const authorization = `Bearer ${security.bearerToken}`;
	const authenticatedFetch = (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, name) => {
			headers.set(name, value);
		});
		headers.set("authorization", authorization);
		return transport(input, { ...init, headers });
	};
	return Object.assign(authenticatedFetch, { preconnect: transport.preconnect });
}

export interface LifecycleSupervisorDependencies {
	readonly store?: LocalAuthorityStore;
	readonly process?: LifecycleProcessAdapter;
	readonly createClient?: (config: {
		readonly baseUrl: string;
		readonly timeoutMs: number;
		readonly bearerToken?: string;
		readonly fetch?: typeof fetch;
	}) => LifecycleE4Client;
	readonly resolveRemoteSecurity?: (
		auth: Exclude<BreadboardAuth, { readonly kind: "process-secret" }>,
	) => Promise<ResolvedRemoteSecurity>;
	readonly randomCredential?: () => string;
	readonly randomSecret?: () => Buffer;
	readonly randomOwnerCredential?: () => Buffer;
	readonly clock?: LifecycleClock;
	readonly stateChanged?: (state: LifecycleState) => void;
	readonly endpointAbsent?: (client: LifecycleE4Client) => Promise<boolean | "ambiguous">;
}

export interface StopOptions {
	readonly consumerClosed: boolean;
	readonly explicit?: boolean;
}

export type LifecycleAction = "connect" | "start" | "status" | "stop" | "restart" | "update" | "close";

interface ReadyContext {
	readonly client: BoundLifecycleE4Client;
	readonly requestFetch: typeof fetch;
	readonly binding: LifecycleEngineBinding;
	readonly registration: ClientRegistrationResponse & { readonly result: "registered" };
	readonly clientInstanceId: string;
	readonly registrationCredential: string;
	readonly ownerCredential?: Buffer;
	readonly ownerGeneration?: number;
	readonly record?: LocalAuthorityRecord;
	readonly process?: SpawnedEngineProcess;
	readonly effectiveExitPolicy?: OwnerExitPolicy;
}

class EngineArtifactValidationError extends Error {}
class ProcessIdentityValidationError extends Error {}

const RESTART_DELAYS_MS = [250, 1_000, 4_000] as const;
function randomOwnerCredential(): Buffer {
	const source = randomBytes(32);
	const encoded = Buffer.allocUnsafe(source.byteLength * 2);
	const hex = "0123456789abcdef";
	try {
		for (let index = 0; index < source.byteLength; index += 1) {
			const byte = source[index] as number;
			encoded[index * 2] = hex.charCodeAt(byte >>> 4);
			encoded[index * 2 + 1] = hex.charCodeAt(byte & 0x0f);
		}
		return encoded;
	} finally {
		source.fill(0);
	}
}

function credentialText(credential: Uint8Array): string {
	return Buffer.from(credential.buffer, credential.byteOffset, credential.byteLength).toString("utf8");
}
const RESTART_WINDOW_MS = 60_000;
const INITIAL_STATES = new Set<LifecycleStateName>(["off", "claiming", "connecting", "backing-off"]);
const ALLOWED_TRANSITIONS: Readonly<Partial<Record<LifecycleStateName, ReadonlySet<LifecycleStateName>>>> = {
	claiming: new Set(["starting", "connecting"]),
	starting: new Set(["connecting", "backing-off"]),
	connecting: new Set(["handshaking"]),
	handshaking: new Set([
		"acquiring-owner",
		"registering-client",
		"compatible-observed",
		"reconnecting",
		"backing-off",
	]),
	"acquiring-owner": new Set(["registering-client", "reconnecting"]),
	"registering-client": new Set(["ready", "reconnecting"]),
	ready: new Set(["claiming", "draining", "detaching-client", "backing-off", "reconnecting"]),
	draining: new Set(["draining", "stopping", "restart-stopping"]),
	"restart-stopping": new Set(["restart-starting", "ready", "detaching-client"]),
	"restart-starting": new Set(["connecting", "backing-off"]),
	stopping: new Set(["stopped", "ready", "detaching-client"]),
	"detaching-client": new Set(["detached"]),
	reconnecting: new Set(["connecting", "starting"]),
	"backing-off": new Set(["claiming", "starting", "restart-starting"]),
};

function randomCredential(): string {
	return randomBytes(32).toString("base64url");
}
export function lifecycleChildEnvironment(launchId: string): Readonly<Record<string, string>> {
	return Object.freeze({
		PATH: "/usr/bin:/bin",
		BREADBOARD_ENGINE_LAUNCH_ID: launchId,
		BREADBOARD_LIFECYCLE_BOOTSTRAP_FD: "3",
	});
}

function mappedFailure(mode: BreadboardRunConfig["mode"], error: unknown, attempt = 0): LifecycleResult {
	if (error instanceof EngineArtifactValidationError)
		return lifecycleFailure(mode, "failed", "engine_artifact_mismatch", attempt);
	if (error instanceof ProcessIdentityValidationError)
		return lifecycleFailure(mode, "failed", "process_identity_unavailable", attempt);
	if (error instanceof LifecycleE4ClientError) {
		switch (error.failure.kind) {
			case "auth":
				return lifecycleFailure(mode, "auth-failed", "auth_failed", attempt);
			case "tls":
				return lifecycleFailure(mode, "tls-failed", "tls_failed", attempt);
			case "identity-changed":
				return lifecycleFailure(mode, "identity-changed", "identity_changed", attempt);
			case "owner-conflict":
				return lifecycleFailure(mode, "ownership-conflict", "ownership_conflict", attempt);
			case "owner-expired":
				return lifecycleFailure(mode, "owner-lease-expired", "owner_lease_expired", attempt);
			case "registration-conflict":
				return lifecycleFailure(mode, "registration-conflict", "registration_conflict", attempt);
			case "registration-expired":
				return lifecycleFailure(mode, "registration-expired", "registration_expired", attempt);
			case "caller-abort":
				return lifecycleFailure(mode, "request-aborted", "request_aborted", attempt);
			case "drain-conflict":
				return lifecycleFailure(mode, "restart-blocked", "drain_denied", attempt);
			case "session-schema-mismatch":
			case "registration-schema-mismatch":
			case "control-schema-mismatch":
			case "protocol":
			case "redirect":
				return lifecycleFailure(mode, "incompatible-engine", "incompatible_engine", attempt);
			case "recovery-failed":
				return lifecycleFailure(mode, "drain-recovery-failed", "drain_recovery_failed", attempt);
			default:
				return lifecycleFailure(
					mode,
					mode === "local-external"
						? "external-disconnected"
						: mode === "remote"
							? "remote-disconnected"
							: "recovery-needed",
					"endpoint_unreachable",
					attempt,
				);
		}
	}
	if (error instanceof LocalAuthorityStoreError) {
		return lifecycleFailure(
			mode,
			error.code === "authority_record_invalid" ? "failed" : "recovery-needed",
			error.code === "authority_record_invalid" ? "authority_record_invalid" : "authority_store_unavailable",
			attempt,
		);
	}
	return lifecycleFailure(mode, "failed", "process_control_failed", attempt);
}
function unrefDelay(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, milliseconds);
	timer.unref();
	return promise;
}

class DefaultLifecycleProcessAdapter implements LifecycleProcessAdapter {
	readonly #children = new Map<number, SpawnedEngineProcess>();

	async spawnVerified(
		artifact: EngineArtifact,
		launchId: string,
		bootstrap: Buffer,
		bindIdentity: (pid: number, startToken: string) => Promise<void>,
	): Promise<SpawnVerifiedResult> {
		const source = await open(artifact.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const snapshotRoot = await mkdtemp(join(tmpdir(), "omp-engine-snapshot-"));
		const snapshotPath = join(snapshotRoot, "engine");
		let snapshot: FileHandle | undefined;
		let execution: FileHandle | undefined;
		try {
			const sourceMetadata = await source.stat();
			if (!sourceMetadata.isFile() || sourceMetadata.nlink !== 1) {
				throw new EngineArtifactValidationError("engine executable identity is invalid");
			}
			const sourceBytes = await source.readFile();
			if (`sha256:${createHash("sha256").update(sourceBytes).digest("hex")}` !== artifact.executableSha256) {
				throw new EngineArtifactValidationError("engine executable digest changed");
			}
			snapshot = await open(
				snapshotPath,
				constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			await snapshot.writeFile(sourceBytes);
			await snapshot.sync();
			await snapshot.chmod(0o500);
			const snapshotMetadata = await snapshot.stat();
			await snapshot.close();
			snapshot = undefined;
			execution = await open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const executionMetadata = await execution.stat();
			if (
				!executionMetadata.isFile() ||
				executionMetadata.nlink !== 1 ||
				executionMetadata.dev !== snapshotMetadata.dev ||
				executionMetadata.ino !== snapshotMetadata.ino ||
				(executionMetadata.mode & 0o777) !== 0o500
			) {
				throw new EngineArtifactValidationError("engine snapshot identity changed");
			}
			const executableBytes = await execution.readFile();
			if (`sha256:${createHash("sha256").update(executableBytes).digest("hex")}` !== artifact.executableSha256) {
				throw new EngineArtifactValidationError("engine snapshot digest changed");
			}
			await execution.close();
			execution = undefined;

			const verified = await spawnDarwinVerified({
				executablePath: snapshotPath,
				executableBytes,
				argv: artifact.argv,
				env: lifecycleChildEnvironment(launchId),
				bootstrap,
				bindIdentity,
			});
			const handle: SpawnedEngineProcess = {
				pid: verified.pid,
				startToken: verified.startToken,
				exited: verified.exited,
				unref: () => verified.unref(),
				sendHardSignal: async authorizationExpiresAtUnix => {
					if (Date.now() >= authorizationExpiresAtUnix * 1_000) return "authorization_expired";
					const outcome = await verified.signalIfSame("SIGKILL");
					if (outcome === "sent") return "sent";
					if (outcome === "process-exited") return "process_exited";
					return "abandoned";
				},
				waitForExit: timeoutMs => verified.waitForExit(timeoutMs),
			};
			this.#children.set(verified.pid, handle);
			void verified.exited.finally(() => this.#children.delete(verified.pid));
			return handle;
		} catch (error) {
			if (error instanceof DarwinVerifiedSpawnError) {
				throw new ProcessIdentityValidationError("Darwin verified engine spawn failed", { cause: error });
			}
			throw error;
		} finally {
			bootstrap.fill(0);
			await Promise.allSettled([
				source.close(),
				snapshot?.close(),
				execution?.close(),
				rm(snapshotRoot, { recursive: true, force: true }),
			]);
		}
	}

	async observe(pid: number): Promise<ProcessObservation> {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
				return { kind: "dead" };
			return { kind: "ambiguous" };
		}
		if (process.platform !== "darwin") return { kind: "ambiguous" };
		const token = await darwinProcessStartToken(pid);
		return token === null ? { kind: "ambiguous" } : { kind: "alive", startToken: token };
	}

	async controlFor(pid: number, expectedStartToken: string): Promise<SpawnedEngineProcess | null> {
		const observation = await this.observe(pid);
		if (observation.kind !== "alive" || observation.startToken !== expectedStartToken) return null;
		const child = this.#children.get(pid);
		if (child) return child;
		const exited = (async (): Promise<number | null> => {
			while (true) {
				try {
					const current = await this.observe(pid);
					if (current.kind === "dead" || (current.kind === "alive" && current.startToken !== expectedStartToken))
						return null;
				} catch {
					// An unobservable process is not proof of death; keep the owner record closed.
				}
				await unrefDelay(250);
			}
		})();
		return {
			pid,
			startToken: expectedStartToken,
			exited,
			unref: () => undefined,
			sendHardSignal: async authorizationExpiresAtUnix => {
				const current = await this.observe(pid);
				if (current.kind === "dead") return "process_exited";
				if (current.kind !== "alive" || current.startToken !== expectedStartToken) return "abandoned";
				if (authorizationExpiresAtUnix !== undefined && Date.now() >= authorizationExpiresAtUnix * 1_000)
					return "authorization_expired";
				try {
					process.kill(pid, "SIGKILL");
					return "sent";
				} catch (error) {
					return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
						? "process_exited"
						: "abandoned";
				}
			},
			waitForExit: async timeoutMs => {
				const deadline = Date.now() + timeoutMs;
				for (;;) {
					const current = await this.observe(pid);
					if (current.kind === "dead" || (current.kind === "alive" && current.startToken !== expectedStartToken))
						return true;
					if (Date.now() >= deadline) return false;
					await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
				}
			},
		};
	}
}

const KEYCHAIN_OUTPUT_LIMIT = 64 * 1024;
const KEYCHAIN_TIMEOUT_MS = 5_000;
export interface KeychainReadProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal: "SIGKILL"): void;
}

export interface KeychainReadOptions {
	readonly outputLimit?: number;
	readonly timeoutMs?: number;
	readonly spawn?: (reference: string) => KeychainReadProcess;
}

export async function readKeychainReference(reference: string, options: KeychainReadOptions = {}): Promise<string> {
	const outputLimit = options.outputLimit ?? KEYCHAIN_OUTPUT_LIMIT;
	const timeoutMs = options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
	const child =
		options.spawn?.(reference) ??
		Bun.spawn(["/usr/bin/security", "find-generic-password", "-w", "-s", reference], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: {},
		});
	const reader = child.stdout.getReader();
	let cancellation: Promise<void> | undefined;
	const cancelReader = (): Promise<void> => {
		cancellation ??= reader.cancel().catch(() => undefined);
		return cancellation;
	};
	let boundedFailure: LifecycleE4ClientError | undefined;
	const timer = setTimeout(() => {
		if (!boundedFailure) {
			boundedFailure = new LifecycleE4ClientError({
				kind: "auth",
				status: 0,
				code: "secret_reference_timeout",
				correlation: {},
				body: "[redacted]",
			});
		}
		child.kill("SIGKILL");
		void cancelReader();
	}, timeoutMs);
	const chunks: Buffer[] = [];
	let size = 0;
	let combined: Buffer | undefined;
	try {
		const output = (async (): Promise<void> => {
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
					size += chunk.byteLength;
					if (boundedFailure || size > outputLimit) {
						chunk.fill(0);
						if (!boundedFailure) {
							boundedFailure = new LifecycleE4ClientError({
								kind: "auth",
								status: 0,
								code: "secret_reference_oversized",
								correlation: {},
								body: "[redacted]",
							});
							child.kill("SIGKILL");
						}
						await cancelReader();
						break;
					}
					chunks.push(chunk);
				}
			} catch (error) {
				if (!boundedFailure) throw error;
			} finally {
				reader.releaseLock();
			}
		})();
		const [exitCode] = await Promise.all([child.exited, output]);
		await cancellation;
		if (boundedFailure) throw boundedFailure;
		combined = Buffer.concat(chunks, size);
		const value = combined.toString("utf8").trim();
		if (exitCode !== 0 || value.length === 0) {
			throw new LifecycleE4ClientError({
				kind: "auth",
				status: 0,
				code: "secret_reference_unavailable",
				correlation: {},
				body: "[redacted]",
			});
		}
		return value;
	} finally {
		clearTimeout(timer);
		combined?.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}
async function defaultResolveRemoteSecurity(
	auth: Exclude<BreadboardAuth, { readonly kind: "process-secret" }>,
): Promise<ResolvedRemoteSecurity> {
	const resolved = await readKeychainReference(auth.reference);
	if (auth.kind === "keychain-reference") return { bearerToken: resolved };
	try {
		const parsed: unknown = JSON.parse(resolved);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("certificatePem" in parsed) ||
			!("privateKeyPem" in parsed)
		)
			throw new Error("invalid identity");
		const identity = parsed as { certificatePem?: unknown; privateKeyPem?: unknown };
		if (typeof identity.certificatePem !== "string" || typeof identity.privateKeyPem !== "string")
			throw new Error("invalid identity");
		return { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem };
	} catch {
		throw new LifecycleE4ClientError({ kind: "tls", code: "tls_transport_error" });
	}
}

function pinnedCheckServerIdentity(
	pin: string | undefined,
): (hostname: string, certificate: PeerCertificate) => Error | undefined {
	return (hostname, certificate) => {
		const hostnameError = checkServerIdentity(hostname, certificate);
		if (hostnameError || pin === undefined) return hostnameError;
		try {
			const publicKey = new X509Certificate(certificate.raw).publicKey.export({ type: "spki", format: "der" });
			const actual = `sha256/${createHash("sha256").update(publicKey).digest("base64")}`;
			if (actual === pin) return undefined;
		} catch {
			// The typed TLS failure below deliberately contains no certificate material.
		}
		return Object.assign(new Error("TLS peer identity rejected"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
	};
}

const LIFECYCLE_RESPONSE_LIMIT = 1024 * 1024;

function createBoundHttpsFetch(security: ResolvedRemoteSecurity, spkiPin: string | undefined): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
		if (url.protocol !== "https:")
			throw Object.assign(new Error("TLS required"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
		const { promise, resolve, reject } = Promise.withResolvers<Response>();
		let settled = false;
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const request = httpsRequest(
			url,
			{
				method: init?.method,
				headers: init?.headers as Record<string, string> | undefined,
				cert: security.certificatePem,
				key: security.privateKeyPem,
				checkServerIdentity: pinnedCheckServerIdentity(spkiPin),
			},
			response => {
				const declared = response.headers["content-length"];
				const contentLength = typeof declared === "string" ? Number(declared) : Number.NaN;
				if (Number.isFinite(contentLength) && contentLength > LIFECYCLE_RESPONSE_LIMIT) {
					const error = new LifecycleE4ClientError({
						kind: "http",
						status: 0,
						code: "response_too_large",
						correlation: {},
						body: "[redacted]",
					});
					response.destroy(error);
					fail(error);
					return;
				}
				const chunks: Buffer[] = [];
				let received = 0;
				response.on("data", chunk => {
					if (settled) return;
					const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					received += bytes.byteLength;
					if (received > LIFECYCLE_RESPONSE_LIMIT) {
						for (const buffered of chunks) buffered.fill(0);
						const error = new LifecycleE4ClientError({
							kind: "http",
							status: 0,
							code: "response_too_large",
							correlation: {},
							body: "[redacted]",
						});
						response.destroy(error);
						fail(error);
						return;
					}
					chunks.push(bytes);
				});
				response.once("error", fail);
				response.once("end", () => {
					if (settled) return;
					const headers = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (Array.isArray(value)) for (const item of value) headers.append(name, item);
						else if (value !== undefined) headers.set(name, String(value));
					}
					settled = true;
					resolve(new Response(Buffer.concat(chunks, received), { status: response.statusCode ?? 500, headers }));
				});
			},
		);
		request.once("error", fail);
		const abort = (): void => {
			request.destroy(new DOMException("Aborted", "AbortError"));
		};
		if (init?.signal?.aborted) abort();
		else init?.signal?.addEventListener("abort", abort, { once: true });
		if (init?.body === undefined || init.body === null) request.end();
		else if (typeof init.body === "string" || init.body instanceof Uint8Array) request.end(init.body);
		else {
			request.destroy();
			fail(new Error("unsupported lifecycle request body"));
		}
		try {
			return await promise;
		} finally {
			init?.signal?.removeEventListener("abort", abort);
		}
	}) as typeof fetch;
}

abstract class ModeStrategy {
	private leaseTimer: NodeJS.Timeout | undefined;
	private currentState: LifecycleStateName | undefined;
	protected context: ReadyContext | undefined;
	protected readonly clientInstanceId: string;
	protected readonly registrationCredential: string;
	protected readonly clock: LifecycleClock;
	protected readonly makeCredential: () => string;
	protected readonly makeOwnerCredential: () => Buffer;
	protected readonly makeSecret: () => Buffer;
	protected readonly createClient: NonNullable<LifecycleSupervisorDependencies["createClient"]>;
	protected readonly stateChanged: (state: LifecycleState) => void;
	protected readonly abortController = new AbortController();

	constructor(
		protected readonly config: BreadboardRunConfig,
		protected readonly dependencies: LifecycleSupervisorDependencies,
	) {
		this.clock = dependencies.clock ?? { now: Date.now, sleep: milliseconds => Bun.sleep(milliseconds) };
		this.makeCredential = dependencies.randomCredential ?? randomCredential;
		this.makeSecret = dependencies.randomSecret ?? (() => randomBytes(32));
		this.makeOwnerCredential = dependencies.randomOwnerCredential ?? randomOwnerCredential;
		this.clientInstanceId = this.makeCredential();
		this.registrationCredential = this.makeCredential();
		this.createClient =
			dependencies.createClient ??
			(options =>
				createLifecycleE4Client({
					baseUrl: options.baseUrl,
					timeoutMs: options.timeoutMs,
					expectedSessionContract: {
						contractId: P30_SESSION_CONTRACT_ID,
						schemaSha256: P30_SESSION_SCHEMA_SHA256,
					},
					...(options.bearerToken === undefined ? {} : { bearerToken: options.bearerToken }),
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
				}));
		this.stateChanged = dependencies.stateChanged ?? (() => undefined);
	}

	protected requestFetch: typeof fetch = globalThis.fetch;

	abstract connect(): Promise<LifecycleResult>;
	async start(): Promise<LifecycleResult> {
		return lifecycleFailure(this.config.mode, "failed", "mode_forbidden");
	}
	abstract status(): Promise<LifecycleResult>;
	abstract stop(options: StopOptions): Promise<LifecycleResult>;
	abstract restart(options: StopOptions): Promise<LifecycleResult>;
	abstract close(options: StopOptions): Promise<LifecycleResult>;

	async update(): Promise<LifecycleResult> {
		return lifecycleFailure(this.config.mode, "failed", "mode_forbidden");
	}

	abort(): void {
		this.stopLeaseRenewal();
		this.abortController.abort();
	}
	abortRequiresQuiescence(): boolean {
		return false;
	}

	protected transition(name: LifecycleStateName, attempt = 0): void {
		const allowed =
			this.currentState === undefined ||
			INITIAL_STATES.has(name) ||
			ALLOWED_TRANSITIONS[this.currentState]?.has(name);
		if (!allowed) throw new Error(`illegal lifecycle transition ${this.currentState} -> ${name}`);
		this.currentState = name;
		this.stateChanged(lifecycleState(this.config.mode, name, attempt));
	}

	protected async clientSecurity(): Promise<{ readonly bearerToken?: string; readonly fetch?: typeof fetch }> {
		const auth = this.config.auth;
		let security: ResolvedRemoteSecurity = {};
		if (auth?.kind === "process-secret") security = { bearerToken: auth.value };
		else if (auth) security = await (this.dependencies.resolveRemoteSecurity ?? defaultResolveRemoteSecurity)(auth);
		if (this.config.mode !== "remote")
			return security.bearerToken === undefined ? {} : { bearerToken: security.bearerToken };
		const pin = this.config.tls?.kind === "system-trust" ? this.config.tls.spkiPin : undefined;
		const needsBoundFetch =
			pin !== undefined || security.certificatePem !== undefined || security.privateKeyPem !== undefined;
		return {
			...(security.bearerToken === undefined ? {} : { bearerToken: security.bearerToken }),
			...(needsBoundFetch ? { fetch: createBoundHttpsFetch(security, pin) } : {}),
		};
	}

	protected async unboundClient(): Promise<LifecycleE4Client> {
		if (!this.config.endpoint) throw new Error("resolved lifecycle endpoint is missing");
		const security = await this.clientSecurity();
		this.requestFetch = createAuthenticatedRequestFetch(security);
		return this.createClient({ baseUrl: this.config.endpoint, timeoutMs: this.config.requestTimeoutMs, ...security });
	}

	protected async handshake(options: { readonly ignoreAbort?: boolean } = {}): Promise<BoundLifecycleE4Client> {
		return await (await this.unboundClient()).handshake({
			signal: options.ignoreAbort ? undefined : this.abortController.signal,
		});
	}

	protected isRetryableTransport(error: unknown): boolean {
		if (this.abortController.signal.aborted || !(error instanceof LifecycleE4ClientError)) return false;
		return error.failure.kind === "timeout" || (error.failure.kind === "http" && error.failure.status === 0);
	}

	protected async withReconnect<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
		let failure: unknown;
		for (let attempt = 0; attempt < RESTART_DELAYS_MS.length; attempt++) {
			try {
				return await operation(attempt);
			} catch (error) {
				failure = error;
				if (!this.isRetryableTransport(error) || attempt === RESTART_DELAYS_MS.length - 1) throw error;
				this.transition("reconnecting", attempt + 1);
				await this.clock.sleep(RESTART_DELAYS_MS[attempt] as number);
			}
		}
		throw failure;
	}

	protected async register(client: BoundLifecycleE4Client): Promise<ReadyContext> {
		this.transition("registering-client");
		const registration = await client.registerClient({
			clientInstanceId: this.clientInstanceId,
			workspaceId: this.config.workspaceId,
			lifecycleMode: this.config.mode as "local-owned" | "local-external" | "remote",
			registrationCredential: this.registrationCredential,
			signal: this.abortController.signal,
		});
		return {
			client,
			requestFetch: this.requestFetch,
			binding: client.binding,
			registration,
			clientInstanceId: this.clientInstanceId,
			registrationCredential: this.registrationCredential,
		};
	}

	protected startLeaseRenewal(context: ReadyContext): void {
		if (this.leaseTimer !== undefined) clearInterval(this.leaseTimer);
		this.leaseTimer = setInterval(() => {
			void (async () => {
				try {
					await context.client.renewClient({
						registrationId: context.registration.registrationId,
						registrationGeneration: context.registration.registrationGeneration,
						clientInstanceId: context.clientInstanceId,
						registrationCredential: context.registrationCredential,
					});
					if (context.ownerCredential !== undefined && context.ownerGeneration !== undefined) {
						await context.client.renewOwner({
							ownerGeneration: context.ownerGeneration,
							ownerCredential: credentialText(context.ownerCredential),
						});
					}
				} catch (error) {
					if (this.context !== context) return;
					this.stopLeaseRenewal();
					this.context = undefined;
					context.ownerCredential?.fill(0);
					const failure = mappedFailure(this.config.mode, error);
					this.currentState = failure.state.name;
					this.stateChanged(failure.state);
				}
			})();
		}, 10_000);
		this.leaseTimer.unref?.();
	}

	protected stopLeaseRenewal(): void {
		if (this.leaseTimer === undefined) return;
		clearInterval(this.leaseTimer);
		this.leaseTimer = undefined;
	}

	protected projectReadyResult(context: ReadyContext): LifecycleResult {
		const handle: LifecycleReadyHandle = Object.freeze({
			mode: this.config.mode as Exclude<BreadboardRunConfig["mode"], "off">,
			binding: context.binding,
			lifecycleClient: context.client,
			requestFetch: context.requestFetch,
			registration: Object.freeze({
				id: context.registration.registrationId,
				generation: context.registration.registrationGeneration,
				clientInstanceId: context.clientInstanceId,
				admissionEpoch: context.registration.admissionEpoch,
				expiresAtUnix: context.registration.expiresAtUnix,
			}),
			...(context.ownerGeneration === undefined ? {} : { ownerGeneration: context.ownerGeneration }),
		});
		return {
			kind: "ready",
			state: lifecycleState(this.config.mode, "ready") as LifecycleState & { readonly name: "ready" },
			handle,
		};
	}

	protected readyResult(context: ReadyContext): LifecycleResult {
		this.context = context;
		this.startLeaseRenewal(context);
		this.transition("ready");
		return this.projectReadyResult(context);
	}

	protected projectObservedResult(binding: LifecycleEngineBinding): LifecycleResult {
		return {
			kind: "observed",
			state: lifecycleState(this.config.mode, "compatible-observed") as LifecycleState & {
				readonly name: "compatible-observed";
			},
			handle: Object.freeze({ mode: this.config.mode as Exclude<BreadboardRunConfig["mode"], "off">, binding }),
		};
	}

	protected observedResult(binding: LifecycleEngineBinding): LifecycleResult {
		this.transition("compatible-observed");
		return this.projectObservedResult(binding);
	}

	protected async detach(): Promise<LifecycleResult> {
		const context = this.context;
		if (!context) return lifecycleFailure(this.config.mode, "failed", "endpoint_unreachable");
		this.transition("detaching-client");
		this.stopLeaseRenewal();
		try {
			await context.client.detachClient({
				registrationId: context.registration.registrationId,
				registrationGeneration: context.registration.registrationGeneration,
				clientInstanceId: context.clientInstanceId,
				registrationCredential: context.registrationCredential,
				signal: this.abortController.signal.aborted ? undefined : this.abortController.signal,
			});
			this.transition("detached");
			return {
				kind: "detached",
				state: lifecycleState(this.config.mode, "detached") as LifecycleState & { readonly name: "detached" },
			};
		} catch (error) {
			return mappedFailure(this.config.mode, error);
		} finally {
			if (this.context === context) this.context = undefined;
			context.ownerCredential?.fill(0);
		}
	}
}

class OffModeStrategy extends ModeStrategy {
	async connect(): Promise<LifecycleResult> {
		const state = lifecycleState("off", "off", 0, "engine_mode_off") as LifecycleState & { readonly name: "off" };
		this.stateChanged(state);
		return { kind: "off", state };
	}
	async status(): Promise<LifecycleResult> {
		return this.connect();
	}
	async stop(): Promise<LifecycleResult> {
		return lifecycleFailure("off", "failed", "mode_forbidden");
	}
	async restart(): Promise<LifecycleResult> {
		return lifecycleFailure("off", "failed", "mode_forbidden");
	}
	async close(): Promise<LifecycleResult> {
		return this.connect();
	}
}

class ConnectOnlyModeStrategy extends ModeStrategy {
	#connectPromise: Promise<LifecycleResult> | undefined;

	async connect(): Promise<LifecycleResult> {
		if (this.context) return this.projectReadyResult(this.context);
		this.#connectPromise ??= this.#connectOnce();
		try {
			return await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(): Promise<LifecycleResult> {
		try {
			const context = await this.withReconnect(async attempt => {
				this.transition("connecting", attempt);
				this.transition("handshaking", attempt);
				const bound = await this.handshake();
				return await this.register(bound);
			});
			return this.readyResult(context);
		} catch (error) {
			return mappedFailure(this.config.mode, error);
		}
	}

	async status(): Promise<LifecycleResult> {
		if (this.context) return this.projectObservedResult(this.context.binding);
		try {
			this.transition("connecting");
			this.transition("handshaking");
			return this.observedResult((await this.handshake()).binding);
		} catch (error) {
			return mappedFailure(this.config.mode, error);
		}
	}

	async stop(): Promise<LifecycleResult> {
		return lifecycleFailure(this.config.mode, "failed", "mode_forbidden");
	}
	async restart(): Promise<LifecycleResult> {
		return lifecycleFailure(this.config.mode, "failed", "mode_forbidden");
	}
	async close(): Promise<LifecycleResult> {
		return this.context ? this.detach() : lifecycleFailure(this.config.mode, "failed", "endpoint_unreachable");
	}
}

class LocalOwnedModeStrategy extends ModeStrategy {
	readonly #store: LocalAuthorityStore;
	readonly #process: LifecycleProcessAdapter;
	readonly #restartStarts: number[] = [];
	readonly #plannedProcesses = new WeakSet<SpawnedEngineProcess>();
	readonly #endpointAbsent: (client: LifecycleE4Client) => Promise<boolean | "ambiguous">;
	#detachedClosePhase: "detach-pending" | "release-pending" | undefined;
	#releaseReplayClient: BoundLifecycleE4Client | undefined;
	#hardSignalCommitActive = false;
	#connectPromise: Promise<LifecycleResult> | undefined;

	constructor(config: BreadboardRunConfig, dependencies: LifecycleSupervisorDependencies) {
		super(config, dependencies);
		if (!dependencies.store) throw new Error("local-owned requires a local authority store");
		this.#store = dependencies.store;
		this.#process = dependencies.process ?? new DefaultLifecycleProcessAdapter();
		this.#endpointAbsent =
			dependencies.endpointAbsent ??
			(async client => {
				try {
					await client.handshake({ signal: this.abortController.signal });
					return false;
				} catch (error) {
					return error instanceof LifecycleE4ClientError &&
						error.failure.kind === "http" &&
						error.failure.status === 0
						? true
						: "ambiguous";
				}
			});
	}
	override abortRequiresQuiescence(): boolean {
		return this.#hardSignalCommitActive;
	}

	async connect(): Promise<LifecycleResult> {
		if (this.context) return this.projectReadyResult(this.context);
		this.#connectPromise ??= this.#connectAttempt(0);
		const connectPromise = this.#connectPromise;
		try {
			return await connectPromise;
		} finally {
			if (this.#connectPromise === connectPromise) this.#connectPromise = undefined;
		}
	}

	async start(): Promise<LifecycleResult> {
		return await this.connect();
	}

	async #connectAttempt(attempt: number): Promise<LifecycleResult> {
		if (this.context) return this.projectReadyResult(this.context);
		const endpoint = this.config.endpoint;
		if (!endpoint || !this.config.engineArtifact || !this.config.ownerExitPolicy)
			return lifecycleFailure("local-owned", "failed", "engine_artifact_unavailable", attempt);
		const deadline = this.clock.now() + this.config.startupTimeoutMs;
		try {
			this.transition("claiming", attempt);
			while (this.clock.now() < deadline) {
				if (this.abortController.signal.aborted)
					return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
				const decision = await this.#store.withExclusiveLock(endpoint, async () => {
					const current = await this.#store.readCurrentForRecovery(endpoint);
					if (current) return { kind: "record" as const, record: current };
					const claimed = await this.#store.claimStart(endpoint);
					if (claimed.kind !== "dead-bound") return claimed;
					const absent = await this.#endpointAbsent(await this.unboundClient());
					if (absent !== true) return claimed;
					await this.#store.retireDeadStartClaim(endpoint, claimed.claim);
					return await this.#store.claimStart(endpoint);
				});
				if (decision.kind === "record") return await this.#adoptOrRecover(decision.record, attempt);
				if (decision.kind === "recoverable")
					return await this.#resumePendingStart(decision.claim, attempt, this.config.ownerExitPolicy);
				if (decision.kind === "unbound")
					return await this.#resumeUnboundPendingStart(decision.claim, attempt, this.config.ownerExitPolicy);
				if (decision.kind === "dead-bound") {
					return lifecycleFailure("local-owned", "recovery-needed", "endpoint_unreachable", attempt);
				}
				if (decision.kind === "occupied") {
					await this.clock.sleep(25);
					continue;
				}
				return await this.#runClaimedStart(decision.claim, attempt, this.config.ownerExitPolicy, false);
			}
			return lifecycleFailure("local-owned", "failed", "endpoint_unreachable", attempt);
		} catch (error) {
			return mappedFailure("local-owned", error, attempt);
		}
	}

	async #abortUnspawnedStart(claim: LocalStartClaim, attempt: number): Promise<LifecycleResult> {
		const endpoint = this.config.endpoint as string;
		await this.#store.withExclusiveLock(endpoint, async () => {
			await this.#store.verifyStartClaim(endpoint, claim);
			await this.#store.releaseStartClaim(endpoint, claim.token);
		});
		return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
	}

	async #runClaimedStart(
		claim: LocalStartClaim,
		attempt: number,
		policy: OwnerExitPolicy,
		restart: boolean,
	): Promise<LifecycleResult> {
		return await this.#coldStart(claim, attempt, policy, restart);
	}

	#isOwnerExpired(error: unknown): boolean {
		return error instanceof LifecycleE4ClientError && error.failure.kind === "owner-expired";
	}
	#isOwnerConflict(error: unknown): boolean {
		return error instanceof LifecycleE4ClientError && error.failure.kind === "owner-conflict";
	}

	#isAmbiguousControlRequest(error: unknown): boolean {
		if (!(error instanceof LifecycleE4ClientError)) return false;
		return (
			error.failure.kind === "timeout" ||
			error.failure.kind === "caller-abort" ||
			(error.failure.kind === "http" && error.failure.status === 0)
		);
	}

	async #retryAmbiguousControlRequest<T>(operation: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await operation(attempt === 0 ? this.abortController.signal : undefined);
			} catch (error) {
				if (!this.#isAmbiguousControlRequest(error)) throw error;
				lastError = error;
			}
		}
		throw lastError;
	}

	async #acquirePendingOwner(
		bound: BoundLifecycleE4Client,
		claim: LocalStartClaim,
		pending: { readonly bootstrapCredential: Buffer; readonly ownerCredential: Buffer },
	): Promise<{ readonly owner: { readonly ownerGeneration: number }; readonly claim: LocalStartClaim }> {
		const endpoint = this.config.endpoint as string;
		const ownerCredential = credentialText(pending.ownerCredential);
		const priorAttemptGeneration = claim.ownerAttemptGeneration;
		if (priorAttemptGeneration !== undefined) {
			try {
				const owner = await bound.renewOwner({
					ownerGeneration: priorAttemptGeneration,
					ownerCredential,
					signal: this.abortController.signal,
				});
				return { owner, claim };
			} catch (error) {
				if (this.#isOwnerConflict(error) && priorAttemptGeneration >= 2) {
					try {
						const predecessor = await bound.renewOwner({
							ownerGeneration: priorAttemptGeneration - 1,
							ownerCredential,
							signal: this.abortController.signal,
						});
						const rolledBackClaim = await this.#store.withExclusiveLock(endpoint, () =>
							this.#store.rollbackOwnerAttempt(endpoint, claim),
						);
						return { owner: predecessor, claim: rolledBackClaim };
					} catch (predecessorError) {
						if (!this.#isOwnerExpired(predecessorError)) throw predecessorError;
					}
					try {
						const owner = await bound.acquireOwner({
							expectedOwnerGeneration: priorAttemptGeneration - 1,
							ownerCredential,
							signal: this.abortController.signal,
						});
						return { owner, claim };
					} catch (acquireError) {
						if (!this.#isOwnerConflict(acquireError)) throw acquireError;
					}
					const owner = await bound.renewOwner({
						ownerGeneration: priorAttemptGeneration,
						ownerCredential,
						signal: this.abortController.signal,
					});
					return { owner, claim };
				}
				if (!this.#isOwnerExpired(error)) throw error;
			}
			const attemptedClaim = await this.#store.withExclusiveLock(endpoint, () =>
				this.#store.markOwnerAttempt(endpoint, claim),
			);
			try {
				const owner = await bound.acquireOwner({
					expectedOwnerGeneration: priorAttemptGeneration,
					ownerCredential,
					signal: this.abortController.signal,
				});
				return { owner, claim: attemptedClaim };
			} catch (error) {
				if (!this.#isOwnerExpired(error)) throw error;
			}
			const rolledBackClaim = await this.#store.withExclusiveLock(endpoint, () =>
				this.#store.rollbackOwnerAttempt(endpoint, attemptedClaim),
			);
			try {
				const owner =
					priorAttemptGeneration === 1
						? await bound.acquireOwner({
								expectedOwnerGeneration: 0,
								bootstrapCredential: pending.bootstrapCredential,
								ownerCredential,
								signal: this.abortController.signal,
							})
						: await bound.acquireOwner({
								expectedOwnerGeneration: priorAttemptGeneration - 1,
								ownerCredential,
								signal: this.abortController.signal,
							});
				return { owner, claim: rolledBackClaim };
			} catch (error) {
				if (!this.#isOwnerConflict(error)) throw error;
			}
			const owner = await bound.renewOwner({
				ownerGeneration: priorAttemptGeneration,
				ownerCredential,
				signal: this.abortController.signal,
			});
			return { owner, claim: rolledBackClaim };
		}
		const attemptedClaim = await this.#store.withExclusiveLock(endpoint, () =>
			this.#store.markOwnerAttempt(endpoint, claim),
		);
		const owner = await bound.acquireOwner({
			expectedOwnerGeneration: 0,
			bootstrapCredential: pending.bootstrapCredential,
			ownerCredential,
			signal: this.abortController.signal,
		});
		return { owner, claim: attemptedClaim };
	}
	async #resumeUnboundPendingStart(
		claim: LocalStartClaim,
		attempt: number,
		ownerExitPolicy: OwnerExitPolicy,
	): Promise<LifecycleResult> {
		const artifact = this.config.engineArtifact;
		const endpoint = this.config.endpoint;
		if (
			!artifact ||
			!endpoint ||
			claim.launchId === undefined ||
			claim.executableSha256 !== artifact.executableSha256 ||
			claim.executablePathSha256 !== executablePathSha256(artifact.executablePath) ||
			claim.argvSha256 !== artifact.argvSha256 ||
			claim.engineArtifactSha256 !== artifact.engineSourceSha256 ||
			claim.servedBackendCommit !== artifact.servedBackendCommit
		)
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		const recoveryDeadline = this.clock.now() + this.config.startupTimeoutMs;
		let reconnectAttempt = 0;
		while (this.clock.now() < recoveryDeadline) {
			if (this.abortController.signal.aborted) {
				return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
			}
			let bound: BoundLifecycleE4Client;
			try {
				this.transition("connecting", reconnectAttempt);
				this.transition("handshaking", reconnectAttempt);
				bound = await this.handshake();
			} catch (error) {
				if (!this.isRetryableTransport(error)) return mappedFailure("local-owned", error, attempt);
				this.transition("reconnecting", reconnectAttempt + 1);
				reconnectAttempt++;
				const remaining = recoveryDeadline - this.clock.now();
				if (remaining <= 0) break;
				await this.clock.sleep(Math.min(25, remaining));
				continue;
			}
			const binding = bound.binding;
			if (
				binding.launchId !== claim.launchId ||
				binding.launch.source !== "supervisor" ||
				binding.artifactRevision.engineArtifactSha256 !== artifact.engineSourceSha256 ||
				binding.artifactRevision.servedBackendCommit !== artifact.servedBackendCommit ||
				binding.artifactRevision.servedBackendDirty !== false
			)
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
			const observation = await this.#process.observe(binding.process.pid);
			if (observation.kind !== "alive" || observation.startToken !== binding.process.osProcessStartToken) {
				return lifecycleFailure("local-owned", "recovery-needed", "process_identity_unavailable", attempt);
			}
			const boundClaim = await this.#store.withExclusiveLock(endpoint, async () => {
				await this.#store.verifyStartClaim(endpoint, claim);
				const lockedObservation = await this.#process.observe(binding.process.pid);
				if (
					lockedObservation.kind !== "alive" ||
					lockedObservation.startToken !== binding.process.osProcessStartToken
				) {
					throw new ProcessIdentityValidationError("unbound pending engine identity changed");
				}
				return await this.#store.bindStartClaimProcess(
					endpoint,
					claim.token,
					binding.process.pid,
					binding.process.osProcessStartToken,
				);
			});
			return await this.#resumePendingStart(boundClaim, attempt, ownerExitPolicy, bound);
		}
		const replacement = await this.#store.withExclusiveLock(endpoint, async () => {
			await this.#store.verifyStartClaim(endpoint, claim);
			const absent = await this.#endpointAbsent(await this.unboundClient());
			if (absent !== true) return null;
			await this.#store.retireDeadStartClaim(endpoint, claim);
			const next = await this.#store.claimStart(endpoint);
			return next.kind === "claimed" ? next.claim : null;
		});
		if (!replacement) return lifecycleFailure("local-owned", "recovery-needed", "endpoint_unreachable", attempt);
		return await this.#runClaimedStart(replacement, attempt, ownerExitPolicy, false);
	}

	async #resumePendingStart(
		claim: LocalStartClaim,
		attempt: number,
		ownerExitPolicy: OwnerExitPolicy,
		recoveredBound?: BoundLifecycleE4Client,
	): Promise<LifecycleResult> {
		if (this.abortController.signal.aborted)
			return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
		const artifact = this.config.engineArtifact;
		const endpoint = this.config.endpoint;
		if (
			!artifact ||
			!endpoint ||
			claim.enginePid === undefined ||
			claim.engineProcessStartToken === undefined ||
			claim.launchId === undefined ||
			claim.executableSha256 !== artifact.executableSha256 ||
			claim.executablePathSha256 !== executablePathSha256(artifact.executablePath) ||
			claim.argvSha256 !== artifact.argvSha256 ||
			claim.engineArtifactSha256 !== artifact.engineSourceSha256 ||
			claim.servedBackendCommit !== artifact.servedBackendCommit
		)
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		const control = await this.#process.controlFor(claim.enginePid, claim.engineProcessStartToken);
		if (!control) return lifecycleFailure("local-owned", "identity-changed", "process_identity_unavailable", attempt);
		const pending = await this.#store.withExclusiveLock(endpoint, async () => {
			await this.#store.verifyStartClaim(endpoint, claim);
			return await this.#store.readPendingSecret(claim);
		});
		try {
			const bound =
				recoveredBound ??
				(await this.withReconnect(async reconnectAttempt => {
					this.transition("connecting", reconnectAttempt);
					this.transition("handshaking", reconnectAttempt);
					return await this.handshake();
				}));
			if (
				bound.binding.process.pid !== claim.enginePid ||
				bound.binding.process.osProcessStartToken !== claim.engineProcessStartToken ||
				bound.binding.launchId !== claim.launchId ||
				bound.binding.launch.source !== "supervisor" ||
				bound.binding.artifactRevision.engineArtifactSha256 !== artifact.engineSourceSha256 ||
				bound.binding.artifactRevision.servedBackendCommit !== artifact.servedBackendCommit ||
				bound.binding.artifactRevision.servedBackendDirty !== false
			)
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
			this.transition("acquiring-owner", attempt);
			const acquired = await this.#acquirePendingOwner(bound, claim, pending);
			const owner = acquired.owner;
			claim = acquired.claim;
			const now = new Date(this.clock.now()).toISOString();
			const record = await this.#store.withExclusiveLock(endpoint, async () => {
				await this.#store.verifyStartClaim(endpoint, claim);
				const observation = await this.#process.observe(claim.enginePid as number);
				if (observation.kind !== "alive" || observation.startToken !== claim.engineProcessStartToken) {
					throw new ProcessIdentityValidationError("pending engine process identity changed");
				}
				const committed = await this.#store.commit(
					endpoint,
					null,
					{
						engineInstanceId: bound.binding.engineInstanceId,
						engineBootId: bound.binding.engineBootId,
						launchId: claim.launchId as string,
						ownerGeneration: owner.ownerGeneration,
						pid: claim.enginePid as number,
						osProcessStartToken: claim.engineProcessStartToken as string,
						normalizedEndpoint: endpoint,
						executableSha256: artifact.executableSha256,
						executablePathSha256: executablePathSha256(artifact.executablePath),
						argvSha256: artifact.argvSha256,
						engineArtifactSha256: artifact.engineSourceSha256,
						servedBackendCommit: artifact.servedBackendCommit,
						ownerExitPolicy,
						createdAt: now,
						lastVerifiedAt: now,
					},
					{ ownerCredential: pending.ownerCredential },
				);
				await this.#store.releaseStartClaim(endpoint, claim.token);
				return committed;
			});
			let registered: ReadyContext;
			try {
				registered = await this.register(bound);
			} catch (error) {
				if (this.abortController.signal.aborted) {
					return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
				}
				throw error;
			}
			if (this.abortController.signal.aborted) {
				return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
			}
			const context: ReadyContext = {
				...registered,
				ownerCredential: Buffer.from(pending.ownerCredential),
				ownerGeneration: owner.ownerGeneration,
				record,
				process: control,
				effectiveExitPolicy: ownerExitPolicy,
			};
			const result = this.readyResult(context);
			this.#monitorOwnedChild(context);
			return result;
		} finally {
			pending.bootstrapCredential.fill(0);
			pending.ownerCredential.fill(0);
		}
	}

	async status(): Promise<LifecycleResult> {
		if (this.context) return this.projectObservedResult(this.context.binding);
		const endpoint = this.config.endpoint;
		const artifact = this.config.engineArtifact;
		if (!endpoint || !artifact) return lifecycleFailure("local-owned", "failed", "engine_artifact_unavailable");
		try {
			const record = await this.#store.probeCurrent(endpoint);
			if (!record)
				return {
					kind: "stopped",
					state: lifecycleState("local-owned", "stopped") as LifecycleState & { readonly name: "stopped" },
				};
			if (!this.#recordMatchesConfig(record))
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
			const observation = await this.#process.observe(record.pid);
			if (observation.kind === "dead")
				return {
					kind: "stopped",
					state: lifecycleState("local-owned", "stopped") as LifecycleState & { readonly name: "stopped" },
				};
			if (observation.kind !== "alive" || observation.startToken !== record.osProcessStartToken)
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
			this.transition("connecting");
			this.transition("handshaking");
			const bound = await this.handshake();
			if (!this.#bindingMatchesRecord(bound.binding, record))
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
			return this.observedResult(bound.binding);
		} catch (error) {
			return mappedFailure("local-owned", error);
		}
	}

	async #adoptOrRecover(record: LocalAuthorityRecord, attempt: number, recoverDead = true): Promise<LifecycleResult> {
		if (!this.#recordMatchesConfig(record))
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		const observation = await this.#process.observe(record.pid);
		if (observation.kind === "dead") {
			if (!recoverDead) {
				return {
					kind: "stopped",
					state: lifecycleState("local-owned", "stopped") as LifecycleState & { readonly name: "stopped" },
				};
			}
			const retired = await this.#store.withExclusiveLock(record.normalizedEndpoint, async () => {
				const current = await this.#store.readCurrentForRecovery(record.normalizedEndpoint);
				if (!current) return true;
				const lockedObservation = await this.#process.observe(current.pid);
				if (lockedObservation.kind !== "dead") return false;
				const absent = await this.#endpointAbsent(await this.unboundClient());
				if (absent !== true) return false;
				await this.#store.retireDeadGeneration(record.normalizedEndpoint, current);
				return true;
			});
			if (!retired) return lifecycleFailure("local-owned", "recovery-needed", "endpoint_unreachable", attempt);
			return await this.#connectAttempt(attempt);
		}
		if (observation.kind !== "alive" || observation.startToken !== record.osProcessStartToken) {
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		}
		const bound = await this.withReconnect(async reconnectAttempt => {
			this.transition("connecting", reconnectAttempt);
			this.transition("handshaking", reconnectAttempt);
			return await this.handshake();
		});
		if (!this.#bindingMatchesRecord(bound.binding, record))
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		const control = await this.#process.controlFor(record.pid, record.osProcessStartToken);
		if (!control) return lifecycleFailure("local-owned", "identity-changed", "process_identity_unavailable", attempt);
		const secret = await this.#store.readSecret(record);
		try {
			this.transition("acquiring-owner", attempt);
			let ownerGeneration = record.ownerGeneration;
			try {
				await bound.renewOwner({
					ownerGeneration,
					ownerCredential: credentialText(secret.ownerCredential),
					signal: this.abortController.signal,
				});
			} catch (error) {
				if (!(error instanceof LifecycleE4ClientError) || error.failure.kind !== "owner-expired") throw error;
				ownerGeneration = (
					await bound.acquireOwner({
						expectedOwnerGeneration: ownerGeneration,
						ownerCredential: credentialText(secret.ownerCredential),
						signal: this.abortController.signal,
					})
				).ownerGeneration;
			}
			const now = new Date(this.clock.now()).toISOString();
			const updated =
				ownerGeneration === record.ownerGeneration
					? record
					: await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
							this.#store.commit(
								record.normalizedEndpoint,
								record,
								{
									...record,
									ownerGeneration,
									lastVerifiedAt: now,
								},
								secret,
							),
						);
			const registered = await this.register(bound);
			const context: ReadyContext = {
				...registered,
				ownerCredential: Buffer.from(secret.ownerCredential),
				ownerGeneration,
				record: updated,
				effectiveExitPolicy: record.ownerExitPolicy,
				process: control,
			};
			const result = this.readyResult(context);
			this.#monitorOwnedChild(context);
			return result;
		} finally {
			secret.ownerCredential.fill(0);
		}
	}

	async #coldStart(
		claim: LocalStartClaim,
		attempt: number,
		ownerExitPolicy: OwnerExitPolicy,
		restart: boolean,
	): Promise<LifecycleResult> {
		const bootstrapCredential = this.makeSecret();
		const ownerCredential = this.makeOwnerCredential();
		try {
			return await this.#coldStartWithCredentials(
				claim,
				attempt,
				ownerExitPolicy,
				restart,
				bootstrapCredential,
				ownerCredential,
			);
		} finally {
			bootstrapCredential.fill(0);
			ownerCredential.fill(0);
		}
	}

	async #coldStartWithCredentials(
		claim: LocalStartClaim,
		attempt: number,
		ownerExitPolicy: OwnerExitPolicy,
		restart: boolean,
		bootstrapCredential: Buffer,
		ownerCredential: Buffer,
	): Promise<LifecycleResult> {
		const artifact = this.config.engineArtifact;
		const endpoint = this.config.endpoint;
		if (!artifact || !endpoint)
			return lifecycleFailure("local-owned", "failed", "engine_artifact_unavailable", attempt);
		this.transition(restart ? "restart-starting" : "starting", attempt);
		if (this.abortController.signal.aborted) return await this.#abortUnspawnedStart(claim, attempt);
		const launchId = this.makeCredential();
		let prepared = await this.#store.withExclusiveLock(endpoint, () =>
			this.#store.prepareStartClaim(
				endpoint,
				claim.token,
				{
					launchId,
					executableSha256: artifact.executableSha256,
					executablePathSha256: executablePathSha256(artifact.executablePath),
					argvSha256: artifact.argvSha256,
					engineArtifactSha256: artifact.engineSourceSha256,
					servedBackendCommit: artifact.servedBackendCommit,
				},
				{ bootstrapCredential, ownerCredential },
			),
		);
		if (this.abortController.signal.aborted) {
			bootstrapCredential.fill(0);
			return await this.#abortUnspawnedStart(prepared, attempt);
		}
		const bootstrap = Buffer.from(bootstrapCredential);
		let child: SpawnedEngineProcess;
		try {
			const spawned = await this.#process.spawnVerified(artifact, launchId, bootstrap, async (pid, startToken) => {
				prepared = await this.#store.withExclusiveLock(endpoint, async () => {
					await this.#store.verifyStartClaim(endpoint, prepared);
					return await this.#store.bindStartClaimProcess(endpoint, prepared.token, pid, startToken);
				});
			});
			if ("kind" in spawned) {
				bootstrapCredential.fill(0);
				await this.#store.withExclusiveLock(endpoint, () =>
					this.#store.releaseStartClaim(endpoint, prepared.token),
				);
				return await this.restartAfterConfirmedDeath();
			}
			child = spawned;
		} catch (error) {
			bootstrap.fill(0);
			bootstrapCredential.fill(0);
			await this.#store.withExclusiveLock(endpoint, () => this.#store.releaseStartClaim(endpoint, prepared.token));
			return mappedFailure("local-owned", error, attempt);
		} finally {
			bootstrap.fill(0);
		}
		const deadline = this.clock.now() + this.config.startupTimeoutMs;
		let observation = await this.#process.observe(child.pid);
		while (observation.kind === "ambiguous" && this.clock.now() < deadline) {
			if (await child.waitForExit(5)) {
				observation = { kind: "dead" };
				break;
			}
			observation = await this.#process.observe(child.pid);
		}
		if (observation.kind === "dead") {
			bootstrapCredential.fill(0);
			return await this.#recoverStartupDeath(prepared, attempt);
		}
		if (observation.kind !== "alive" || observation.startToken !== child.startToken) {
			bootstrapCredential.fill(0);
			return lifecycleFailure("local-owned", "failed", "process_identity_unavailable", attempt);
		}
		if (ownerExitPolicy === "detached") child.unref();

		let bound: BoundLifecycleE4Client | undefined;
		for (
			let reconnectAttempt = 0;
			reconnectAttempt < RESTART_DELAYS_MS.length && this.clock.now() < deadline;
			reconnectAttempt++
		) {
			this.transition("connecting", reconnectAttempt);
			this.transition("handshaking", reconnectAttempt);
			const handshake = this.handshake().then(
				value => ({ kind: "bound" as const, value }),
				error => ({ kind: "failure" as const, error }),
			);
			const raced = await Promise.race([handshake, child.exited.then(() => ({ kind: "exited" as const }))]);
			if (raced.kind === "exited") {
				bootstrapCredential.fill(0);
				return await this.#recoverStartupDeath(prepared, attempt);
			}
			if (raced.kind === "bound") {
				bound = raced.value;
				break;
			}
			if (this.abortController.signal.aborted) {
				bootstrapCredential.fill(0);
				return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
			}
			if (!this.isRetryableTransport(raced.error)) {
				bootstrapCredential.fill(0);
				return mappedFailure("local-owned", raced.error, attempt);
			}
			if (reconnectAttempt < RESTART_DELAYS_MS.length - 1) {
				this.transition("reconnecting", reconnectAttempt + 1);
				await this.clock.sleep(RESTART_DELAYS_MS[reconnectAttempt] as number);
			}
		}
		if (!bound) {
			bootstrapCredential.fill(0);
			return lifecycleFailure("local-owned", "failed", "endpoint_unreachable", attempt);
		}
		observation = await this.#process.observe(child.pid);
		if (
			observation.kind !== "alive" ||
			bound.binding.process.pid !== child.pid ||
			bound.binding.process.osProcessStartToken !== observation.startToken ||
			bound.binding.launchId !== launchId ||
			bound.binding.launch.source !== "supervisor" ||
			bound.binding.artifactRevision.engineArtifactSha256 !== artifact.engineSourceSha256 ||
			bound.binding.artifactRevision.servedBackendCommit !== artifact.servedBackendCommit ||
			bound.binding.artifactRevision.servedBackendDirty !== false
		) {
			bootstrapCredential.fill(0);
			return lifecycleFailure("local-owned", "identity-changed", "identity_changed", attempt);
		}
		prepared = await this.#store.withExclusiveLock(endpoint, () => this.#store.markOwnerAttempt(endpoint, prepared));
		this.transition("acquiring-owner", attempt);
		let owner: Awaited<ReturnType<BoundLifecycleE4Client["acquireOwner"]>>;
		try {
			owner = await bound.acquireOwner({
				expectedOwnerGeneration: 0,
				bootstrapCredential,
				ownerCredential: credentialText(ownerCredential),
				signal: this.abortController.signal,
			});
		} catch (error) {
			if (this.abortController.signal.aborted) {
				return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
			}
			return mappedFailure("local-owned", error, attempt);
		} finally {
			bootstrapCredential.fill(0);
		}
		const now = new Date(this.clock.now()).toISOString();
		let record: LocalAuthorityRecord;
		try {
			record = await this.#store.withExclusiveLock(endpoint, async () => {
				await this.#store.verifyStartClaim(endpoint, prepared);
				const committed = await this.#store.commit(
					endpoint,
					null,
					{
						engineInstanceId: bound.binding.engineInstanceId,
						engineBootId: bound.binding.engineBootId,
						launchId,
						ownerGeneration: owner.ownerGeneration,
						pid: child.pid,
						osProcessStartToken: observation.startToken,
						normalizedEndpoint: endpoint,
						executableSha256: artifact.executableSha256,
						executablePathSha256: executablePathSha256(artifact.executablePath),
						argvSha256: artifact.argvSha256,
						engineArtifactSha256: artifact.engineSourceSha256,
						servedBackendCommit: artifact.servedBackendCommit,
						ownerExitPolicy,
						createdAt: now,
						lastVerifiedAt: now,
					},
					{ ownerCredential },
				);
				await this.#store.releaseStartClaim(endpoint, prepared.token);
				return committed;
			});
		} catch (error) {
			return mappedFailure("local-owned", error, attempt);
		}
		if (this.abortController.signal.aborted) {
			return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
		}
		let registered: ReadyContext;
		try {
			registered = await this.register(bound);
		} catch (error) {
			if (this.abortController.signal.aborted) {
				return lifecycleFailure("local-owned", "request-aborted", "request_aborted", attempt);
			}
			if (await child.waitForExit(0)) return await this.#recoverCommittedStartupDeath(record, attempt);
			return mappedFailure("local-owned", error, attempt);
		}
		if (await child.waitForExit(0)) return await this.#recoverCommittedStartupDeath(record, attempt);
		const context: ReadyContext = {
			...registered,
			ownerCredential: Buffer.from(ownerCredential),
			ownerGeneration: owner.ownerGeneration,
			record,
			process: child,
			effectiveExitPolicy: ownerExitPolicy,
		};
		const result = this.readyResult(context);
		this.#monitorOwnedChild(context);
		return result;
	}

	async #recoverStartupDeath(claim: LocalStartClaim, attempt: number): Promise<LifecycleResult> {
		const endpoint = this.config.endpoint as string;
		const recovered = await this.#store.withExclusiveLock(endpoint, async () => {
			await this.#store.verifyStartClaim(endpoint, claim);
			if (claim.enginePid !== undefined) {
				const observation = await this.#process.observe(claim.enginePid);
				if (observation.kind !== "dead") return false;
			}
			const absent = await this.#endpointAbsent(await this.unboundClient());
			if (absent !== true) return false;
			await this.#store.releaseStartClaim(endpoint, claim.token);
			return true;
		});
		if (!recovered) return lifecycleFailure("local-owned", "recovery-needed", "endpoint_unreachable", attempt);
		return await this.restartAfterConfirmedDeath();
	}

	async #recoverCommittedStartupDeath(record: LocalAuthorityRecord, attempt: number): Promise<LifecycleResult> {
		const recovered = await this.#store.withExclusiveLock(record.normalizedEndpoint, async () => {
			const current = await this.#store.readCurrentForRecovery(record.normalizedEndpoint);
			if (!current) return true;
			const observation = await this.#process.observe(current.pid);
			if (observation.kind !== "dead") return false;
			const absent = await this.#endpointAbsent(await this.unboundClient());
			if (absent !== true) return false;
			await this.#store.retireDeadGeneration(record.normalizedEndpoint, record);
			return true;
		});
		if (!recovered) return lifecycleFailure("local-owned", "recovery-needed", "endpoint_unreachable", attempt);
		return await this.restartAfterConfirmedDeath();
	}

	#recordMatchesConfig(record: LocalAuthorityRecord): boolean {
		const artifact = this.config.engineArtifact;
		return (
			artifact !== undefined &&
			record.executableSha256 === artifact.executableSha256 &&
			record.executablePathSha256 === executablePathSha256(artifact.executablePath) &&
			record.argvSha256 === artifact.argvSha256 &&
			record.engineArtifactSha256 === artifact.engineSourceSha256 &&
			record.servedBackendCommit === artifact.servedBackendCommit
		);
	}

	#bindingMatchesRecord(binding: LifecycleEngineBinding, record: LocalAuthorityRecord): boolean {
		return (
			this.#recordMatchesConfig(record) &&
			binding.engineInstanceId === record.engineInstanceId &&
			binding.engineBootId === record.engineBootId &&
			binding.launchId === record.launchId &&
			binding.process.pid === record.pid &&
			binding.process.osProcessStartToken === record.osProcessStartToken &&
			binding.artifactRevision.engineArtifactSha256 === record.engineArtifactSha256 &&
			binding.artifactRevision.servedBackendCommit === record.servedBackendCommit &&
			binding.artifactRevision.servedBackendDirty === false
		);
	}

	#monitorOwnedChild(context: ReadyContext): void {
		const child = context.process;
		if (!child) return;
		void child.exited.then(async () => {
			if (this.#plannedProcesses.has(child) || this.context !== context) return;
			this.stopLeaseRenewal();
			this.context = undefined;
			context.ownerCredential?.fill(0);
			const result = await this.restartAfterConfirmedDeath();
			this.stateChanged(result.state);
		});
	}

	async #withRevalidatedAuthority<T>(
		context: ReadyContext,
		operation: (client: BoundLifecycleE4Client) => Promise<T>,
		options: { readonly ignoreAbort?: boolean } = {},
	): Promise<{ readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" }> {
		const record = context.record;
		const ownerCredential = context.ownerCredential;
		const ownerGeneration = context.ownerGeneration;
		const endpoint = this.config.endpoint;
		if (
			!record ||
			!ownerCredential ||
			ownerGeneration === undefined ||
			!endpoint ||
			!this.#recordMatchesConfig(record)
		) {
			return { kind: "invalid" };
		}
		return await this.#store.withExclusiveLock(endpoint, async () => {
			const current = await this.#store.readCurrentForRecovery(endpoint);
			if (!current || !this.#sameAuthorityRecord(current, record) || !this.#recordMatchesConfig(current)) {
				return { kind: "invalid" };
			}
			const observation = await this.#process.observe(current.pid);
			if (observation.kind !== "alive" || observation.startToken !== current.osProcessStartToken) {
				return { kind: "invalid" };
			}
			const client = await this.handshake(options);
			if (!this.#bindingMatchesRecord(client.binding, current)) return { kind: "invalid" };
			await client.renewOwner({
				ownerGeneration,
				ownerCredential: credentialText(ownerCredential),
				signal: this.abortController.signal.aborted ? undefined : this.abortController.signal,
			});
			return { kind: "valid", value: await operation(client) };
		});
	}

	#sameAuthorityRecord(left: LocalAuthorityRecord, right: LocalAuthorityRecord): boolean {
		return (
			left.recordRevision === right.recordRevision &&
			left.engineInstanceId === right.engineInstanceId &&
			left.engineBootId === right.engineBootId &&
			left.launchId === right.launchId &&
			left.ownerGeneration === right.ownerGeneration &&
			left.pid === right.pid &&
			left.osProcessStartToken === right.osProcessStartToken &&
			left.normalizedEndpoint === right.normalizedEndpoint &&
			left.executableSha256 === right.executableSha256 &&
			left.executablePathSha256 === right.executablePathSha256 &&
			left.argvSha256 === right.argvSha256 &&
			left.engineArtifactSha256 === right.engineArtifactSha256 &&
			left.servedBackendCommit === right.servedBackendCommit &&
			left.ownerCredentialVerifier === right.ownerCredentialVerifier
		);
	}

	async #detachRequesterBestEffort(context: ReadyContext): Promise<void> {
		this.stopLeaseRenewal();
		try {
			await context.client.detachClient({
				registrationId: context.registration.registrationId,
				registrationGeneration: context.registration.registrationGeneration,
				clientInstanceId: context.clientInstanceId,
				registrationCredential: context.registrationCredential,
			});
		} finally {
			if (this.context === context) this.context = undefined;
			context.ownerCredential?.fill(0);
		}
	}

	async #rollbackDrain(context: ReadyContext, drainGeneration: number): Promise<boolean> {
		try {
			const rollback = await this.#retryAmbiguousControlRequest(signal =>
				this.#withRevalidatedAuthority(
					context,
					client =>
						client.rollbackDrain({
							ownerGeneration: context.ownerGeneration as number,
							ownerCredential: credentialText(context.ownerCredential as Buffer),
							drainGeneration,
							signal,
						}),
					{ ignoreAbort: true },
				),
			);
			return rollback.kind === "valid";
		} catch {
			return false;
		}
	}

	async #waitForExactExit(
		record: LocalAuthorityRecord,
		control: SpawnedEngineProcess | null,
		timeoutMs: number,
	): Promise<boolean> {
		if (control) {
			if (!(await control.waitForExit(timeoutMs))) return false;
			return (await this.#process.observe(record.pid)).kind === "dead";
		}
		const polls = Math.max(1, Math.ceil(timeoutMs / 25));
		for (let poll = 0; poll < polls; poll++) {
			const observation = await this.#process.observe(record.pid);
			if (observation.kind === "dead") return true;
			if (observation.kind !== "alive" || observation.startToken !== record.osProcessStartToken) return false;
			await this.clock.sleep(25);
		}
		return false;
	}

	async #retireObservedExit(record: LocalAuthorityRecord): Promise<boolean> {
		return await this.#store.withExclusiveLock(record.normalizedEndpoint, async () => {
			const current = await this.#store.readCurrentForRecovery(record.normalizedEndpoint);
			if (!current || !this.#sameAuthorityRecord(current, record)) return false;
			if ((await this.#process.observe(current.pid)).kind !== "dead") return false;
			await this.#store.retireDeadGeneration(record.normalizedEndpoint, current);
			return true;
		});
	}

	async #rollbackResult(context: ReadyContext): Promise<LifecycleResult> {
		if ((context.effectiveExitPolicy ?? context.record?.ownerExitPolicy) === "detached") return await this.detach();
		return this.readyResult(context);
	}

	async #controlledStop(context: ReadyContext, restart: boolean): Promise<LifecycleResult> {
		if (!context.ownerCredential || context.ownerGeneration === undefined || !context.record) {
			return lifecycleFailure("local-owned", "ownership-conflict", "ownership_conflict");
		}
		const record = context.record;
		const ownerCredential = context.ownerCredential;
		const ownerGeneration = context.ownerGeneration;
		const ownerCredentialText = credentialText(ownerCredential);
		let control = context.process ?? (await this.#process.controlFor(record.pid, record.osProcessStartToken));
		this.transition("draining");
		let drainGeneration: number | undefined;
		let hardDecisionRecorded = false;
		const currentRequester = {
			registrationId: context.registration.registrationId,
			registrationGeneration: context.registration.registrationGeneration,
			clientInstanceId: context.clientInstanceId,
			registrationCredential: context.registrationCredential,
			admissionEpoch: context.registration.admissionEpoch,
		};
		let controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
			this.#store.prepareControlAttempt(
				record.normalizedEndpoint,
				record,
				restart ? "restart" : "stop",
				this.makeCredential(),
				currentRequester,
			),
		);
		let controlRequestId = controlAttempt.controlRequestId;
		const clearControlAttempt = async (): Promise<void> => {
			await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
				this.#store.clearControlAttempt(record.normalizedEndpoint, controlAttempt),
			);
		};
		const abortBeforeHardCommit = async (activeDrainGeneration: number): Promise<LifecycleResult | undefined> => {
			if (!this.abortController.signal.aborted || controlAttempt.phase === "hard-signal-commit-pending")
				return undefined;
			if (!(await this.#rollbackDrain(context, activeDrainGeneration))) {
				return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
			}
			if (control) this.#plannedProcesses.delete(control);
			await clearControlAttempt();
			return lifecycleFailure("local-owned", "request-aborted", "request_aborted");
		};
		this.#hardSignalCommitActive = controlAttempt.phase === "hard-signal-commit-pending";
		try {
			if (controlAttempt.phase !== "begin-pending") {
				drainGeneration = controlAttempt.drainGeneration;
			} else {
				for (let requesterAttempt = 0; requesterAttempt < 2; requesterAttempt++) {
					const requesterSecret = await this.#store.readControlAttemptSecret(controlAttempt);
					let drain: Awaited<ReturnType<BoundLifecycleE4Client["beginControlDrain"]>>;
					try {
						try {
							const drainAuthority = await this.#retryAmbiguousControlRequest(signal =>
								this.#withRevalidatedAuthority(context, client =>
									client.beginControlDrain({
										ownerGeneration,
										controlRequestId,
										ownerCredential: ownerCredentialText,
										registrationId: controlAttempt.registrationId,
										requesterRegistrationGeneration: controlAttempt.requesterRegistrationGeneration,
										requesterClientInstanceId: controlAttempt.requesterClientInstanceId,
										registrationCredential: credentialText(requesterSecret.requesterRegistrationCredential),
										expectedAdmissionEpoch: controlAttempt.expectedAdmissionEpoch,
										signal,
									}),
								),
							);
							if (drainAuthority.kind === "invalid") {
								return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
							}
							drain = drainAuthority.value;
						} catch (error) {
							if (
								requesterAttempt === 0 &&
								error instanceof LifecycleE4ClientError &&
								error.failure.kind === "registration-expired"
							) {
								const expiredAttempt = controlAttempt;
								const replacementRequestId = this.makeCredential();
								controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
									this.#store.replaceExpiredBeginControlAttempt(
										record.normalizedEndpoint,
										record,
										expiredAttempt,
										restart ? "restart" : "stop",
										replacementRequestId,
										currentRequester,
									),
								);
								controlRequestId = controlAttempt.controlRequestId;
								if (controlAttempt.phase !== "begin-pending") {
									drainGeneration = controlAttempt.drainGeneration;
									break;
								}
								continue;
							}
							if (error instanceof LifecycleE4ClientError && error.failure.kind === "drain-conflict") {
								await clearControlAttempt();
								await this.#detachRequesterBestEffort(context);
								return lifecycleFailure("local-owned", "restart-blocked", "drain_denied");
							}
							throw error;
						}
					} finally {
						requesterSecret.requesterRegistrationCredential.fill(0);
					}
					drainGeneration = drain.drainGeneration;
					controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
						this.#store.markControlAttemptDraining(
							record.normalizedEndpoint,
							controlAttempt,
							drain.drainGeneration,
						),
					);
					break;
				}
			}
			if (drainGeneration === undefined) throw new Error("durable control drain generation is unavailable");
			const activeDrainGeneration = drainGeneration;
			this.transition(restart ? "restart-stopping" : "stopping");
			if (control) this.#plannedProcesses.add(control);
			const abortAfterBegin = await abortBeforeHardCommit(activeDrainGeneration);
			if (abortAfterBegin) return abortAfterBegin;
			if (controlAttempt.ownerGeneration !== ownerGeneration) {
				if (controlAttempt.phase === "hard-signal-pending") {
					if (!(await this.#rollbackDrain(context, activeDrainGeneration))) {
						if (control) this.#plannedProcesses.delete(control);
						return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
					}
					if (control) this.#plannedProcesses.delete(control);
					await clearControlAttempt();
					return await this.#rollbackResult(context);
				}
				if (controlAttempt.phase === "hard-signal-commit-pending") {
					if (control) this.#plannedProcesses.delete(control);
					return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
				}
			}

			if (controlAttempt.phase === "draining") {
				const gracefulAuthority = await this.#retryAmbiguousControlRequest(signal =>
					this.#withRevalidatedAuthority(context, client =>
						client.recordGracefulControl({
							ownerGeneration,
							ownerCredential: ownerCredentialText,
							drainGeneration: activeDrainGeneration,
							outcome: "accepted",
							signal,
						}),
					),
				);
				if (gracefulAuthority.kind === "invalid") {
					return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
				}
				const graceful = gracefulAuthority.value;
				if (graceful.result === "rollback_permitted") {
					if (!(await this.#rollbackDrain(context, activeDrainGeneration))) {
						return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
					}
					if (control) this.#plannedProcesses.delete(control);
					await clearControlAttempt();
					return await this.#rollbackResult(context);
				}
				controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
					this.#store.advanceControlAttempt(record.normalizedEndpoint, controlAttempt, "graceful-accepted"),
				);
			}

			const abortAfterGraceful = await abortBeforeHardCommit(activeDrainGeneration);
			if (abortAfterGraceful) return abortAfterGraceful;
			let exited =
				controlAttempt.phase === "hard-signal-pending" || controlAttempt.phase === "hard-signal-commit-pending"
					? false
					: await this.#waitForExactExit(record, control, this.config.requestTimeoutMs);
			if (!exited) {
				if (
					controlAttempt.phase !== "hard-signal-pending" &&
					controlAttempt.phase !== "hard-signal-commit-pending"
				) {
					const abortAfterWait = await abortBeforeHardCommit(activeDrainGeneration);
					if (abortAfterWait) return abortAfterWait;
					const authorizationAuthority = await this.#retryAmbiguousControlRequest(signal =>
						this.#withRevalidatedAuthority(context, client =>
							client.recordGracefulControl({
								ownerGeneration,
								ownerCredential: ownerCredentialText,
								drainGeneration: activeDrainGeneration,
								outcome: "timeout",
								signal,
							}),
						),
					);
					if (authorizationAuthority.kind === "invalid") {
						return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
					}
					const authorization = authorizationAuthority.value;
					if (authorization.result === "rollback_permitted") {
						if (!(await this.#rollbackDrain(context, activeDrainGeneration))) {
							return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
						}
						if (control) this.#plannedProcesses.delete(control);
						await clearControlAttempt();
						return await this.#rollbackResult(context);
					}
					if (authorization.result !== "hard_signal_decision_pending" || !authorization.signalPermitted) {
						throw new Error("hard signal authorization unavailable");
					}
					controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
						this.#store.advanceControlAttempt(record.normalizedEndpoint, controlAttempt, "hard-signal-pending"),
					);
				}
				const abortAfterAuthorization = await abortBeforeHardCommit(activeDrainGeneration);
				if (abortAfterAuthorization) return abortAfterAuthorization;
				const preparationAttempt = await this.#withRevalidatedAuthority(context, async client => {
					const rollbackDrain = () =>
						this.#retryAmbiguousControlRequest(signal =>
							client.rollbackDrain({
								ownerGeneration,
								ownerCredential: ownerCredentialText,
								drainGeneration: activeDrainGeneration,
								signal,
							}),
						);
					control ??= await this.#process.controlFor(record.pid, record.osProcessStartToken);
					if (!control) {
						await rollbackDrain();
						return { kind: "rolled-back" as const };
					}
					const preparedSignal = await this.#retryAmbiguousControlRequest(signal =>
						client.prepareHardSignal({
							ownerGeneration,
							ownerCredential: ownerCredentialText,
							drainGeneration: activeDrainGeneration,
							pid: record.pid,
							osProcessStartToken: record.osProcessStartToken,
							signal,
						}),
					);
					return { kind: "prepared" as const, preparedSignal };
				});
				if (preparationAttempt.kind === "invalid") {
					return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
				}
				if (preparationAttempt.value.kind === "rolled-back") {
					if (control) this.#plannedProcesses.delete(control);
					await clearControlAttempt();
					return await this.#rollbackResult(context);
				}
				const preparedSignal = preparationAttempt.value.preparedSignal;
				const abortAfterPreparation = await abortBeforeHardCommit(activeDrainGeneration);
				if (abortAfterPreparation) return abortAfterPreparation;
				this.#hardSignalCommitActive = true;
				if (controlAttempt.phase === "hard-signal-pending") {
					controlAttempt = await this.#store.withExclusiveLock(record.normalizedEndpoint, () =>
						this.#store.advanceControlAttempt(
							record.normalizedEndpoint,
							controlAttempt,
							"hard-signal-commit-pending",
						),
					);
				}
				const signalControl = control;
				if (!signalControl) throw new Error("hard signal process control unavailable after preparation");
				hardDecisionRecorded = true;
				const hardAttempt = await this.#withRevalidatedAuthority(context, async client => {
					const signalClient = client;
					let signalPermit: HardSignalPermitResponse;
					try {
						signalPermit = await this.#retryAmbiguousControlRequest(signal =>
							signalClient.commitHardSignal({
								ownerGeneration,
								ownerCredential: ownerCredentialText,
								drainGeneration: activeDrainGeneration,
								authorizationId: preparedSignal.authorizationId,
								pid: record.pid,
								osProcessStartToken: record.osProcessStartToken,
								signal,
							}),
						);
					} catch (error) {
						if (
							error instanceof LifecycleE4ClientError &&
							error.failure.kind === "hard-signal-authorization-expired"
						) {
							hardDecisionRecorded = false;
						}
						throw error;
					}
					if (signalPermit.authorizationId !== preparedSignal.authorizationId) {
						throw new Error("hard signal commit authorization mismatch");
					}
					const immediateObservation = await this.#process.observe(record.pid);
					if (
						immediateObservation.kind !== "alive" ||
						immediateObservation.startToken !== record.osProcessStartToken
					) {
						if (immediateObservation.kind !== "dead")
							throw new Error("process identity changed after hard signal commit");
						await this.#retryAmbiguousControlRequest(signal =>
							signalClient.recordHardSignalOutcome({
								ownerGeneration,
								ownerCredential: ownerCredentialText,
								drainGeneration: activeDrainGeneration,
								authorizationId: signalPermit.authorizationId,
								outcome: "process_exited",
								signal,
							}),
						);
						return { outcome: "process_exited" as const };
					}
					const outcome = await signalControl.sendHardSignal(signalPermit.expiresAtUnix);
					if (outcome === "authorization_expired" || outcome === "abandoned") {
						throw new Error("hard signal permit became unusable after commit");
					}
					await this.#retryAmbiguousControlRequest(signal =>
						signalClient.recordHardSignalOutcome({
							ownerGeneration,
							ownerCredential: ownerCredentialText,
							drainGeneration: activeDrainGeneration,
							authorizationId: signalPermit.authorizationId,
							outcome,
							signal,
						}),
					);
					return { outcome };
				});
				if (hardAttempt.kind === "invalid") {
					return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
				}
				exited = await this.#waitForExactExit(record, control, this.config.requestTimeoutMs);
			}
			if (!exited || !(await this.#retireObservedExit(record))) {
				return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
			}
			if (control) this.#plannedProcesses.delete(control);
			this.stopLeaseRenewal();
			this.context = undefined;
			ownerCredential.fill(0);
			if (!restart) this.transition("stopped");
			return {
				kind: "stopped",
				state: lifecycleState("local-owned", "stopped") as LifecycleState & { readonly name: "stopped" },
			};
		} catch (error) {
			const expiredAuthorization =
				error instanceof LifecycleE4ClientError && error.failure.kind === "hard-signal-authorization-expired";
			if (
				drainGeneration !== undefined &&
				!hardDecisionRecorded &&
				(controlAttempt.phase !== "hard-signal-commit-pending" || expiredAuthorization)
			) {
				if (!(await this.#rollbackDrain(context, drainGeneration))) {
					return lifecycleFailure("local-owned", "drain-recovery-failed", "drain_recovery_failed");
				}
				await clearControlAttempt();
				if (expiredAuthorization) {
					if (control) this.#plannedProcesses.delete(control);
					return await this.#rollbackResult(context);
				}
			}
			if (control) this.#plannedProcesses.delete(control);
			return mappedFailure("local-owned", error);
		} finally {
			this.#hardSignalCommitActive = false;
		}
	}
	async stop(options: StopOptions): Promise<LifecycleResult> {
		if (!options.consumerClosed) return lifecycleFailure("local-owned", "restart-blocked", "drain_denied");
		if (!this.context) {
			const endpoint = this.config.endpoint;
			if (!endpoint) return lifecycleFailure("local-owned", "failed", "endpoint_unreachable");
			const record = await this.#store.probeCurrent(endpoint);
			if (!record) {
				return {
					kind: "stopped",
					state: lifecycleState("local-owned", "stopped") as LifecycleState & { readonly name: "stopped" },
				};
			}
			const adopted = await this.#adoptOrRecover(record, 0, false);
			if (adopted.kind !== "ready") return adopted;
		}
		return await this.#controlledStop(this.context as ReadyContext, false);
	}

	async restart(options: StopOptions): Promise<LifecycleResult> {
		if (!options.consumerClosed) return lifecycleFailure("local-owned", "restart-blocked", "drain_denied");
		if (!this.context) {
			const endpoint = this.config.endpoint;
			const initialPolicy = this.config.ownerExitPolicy;
			if (!endpoint || !initialPolicy) return lifecycleFailure("local-owned", "failed", "process_control_failed");
			const initial = await this.#store.withExclusiveLock(endpoint, async () => {
				const record = await this.#store.readCurrentForRecovery(endpoint);
				if (record) return { kind: "record" as const, record };
				return await this.#store.claimStart(endpoint);
			});
			if (initial.kind === "claimed") {
				return await this.#runClaimedStart(initial.claim, 0, initialPolicy, true);
			}
			const connected = await this.connect();
			if (connected.kind !== "ready") return connected;
		}
		const context = this.context;
		if (!context) return lifecycleFailure("local-owned", "failed", "endpoint_unreachable");
		const policy = context.effectiveExitPolicy ?? context.record?.ownerExitPolicy ?? this.config.ownerExitPolicy;
		if (!policy) return lifecycleFailure("local-owned", "failed", "process_control_failed");
		const stopped = await this.#controlledStop(context, true);
		if (stopped.kind !== "stopped") return stopped;
		const endpoint = this.config.endpoint as string;
		const claim = await this.#store.withExclusiveLock(endpoint, () => this.#store.claimStart(endpoint));
		if (claim.kind !== "claimed") return lifecycleFailure("local-owned", "restart-blocked", "drain_denied");
		return await this.#runClaimedStart(claim.claim, 0, policy, true);
	}

	async restartAfterConfirmedDeath(): Promise<LifecycleResult> {
		const now = this.clock.now();
		while (this.#restartStarts.length > 0 && now - (this.#restartStarts[0] as number) >= RESTART_WINDOW_MS)
			this.#restartStarts.shift();
		if (this.#restartStarts.length >= RESTART_DELAYS_MS.length)
			return lifecycleFailure("local-owned", "failed", "restart_budget_exhausted", this.#restartStarts.length);
		const attempt = this.#restartStarts.length;
		this.#restartStarts.push(now);
		this.transition("backing-off", attempt + 1);
		await this.clock.sleep(RESTART_DELAYS_MS[attempt] as number);
		return await this.#connectAttempt(attempt + 1);
	}

	#clearDetachedClose(context: ReadyContext): void {
		if (this.context === context) this.context = undefined;
		context.ownerCredential?.fill(0);
		this.#detachedClosePhase = undefined;
		this.#releaseReplayClient = undefined;
	}

	async #releaseOwnerForDetachedClose(context: ReadyContext): Promise<boolean> {
		const endpoint = context.record?.normalizedEndpoint;
		const ownerCredential = context.ownerCredential;
		const ownerGeneration = context.ownerGeneration;
		if (!endpoint || !ownerCredential || ownerGeneration === undefined) return false;
		const release = (client: BoundLifecycleE4Client) =>
			this.#retryAmbiguousControlRequest(signal =>
				client.releaseOwner({
					ownerGeneration,
					ownerCredential: credentialText(ownerCredential),
					signal,
				}),
			);
		if (this.#releaseReplayClient) {
			const replayClient = this.#releaseReplayClient;
			return await this.#store.withExclusiveLock(endpoint, async () => {
				const current = await this.#store.readCurrentForRecovery(endpoint);
				if (!current || !context.record || !this.#sameAuthorityRecord(current, context.record)) return false;
				const observation = await this.#process.observe(current.pid);
				if (observation.kind !== "alive" || observation.startToken !== current.osProcessStartToken) return false;
				await release(replayClient);
				return true;
			});
		}
		const released = await this.#withRevalidatedAuthority(context, async client => {
			this.#releaseReplayClient = client;
			return await release(client);
		});
		return released.kind === "valid";
	}

	async close(options: StopOptions): Promise<LifecycleResult> {
		const context = this.context;
		const policy = context?.effectiveExitPolicy ?? context?.record?.ownerExitPolicy ?? this.config.ownerExitPolicy;
		if (policy !== "detached") return await this.stop(options);
		if (!context || context.ownerCredential === undefined || context.ownerGeneration === undefined) {
			return lifecycleFailure("local-owned", "failed", "endpoint_unreachable");
		}
		if (this.#detachedClosePhase === undefined) {
			this.transition("detaching-client");
			this.stopLeaseRenewal();
			this.#detachedClosePhase = "detach-pending";
		}
		try {
			if (this.#detachedClosePhase === "detach-pending") {
				await this.#retryAmbiguousControlRequest(signal =>
					context.client.detachClient({
						registrationId: context.registration.registrationId,
						registrationGeneration: context.registration.registrationGeneration,
						clientInstanceId: context.clientInstanceId,
						registrationCredential: context.registrationCredential,
						signal,
					}),
				);
				this.#detachedClosePhase = "release-pending";
			}
			if (!(await this.#releaseOwnerForDetachedClose(context))) {
				this.#clearDetachedClose(context);
				return lifecycleFailure("local-owned", "identity-changed", "identity_changed");
			}
			this.#clearDetachedClose(context);
			this.transition("detached");
			return {
				kind: "detached",
				state: lifecycleState("local-owned", "detached") as LifecycleState & { readonly name: "detached" },
			};
		} catch (error) {
			if (!this.#isAmbiguousControlRequest(error)) this.#clearDetachedClose(context);
			return mappedFailure("local-owned", error);
		}
	}

	async update(): Promise<LifecycleResult> {
		return lifecycleFailure("local-owned", "update-unavailable", "artifact_update_not_governed");
	}
}

export class LifecycleSupervisor {
	readonly #strategy: ModeStrategy;

	constructor(
		readonly config: BreadboardRunConfig,
		dependencies: LifecycleSupervisorDependencies = {},
	) {
		if (config.mode === "off") this.#strategy = new OffModeStrategy(config, dependencies);
		else if (config.mode === "local-owned") this.#strategy = new LocalOwnedModeStrategy(config, dependencies);
		else this.#strategy = new ConnectOnlyModeStrategy(config, dependencies);
	}

	connect(): Promise<LifecycleResult> {
		return this.#strategy.connect();
	}
	start(): Promise<LifecycleResult> {
		return this.#strategy.start();
	}
	status(): Promise<LifecycleResult> {
		return this.#strategy.status();
	}
	stop(options: StopOptions): Promise<LifecycleResult> {
		return this.#strategy.stop(options);
	}
	restart(options: StopOptions): Promise<LifecycleResult> {
		return this.#strategy.restart(options);
	}
	update(): Promise<LifecycleResult> {
		return this.#strategy.update();
	}
	close(options: StopOptions): Promise<LifecycleResult> {
		return this.#strategy.close(options);
	}
	abort(): void {
		this.#strategy.abort();
	}
	abortRequiresQuiescence(): boolean {
		return this.#strategy.abortRequiresQuiescence();
	}
	abortResult(): LifecycleResult {
		return lifecycleFailure(this.config.mode, "request-aborted", "request_aborted");
	}
	restartAfterConfirmedDeath(): Promise<LifecycleResult> {
		return this.#strategy instanceof LocalOwnedModeStrategy
			? this.#strategy.restartAfterConfirmedDeath()
			: Promise.resolve(lifecycleFailure(this.config.mode, "failed", "mode_forbidden"));
	}
}

export type LifecycleSignal = "SIGINT" | "SIGTERM";
export type LifecycleDispatchResult = LifecycleResult;
export type LifecycleDispatchAction = "connect" | "start" | "status" | "stop" | "restart" | "update";

export interface LifecycleController {
	connect(): Promise<LifecycleDispatchResult>;
	start(): Promise<LifecycleDispatchResult>;
	status(): Promise<LifecycleDispatchResult>;
	stop(options: StopOptions): Promise<LifecycleDispatchResult>;
	restart(options: StopOptions): Promise<LifecycleDispatchResult>;
	update(): Promise<LifecycleDispatchResult>;
	close(options: StopOptions): Promise<LifecycleDispatchResult>;
	abort?(): void;
	abortRequiresQuiescence?(): boolean;
	abortResult(): LifecycleDispatchResult;
}

export interface LifecycleSignalTarget {
	on(signal: LifecycleSignal, listener: () => void): unknown;
	off(signal: LifecycleSignal, listener: () => void): unknown;
}

export interface DispatchLifecycleActionOptions {
	readonly closeReady?: boolean;
	readonly actionOptions?: StopOptions;
	readonly closeOptions?: StopOptions;
	readonly restoreTerminal: () => void;
	readonly signalTarget?: LifecycleSignalTarget;
	readonly signalSettleTimeoutMs?: number;
}

export interface LifecycleActionExecution {
	readonly result: LifecycleDispatchResult;
	readonly closeResult?: LifecycleDispatchResult;
	readonly signal?: LifecycleSignal;
}

function invokeLifecycleAction(
	controller: LifecycleController,
	action: LifecycleDispatchAction,
	options: StopOptions,
): Promise<LifecycleDispatchResult> {
	switch (action) {
		case "connect":
			return controller.connect();
		case "start":
			return controller.start();
		case "status":
			return controller.status();
		case "stop":
			return controller.stop(options);
		case "restart":
			return controller.restart(options);
		case "update":
			return controller.update();
	}
}

/**
 * Coordinates one lifecycle action with process signals and optional ready-handle cleanup.
 * A signal restores the terminal and aborts the in-flight transport. Cleanup begins after the
 * action settles, preventing registration detach or drain from racing connection setup.
 */
export async function dispatchLifecycleAction(
	controller: LifecycleController,
	action: LifecycleDispatchAction,
	options: DispatchLifecycleActionOptions,
): Promise<LifecycleActionExecution> {
	const actionOptions = options.actionOptions ?? { consumerClosed: true };
	const closeOptions = options.closeOptions ?? { consumerClosed: true };
	const signalTarget = options.signalTarget ?? process;
	let signal: LifecycleSignal | undefined;
	let restored = false;
	const signalReceived = Promise.withResolvers<void>();
	let closePromise: Promise<LifecycleDispatchResult> | undefined;

	const restoreOnce = (): void => {
		if (restored) return;
		restored = true;
		options.restoreTerminal();
	};
	const onSignal = (received: LifecycleSignal): void => {
		if (signal !== undefined) return;
		signal = received;
		restoreOnce();
		controller.abort?.();
		signalReceived.resolve();
	};
	const onSigint = (): void => onSignal("SIGINT");
	const onSigterm = (): void => onSignal("SIGTERM");
	const closeOnce = (): Promise<LifecycleDispatchResult> => {
		closePromise ??= controller.close(closeOptions);
		return closePromise;
	};

	signalTarget.on("SIGINT", onSigint);
	signalTarget.on("SIGTERM", onSigterm);
	try {
		const actionPromise = invokeLifecycleAction(controller, action, actionOptions);
		const first = await Promise.race([
			actionPromise.then(result => ({ kind: "result" as const, result })),
			signalReceived.promise.then(() => ({ kind: "signal" as const })),
		]);
		let result: LifecycleDispatchResult;
		if (first.kind === "result") {
			result = first.result;
		} else {
			const timeout = Promise.withResolvers<void>();
			const timeoutHandle = setTimeout(timeout.resolve, options.signalSettleTimeoutMs ?? 10_000);
			timeoutHandle.unref?.();
			const settled = await Promise.race([
				actionPromise.then(value => ({ kind: "settled" as const, value })),
				timeout.promise.then(() => ({ kind: "timeout" as const })),
			]);
			clearTimeout(timeoutHandle);
			result =
				settled.kind === "settled"
					? settled.value
					: controller.abortRequiresQuiescence?.()
						? await actionPromise
						: controller.abortResult();
		}
		const closeResult =
			result.kind === "ready" && (options.closeReady === true || signal !== undefined)
				? await closeOnce()
				: undefined;
		return {
			result,
			...(closeResult === undefined ? {} : { closeResult }),
			...(signal === undefined ? {} : { signal }),
		};
	} finally {
		signalTarget.off("SIGINT", onSigint);
		signalTarget.off("SIGTERM", onSigterm);
		restoreOnce();
	}
}
