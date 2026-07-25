import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BoundLifecycleE4Client,
	CommitHardSignalInput,
	GracefulControlInput,
	HardSignalPermitResponse,
	LifecycleE4Client,
	LifecycleEngineBinding,
	PrepareHardSignalInput,
} from "@breadboard/sdk";
import { LifecycleE4ClientError } from "@breadboard/sdk";
import { presentLifecycle, writeLifecyclePresentation } from "./lifecycle-presenter";
import { type LifecycleState, lifecycleFailure } from "./lifecycle-state";
import * as lifecycleModule from "./lifecycle-supervisor";
import {
	dispatchLifecycleAction,
	type LifecycleController,
	type LifecycleDispatchResult,
	type LifecycleProcessAdapter,
	type LifecycleSignal,
	type LifecycleSignalTarget,
	LifecycleSupervisor,
	lifecycleChildEnvironment,
	type ProcessObservation,
	readKeychainReference,
	type SpawnedEngineProcess,
} from "./lifecycle-supervisor";
import { LocalAuthorityStore } from "./local-authority-store";
import {
	type BreadboardRunConfig,
	type EngineArtifact,
	executablePathSha256,
	resolveBreadboardRunConfig,
} from "./run-config";

const roots: string[] = [];
const executableSha256 = `sha256:${"a".repeat(64)}` as const;
const engineSourceSha256 = `sha256:${"b".repeat(64)}` as const;
const backendCommit = "c".repeat(40);
const artifact: EngineArtifact = {
	executablePath: "/usr/bin/false",
	argv: ["--serve"],
	argvSha256: "sha256:b76470afe32d50ae8194866d39a872e4dc846e89ac409f390884db522242a6b4",
	executableSha256,
	engineSourceSha256,
	servedBackendCommit: backendCommit,
};
const common = {
	workspacePath: "/workspace",
	canonicalizeWorkspace: () => "/canonical/workspace",
	environment: {} as Record<string, string | undefined>,
};

function resolved(
	mode: "off" | "local-external" | "remote" | "local-owned",
	ownerExitPolicy?: "attached" | "detached",
): BreadboardRunConfig {
	if (mode === "off") return resolveBreadboardRunConfig({ ...common, cli: { engineMode: "off" } });
	if (mode === "local-external")
		return resolveBreadboardRunConfig({ ...common, cli: { engineMode: mode, engineUrl: "http://127.0.0.1:7777" } });
	if (mode === "remote") {
		return resolveBreadboardRunConfig({
			...common,
			cli: { engineMode: mode, engineUrl: "https://engine.example" },
			environment: { BREADBOARD_API_TOKEN: "synthetic-process-secret" },
		});
	}
	return resolveBreadboardRunConfig({
		...common,
		cli: { engineMode: mode, ownerExitPolicy },
		selectedConfig: { engineArtifact: artifact },
	});
}

function bindingFor(
	pid: number,
	launchId: string,
	overrides: Partial<LifecycleEngineBinding> = {},
): LifecycleEngineBinding {
	const engineInstanceId = `engine_instance_${pid}_abcdefghijklmnopqrstuvwxyz`;
	const engineBootId = `engine_boot_${pid}_abcdefghijklmnopqrstuvwxyz012`;
	const startToken = `darwin:${pid}:1`;
	return {
		endpoint: "http://127.0.0.1:7777",
		engineInstanceId,
		engineBootId,
		launchId,
		protocolVersion: "1.0",
		sessionContractId: "p30-e4-session-v1",
		sessionSchemaSha256: "sha256:5757652c22d6aa2eb7a1cc8be1a40021d3f6a15df18d69ca22dc1916a400dbd4",
		sessionReplayContractDigest: {} as LifecycleEngineBinding["sessionReplayContractDigest"],
		liveness: { status: "live" },
		process: {
			engineInstanceId,
			engineBootId,
			startedAt: "2026-07-17T00:00:00.000Z",
			startedAtUnix: 1,
			pid,
			osProcessStartToken: startToken,
		},
		launch: { launchId, source: "supervisor" },
		artifactRevision: {
			engineArtifactSha256: engineSourceSha256,
			servedBackendCommit: backendCommit,
			servedBackendDirty: false,
		},
		protocol: { protocolVersion: "1.0" },
		sessionContract: {
			contractId: "p30-e4-session-v1",
			schemaSha256: "sha256:5757652c22d6aa2eb7a1cc8be1a40021d3f6a15df18d69ca22dc1916a400dbd4",
			compatibility: "compatible",
			sessionReplayContractDigest: {} as LifecycleEngineBinding["sessionReplayContractDigest"],
		},
		sessionReadiness: { ready: true, reason: "ready" },
		...overrides,
	};
}

function hardSignalPermit(
	binding: LifecycleEngineBinding,
	input: Pick<CommitHardSignalInput, "ownerGeneration" | "drainGeneration" | "authorizationId">,
	expiresAtUnix = Math.floor(Date.now() / 1_000) + 30,
): HardSignalPermitResponse {
	return {
		schemaVersion: "bb.engine_hard_signal_permit.v1",
		engineInstanceId: binding.engineInstanceId,
		engineBootId: binding.engineBootId,
		launchId: binding.launchId,
		ownerGeneration: input.ownerGeneration,
		drainGeneration: input.drainGeneration,
		authorizationId: input.authorizationId,
		expiresAtUnix,
		result: "signal_permitted",
		signalPermitted: true,
	};
}

interface ClientBehavior {
	readonly registerError?: Error;
	readonly drainError?: Error;
	readonly gracefulError?: Error;
	readonly hardSignalError?: Error;
	readonly gracefulOutcome?: "shutdown_started" | "rollback_permitted";
}

function boundClient(
	binding: LifecycleEngineBinding,
	calls: string[],
	behavior: ClientBehavior = {},
): BoundLifecycleE4Client {
	return {
		binding,
		acquireOwner: async input => {
			calls.push("acquire-owner");
			if (
				!("bootstrapCredential" in input) ||
				!ArrayBuffer.isView(input.bootstrapCredential) ||
				input.bootstrapCredential.byteLength !== 32
			)
				throw new Error("bootstrap rotation missing");
			return { result: "acquired", ownerGeneration: 1 } as never;
		},
		renewOwner: async () => {
			calls.push("renew-owner");
			return { result: "renewed", ownerGeneration: 1 } as never;
		},
		releaseOwner: async () => {
			calls.push("release-owner");
			return { result: "released" } as never;
		},
		registerClient: async input => {
			calls.push(`register:${input.lifecycleMode}`);
			if (behavior.registerError) throw behavior.registerError;
			return {
				result: "registered",
				registrationId: `registration_${input.clientInstanceId}`,
				registrationGeneration: 1,
				clientInstanceId: input.clientInstanceId,
				admissionEpoch: 7,
				expiresAtUnix: 100,
			} as never;
		},
		renewClient: async () => ({ result: "renewed" }) as never,
		detachClient: async () => {
			calls.push("detach-client");
			return { result: "detached" } as never;
		},
		beginControlDrain: async input => {
			calls.push("begin-drain");
			if (behavior.drainError) throw behavior.drainError;
			return { result: "draining", controlRequestId: input.controlRequestId, drainGeneration: 2 } as never;
		},
		recordGracefulControl: async input => {
			calls.push(`graceful:${input.outcome}`);
			if (behavior.gracefulError) throw behavior.gracefulError;
			return input.outcome === "timeout" || input.outcome === "uncertain"
				? ({ result: "hard_signal_decision_pending", signalPermitted: true } as never)
				: ({
						result:
							behavior.gracefulOutcome ??
							(input.outcome === "definitive_rejection" ? "rollback_permitted" : "shutdown_started"),
					} as never);
		},
		prepareHardSignal: async () => {
			calls.push("prepare-hard-signal");
			return {
				result: "prepared",
				authorizationId: "authorization_abcdefghijklmnopqrstuvwxyz",
				expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
			} as never;
		},
		commitHardSignal: async input => {
			calls.push("commit-hard-signal");
			return hardSignalPermit(binding, input);
		},
		recordHardSignalOutcome: async input => {
			calls.push(`hard-signal:${input.outcome}`);
			if (behavior.hardSignalError) throw behavior.hardSignalError;
			return {
				result:
					input.outcome === "abandoned"
						? "rollback_permitted"
						: input.outcome === "process_exited"
							? "process_exited"
							: "signal_sent",
			} as never;
		},
		rollbackDrain: async () => {
			calls.push("rollback");
			return { result: "rolled_back" } as never;
		},
	} as BoundLifecycleE4Client;
}

async function temporaryStore(
	seams: ConstructorParameters<typeof LocalAuthorityStore>[1] = {},
): Promise<LocalAuthorityStore> {
	const root = await mkdtemp(join(tmpdir(), "omp-supervisor-"));
	roots.push(root);
	return new LocalAuthorityStore(root, seams);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("LifecycleSupervisor mode authority", () => {
	test("off performs zero client, store, process, or secret I/O", async () => {
		let touched = 0;
		const supervisor = new LifecycleSupervisor(resolved("off"), {
			createClient: () => {
				touched++;
				throw new Error("forbidden");
			},
			resolveRemoteSecurity: async () => {
				touched++;
				return {};
			},
		});
		expect((await supervisor.status()).kind).toBe("off");
		expect((await supervisor.start()).state.reason).toBe("mode_forbidden");
		expect((await supervisor.stop({ consumerClosed: true })).state.reason).toBe("mode_forbidden");
		expect((await supervisor.restart({ consumerClosed: true })).state.reason).toBe("mode_forbidden");
		expect((await supervisor.update()).state.reason).toBe("mode_forbidden");
		expect(touched).toBe(0);
	});

	test("local-external and remote forbidden actions cannot construct a client", async () => {
		for (const mode of ["local-external", "remote"] as const) {
			let touched = 0;
			const supervisor = new LifecycleSupervisor(resolved(mode), {
				createClient: () => {
					touched++;
					throw new Error("must not connect");
				},
			});
			expect((await supervisor.start()).state.reason).toBe("mode_forbidden");
			expect((await supervisor.stop({ consumerClosed: true })).state.reason).toBe("mode_forbidden");
			expect((await supervisor.restart({ consumerClosed: true })).state.reason).toBe("mode_forbidden");
			expect((await supervisor.update()).state.reason).toBe("mode_forbidden");
			expect((await supervisor.restartAfterConfirmedDeath()).state.reason).toBe("mode_forbidden");
			expect(touched).toBe(0);
		}
	});

	test("status handshakes without registration and connect registers exactly once", async () => {
		for (const mode of ["local-external", "remote"] as const) {
			const calls: string[] = [];
			const binding = bindingFor(321, "external_launch_abcdefghijklmnopqrstuvwxyz", {
				endpoint: mode === "remote" ? "https://engine.example" : "http://127.0.0.1:7777",
				launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
			});
			const bound = boundClient(binding, calls);
			const supervisor = new LifecycleSupervisor(resolved(mode), {
				createClient: () => ({ handshake: async () => bound }),
			});
			const observed = await supervisor.status();
			expect(observed).toMatchObject({ kind: "observed", state: { name: "compatible-observed" } });
			expect(presentLifecycle(observed).summary).toContain("compatible, observed only");
			expect(presentLifecycle(observed).summary).not.toContain("engine: ready");
			expect(calls.some(call => call.startsWith("register:"))).toBe(false);
			expect((await supervisor.connect()).kind).toBe("ready");
			expect(calls.filter(call => call.startsWith("register:"))).toHaveLength(1);
			expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		}
	});
	test("shares concurrent initial connect and projects repeated ready results in connect-only modes", async () => {
		for (const mode of ["local-external", "remote"] as const) {
			const calls: string[] = [];
			let handshakes = 0;
			const binding = bindingFor(321, "external_launch_abcdefghijklmnopqrstuvwxyz", {
				endpoint: mode === "remote" ? "https://engine.example" : "http://127.0.0.1:7777",
				launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
			});
			const bound = boundClient(binding, calls);
			const supervisor = new LifecycleSupervisor(resolved(mode), {
				createClient: () => ({
					handshake: async () => {
						handshakes++;
						await Bun.sleep(0);
						return bound;
					},
				}),
			});
			const initial = await Promise.all([supervisor.connect(), supervisor.connect()]);
			expect(initial).toMatchObject([{ kind: "ready" }, { kind: "ready" }]);
			expect(initial[1]).toEqual(initial[0]);
			const callsAfterInitial = [...calls];
			expect(await supervisor.connect()).toEqual(initial[0]);
			expect({
				handshakes,
				registrations: calls.filter(call => call.startsWith("register:")).length,
				calls,
			}).toEqual({
				handshakes: 1,
				registrations: 1,
				calls: callsAfterInitial,
			});
			expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		}
	});
	test.each(["local-external", "remote"] as const)("keeps status after ready observational in %s mode", async mode => {
		const calls: string[] = [];
		let handshakes = 0;
		const binding = bindingFor(321, "external_launch_abcdefghijklmnopqrstuvwxyz", {
			endpoint: mode === "remote" ? "https://engine.example" : "http://127.0.0.1:7777",
			launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
		});
		const bound = boundClient(binding, calls);
		const supervisor = new LifecycleSupervisor(resolved(mode), {
			createClient: () => ({
				handshake: async () => {
					handshakes++;
					return bound;
				},
			}),
		});
		const ready = await supervisor.connect();
		expect(ready.kind).toBe("ready");
		const callsAfterReady = [...calls];
		expect(await supervisor.status()).toMatchObject({ kind: "observed" });
		expect(await supervisor.connect()).toEqual(ready);
		expect({ handshakes, calls }).toEqual({ handshakes: 1, calls: callsAfterReady });
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
	});

	test.each(["local-external", "remote"] as const)(
		"reports %s client-registration renewal loss after ready",
		async mode => {
			const originalSetInterval = globalThis.setInterval;
			const originalClearInterval = globalThis.clearInterval;
			let runRenewal: (() => void) | undefined;
			let renewalActive = false;
			try {
				globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
					renewalActive = true;
					runRenewal = () => {
						if (typeof handler === "function") handler();
					};
					return { unref: () => undefined } as unknown as NodeJS.Timeout;
				}) as typeof setInterval;
				globalThis.clearInterval = (() => {
					renewalActive = false;
				}) as typeof clearInterval;
				const binding = bindingFor(321, "external_launch_abcdefghijklmnopqrstuvwxyz", {
					endpoint: mode === "remote" ? "https://engine.example" : "http://127.0.0.1:7777",
					launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
				});
				const base = boundClient(binding, []);
				const renewalFailure = Promise.withResolvers<LifecycleState>();
				const supervisor = new LifecycleSupervisor(resolved(mode), {
					createClient: () => ({
						handshake: async () => ({
							...base,
							renewClient: async () => {
								throw new LifecycleE4ClientError({
									kind: "registration-expired",
									status: 410,
									code: "registration_expired",
									correlation: {},
									body: "[redacted]",
								});
							},
						}),
					}),
					stateChanged: state => {
						if (state.name === "registration-expired") renewalFailure.resolve(state);
					},
				});

				expect((await supervisor.connect()).kind).toBe("ready");
				expect(renewalActive).toBe(true);
				if (!runRenewal) throw new Error("lease renewal interval was not installed");
				runRenewal();
				await expect(renewalFailure.promise).resolves.toMatchObject({
					name: "registration-expired",
					reason: "registration_expired",
				});
				expect(renewalActive).toBe(false);
			} finally {
				globalThis.setInterval = originalSetInterval;
				globalThis.clearInterval = originalClearInterval;
			}
		},
	);

	test("remote keychain and mTLS security bind to the endpoint-scoped client", async () => {
		for (const auth of [
			{ kind: "keychain-reference", reference: "test-token" },
			{ kind: "mtls-reference", reference: "test-identity" },
		] as const) {
			const config = resolveBreadboardRunConfig({
				...common,
				cli: { engineMode: "remote", engineUrl: "https://engine.example" },
				selectedConfig: { auth },
			});
			let received: { bearerToken?: string; fetch?: typeof fetch } = {};
			const binding = bindingFor(99, "external_launch_abcdefghijklmnopqrstuvwxyz", {
				endpoint: "https://engine.example",
				launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
			});
			const supervisor = new LifecycleSupervisor(config, {
				resolveRemoteSecurity: async value =>
					value.kind === "keychain-reference"
						? { bearerToken: "resolved-token" }
						: { certificatePem: "certificate", privateKeyPem: "key" },
				createClient: options => {
					received = options;
					return { handshake: async () => boundClient(binding, []) };
				},
			});
			expect((await supervisor.status()).kind).toBe("observed");
			if (auth.kind === "keychain-reference") expect(received.bearerToken).toBe("resolved-token");
			else expect(typeof received.fetch).toBe("function");
		}
	});

	test("ready handle exposes an authenticated request transport without exposing the token", async () => {
		const originalFetch = globalThis.fetch;
		let observedAuthorization: string | null = null;
		let observedCustomHeader: string | null = null;
		globalThis.fetch = Object.assign(
			async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const headers = new Headers(init?.headers);
				observedAuthorization = headers.get("authorization");
				observedCustomHeader = headers.get("x-product");
				return new Response(null, { status: 204 });
			},
			{ preconnect: originalFetch.preconnect },
		);
		try {
			const config = resolveBreadboardRunConfig({
				...common,
				cli: { engineMode: "remote", engineUrl: "https://engine.example" },
				selectedConfig: { auth: { kind: "keychain-reference", reference: "test-token" } },
			});
			const binding = bindingFor(99, "external_launch_abcdefghijklmnopqrstuvwxyz", {
				endpoint: "https://engine.example",
				launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" },
			});
			const supervisor = new LifecycleSupervisor(config, {
				resolveRemoteSecurity: async () => ({ bearerToken: "resolved-token" }),
				createClient: () => ({ handshake: async () => boundClient(binding, []) }),
			});
			const result = await supervisor.connect();
			expect(result.kind).toBe("ready");
			if (result.kind !== "ready") throw new Error("expected ready lifecycle result");
			expect(result.handle).not.toHaveProperty("bearerToken");
			await result.handle.requestFetch("https://engine.example/v1/sessions", {
				headers: { "x-product": "breadboard" },
			});
			expect([observedAuthorization, observedCustomHeader].join("|")).toBe("Bearer resolved-token|breadboard");
			expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("default child process environment is an exact minimal allowlist", () => {
		process.env.BREADBOARD_HOSTILE_PARENT_SECRET = "must-not-cross";
		try {
			expect(lifecycleChildEnvironment("launch_environment_abcdefghijklmnopqrstuvwxyz")).toEqual({
				PATH: "/usr/bin:/bin",
				BREADBOARD_ENGINE_LAUNCH_ID: "launch_environment_abcdefghijklmnopqrstuvwxyz",
				BREADBOARD_LIFECYCLE_BOOTSTRAP_FD: "3",
			});
			expect(lifecycleChildEnvironment("launch_environment_abcdefghijklmnopqrstuvwxyz")).not.toHaveProperty(
				"BREADBOARD_HOSTILE_PARENT_SECRET",
			);
			expect(lifecycleChildEnvironment("launch_environment_abcdefghijklmnopqrstuvwxyz")).not.toHaveProperty("HOME");
		} finally {
			delete process.env.BREADBOARD_HOSTILE_PARENT_SECRET;
		}
	});
	test("Keychain timeout and oversize paths kill, cancel, reap, and wipe every received buffer", async () => {
		for (const testCase of [
			{ code: "secret_reference_oversized", outputLimit: 4, timeoutMs: 1_000 },
			{ code: "secret_reference_timeout", outputLimit: 1_024, timeoutMs: 5 },
		] as const) {
			const chunk = Buffer.from("synthetic-secret-material", "utf8");
			const exit = Promise.withResolvers<number>();
			let killed = false;
			let cancelled = false;
			let reaped = false;
			const stdout = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			});
			const exited = exit.promise.then(code => {
				reaped = true;
				return code;
			});
			await expect(
				readKeychainReference("synthetic-reference", {
					outputLimit: testCase.outputLimit,
					timeoutMs: testCase.timeoutMs,
					spawn: () => ({
						stdout,
						exited,
						kill: () => {
							killed = true;
							exit.resolve(137);
						},
					}),
				}),
			).rejects.toMatchObject({ failure: { code: testCase.code } });
			expect({ killed, cancelled, reaped }).toEqual({ killed: true, cancelled: true, reaped: true });
			expect([...chunk].every(byte => byte === 0)).toBe(true);
		}
	});

	test("typed transport failures remain distinct", async () => {
		const cases = [
			[
				new LifecycleE4ClientError({
					kind: "auth",
					status: 401,
					code: "auth",
					correlation: {},
					body: "[redacted]",
				}),
				"auth-failed",
			],
			[new LifecycleE4ClientError({ kind: "tls", code: "tls_transport_error" }), "tls-failed"],
			[
				new LifecycleE4ClientError({
					kind: "identity-changed",
					status: 409,
					code: "identity",
					correlation: {},
					body: "[redacted]",
				}),
				"identity-changed",
			],
		] as const;
		for (const [failure, state] of cases) {
			const supervisor = new LifecycleSupervisor(resolved("remote"), {
				createClient: () => ({
					handshake: async () => {
						throw failure;
					},
				}),
			});
			expect((await supervisor.connect()).state.name).toBe(state);
		}
	});
});

describe("LifecycleSupervisor local-owned authority", () => {
	function processHarness() {
		let nextPid = 4000;
		let currentPid = 0;
		let currentLaunch = "";
		let spawnCount = 0;
		const dead = new Set<number>();
		const events: string[] = [];
		const bootstrapBuffers: Buffer[] = [];
		const handles = new Map<number, SpawnedEngineProcess>();
		const exitResolvers = new Map<number, (code: number | null) => void>();
		const processTokens = new Map<number, string>();
		const waitResults: boolean[] = [];
		let gracefulExitOnWait = false;
		let suppressNextExitNotification = false;
		let returnUnbound = false;
		const adapter: LifecycleProcessAdapter = {
			spawnVerified: async (_artifact, launchId, bootstrap, bindIdentity) => {
				spawnCount++;
				currentPid = ++nextPid;
				currentLaunch = launchId;
				const pid = currentPid;
				const startToken = `darwin:${pid}:1`;
				processTokens.set(pid, startToken);
				bootstrapBuffers.push(bootstrap);
				const { promise: exited, resolve } = Promise.withResolvers<number | null>();
				exitResolvers.set(pid, resolve);
				const handle: SpawnedEngineProcess = {
					pid,
					startToken,
					exited,
					unref: () => events.push("unref"),
					sendHardSignal: async authorizationExpiresAtUnix => {
						if (authorizationExpiresAtUnix !== undefined && authorizationExpiresAtUnix * 1_000 <= Date.now())
							return "authorization_expired";
						if (processTokens.get(pid) !== startToken) return "abandoned";
						events.push("hard-control");
						dead.add(pid);
						resolve(0);
						return "sent";
					},
					waitForExit: async timeoutMs => {
						if (timeoutMs > 0 && gracefulExitOnWait) {
							gracefulExitOnWait = false;
							dead.add(pid);
							if (!suppressNextExitNotification) resolve(0);
							suppressNextExitNotification = false;
							return true;
						}
						return timeoutMs === 0 ? dead.has(pid) : (waitResults.shift() ?? dead.has(pid));
					},
				};
				try {
					await bindIdentity(pid, startToken);
				} catch {
					bootstrap.fill(0);
					dead.add(pid);
					resolve(1);
					return { kind: "spawn-failed-dead" as const };
				}
				if (returnUnbound) {
					returnUnbound = false;
					bootstrap.fill(0);
					dead.add(pid);
					resolve(1);
					return { kind: "spawn-failed-dead" as const };
				}
				handles.set(pid, handle);
				return handle;
			},
			observe: async pid =>
				dead.has(pid)
					? ({ kind: "dead" } as ProcessObservation)
					: ({
							kind: "alive",
							startToken: processTokens.get(pid) ?? `darwin:${pid}:unknown`,
						} as ProcessObservation),
			controlFor: async (pid, token) => (token === processTokens.get(pid) ? (handles.get(pid) ?? null) : null),
		};
		return {
			adapter,
			dead,
			events,
			waitResults,
			bootstrapBuffers,
			current: () => ({ pid: currentPid, launchId: currentLaunch }),
			spawnCount: () => spawnCount,
			crash: (pid = currentPid) => {
				dead.add(pid);
				exitResolvers.get(pid)?.(1);
			},
			rotateIdentity: (pid = currentPid) => processTokens.set(pid, `darwin:${pid}:2`),
			exitOnNextWait: () => {
				gracefulExitOnWait = true;
			},
			exitSilentlyOnNextWait: () => {
				suppressNextExitNotification = true;
				gracefulExitOnWait = true;
			},
			unboundNext: () => {
				returnUnbound = true;
			},
		};
	}

	function clientFactory(
		process: ReturnType<typeof processHarness>,
		calls: string[],
		behavior: ClientBehavior = {},
	): () => LifecycleE4Client {
		return () => ({
			handshake: async () => {
				const current = process.current();
				return boundClient(bindingFor(current.pid, current.launchId), calls, behavior);
			},
		});
	}

	test("cold start commits recoverable owner before registration and wipes exact bootstrap buffer", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect(calls.slice(0, 3)).toEqual(["acquire-owner", "register:local-owned", "renew-owner"].slice(0, 2));
		expect(process.bootstrapBuffers).toHaveLength(1);
		expect([...(process.bootstrapBuffers[0] as Buffer)].every(byte => byte === 0)).toBe(true);
		const current = await store.readCurrent("http://127.0.0.1:7777");
		expect(current?.pid).toBe(process.current().pid);
		expect(current).toMatchObject({
			executablePathSha256: executablePathSha256(artifact.executablePath),
			argvSha256: artifact.argvSha256,
		});
	});
	test("shares one same-object local-owned initial connect", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		let registrationAttempts = 0;
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					await Bun.sleep(0);
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...base,
						registerClient: async input => {
							registrationAttempts++;
							if (registrationAttempts > 1) {
								throw new LifecycleE4ClientError({
									kind: "registration-conflict",
									status: 409,
									code: "registration_conflict",
									correlation: {},
									body: "[redacted]",
								});
							}
							return await base.registerClient(input);
						},
					};
				},
			}),
		});
		const initial = await Promise.all([supervisor.connect(), supervisor.connect()]);
		expect(initial).toMatchObject([{ kind: "ready" }, { kind: "ready" }]);
		expect(initial[1]).toEqual(initial[0]);
		expect({
			spawns: process.spawnCount(),
			acquisitions: calls.filter(call => call === "acquire-owner").length,
			registrationAttempts,
			registrations: calls.filter(call => call === "register:local-owned").length,
		}).toEqual({ spawns: 1, acquisitions: 1, registrationAttempts: 1, registrations: 1 });
	});

	test("projects repeated and concurrent post-ready connects without mutating lifecycle authority", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const endpoint = "http://127.0.0.1:7777";
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		const first = await supervisor.connect();
		expect(first.kind).toBe("ready");
		const before = {
			record: await store.readCurrent(endpoint),
			calls: [...calls],
			events: [...process.events],
			spawns: process.spawnCount(),
		};
		const second = await supervisor.connect();
		const concurrent = await Promise.all([supervisor.connect(), supervisor.connect()]);
		expect(second).toEqual(first);
		expect(concurrent).toEqual([first, first]);
		expect({
			record: await store.readCurrent(endpoint),
			calls,
			events: process.events,
			spawns: process.spawnCount(),
		}).toEqual(before);
	});
	test("keeps local-owned status after ready observational and the detached close usable", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		let handshakes = 0;
		const baseFactory = clientFactory(process, calls);
		const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					handshakes++;
					return await baseFactory().handshake();
				},
			}),
		});
		const ready = await supervisor.connect();
		expect(ready.kind).toBe("ready");
		const endpoint = "http://127.0.0.1:7777";
		const before = {
			record: await store.readCurrent(endpoint),
			calls: [...calls],
			events: [...process.events],
			spawns: process.spawnCount(),
			handshakes,
		};
		expect(await supervisor.status()).toMatchObject({ kind: "observed" });
		expect(await supervisor.connect()).toEqual(ready);
		expect({
			record: await store.readCurrent(endpoint),
			calls,
			events: process.events,
			spawns: process.spawnCount(),
			handshakes,
		}).toEqual(before);
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
	});

	test("persists only a domain-separated executable path digest in public claim and authority records", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "omp-engine-path-sentinel-"));
		roots.push(artifactRoot);
		const executablePath = join(artifactRoot, "canonical-path-must-not-persist");
		await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const config = resolveBreadboardRunConfig({
			...common,
			cli: { engineMode: "local-owned" },
			selectedConfig: { engineArtifact: { ...artifact, executablePath } },
		});
		const canonicalExecutablePath = config.engineArtifact?.executablePath;
		if (!canonicalExecutablePath) throw new Error("expected canonical engine artifact path");
		const expectedPathDigest = `sha256:${createHash("sha256").update("breadboard-engine-executable-path-v1\0").update(canonicalExecutablePath).digest("hex")}`;
		const store = await temporaryStore();
		const process = processHarness();
		const inspectingProcess: LifecycleProcessAdapter = {
			...process.adapter,
			spawnVerified: async (...args) => {
				const claimName = (await readdir(store.root)).find(name => name.endsWith(".starting.json"));
				expect(claimName).toBeDefined();
				const claimText = await readFile(join(store.root, claimName as string), "utf8");
				expect(claimText).not.toContain(canonicalExecutablePath);
				expect(claimText).toContain(expectedPathDigest);
				return await process.adapter.spawnVerified(...args);
			},
		};
		const supervisor = new LifecycleSupervisor(config, {
			store,
			process: inspectingProcess,
			createClient: clientFactory(process, []),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		const authorityName = (await readdir(store.root)).find(name => name.endsWith(".authority.json"));
		expect(authorityName).toBeDefined();
		const authorityText = await readFile(join(store.root, authorityName as string), "utf8");
		expect(authorityText).not.toContain(canonicalExecutablePath);
		expect(authorityText).toContain(expectedPathDigest);
	});

	test("registration failure leaves one adoptable committed engine and never respawns", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const first = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, [], { registerError: new Error("register failed") }),
		});
		expect((await first.connect()).kind).toBe("failure");
		expect(await store.readCurrent("http://127.0.0.1:7777")).not.toBeNull();
		const second = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, []),
		});
		expect((await second.connect()).kind).toBe("ready");
		expect(process.spawnCount()).toBe(1);
	});
	test("fails closed when an adopted engine has no verified process control handle", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const first = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, [], { registerError: new Error("register failed") }),
		});
		expect((await first.connect()).kind).toBe("failure");
		const calls: string[] = [];
		const unavailableControl: LifecycleProcessAdapter = { ...process.adapter, controlFor: async () => null };
		const adopter = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: unavailableControl,
			createClient: clientFactory(process, calls),
		});
		expect((await adopter.connect()).state.reason).toBe("process_identity_unavailable");
		expect(calls).toEqual([]);
		expect(process.spawnCount()).toBe(1);
	});

	test("preserves a recoverable pending claim without hard control on pre-owner handshake failure", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
		const failure = new LifecycleE4ClientError({
			kind: "auth",
			status: 401,
			code: "unauthorized",
			correlation: {},
			body: "[redacted]",
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					throw failure;
				},
			}),
		});
		expect((await supervisor.connect()).state.reason).toBe("auth_failed");
		expect(process.events).not.toContain("hard-control");
		const preserved = await store.withExclusiveLock("http://127.0.0.1:7777", () =>
			store.claimStart("http://127.0.0.1:7777"),
		);
		expect(preserved.kind).toBe("recoverable");
		if (preserved.kind === "recoverable") {
			expect(preserved.claim).toMatchObject({
				enginePid: process.current().pid,
				engineProcessStartToken: `darwin:${process.current().pid}:1`,
			});
			const secret = await store.readPendingSecret(preserved.claim);
			expect(secret.bootstrapCredential.byteLength).toBe(32);
			secret.bootstrapCredential.fill(0);
			secret.ownerCredential.fill(0);
		}
	});

	test("pure local status never spawns, owns, or registers", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		let clientTouches = 0;
		const status = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => {
				clientTouches++;
				throw new Error("forbidden");
			},
		});
		expect((await status.status()).kind).toBe("stopped");
		expect(process.spawnCount()).toBe(0);
		expect(clientTouches).toBe(0);
	});

	test("two concurrent launchers use one slow start and register independently", async () => {
		const store = await temporaryStore({ isLockOwnerAlive: async () => true });
		const process = processHarness();
		const calls: string[] = [];
		let firstHandshake = true;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const createClient = () => ({
			handshake: async () => {
				if (firstHandshake) {
					firstHandshake = false;
					entered.resolve();
					await release.promise;
				}
				const current = process.current();
				return boundClient(bindingFor(current.pid, current.launchId), calls);
			},
		});
		const clock = {
			now: Date.now,
			sleep: async () => {
				await Promise.resolve();
			},
		};
		const first = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
			clock,
		});
		const second = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
			clock,
		});
		const firstResult = first.connect();
		await entered.promise;
		const secondResult = second.connect();
		release.resolve();
		const results = await Promise.all([firstResult, secondResult]);
		expect(results).toMatchObject([{ kind: "ready" }, { kind: "ready" }]);
		expect(process.spawnCount()).toBe(1);
		expect(calls.filter(call => call === "register:local-owned")).toHaveLength(2);
	});
	test("continues a durable bound pending start after the original supervisor dies", async () => {
		const process = processHarness();
		let enginePid = 0;
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === enginePid });
		const config = resolved("local-owned");
		const artifact = config.engineArtifact as EngineArtifact;
		const endpoint = config.endpoint as string;
		const launchId = "launch_recovery_abcdefghijklmnopqrstuvwxyz";
		const pendingBootstrap = Buffer.alloc(32, 9);
		await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			const prepared = await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId,
					executableSha256: artifact.executableSha256,
					engineArtifactSha256: artifact.engineSourceSha256,
					servedBackendCommit: artifact.servedBackendCommit,
					executablePathSha256: executablePathSha256(artifact.executablePath),
					argvSha256: artifact.argvSha256,
				},
				{ bootstrapCredential: pendingBootstrap, ownerCredential: Buffer.from("o".repeat(43), "ascii") },
			);
			const transfer = Buffer.from(pendingBootstrap);
			const child = await process.adapter.spawnVerified(artifact, launchId, transfer, async (pid, startToken) => {
				await store.bindStartClaimProcess(endpoint, prepared.token, pid, startToken);
			});
			if ("kind" in child) throw new Error("expected bound spawned process");
			transfer.fill(0);
			enginePid = child.pid;
		});
		pendingBootstrap.fill(0);
		const calls: string[] = [];
		const recovered = new LifecycleSupervisor(config, {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await recovered.connect()).kind).toBe("ready");
		expect(process.spawnCount()).toBe(1);
		expect(calls.slice(0, 2)).toEqual(["acquire-owner", "register:local-owned"]);
		expect((await store.readCurrent(endpoint))?.pid).toBe(enginePid);
	});
	test("retires a dead starter's durable unbound claim after confirmed endpoint absence and starts once", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async () => false });
		const config = resolved("local-owned");
		const configuredArtifact = config.engineArtifact as EngineArtifact;
		const endpoint = config.endpoint as string;
		const bootstrap = Buffer.alloc(32, 21);
		const owner = Buffer.from("orphaned_owner_abcdefghijklmnopqrstuvwxyz0123", "ascii");
		const orphaned = await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			return await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId: "launch_orphaned_unbound_abcdefghijklmnopqrst",
					executableSha256: configuredArtifact.executableSha256,
					executablePathSha256: executablePathSha256(configuredArtifact.executablePath),
					argvSha256: configuredArtifact.argvSha256,
					engineArtifactSha256: configuredArtifact.engineSourceSha256,
					servedBackendCommit: configuredArtifact.servedBackendCommit,
				},
				{ bootstrapCredential: bootstrap, ownerCredential: owner },
			);
		});
		bootstrap.fill(0);
		owner.fill(0);
		let now = 0;
		let handshakeAttempts = 0;
		let absenceChecks = 0;
		const calls: string[] = [];
		const recovered = new LifecycleSupervisor(config, {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					handshakeAttempts++;
					if (process.spawnCount() === 0) throw new LifecycleE4ClientError({ kind: "timeout" });
					const current = process.current();
					return boundClient(bindingFor(current.pid, current.launchId), calls);
				},
			}),
			endpointAbsent: async () => {
				absenceChecks++;
				return true;
			},
			clock: {
				now: () => now,
				sleep: async milliseconds => {
					now += milliseconds;
				},
			},
		});
		const result = await recovered.connect();
		expect(result).toMatchObject({ kind: "ready" });
		expect(handshakeAttempts).toBeGreaterThan(0);
		expect(absenceChecks).toBe(1);
		expect(process.spawnCount()).toBe(1);
		expect(await store.readCurrent(endpoint)).toMatchObject({ pid: process.current().pid });
		await expect(
			store.withExclusiveLock(endpoint, () =>
				store.bindStartClaimProcess(endpoint, orphaned.token, 9999, "darwin:9999:late"),
			),
		).rejects.toBeDefined();
	});

	test("recovers a stale-createdAt dead-starter claim within a fresh bounded handshake window", async () => {
		const process = processHarness();
		let enginePid = 0;
		const store = await temporaryStore({
			now: () => 1_000,
			isLockOwnerAlive: async owner => owner.pid === enginePid,
		});
		const config = resolved("local-owned");
		const configuredArtifact = config.engineArtifact as EngineArtifact;
		const endpoint = config.endpoint as string;
		const launchId = "launch_unbound_recovery_abcdefghijklmnopqrstuv";
		const bootstrap = Buffer.alloc(32, 12);
		const owner = Buffer.from("unbound_owner_abcdefghijklmnopqrstuvwxyz012345", "ascii");
		await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId,
					executableSha256: configuredArtifact.executableSha256,
					executablePathSha256: executablePathSha256(configuredArtifact.executablePath),
					argvSha256: configuredArtifact.argvSha256,
					engineArtifactSha256: configuredArtifact.engineSourceSha256,
					servedBackendCommit: configuredArtifact.servedBackendCommit,
				},
				{ bootstrapCredential: bootstrap, ownerCredential: owner },
			);
			const transfer = Buffer.from(bootstrap);
			const child = await process.adapter.spawnVerified(configuredArtifact, launchId, transfer, async () => {});
			if ("kind" in child) throw new Error("expected bound spawned process");
			transfer.fill(0);
			enginePid = child.pid;
		});
		bootstrap.fill(0);
		owner.fill(0);
		let probes = 0;
		const calls: string[] = [];
		const recovered = new LifecycleSupervisor(config, {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					probes++;
					if (probes < 3) throw new LifecycleE4ClientError({ kind: "timeout" });
					return boundClient(bindingFor(enginePid, launchId), calls);
				},
			}),
			clock: { now: () => 50_000, sleep: async () => {} },
		});
		expect((await recovered.connect()).kind).toBe("ready");
		expect(probes).toBe(3);
		expect(process.spawnCount()).toBe(1);
		expect(calls.slice(0, 2)).toEqual(["acquire-owner", "register:local-owned"]);
		expect((await store.readCurrent(endpoint))?.pid).toBe(enginePid);
	});

	test("preserves an uncertain unbound claim and forbids a replacement spawn", async () => {
		const process = processHarness();
		let enginePid = 0;
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === enginePid });
		const config = resolved("local-owned");
		const configuredArtifact = config.engineArtifact as EngineArtifact;
		const endpoint = config.endpoint as string;
		const launchId = "launch_unbound_uncertain_abcdefghijklmnopqrst";
		const bootstrap = Buffer.alloc(32, 13);
		const owner = Buffer.from("uncertain_owner_abcdefghijklmnopqrstuvwxyz0123", "ascii");
		await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId,
					executableSha256: configuredArtifact.executableSha256,
					executablePathSha256: executablePathSha256(configuredArtifact.executablePath),
					argvSha256: configuredArtifact.argvSha256,
					engineArtifactSha256: configuredArtifact.engineSourceSha256,
					servedBackendCommit: configuredArtifact.servedBackendCommit,
				},
				{ bootstrapCredential: bootstrap, ownerCredential: owner },
			);
			const transfer = Buffer.from(bootstrap);
			const child = await process.adapter.spawnVerified(configuredArtifact, launchId, transfer, async () => {});
			if ("kind" in child) throw new Error("expected bound spawned process");
			transfer.fill(0);
			enginePid = child.pid;
		});
		bootstrap.fill(0);
		owner.fill(0);
		const recovered = new LifecycleSupervisor(config, {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => boundClient(bindingFor(enginePid + 1, launchId), []),
			}),
		});
		expect((await recovered.connect()).state).toMatchObject({
			name: "recovery-needed",
			reason: "process_identity_unavailable",
		});
		expect(process.spawnCount()).toBe(1);
		const preserved = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
		expect(preserved.kind).toBe("unbound");
	});

	test("configured canonical executable and argv drift reject adoption before renew or registration", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const first = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await first.connect()).kind).toBe("ready");
		expect((await first.close({ consumerClosed: true })).kind).toBe("detached");
		calls.length = 0;
		const changed = resolveBreadboardRunConfig({
			...common,
			cli: { engineMode: "local-owned" },
			selectedConfig: { engineArtifact: { ...artifact, argv: ["--different"] } },
		});
		const adopter = new LifecycleSupervisor(changed, {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await adopter.connect()).state.reason).toBe("identity_changed");
		expect(calls).toEqual([]);
	});

	test("adopted detached policy is retained on close", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const first = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await first.connect()).kind).toBe("ready");
		expect((await first.close({ consumerClosed: true })).kind).toBe("detached");
		const adopter = new LifecycleSupervisor(resolved("local-owned", "attached"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await adopter.connect()).kind).toBe("ready");
		expect((await adopter.close({ consumerClosed: true })).kind).toBe("detached");
		expect(calls.filter(call => call === "release-owner")).toHaveLength(2);
		expect(calls.slice(-3)).toEqual(["detach-client", "renew-owner", "release-owner"]);
		expect(process.events.some(event => event.startsWith("graceful-control"))).toBe(false);
	});

	test("replays two committed drain response losses with the same opaque request binding before graceful or hard control", async () => {
		for (const path of ["graceful", "hard"] as const) {
			const store = await temporaryStore();
			const process = processHarness();
			if (path === "graceful") process.exitOnNextWait();
			const calls: string[] = [];
			const requests: Array<{
				readonly controlRequestId: string;
				readonly ownerGeneration: number;
				readonly registrationId: string;
				readonly requesterRegistrationGeneration: number;
				readonly requesterClientInstanceId: string;
				readonly expectedAdmissionEpoch: number;
			}> = [];
			let admissionClosures = 0;
			let committedRequestId: string | undefined;
			let responseLosses = 2;
			const timeout = new LifecycleE4ClientError({ kind: "timeout" });
			const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient: () => ({
					handshake: async () => {
						const current = process.current();
						return {
							...boundClient(bindingFor(current.pid, current.launchId), calls),
							beginControlDrain: async input => {
								calls.push("begin-drain");
								requests.push(input);
								if (responseLosses-- > 0) {
									if (committedRequestId === undefined) {
										committedRequestId = input.controlRequestId;
										admissionClosures++;
									}
									throw timeout;
								}
								return {
									result: "draining",
									controlRequestId: input.controlRequestId,
									drainGeneration: 2,
								} as never;
							},
						};
					},
				}),
			});
			expect((await supervisor.connect()).kind).toBe("ready");
			const result = await supervisor.stop({ consumerClosed: true });
			expect(result.kind).toBe("stopped");
			expect(requests).toHaveLength(3);
			expect(requests[0]?.controlRequestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
			for (const replay of requests.slice(1)) {
				expect(replay).toMatchObject({
					controlRequestId: requests[0]?.controlRequestId,
					ownerGeneration: requests[0]?.ownerGeneration,
					registrationId: requests[0]?.registrationId,
					requesterRegistrationGeneration: requests[0]?.requesterRegistrationGeneration,
					requesterClientInstanceId: requests[0]?.requesterClientInstanceId,
					expectedAdmissionEpoch: requests[0]?.expectedAdmissionEpoch,
				});
			}
			expect(admissionClosures).toBe(1);
			expect(JSON.stringify(result)).not.toContain(requests[0]?.controlRequestId as string);
			expect(process.events.includes("hard-control")).toBe(path === "hard");
		}
	});

	test("persists an ambiguous stop request and reuses its exact identifier on a later recovery attempt", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const endpoint = "http://127.0.0.1:7777";
		let responseLosses = 3;
		const requestIds: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					return {
						...boundClient(bindingFor(current.pid, current.launchId), []),
						beginControlDrain: async input => {
							requestIds.push(input.controlRequestId);
							if (responseLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return {
								result: "draining",
								controlRequestId: input.controlRequestId,
								drainGeneration: 2,
							} as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("failure");
		const record = await store.readCurrent(endpoint);
		if (!record) throw new Error("authority record missing after ambiguous control");
		const pending = await store.readControlAttempt(endpoint, record);
		expect(pending).toMatchObject({ operation: "stop", controlRequestId: requestIds[0] });
		process.exitOnNextWait();
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(new Set(requestIds).size).toBe(1);
		expect(requestIds).toHaveLength(4);
		expect((await readdir(store.root)).some(name => name.endsWith(".control.json"))).toBe(false);
	});
	test.each(["before-request", "lost-response"] as const)(
		"recovers durable begin-pending after %s controller crash",
		async crashPoint => {
			const store = await temporaryStore();
			const process = processHarness();
			const endpoint = "http://127.0.0.1:7777";
			const registrations: Array<{
				readonly input: Parameters<BoundLifecycleE4Client["registerClient"]>[0];
				readonly registrationId: string;
				readonly admissionEpoch: number;
			}> = [];
			const beginRequests: Array<Record<string, unknown>> = [];
			let responseLosses = crashPoint === "lost-response" ? 3 : 0;
			const createClient = (): LifecycleE4Client => ({
				handshake: async () => {
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), []);
					return {
						...base,
						registerClient: async input => {
							const registrationId = `registration_${input.clientInstanceId}`;
							const admissionEpoch = 40 + registrations.length;
							registrations.push({ input, registrationId, admissionEpoch });
							return {
								result: "registered",
								registrationId,
								registrationGeneration: 1,
								clientInstanceId: input.clientInstanceId,
								admissionEpoch,
								expiresAtUnix: 100,
							} as never;
						},
						beginControlDrain: async input => {
							const { signal: _, ...request } = input;
							beginRequests.push(request);
							if (responseLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return {
								result: "draining",
								controlRequestId: input.controlRequestId,
								drainGeneration: 2,
							} as never;
						},
					};
				},
			});
			const starter = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect((await starter.connect()).kind).toBe("ready");
			if (crashPoint === "before-request") {
				const prepare = store.prepareControlAttempt.bind(store);
				store.prepareControlAttempt = async (...args: Parameters<typeof prepare>) => {
					const pending = await prepare(...args);
					throw new Error(`simulated controller death after ${pending.phase} persistence`);
				};
				await starter.stop({ consumerClosed: true }).catch(() => undefined);
				store.prepareControlAttempt = prepare;
				expect(beginRequests).toHaveLength(0);
			} else {
				expect((await starter.stop({ consumerClosed: true })).kind).toBe("failure");
				expect(beginRequests).toHaveLength(3);
			}
			const record = await store.readCurrent(endpoint);
			if (!record) throw new Error("authority record missing after controller crash");
			const pending = await store.readControlAttempt(endpoint, record);
			expect(pending).toMatchObject({ operation: "stop", phase: "begin-pending" });
			const controlName = (await readdir(store.root)).find(name => name.endsWith(".control.json"));
			if (!controlName) throw new Error("durable control attempt missing");
			const publicControl = JSON.parse(await readFile(join(store.root, controlName), "utf8")) as Record<
				string,
				unknown
			>;
			const credentialRef =
				typeof publicControl.requesterCredentialRef === "string" ? publicControl.requesterCredentialRef : undefined;
			const credentialMode =
				credentialRef === undefined ? undefined : (await stat(join(store.root, credentialRef))).mode & 0o777;
			const originalRegistration = registrations[0];
			if (!originalRegistration) throw new Error("original requester registration missing");
			const successor = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect((await successor.connect()).kind).toBe("ready");
			expect(registrations).toHaveLength(2);
			expect(registrations[1]?.registrationId).not.toBe(originalRegistration.registrationId);
			process.exitSilentlyOnNextWait();
			expect((await successor.stop({ consumerClosed: true })).kind).toBe("stopped");
			expect(beginRequests).toHaveLength(crashPoint === "lost-response" ? 4 : 1);
			const replay = beginRequests.at(-1);
			expect(replay).toMatchObject({
				controlRequestId: pending?.controlRequestId,
				registrationId: originalRegistration.registrationId,
				requesterRegistrationGeneration: 1,
				requesterClientInstanceId: originalRegistration.input.clientInstanceId,
				registrationCredential: originalRegistration.input.registrationCredential,
				expectedAdmissionEpoch: originalRegistration.admissionEpoch,
			});
			for (const request of beginRequests.slice(1)) expect(request).toEqual(beginRequests[0]);
			expect(publicControl).toMatchObject({
				expectedAdmissionEpoch: originalRegistration.admissionEpoch,
				requesterCredentialRef: expect.stringMatching(/\.control\.secret\./),
				requesterCredentialVerifier: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
			expect(JSON.stringify(publicControl)).not.toContain(originalRegistration.input.registrationCredential);
			expect(credentialMode).toBe(0o600);
			const remainingNames = await readdir(store.root);
			expect(remainingNames).not.toContain(controlName);
			expect(remainingNames).not.toContain(credentialRef as string);
		},
	);
	test("replaces an expired durable begin requester once with the current registration", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const endpoint = "http://127.0.0.1:7777";
		const registrations: Array<{
			readonly input: Parameters<BoundLifecycleE4Client["registerClient"]>[0];
			readonly registrationId: string;
			readonly admissionEpoch: number;
		}> = [];
		const beginRequests: Array<Record<string, unknown>> = [];
		let expiredRollbacks = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					registerClient: async input => {
						const registrationId = `registration_${registrations.length}_${input.clientInstanceId}`;
						const admissionEpoch = 60 + registrations.length;
						registrations.push({ input, registrationId, admissionEpoch });
						return {
							result: "registered",
							registrationId,
							registrationGeneration: 1,
							clientInstanceId: input.clientInstanceId,
							admissionEpoch,
							expiresAtUnix: 100,
						} as never;
					},
					beginControlDrain: async input => {
						const { signal: _, ...request } = input;
						beginRequests.push(request);
						if (input.registrationId === registrations[0]?.registrationId) {
							expiredRollbacks++;
							throw new LifecycleE4ClientError({
								kind: "registration-expired",
								status: 409,
								code: "registration_expired",
								correlation: {},
								body: "[redacted]",
							});
						}
						return { result: "draining", controlRequestId: input.controlRequestId, drainGeneration: 3 } as never;
					},
				};
			},
		});
		const starter = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await starter.connect()).kind).toBe("ready");
		const prepare = store.prepareControlAttempt.bind(store);
		store.prepareControlAttempt = async (...args: Parameters<typeof prepare>) => {
			const pending = await prepare(...args);
			throw new Error(`simulated controller death after ${pending.phase} persistence`);
		};
		await starter.stop({ consumerClosed: true }).catch(() => undefined);
		store.prepareControlAttempt = prepare;
		const record = await store.readCurrent(endpoint);
		if (!record) throw new Error("authority record missing after controller crash");
		const oldAttempt = await store.readControlAttempt(endpoint, record);
		if (!oldAttempt) throw new Error("durable old control attempt missing");
		const successor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await successor.connect()).kind).toBe("ready");
		process.exitSilentlyOnNextWait();
		expect((await successor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(expiredRollbacks).toBe(1);
		expect(beginRequests).toHaveLength(2);
		expect(beginRequests[0]).toMatchObject({
			controlRequestId: oldAttempt.controlRequestId,
			registrationId: registrations[0]?.registrationId,
		});
		expect(beginRequests[1]).toMatchObject({
			registrationId: registrations[1]?.registrationId,
			requesterClientInstanceId: registrations[1]?.input.clientInstanceId,
			registrationCredential: registrations[1]?.input.registrationCredential,
			expectedAdmissionEpoch: registrations[1]?.admissionEpoch,
		});
		expect(beginRequests[1]?.controlRequestId).not.toBe(oldAttempt.controlRequestId);
		await expect(stat(join(store.root, oldAttempt.requesterCredentialRef))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.readControlAttempt(endpoint, record)).toBeNull();
		expect((await successor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(beginRequests).toHaveLength(2);
	});

	test("replays two committed graceful-accepted responses before observing exact exit", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.exitOnNextWait();
		let acceptedLosses = 2;
		let acceptedTransitions = 0;
		const acceptedRequests: number[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					return {
						...boundClient(bindingFor(current.pid, current.launchId), []),
						recordGracefulControl: async input => {
							if (input.outcome !== "accepted") throw new Error("unexpected graceful outcome");
							acceptedRequests.push(input.drainGeneration);
							if (acceptedTransitions === 0) acceptedTransitions++;
							if (acceptedLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return { result: "shutdown_started" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(acceptedRequests).toEqual([2, 2, 2]);
		expect(acceptedTransitions).toBe(1);
		expect(process.events).not.toContain("hard-control");
	});

	test("replays timeout, prepare, and commit response losses before one governed hard signal", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		let timeoutLosses = 2;
		let prepareLosses = 2;
		let commitLosses = 2;
		let timeoutTransitions = 0;
		let authorizationCreations = 0;
		let permitCreations = 0;
		const timeoutRequests: number[] = [];
		const prepareRequests: number[] = [];
		const commitRequests: Array<Record<string, unknown>> = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), []);
					return {
						...base,
						recordGracefulControl: async input => {
							if (input.outcome === "accepted") return { result: "shutdown_started" } as never;
							if (input.outcome !== "timeout") throw new Error("unexpected graceful outcome");
							timeoutRequests.push(input.drainGeneration);
							if (timeoutTransitions === 0) timeoutTransitions++;
							if (timeoutLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return { result: "hard_signal_decision_pending", signalPermitted: true } as never;
						},
						prepareHardSignal: async input => {
							prepareRequests.push(input.drainGeneration);
							if (authorizationCreations === 0) authorizationCreations++;
							if (prepareLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return {
								result: "prepared",
								authorizationId: "authorization_replay_abcdefghijklmnop",
								expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
							} as never;
						},
						commitHardSignal: async (input: CommitHardSignalInput) => {
							const { signal: _signal, ...request } = input;
							commitRequests.push(request);
							if (permitCreations === 0) permitCreations++;
							if (commitLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return hardSignalPermit(base.binding, input);
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(timeoutRequests).toEqual([2, 2, 2]);
		expect(prepareRequests).toEqual([2, 2, 2]);
		expect(commitRequests).toHaveLength(3);
		expect(commitRequests.every(request => JSON.stringify(request) === JSON.stringify(commitRequests[0]))).toBe(true);
		expect({ timeoutTransitions, authorizationCreations, permitCreations }).toEqual({
			timeoutTransitions: 1,
			authorizationCreations: 1,
			permitCreations: 1,
		});
		expect(process.events.filter(event => event === "hard-control")).toHaveLength(1);
	});

	test("persists commit ambiguity before the request and resumes exact commit after controller crash without rollback or early signal", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		let commitLosses = 3;
		const prepareRequests: Array<Record<string, unknown>> = [];
		const commitRequests: Array<Record<string, unknown>> = [];
		const createClient = () => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					recordGracefulControl: async (input: GracefulControlInput) =>
						input.outcome === "timeout"
							? ({ result: "hard_signal_decision_pending", signalPermitted: true } as never)
							: ({ result: "shutdown_started" } as never),
					prepareHardSignal: async (input: PrepareHardSignalInput) => {
						const { signal: _signal, ...request } = input;
						prepareRequests.push(request);
						return {
							result: "prepared",
							authorizationId: "authorization_commit_crash_abcdefghij",
							expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
						} as never;
					},
					commitHardSignal: async (input: CommitHardSignalInput) => {
						const { signal: _signal, ...request } = input;
						commitRequests.push(request);
						if (commitLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
						return hardSignalPermit(base.binding, input);
					},
				};
			},
		});
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient });
		expect((await first.connect()).kind).toBe("ready");
		expect((await first.stop({ consumerClosed: true })).kind).toBe("failure");
		expect(process.events).not.toContain("hard-control");
		const record = await store.readCurrent("http://127.0.0.1:7777");
		if (!record) throw new Error("authority record missing after commit ambiguity");
		expect(await store.readControlAttempt(record.normalizedEndpoint, record)).toMatchObject({
			phase: "hard-signal-commit-pending",
			drainGeneration: 2,
		});
		first.abort();
		commitLosses = 0;
		const recovered = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await recovered.connect()).kind).toBe("ready");
		expect((await recovered.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(commitRequests).toHaveLength(4);
		expect(commitRequests.every(request => JSON.stringify(request) === JSON.stringify(commitRequests[0]))).toBe(true);
		expect(prepareRequests.length).toBeGreaterThanOrEqual(2);
		expect(process.events.filter(event => event === "hard-control")).toHaveLength(1);
	});

	test("fails closed without rollback or outcome when a committed hard-signal permit is locally expired", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		const outcomeRequests: Array<Record<string, unknown>> = [];
		const rollbackRequests: Array<Record<string, unknown>> = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), []);
					return {
						...base,
						recordGracefulControl: async input =>
							input.outcome === "timeout"
								? ({ result: "hard_signal_decision_pending", signalPermitted: true } as never)
								: ({ result: "shutdown_started" } as never),
						prepareHardSignal: async () =>
							({
								result: "prepared",
								authorizationId: "authorization_committed_expired_abcde",
								expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
							}) as never,
						commitHardSignal: async (input: CommitHardSignalInput) => hardSignalPermit(base.binding, input, 0),
						recordHardSignalOutcome: async input => {
							const { signal: _signal, ...request } = input;
							outcomeRequests.push(request);
							return { result: "signal_sent" } as never;
						},
						rollbackDrain: async input => {
							const { signal: _signal, ...request } = input;
							rollbackRequests.push(request);
							return { result: "rolled_back" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("failure");
		expect(outcomeRequests).toEqual([]);
		expect(rollbackRequests).toEqual([]);
		expect(process.events).not.toContain("hard-control");
		const record = await store.readCurrent("http://127.0.0.1:7777");
		if (!record) throw new Error("authority record missing after committed permit failure");
		expect(await store.readControlAttempt(record.normalizedEndpoint, record)).toMatchObject({
			phase: "hard-signal-commit-pending",
			drainGeneration: 2,
		});
	});

	test("maps an expired lost prepare response to exact rollback replay and never signals", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		let prepareLosses = 2;
		let rollbackLosses = 2;
		const prepareRequests: Array<Record<string, unknown>> = [];
		const rollbackRequests: Array<Record<string, unknown>> = [];
		const expired = new LifecycleE4ClientError({
			kind: "hard-signal-authorization-expired",
			status: 410,
			code: "hard_signal_authorization_expired",
			correlation: {},
			body: "[redacted]",
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), []);
					return {
						...base,
						recordGracefulControl: async input =>
							input.outcome === "timeout"
								? ({ result: "hard_signal_decision_pending", signalPermitted: true } as never)
								: ({ result: "shutdown_started" } as never),
						prepareHardSignal: async input => {
							const { signal: _signal, ...request } = input;
							prepareRequests.push(request);
							if (prepareLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							throw expired;
						},
						rollbackDrain: async input => {
							const { signal: _signal, ...request } = input;
							rollbackRequests.push(request);
							if (rollbackLosses-- > 0) throw new LifecycleE4ClientError({ kind: "timeout" });
							return { result: "rolled_back" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("ready");
		expect(prepareRequests).toHaveLength(3);
		expect(prepareRequests.every(request => JSON.stringify(request) === JSON.stringify(prepareRequests[0]))).toBe(
			true,
		);
		expect(rollbackRequests).toHaveLength(3);
		expect(rollbackRequests.every(request => JSON.stringify(request) === JSON.stringify(rollbackRequests[0]))).toBe(
			true,
		);
		expect(process.events).not.toContain("hard-control");
	});

	test.each([
		["hard-signal-pending", "ready", true],
		["hard-signal-commit-pending", "failure", false],
	] as const)(
		"handles rotated-owner %s recovery without replay or signaling",
		async (phase, expectedKind, rollbackPermitted) => {
			const store = await temporaryStore();
			const process = processHarness();
			const endpoint = "http://127.0.0.1:7777";
			const first = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient: clientFactory(process, []),
			});
			expect((await first.connect()).kind).toBe("ready");
			const originalRecord = await store.readCurrent(endpoint);
			if (!originalRecord) throw new Error("authority record missing");
			let attempt = await store.withExclusiveLock(endpoint, () =>
				store.prepareControlAttempt(
					endpoint,
					originalRecord,
					"stop",
					"rotated_control_request_abcdefghijklmnopqrstu",
					{
						registrationId: "rotated_registration_abcdefghijklmnopqrstuv",
						registrationGeneration: 1,
						clientInstanceId: "rotated_client_abcdefghijklmnopqrstuvwxyz",
						registrationCredential: "rotated_requester_credential_abcdefghijklmnop",
						admissionEpoch: 7,
					},
				),
			);
			attempt = await store.withExclusiveLock(endpoint, () =>
				store.markControlAttemptDraining(endpoint, attempt, 2),
			);
			attempt = await store.withExclusiveLock(endpoint, () =>
				store.advanceControlAttempt(endpoint, attempt, "graceful-accepted"),
			);
			await store.withExclusiveLock(endpoint, async () => {
				attempt = await store.advanceControlAttempt(endpoint, attempt, "hard-signal-pending");
			});
			if (phase === "hard-signal-commit-pending") {
				attempt = await store.withExclusiveLock(endpoint, () =>
					store.advanceControlAttempt(endpoint, attempt, phase),
				);
			}
			first.abort();

			const calls: string[] = [];
			const prepareRequests: Array<Record<string, unknown>> = [];
			const rollbackRequests: Array<Record<string, unknown>> = [];
			const ownerExpired = new LifecycleE4ClientError({
				kind: "owner-expired",
				status: 410,
				code: "owner_expired",
				correlation: {},
				body: "[redacted]",
			});
			const authorizationExpired = new LifecycleE4ClientError({
				kind: "hard-signal-authorization-expired",
				status: 410,
				code: "hard_signal_authorization_expired",
				correlation: {},
				body: "[redacted]",
			});
			const recovered = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient: () => ({
					handshake: async () => {
						const current = process.current();
						const base = boundClient(bindingFor(current.pid, current.launchId), calls);
						return {
							...base,
							renewOwner: async input => {
								calls.push(`renew-owner:${input.ownerGeneration}`);
								if (input.ownerGeneration === 1) throw ownerExpired;
								return { result: "renewed", ownerGeneration: 2 } as never;
							},
							acquireOwner: async input => {
								calls.push(`acquire-owner:${input.expectedOwnerGeneration}`);
								return { result: "acquired", ownerGeneration: 2 } as never;
							},
							beginControlDrain: async () => {
								throw new Error("durable hard-signal recovery must not begin another drain");
							},
							recordGracefulControl: async () => {
								throw new Error("durable hard-signal recovery must not repeat graceful control");
							},
							prepareHardSignal: async input => {
								const { signal: _signal, ...request } = input;
								prepareRequests.push(request);
								throw authorizationExpired;
							},
							rollbackDrain: async input => {
								const { signal: _signal, ...request } = input;
								rollbackRequests.push(request);
								return { result: "rolled_back" } as never;
							},
						};
					},
				}),
			});
			expect((await recovered.connect()).kind).toBe("ready");
			expect((await recovered.stop({ consumerClosed: true })).kind).toBe(expectedKind);
			expect(prepareRequests).toEqual([]);
			expect(rollbackRequests).toEqual(
				rollbackPermitted ? [expect.objectContaining({ ownerGeneration: 2, drainGeneration: 2 })] : [],
			);
			expect(calls).toContain("acquire-owner:1");
			expect(process.events).not.toContain("hard-control");
			const rotatedRecord = await store.readCurrent(endpoint);
			if (!rotatedRecord) throw new Error("rotated authority record missing");
			expect(await store.readControlAttempt(endpoint, rotatedRecord)).toEqual(rollbackPermitted ? null : attempt);
		},
	);

	test.each([
		[
			"control-request echo mismatch",
			new LifecycleE4ClientError({
				kind: "protocol",
				code: "drain_control_request_echo_mismatch",
				correlation: {},
				body: "[redacted]",
			}),
			"incompatible_engine",
		],
		[
			"control-request binding conflict",
			new LifecycleE4ClientError({
				kind: "drain-conflict",
				status: 409,
				code: "control_request_conflict",
				correlation: {},
				body: "[redacted]",
			}),
			"drain_denied",
		],
		[
			"control-request capacity exhaustion",
			new LifecycleE4ClientError({
				kind: "drain-conflict",
				status: 409,
				code: "control_request_capacity_exceeded",
				correlation: {},
				body: "[redacted]",
			}),
			"drain_denied",
		],
	] as const)(
		"fails closed on typed %s without replay, signal, or request identifier exposure",
		async (_label, failure, reason) => {
			const store = await temporaryStore();
			const process = processHarness();
			const calls: string[] = [];
			let requestId = "";
			const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient: () => ({
					handshake: async () => {
						const current = process.current();
						return {
							...boundClient(bindingFor(current.pid, current.launchId), calls),
							beginControlDrain: async input => {
								requestId = input.controlRequestId;
								calls.push("begin-drain");
								throw failure;
							},
						};
					},
				}),
			});
			expect((await supervisor.connect()).kind).toBe("ready");
			const result = await supervisor.stop({ consumerClosed: true });
			expect(result.state.reason).toBe(reason);
			expect(calls.filter(call => call === "begin-drain")).toHaveLength(1);
			expect(process.events).toEqual([]);
			expect(JSON.stringify(result)).not.toContain(requestId);
		},
	);

	test("drain denial detaches requester and never signals or rolls back", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const drainConflict = new LifecycleE4ClientError({
			kind: "drain-conflict",
			status: 409,
			code: "clients_live",
			correlation: {},
			body: "[redacted]",
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls, { drainError: drainConflict }),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).state.reason).toBe("drain_denied");
		expect(calls).toContain("detach-client");
		expect(calls).not.toContain("rollback");
		expect(process.events).toEqual([]);
	});

	test("retires only after exact graceful process death without rollback or hard-signal outcome", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.exitOnNextWait();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(calls).toContain("graceful:accepted");
		expect(calls).not.toContain("graceful:timeout");
		expect(calls.some(call => call.startsWith("hard-signal:"))).toBe(false);
		expect(calls).not.toContain("rollback");
		expect(process.events).not.toContain("hard-control");
		expect(await store.readCurrent("http://127.0.0.1:7777")).toBeNull();
	});

	test("hard signal delivery never rolls back when exit observation times out", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false, false);
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).state.reason).toBe("drain_recovery_failed");
		expect(calls).toContain("hard-signal:sent");
		expect(calls).not.toContain("rollback");
	});
	test("wipes bootstrap and owner buffers when durable preparation fails", async () => {
		const store = await temporaryStore({
			beforeAtomicRename: (_from, to) => {
				if (to.endsWith(".starting.json")) throw new Error("synthetic durable preparation failure");
			},
		});
		const process = processHarness();
		const bootstrap = Buffer.alloc(32, 17);
		const owner = Buffer.from("durable_failure_owner_abcdefghijklmnopqrstuvwxyz", "ascii");
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, []),
			randomSecret: () => bootstrap,
			randomOwnerCredential: () => owner,
		});
		expect((await supervisor.connect()).kind).toBe("failure");
		expect(process.spawnCount()).toBe(0);
		expect([...bootstrap].every(byte => byte === 0)).toBe(true);
		expect([...owner].every(byte => byte === 0)).toBe(true);
		expect((await readdir(store.root)).some(name => name.includes(".starting.secret."))).toBe(false);
	});

	test("honors abort after durable preparation and before spawning", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		const store = await temporaryStore({
			beforeAtomicRename: async (_from, to) => {
				if (!paused && to.endsWith(".starting.json")) {
					paused = true;
					entered.resolve();
					await release.promise;
				}
			},
		});
		const process = processHarness();
		const bootstrap = Buffer.alloc(32, 11);
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, []),
			randomSecret: () => bootstrap,
		});
		const connecting = supervisor.connect();
		await entered.promise;
		supervisor.abort();
		release.resolve();
		expect((await connecting).state.reason).toBe("request_aborted");
		expect(process.spawnCount()).toBe(0);
		expect([...bootstrap].every(byte => byte === 0)).toBe(true);
		const next = await store.withExclusiveLock("http://127.0.0.1:7777", () =>
			store.claimStart("http://127.0.0.1:7777"),
		);
		expect(next.kind).toBe("claimed");
	});

	test("caller abort wipes transferred bootstrap and preserves the recoverable pending claim without hard control", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
		const entered = Promise.withResolvers<void>();
		const handshake = Promise.withResolvers<BoundLifecycleE4Client>();
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					entered.resolve();
					return await handshake.promise;
				},
			}),
		});
		const connecting = supervisor.connect();
		await entered.promise;
		supervisor.abort();
		handshake.reject(new LifecycleE4ClientError({ kind: "caller-abort" }));
		const result = await connecting;
		expect(result.state.reason).toBe("request_aborted");
		expect([...(process.bootstrapBuffers[0] as Buffer)].every(byte => byte === 0)).toBe(true);
		expect(process.events).not.toContain("hard-control");
		const preserved = await store.withExclusiveLock("http://127.0.0.1:7777", () =>
			store.claimStart("http://127.0.0.1:7777"),
		);
		expect(preserved.kind).toBe("recoverable");
		if (preserved.kind === "recoverable") {
			expect(preserved.claim).toMatchObject({
				enginePid: process.current().pid,
				engineProcessStartToken: `darwin:${process.current().pid}:1`,
			});
			const secret = await store.readPendingSecret(preserved.claim);
			expect(secret.bootstrapCredential.byteLength).toBe(32);
			secret.bootstrapCredential.fill(0);
			secret.ownerCredential.fill(0);
		}
	});
	test("retains the durable claim without hard control when identity changes during caller abort", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const entered = Promise.withResolvers<void>();
		const handshake = Promise.withResolvers<BoundLifecycleE4Client>();
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					entered.resolve();
					return await handshake.promise;
				},
			}),
		});
		const connecting = supervisor.connect();
		await entered.promise;
		process.rotateIdentity();
		supervisor.abort();
		handshake.reject(new LifecycleE4ClientError({ kind: "caller-abort" }));
		const result = await connecting;
		expect(result.state).toMatchObject({ name: "request-aborted", reason: "request_aborted" });
		expect(process.events).not.toContain("hard-control");
		const claim = await store.withExclusiveLock("http://127.0.0.1:7777", () =>
			store.claimStart("http://127.0.0.1:7777"),
		);
		expect(claim.kind).toBe("occupied");
	});

	test("abort during authority commit preserves the adoptable authenticated record without hard control", async () => {
		let supervisor: LifecycleSupervisor | undefined;
		const store = await temporaryStore({
			beforeAtomicRename: (_from, to) => {
				if (to.endsWith(".authority.json")) supervisor?.abort();
			},
		});
		const process = processHarness();
		const calls: string[] = [];
		supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		const result = await supervisor.connect();
		expect(result.state).toMatchObject({ name: "request-aborted", reason: "request_aborted" });
		expect(process.events).not.toContain("hard-control");
		expect(calls).toEqual(["acquire-owner"]);
		const current = await store.readCurrent("http://127.0.0.1:7777");
		expect(current).not.toBeNull();
		if (current) {
			const secret = await store.readSecret(current);
			secret.ownerCredential.fill(0);
		}
		expect((await readdir(store.root)).some(name => name.includes(".secret."))).toBe(true);
	});

	test("abort during registration preserves the adoptable committed record without hard control", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const entered = Promise.withResolvers<void>();
		const registration = Promise.withResolvers<never>();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const client = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...client,
						registerClient: async () => {
							calls.push("register:local-owned");
							entered.resolve();
							return await registration.promise;
						},
					};
				},
			}),
		});
		const connecting = supervisor.connect();
		await entered.promise;
		supervisor.abort();
		registration.reject(new LifecycleE4ClientError({ kind: "caller-abort" }));
		const result = await connecting;
		expect(result.state).toMatchObject({ name: "request-aborted", reason: "request_aborted" });
		expect(process.events).not.toContain("hard-control");
		const current = await store.readCurrent("http://127.0.0.1:7777");
		expect(current).not.toBeNull();
		if (current) {
			const secret = await store.readSecret(current);
			secret.ownerCredential.fill(0);
		}
		expect((await readdir(store.root)).some(name => name.includes(".secret."))).toBe(true);
	});

	test("persists commit intent before requesting a permit, signals once, then records the exact outcome", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const client = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...client,
						prepareHardSignal: async () => {
							process.events.push("authorize-hard-signal");
							return {
								result: "prepared",
								authorizationId: "authorization_abcdefghijklmnopqrstuvwxyz",
								expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
							} as never;
						},
						commitHardSignal: async (input: CommitHardSignalInput) => {
							const record = await store.readCurrent("http://127.0.0.1:7777");
							if (!record) throw new Error("authority record missing before hard signal commit");
							expect(await store.readControlAttempt(record.normalizedEndpoint, record)).toMatchObject({
								phase: "hard-signal-commit-pending",
							});
							process.events.push("commit-hard-signal");
							return hardSignalPermit(client.binding, input);
						},
						recordHardSignalOutcome: async input => {
							expect(process.events).toContain("hard-control");
							process.events.push("record-hard-signal-outcome");
							calls.push(`hard-signal:${input.outcome}`);
							return { result: "signal_sent" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect(calls).toContain("hard-signal:sent");
		expect(process.events.indexOf("authorize-hard-signal")).toBeLessThan(
			process.events.indexOf("commit-hard-signal"),
		);
		expect(process.events.indexOf("commit-hard-signal")).toBeLessThan(process.events.indexOf("hard-control"));
		expect(process.events.indexOf("hard-control")).toBeLessThan(process.events.indexOf("record-hard-signal-outcome"));
	});

	test("fails closed without commit or rollback when process identity rotates after preparation", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const client = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...client,
						prepareHardSignal: async () => {
							process.rotateIdentity();
							return {
								result: "prepared",
								authorizationId: "authorization_rotated_abcdefghijklmnop",
								expiresAtUnix: Math.floor(Date.now() / 1_000) + 30,
							} as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("failure");
		expect(calls).not.toContain("commit-hard-signal");
		expect(calls.some(call => call.startsWith("hard-signal:"))).toBe(false);
		expect(calls).not.toContain("rollback");
		expect(process.events).not.toContain("hard-control");
		const record = await store.readCurrent("http://127.0.0.1:7777");
		if (!record) throw new Error("authority record missing after identity rotation");
		expect(await store.readControlAttempt(record.normalizedEndpoint, record)).toMatchObject({
			phase: "hard-signal-commit-pending",
		});
	});

	test("rolls back a definitive commit expiry and never signals", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(false);
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const client = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...client,
						prepareHardSignal: async () =>
							({
								result: "prepared",
								authorizationId: "authorization_expired_abcdefghijklmnop",
								expiresAtUnix: 1,
							}) as never,
						commitHardSignal: async () => {
							calls.push("commit-expired");
							throw new LifecycleE4ClientError({
								kind: "hard-signal-authorization-expired",
								status: 409,
								code: "hard_signal_authorization_expired",
								correlation: {},
								body: "[redacted]",
							});
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("ready");
		expect(calls).toContain("commit-expired");
		expect(calls.some(call => call.startsWith("hard-signal:"))).toBe(false);
		expect(calls).toContain("rollback");
		expect(process.events).not.toContain("hard-control");
	});

	test("post-drain exceptions roll back before any hard signal", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls, { gracefulError: new Error("record failed") }),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("failure");
		expect(calls).toContain("rollback");
		expect(process.events.some(event => event.startsWith("hard-control"))).toBe(false);
	});
	test("fences hard control after dispatcher abort and reaches quiescence before later work can signal", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const waitEntered = Promise.withResolvers<void>();
		const releaseWait = Promise.withResolvers<boolean>();
		const quiesced = Promise.withResolvers<void>();
		const calls: string[] = [];
		const blockedProcess: LifecycleProcessAdapter = {
			...process.adapter,
			spawnVerified: async (...args) => {
				const spawned = await process.adapter.spawnVerified(...args);
				if ("kind" in spawned) return spawned;
				return {
					...spawned,
					waitForExit: async timeoutMs => {
						if (timeoutMs === 0) return await spawned.waitForExit(0);
						waitEntered.resolve();
						return await releaseWait.promise;
					},
				};
			},
		};
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: blockedProcess,
			createClient: () => ({
				handshake: async () => {
					const current = process.current();
					const base = boundClient(bindingFor(current.pid, current.launchId), calls);
					return {
						...base,
						rollbackDrain: async () => {
							calls.push("rollback-after-abort");
							quiesced.resolve();
							return { result: "rolled_back" } as never;
						},
						recordHardSignalOutcome: async input => {
							calls.push(`hard-signal-after-abort:${input.outcome}`);
							quiesced.resolve();
							return { result: input.outcome === "process_exited" ? "process_exited" : "signal_sent" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		const signals = new TestLifecycleSignalTarget();
		const executionPromise = dispatchLifecycleAction(supervisor, "stop", {
			actionOptions: { consumerClosed: true },
			restoreTerminal: () => undefined,
			signalTarget: signals,
			signalSettleTimeoutMs: 1,
		});
		let settledExecution: Awaited<typeof executionPromise> | undefined;
		void executionPromise.then(execution => {
			settledExecution = execution;
		});
		await waitEntered.promise;
		signals.emit("SIGINT");
		await Bun.sleep(10);
		const settledBeforeRelease = settledExecution !== undefined;
		expect(process.events).not.toContain("hard-control");
		releaseWait.resolve(false);
		const execution = settledExecution ?? (await executionPromise);
		expect(settledBeforeRelease).toBe(true);
		expect(execution).toMatchObject({ result: { state: { reason: "request_aborted" } }, signal: "SIGINT" });
		expect(await Promise.race([quiesced.promise.then(() => true), Bun.sleep(50).then(() => false)])).toBe(true);
		expect(process.events).not.toContain("hard-control");
		expect(calls).toContain("rollback-after-abort");
		expect(calls.some(call => call.startsWith("hard-signal-after-abort:"))).toBe(false);
	});

	test("explicit restart emits exact governed transition order and preserves policy", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.waitResults.push(true);
		const states: string[] = [];
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
			stateChanged: state => states.push(state.name),
		});
		const connected = await supervisor.connect();
		expect({ connected, calls, events: process.events, states }).toMatchObject({ connected: { kind: "ready" } });
		states.length = 0;
		expect((await supervisor.restart({ consumerClosed: true })).kind).toBe("ready");
		expect(states).toEqual([
			"draining",
			"restart-stopping",
			"restart-starting",
			"connecting",
			"handshaking",
			"acquiring-owner",
			"registering-client",
			"ready",
		]);
		expect((await store.readCurrent("http://127.0.0.1:7777"))?.ownerExitPolicy).toBe("detached");
	});

	test("automatic confirmed child death uses bounded backoff", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const sleeps: number[] = [];
		const restarted = Promise.withResolvers<void>();
		let readyCount = 0;
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			clock: {
				now: () => 1_000,
				sleep: async milliseconds => {
					sleeps.push(milliseconds);
				},
			},
			endpointAbsent: async () => true,
			createClient: clientFactory(process, []),
			stateChanged: state => {
				if (state.name === "ready" && ++readyCount === 2) restarted.resolve();
			},
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		process.crash();
		await restarted.promise;
		expect(sleeps).toContain(250);
		expect(process.spawnCount()).toBe(2);
	});
	test("monitors an adopted child and replaces it once after confirmed death", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const endpoint = "http://127.0.0.1:7777";
		const abandonedStarter = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, [], { registerError: new Error("starter registration failed") }),
		});
		expect((await abandonedStarter.connect()).kind).toBe("failure");
		const adoptedPid = process.current().pid;
		const sleeps: number[] = [];
		const restarted = Promise.withResolvers<void>();
		let readyCount = 0;
		const adopter = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			clock: {
				now: () => 1_000,
				sleep: async milliseconds => {
					sleeps.push(milliseconds);
				},
			},
			endpointAbsent: async () => true,
			createClient: clientFactory(process, []),
			stateChanged: state => {
				if (state.name === "ready" && ++readyCount === 2) restarted.resolve();
			},
		});
		expect((await adopter.connect()).kind).toBe("ready");
		process.crash(adoptedPid);
		expect(await Promise.race([restarted.promise.then(() => true), Bun.sleep(50).then(() => false)])).toBe(true);
		expect(sleeps).toContain(250);
		expect(process.spawnCount()).toBe(2);
		expect((await store.readCurrent(endpoint))?.pid).toBe(process.current().pid);
	});

	test("bootstrap delivery failure closes the bound child and replaces it only after exact death", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		process.unboundNext();
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, []),
			endpointAbsent: async () => true,
		});
		const result = await supervisor.connect();
		expect(result.kind).toBe("ready");
		expect(process.spawnCount()).toBe(2);
		expect(process.events).not.toContain("hard-control");
		expect(process.bootstrapBuffers).toHaveLength(2);
		expect(process.bootstrapBuffers.every(buffer => [...buffer].every(byte => byte === 0))).toBe(true);
		const current = await store.readCurrent("http://127.0.0.1:7777");
		expect(current?.pid).toBe(process.current().pid);
	});

	test("durable identity bind failure closes the unreleased child before one safe replacement", async () => {
		let startingRenames = 0;
		const store = await temporaryStore({
			beforeAtomicRename: (_from, to) => {
				if (to.endsWith(".starting.json") && ++startingRenames === 2) {
					throw new Error("synthetic durable identity bind failure");
				}
			},
		});
		const process = processHarness();
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, []),
			endpointAbsent: async () => true,
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect(process.spawnCount()).toBe(2);
		expect(process.bootstrapBuffers).toHaveLength(2);
		expect(process.bootstrapBuffers.every(buffer => [...buffer].every(byte => byte === 0))).toBe(true);
		expect(process.events).not.toContain("hard-control");
	});

	test("default process control implementation is not a reachable module export", async () => {
		expect(lifecycleModule).not.toHaveProperty("DefaultLifecycleProcessAdapter");
	});

	test("explicit stop of an absent local-owned engine performs no claim, spawn, client, or control work", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		let clients = 0;
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => {
				clients++;
				throw new Error("absent stop must not construct a client");
			},
		});
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("stopped");
		expect({ clients, spawns: process.spawnCount(), events: process.events }).toEqual({
			clients: 0,
			spawns: 0,
			events: [],
		});
		const claim = await store.withExclusiveLock("http://127.0.0.1:7777", () =>
			store.claimStart("http://127.0.0.1:7777"),
		);
		expect(claim.kind).toBe("claimed");
	});

	test("explicit restart of an absent engine starts exactly one process without a drain cycle", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: clientFactory(process, calls),
		});
		expect((await supervisor.restart({ consumerClosed: true })).kind).toBe("ready");
		expect(process.spawnCount()).toBe(1);
		expect(calls.filter(call => call === "begin-drain")).toHaveLength(0);
		expect(process.events).not.toContain("hard-control");
	});

	test("dead bound pending claims require locked authenticated absence before exactly one replacement", async () => {
		for (const absent of [false, "ambiguous", true] as const) {
			const process = processHarness();
			let enginePid = 0;
			const store = await temporaryStore({ isLockOwnerAlive: async () => false });
			const config = resolved("local-owned");
			const configuredArtifact = config.engineArtifact as EngineArtifact;
			const endpoint = config.endpoint as string;
			const launchId = `launch_dead_bound_${String(absent)}_abcdefghijklmnop`;
			const bootstrap = Buffer.alloc(32, 21);
			const owner = Buffer.from("dead_bound_owner_abcdefghijklmnopqrstuvwxyz012", "ascii");
			await store.withExclusiveLock(endpoint, async () => {
				const claimed = await store.claimStart(endpoint);
				if (claimed.kind !== "claimed") throw new Error("expected claimed start");
				const prepared = await store.prepareStartClaim(
					endpoint,
					claimed.claim.token,
					{
						launchId,
						executableSha256: configuredArtifact.executableSha256,
						executablePathSha256: executablePathSha256(configuredArtifact.executablePath),
						argvSha256: configuredArtifact.argvSha256,
						engineArtifactSha256: configuredArtifact.engineSourceSha256,
						servedBackendCommit: configuredArtifact.servedBackendCommit,
					},
					{ bootstrapCredential: bootstrap, ownerCredential: owner },
				);
				const transfer = Buffer.from(bootstrap);
				const spawned = await process.adapter.spawnVerified(
					configuredArtifact,
					launchId,
					transfer,
					async (pid, startToken) => {
						await store.bindStartClaimProcess(endpoint, prepared.token, pid, startToken);
					},
				);
				if ("kind" in spawned) throw new Error("expected bound spawned process");
				enginePid = spawned.pid;
				process.crash(spawned.pid);
			});
			bootstrap.fill(0);
			owner.fill(0);
			const supervisor = new LifecycleSupervisor(config, {
				store,
				process: process.adapter,
				endpointAbsent: async () => absent,
				createClient:
					absent === true
						? clientFactory(process, [])
						: () => ({
								handshake: async () => {
									throw new Error("endpoint absence override owns the probe");
								},
							}),
			});
			const result = await supervisor.connect();
			if (absent === true) {
				expect(result.kind).toBe("ready");
				expect(process.spawnCount()).toBe(2);
				expect((await store.readCurrent(endpoint))?.pid).not.toBe(enginePid);
			} else {
				expect({ absent, result }).toMatchObject({
					absent,
					result: { state: { name: "recovery-needed", reason: "endpoint_unreachable" } },
				});
				expect(process.spawnCount()).toBe(1);
				const preserved = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
				expect(preserved.kind).toBe("dead-bound");
			}
			expect(process.events).not.toContain("hard-control");
		}
	});

	test("generation-one owner response loss renews the same owner without bootstrap replay or replacement spawn", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
		let acquired = false;
		let acquireCalls = 0;
		let renewCalls = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					acquireOwner: async input => {
						acquireCalls++;
						if (!("bootstrapCredential" in input)) throw new Error("bootstrap CAS expected only once");
						acquired = true;
						throw new LifecycleE4ClientError({ kind: "timeout" });
					},
					renewOwner: async input => {
						renewCalls++;
						if (!acquired || input.ownerGeneration !== 1)
							throw new Error("generation-one owner was not acquired");
						return { result: "renewed", ownerGeneration: 1 } as never;
					},
				};
			},
		});
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient });
		expect((await first.connect()).state.reason).toBe("endpoint_unreachable");
		const recovered = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await recovered.connect()).kind).toBe("ready");
		expect({ acquireCalls, renewCalls, spawns: process.spawnCount() }).toEqual({
			acquireCalls: 1,
			renewCalls: 1,
			spawns: 1,
		});
	});
	test.each([
		[
			"generation-one bootstrap acquire was never delivered",
			new LifecycleE4ClientError({ kind: "timeout" }),
			"endpoint_unreachable",
		],
		[
			"generation-one bootstrap acquire was aborted before send",
			new LifecycleE4ClientError({ kind: "caller-abort" }),
			"request_aborted",
		],
	] as const)(
		"%s falls back only after definitive lower-generation proof",
		async (_name, initialFailure, firstReason) => {
			const process = processHarness();
			const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
			const ownerExpired = () =>
				new LifecycleE4ClientError({
					kind: "owner-expired",
					status: 410,
					code: "owner_expired",
					correlation: {},
					body: "[redacted]",
				});
			const requests: Array<{ readonly expected: number; readonly bootstrap: boolean }> = [];
			let firstAcquire = true;
			const createClient = (): LifecycleE4Client => ({
				handshake: async () => {
					const current = process.current();
					return {
						...boundClient(bindingFor(current.pid, current.launchId), []),
						renewOwner: async () => {
							throw ownerExpired();
						},
						acquireOwner: async input => {
							requests.push({
								expected: input.expectedOwnerGeneration,
								bootstrap: "bootstrapCredential" in input,
							});
							if (firstAcquire) {
								firstAcquire = false;
								throw initialFailure;
							}
							if (input.expectedOwnerGeneration === 1) throw ownerExpired();
							return { result: "acquired", ownerGeneration: 1 } as never;
						},
					};
				},
			});
			const first = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect((await first.connect()).state.reason).toBe(firstReason);
			const recovered = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect(await recovered.connect()).toMatchObject({ kind: "ready" });
			expect(requests).toEqual([
				{ expected: 0, bootstrap: true },
				{ expected: 1, bootstrap: false },
				{ expected: 0, bootstrap: true },
			]);
			expect(process.spawnCount()).toBe(1);
		},
	);

	test("response loss then owner expiry advances the durable attempt and recovers generation two without bootstrap replay", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
		const endpoint = "http://127.0.0.1:7777";
		const ownerExpired = (): LifecycleE4ClientError =>
			new LifecycleE4ClientError({
				kind: "owner-expired",
				status: 410,
				code: "owner_expired",
				correlation: {},
				body: "[redacted]",
			});
		let remoteGeneration = 0;
		let bootstrapRequests = 0;
		let credentialRequests = 0;
		const renewGenerations: number[] = [];
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					renewOwner: async input => {
						renewGenerations.push(input.ownerGeneration);
						if (input.ownerGeneration === 1) throw ownerExpired();
						if (input.ownerGeneration !== remoteGeneration)
							throw new Error("unexpected recovered owner generation");
						return { result: "renewed", ownerGeneration: remoteGeneration } as never;
					},
					acquireOwner: async input => {
						if (input.expectedOwnerGeneration === 0) {
							expect("bootstrapCredential" in input).toBe(true);
							bootstrapRequests++;
						} else {
							expect("bootstrapCredential" in input).toBe(false);
							credentialRequests++;
						}
						if (input.expectedOwnerGeneration !== remoteGeneration) {
							throw new LifecycleE4ClientError({
								kind: "owner-conflict",
								status: 409,
								code: "owner_generation_conflict",
								correlation: {},
								body: "[redacted]",
							});
						}
						remoteGeneration++;
						throw new LifecycleE4ClientError({ kind: "timeout" });
					},
				};
			},
		});
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient });
		expect((await first.connect()).state.reason).toBe("endpoint_unreachable");
		const afterFirst = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
		expect(afterFirst).toMatchObject({ kind: "recoverable", claim: { ownerAttemptGeneration: 1 } });
		const second = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await second.connect()).state.reason).toBe("endpoint_unreachable");
		const afterSecond = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
		expect(afterSecond).toMatchObject({ kind: "recoverable", claim: { ownerAttemptGeneration: 2 } });
		const recovered = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect(await recovered.connect()).toMatchObject({ kind: "ready" });
		expect({
			remoteGeneration,
			bootstrapRequests,
			credentialRequests,
			renewGenerations,
			spawns: process.spawnCount(),
			hardControl: process.events.includes("hard-control"),
		}).toEqual({
			remoteGeneration: 2,
			bootstrapRequests: 1,
			credentialRequests: 1,
			renewGenerations: [1, 2],
			spawns: 1,
			hardControl: false,
		});
	});
	test.each(["predecessor-expired", "predecessor-live", "delayed-prior-wins"] as const)(
		"generation-two acquire nondelivery recovers pinned backend state when %s",
		async outcome => {
			const process = processHarness();
			const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
			const endpoint = "http://127.0.0.1:7777";
			const ownerFailure = (kind: "owner-expired" | "owner-conflict") =>
				new LifecycleE4ClientError({
					kind,
					status: kind === "owner-expired" ? 410 : 409,
					code: kind === "owner-expired" ? "owner_expired" : "owner_generation_conflict",
					correlation: {},
					body: "[redacted]",
				});
			const acquireRequests: Array<{ readonly expected: number; readonly bootstrap: boolean }> = [];
			const renewRequests: number[] = [];
			let acquireCall = 0;
			let renewOneCalls = 0;
			let delayedPriorWon = false;
			const createClient = (): LifecycleE4Client => ({
				handshake: async () => {
					const current = process.current();
					return {
						...boundClient(bindingFor(current.pid, current.launchId), []),
						renewOwner: async input => {
							renewRequests.push(input.ownerGeneration);
							if (input.ownerGeneration === 2) {
								if (delayedPriorWon) return { result: "renewed", ownerGeneration: 2 } as never;
								throw ownerFailure("owner-conflict");
							}
							renewOneCalls++;
							if (renewOneCalls === 1 || outcome !== "predecessor-live") throw ownerFailure("owner-expired");
							return { result: "renewed", ownerGeneration: 1 } as never;
						},
						acquireOwner: async input => {
							acquireCall++;
							acquireRequests.push({
								expected: input.expectedOwnerGeneration,
								bootstrap: "bootstrapCredential" in input,
							});
							if (acquireCall <= 2) throw new LifecycleE4ClientError({ kind: "timeout" });
							if (input.expectedOwnerGeneration !== 1 || "bootstrapCredential" in input) {
								throw new Error("unexpected predecessor acquire");
							}
							if (outcome === "delayed-prior-wins") {
								delayedPriorWon = true;
								throw ownerFailure("owner-conflict");
							}
							return { result: "acquired", ownerGeneration: 2 } as never;
						},
					};
				},
			});
			const first = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect((await first.connect()).state.reason).toBe("endpoint_unreachable");
			const second = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect((await second.connect()).state.reason).toBe("endpoint_unreachable");
			const pending = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
			expect(pending).toMatchObject({ kind: "recoverable", claim: { ownerAttemptGeneration: 2 } });
			const recovered = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient,
			});
			expect(await recovered.connect()).toMatchObject({ kind: "ready" });
			expect(acquireRequests).toEqual(
				outcome === "predecessor-live"
					? [
							{ expected: 0, bootstrap: true },
							{ expected: 1, bootstrap: false },
						]
					: [
							{ expected: 0, bootstrap: true },
							{ expected: 1, bootstrap: false },
							{ expected: 1, bootstrap: false },
						],
			);
			expect(renewRequests).toEqual(outcome === "delayed-prior-wins" ? [1, 2, 1, 2] : [1, 2, 1]);
			expect(process.spawnCount()).toBe(1);
			expect(process.events).not.toContain("hard-control");
			expect((await store.readCurrent(endpoint))?.ownerGeneration).toBe(outcome === "predecessor-live" ? 1 : 2);
		},
	);

	test("generation conflict after a lost owner request fails closed without bootstrap replay", async () => {
		const process = processHarness();
		const store = await temporaryStore({ isLockOwnerAlive: async owner => owner.pid === process.current().pid });
		let firstRequestLost = true;
		let bootstrapRequests = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					renewOwner: async () => {
						throw new LifecycleE4ClientError({
							kind: "owner-expired",
							status: 410,
							code: "owner_expired",
							correlation: {},
							body: "[redacted]",
						});
					},
					acquireOwner: async input => {
						if (input.expectedOwnerGeneration === 0) {
							bootstrapRequests++;
							if (firstRequestLost) {
								firstRequestLost = false;
								throw new LifecycleE4ClientError({ kind: "timeout" });
							}
							return { result: "acquired", ownerGeneration: 1 } as never;
						}
						throw new LifecycleE4ClientError({
							kind: "owner-conflict",
							status: 409,
							code: "owner_generation_conflict",
							correlation: {},
							body: "[redacted]",
						});
					},
				};
			},
		});
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient });
		expect((await first.connect()).state.reason).toBe("endpoint_unreachable");
		const recovered = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		const result = await recovered.connect();
		expect(result).toMatchObject({ kind: "failure", state: { reason: "ownership_conflict" } });
		expect({ bootstrapRequests, spawns: process.spawnCount() }).toEqual({ bootstrapRequests: 1, spawns: 1 });
	});

	test("authority commit failure recovers the durably attempted owner without bootstrap replay or replacement spawn", async () => {
		const process = processHarness();
		let failCommit = true;
		const store = await temporaryStore({
			isLockOwnerAlive: async owner => owner.pid === process.current().pid,
			beforeAtomicRename: (_from, to) => {
				if (failCommit && to.endsWith(".authority.json")) {
					failCommit = false;
					throw new Error("synthetic authority commit failure");
				}
			},
		});
		let acquired = false;
		let acquireCalls = 0;
		let renewCalls = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					acquireOwner: async input => {
						acquireCalls++;
						if (!("bootstrapCredential" in input)) throw new Error("unexpected credential-only initial acquire");
						acquired = true;
						return { result: "acquired", ownerGeneration: 1 } as never;
					},
					renewOwner: async input => {
						renewCalls++;
						if (!acquired || input.ownerGeneration !== 1)
							throw new Error("generation-one owner was not acquired");
						return { result: "renewed", ownerGeneration: 1 } as never;
					},
				};
			},
		});
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient });
		expect((await first.connect()).kind).toBe("failure");
		const recovered = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await recovered.connect()).kind).toBe("ready");
		expect({ acquireCalls, renewCalls, spawns: process.spawnCount() }).toEqual({
			acquireCalls: 1,
			renewCalls: 1,
			spawns: 1,
		});
	});

	test("reports local-owned owner-lease renewal loss after ready", async () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		let runRenewal: (() => void) | undefined;
		let renewalActive = false;
		try {
			globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
				renewalActive = true;
				runRenewal = () => {
					if (typeof handler === "function") handler();
				};
				return { unref: () => undefined } as unknown as NodeJS.Timeout;
			}) as typeof setInterval;
			globalThis.clearInterval = (() => {
				renewalActive = false;
			}) as typeof clearInterval;
			const process = processHarness();
			const store = await temporaryStore();
			const renewalFailure = Promise.withResolvers<LifecycleState>();
			const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
				store,
				process: process.adapter,
				createClient: () => ({
					handshake: async () => {
						const current = process.current();
						return {
							...boundClient(bindingFor(current.pid, current.launchId), []),
							renewOwner: async () => {
								throw new LifecycleE4ClientError({
									kind: "owner-expired",
									status: 410,
									code: "owner_expired",
									correlation: {},
									body: "[redacted]",
								});
							},
						};
					},
				}),
				stateChanged: state => {
					if (state.name === "owner-lease-expired") renewalFailure.resolve(state);
				},
			});
			expect((await supervisor.connect()).kind).toBe("ready");
			expect(renewalActive).toBe(true);
			if (!runRenewal) throw new Error("lease renewal interval was not installed");
			runRenewal();
			await expect(renewalFailure.promise).resolves.toMatchObject({
				name: "owner-lease-expired",
				reason: "owner_lease_expired",
			});
			expect(renewalActive).toBe(false);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
	test("detached close failure cancels lease renewal before detach and never renews afterward", async () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		let active = false;
		let renewals = 0;
		try {
			globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
				active = true;
				return { unref: () => undefined, handler } as unknown as NodeJS.Timeout;
			}) as typeof setInterval;
			globalThis.clearInterval = (() => {
				active = false;
			}) as typeof clearInterval;
			const store = await temporaryStore();
			const process = processHarness();
			const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
				store,
				process: process.adapter,
				createClient: () => ({
					handshake: async () => {
						const current = process.current();
						const base = boundClient(bindingFor(current.pid, current.launchId), []);
						return {
							...base,
							renewClient: async () => {
								renewals++;
								return { result: "renewed" } as never;
							},
							detachClient: async () => {
								throw new LifecycleE4ClientError({ kind: "timeout" });
							},
						};
					},
				}),
			});
			expect((await supervisor.connect()).kind).toBe("ready");
			expect(active).toBe(true);
			expect((await supervisor.close({ consumerClosed: true })).kind).toBe("failure");
			expect(active).toBe(false);
			expect(renewals).toBe(0);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
	test("replays exact detached close requests after lost responses in one close", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const detachInputs: Parameters<BoundLifecycleE4Client["detachClient"]>[0][] = [];
		const releaseInputs: Parameters<BoundLifecycleE4Client["releaseOwner"]>[0][] = [];
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					detachClient: async input => {
						detachInputs.push(input);
						if (detachInputs.length === 1) throw new LifecycleE4ClientError({ kind: "timeout" });
						return { result: "already_detached" } as never;
					},
					releaseOwner: async input => {
						releaseInputs.push(input);
						if (releaseInputs.length === 1) throw new LifecycleE4ClientError({ kind: "timeout" });
						return { result: "already_released" } as never;
					},
				};
			},
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		expect(detachInputs).toHaveLength(2);
		expect(detachInputs.map(({ signal: _, ...input }) => input)[1]).toEqual(
			detachInputs.map(({ signal: _, ...input }) => input)[0],
		);
		expect(releaseInputs).toHaveLength(2);
		expect(releaseInputs.map(({ signal: _, ...input }) => input)[1]).toEqual(
			releaseInputs.map(({ signal: _, ...input }) => input)[0],
		);
	});

	test("replays detach-pending on a later detached close after ambiguous retries exhaust", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		let detachCalls = 0;
		let releaseCalls = 0;
		let renewCalls = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					renewOwner: async () => {
						renewCalls++;
						return { result: "renewed", ownerGeneration: 1 } as never;
					},
					detachClient: async () => {
						detachCalls++;
						if (detachCalls <= 3) throw new LifecycleE4ClientError({ kind: "timeout" });
						return { result: "already_detached" } as never;
					},
					releaseOwner: async () => {
						releaseCalls++;
						return { result: "released" } as never;
					},
				};
			},
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("failure");
		expect({ detachCalls, releaseCalls, renewCalls }).toEqual({ detachCalls: 3, releaseCalls: 0, renewCalls: 0 });
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		expect({ detachCalls, releaseCalls, renewCalls }).toEqual({ detachCalls: 4, releaseCalls: 1, renewCalls: 1 });
	});

	test("replays release-pending without detach or renew after ambiguous release may have committed", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		let detachCalls = 0;
		let releaseCalls = 0;
		let renewCalls = 0;
		const createClient = (): LifecycleE4Client => ({
			handshake: async () => {
				const current = process.current();
				const base = boundClient(bindingFor(current.pid, current.launchId), []);
				return {
					...base,
					renewOwner: async () => {
						renewCalls++;
						if (renewCalls > 1) throw new Error("release replay must not renew a possibly released owner");
						return { result: "renewed", ownerGeneration: 1 } as never;
					},
					detachClient: async () => {
						detachCalls++;
						if (detachCalls > 1) throw new Error("release-pending replay must not detach again");
						return { result: "detached" } as never;
					},
					releaseOwner: async () => {
						releaseCalls++;
						if (releaseCalls <= 3) throw new LifecycleE4ClientError({ kind: "timeout" });
						return { result: "already_released" } as never;
					},
				};
			},
		});
		const supervisor = new LifecycleSupervisor(resolved("local-owned", "detached"), {
			store,
			process: process.adapter,
			createClient,
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("failure");
		expect({ detachCalls, releaseCalls, renewCalls }).toEqual({ detachCalls: 1, releaseCalls: 3, renewCalls: 1 });
		expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		expect({ detachCalls, releaseCalls, renewCalls }).toEqual({ detachCalls: 1, releaseCalls: 4, renewCalls: 1 });
	});
});

class TestLifecycleSignalTarget implements LifecycleSignalTarget {
	readonly #listeners = new Map<LifecycleSignal, Set<() => void>>();

	on(signal: LifecycleSignal, listener: () => void): void {
		const listeners = this.#listeners.get(signal) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(signal, listeners);
	}

	off(signal: LifecycleSignal, listener: () => void): void {
		this.#listeners.get(signal)?.delete(listener);
	}

	emit(signal: LifecycleSignal): void {
		for (const listener of [...(this.#listeners.get(signal) ?? [])]) listener();
	}

	listenerCount(): number {
		return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}

const coordinatorReady = {
	kind: "ready",
	state: { name: "ready", mode: "remote", attempt: 0 },
	handle: {},
} as LifecycleDispatchResult;
const coordinatorObserved = {
	kind: "observed",
	state: { name: "ready", mode: "remote", attempt: 0 },
	handle: {},
} as LifecycleDispatchResult;
const coordinatorDetached = {
	kind: "detached",
	state: { name: "detached", mode: "remote", attempt: 0 },
} as LifecycleDispatchResult;

function lifecycleController(overrides: Partial<LifecycleController>): LifecycleController {
	const forbidden = async (): Promise<LifecycleDispatchResult> => {
		throw new Error("unexpected lifecycle call");
	};
	return {
		connect: forbidden,
		start: forbidden,
		status: forbidden,
		stop: forbidden,
		restart: forbidden,
		update: forbidden,
		close: forbidden,
		abortResult: () => lifecycleFailure("remote", "request-aborted", "request_aborted"),
		...overrides,
	};
}

describe("lifecycle dispatch coordination", () => {
	test("keeps observed status pure and removes signal listeners", async () => {
		const signals = new TestLifecycleSignalTarget();
		let closes = 0;
		let restores = 0;
		const execution = await dispatchLifecycleAction(
			lifecycleController({
				status: async () => coordinatorObserved,
				close: async () => {
					closes++;
					return coordinatorDetached;
				},
			}),
			"status",
			{
				closeReady: true,
				restoreTerminal: () => {
					restores++;
				},
				signalTarget: signals,
			},
		);

		expect(execution).toEqual({ result: coordinatorObserved });
		expect(closes).toBe(0);
		expect(restores).toBe(1);
		expect(signals.listenerCount()).toBe(0);
	});

	test("restores then aborts an action and closes exactly once after it settles", async () => {
		const signals = new TestLifecycleSignalTarget();
		const connecting = Promise.withResolvers<LifecycleDispatchResult>();
		const events: string[] = [];
		const executionPromise = dispatchLifecycleAction(
			lifecycleController({
				connect: () => {
					events.push("connect");
					return connecting.promise;
				},
				abort: () => {
					events.push("abort");
				},
				close: async () => {
					events.push("close");
					return coordinatorDetached;
				},
			}),
			"connect",
			{
				closeReady: true,
				restoreTerminal: () => {
					events.push("restore");
				},
				signalTarget: signals,
			},
		);

		signals.emit("SIGINT");
		signals.emit("SIGTERM");
		connecting.resolve(coordinatorReady);
		const execution = await executionPromise;

		expect(events).toEqual(["connect", "restore", "abort", "close"]);
		expect(execution).toEqual({ result: coordinatorReady, closeResult: coordinatorDetached, signal: "SIGINT" });
		expect(signals.listenerCount()).toBe(0);
	});

	test("bounds signal cleanup when an action ignores abort", async () => {
		const signals = new TestLifecycleSignalTarget();
		const never = Promise.withResolvers<LifecycleDispatchResult>();
		const events: string[] = [];
		const executionPromise = dispatchLifecycleAction(
			lifecycleController({
				connect: () => never.promise,
				abort: () => {
					events.push("abort");
				},
			}),
			"connect",
			{
				restoreTerminal: () => {
					events.push("restore");
				},
				signalTarget: signals,
				signalSettleTimeoutMs: 1,
			},
		);
		signals.emit("SIGTERM");
		const execution = await executionPromise;
		expect(execution.result.state.reason).toBe("request_aborted");
		expect(execution.signal).toBe("SIGTERM");
		expect(events).toEqual(["restore", "abort"]);
		expect(signals.listenerCount()).toBe(0);
	});

	test("does not duplicate close or restoration when signaled during close", async () => {
		const signals = new TestLifecycleSignalTarget();
		const closing = Promise.withResolvers<LifecycleDispatchResult>();
		const closeEntered = Promise.withResolvers<void>();
		const events: string[] = [];
		const executionPromise = dispatchLifecycleAction(
			lifecycleController({
				connect: async () => coordinatorReady,
				abort: () => {
					events.push("abort");
				},
				close: () => {
					events.push("close");
					closeEntered.resolve();
					return closing.promise;
				},
			}),
			"connect",
			{
				closeReady: true,
				restoreTerminal: () => {
					events.push("restore");
				},
				signalTarget: signals,
			},
		);

		await closeEntered.promise;
		signals.emit("SIGTERM");
		signals.emit("SIGTERM");
		closing.resolve(coordinatorDetached);
		const execution = await executionPromise;

		expect(events).toEqual(["close", "restore", "abort"]);
		expect(execution.signal).toBe("SIGTERM");
		expect(signals.listenerCount()).toBe(0);
	});

	test("returns typed close failure for native-safe presentation", async () => {
		const closeFailure = lifecycleFailure("remote", "failed", "registration_expired");
		const execution = await dispatchLifecycleAction(
			lifecycleController({ connect: async () => coordinatorReady, close: async () => closeFailure }),
			"connect",
			{ closeReady: true, restoreTerminal: () => {}, signalTarget: new TestLifecycleSignalTarget() },
		);

		expect(execution.closeResult).toEqual(closeFailure);
		const output: string[] = [];
		const presentation = writeLifecyclePresentation(execution.closeResult!, text => output.push(text));
		expect(presentation.exitCode).toBe(1);
		expect(output.join("")).toBe(
			"BreadBoard engine: failed (registration_expired)\nReconnect and register this invocation again.\n",
		);
		expect(output.join("")).not.toContain("synthetic secret");
	});

	test("restores and removes listeners when an action throws", async () => {
		const signals = new TestLifecycleSignalTarget();
		let restores = 0;
		await expect(
			dispatchLifecycleAction(
				lifecycleController({
					connect: async () => {
						throw new Error("synthetic secret");
					},
				}),
				"connect",
				{
					restoreTerminal: () => {
						restores++;
					},
					signalTarget: signals,
				},
			),
		).rejects.toThrow("synthetic secret");
		expect(restores).toBe(1);
		expect(signals.listenerCount()).toBe(0);
	});
});

interface LifecycleCliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runLifecycleCli(args: readonly string[], home: string): Promise<LifecycleCliResult> {
	const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
		cwd: join(import.meta.dir, "../../.."),
		env: {
			...Bun.env,
			HOME: home,
			BREADBOARD_ENGINE_MODE: undefined,
			ANTHROPIC_API_KEY: "test-key",
			PI_CODING_AGENT_DIR: undefined,
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CONFIG_DIR: undefined,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function temporaryLifecycleHome(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-cli-"));
	roots.push(root);
	return root;
}

describe("CLI lifecycle composition boundary", () => {
	test("non-session launch exits bypass lifecycle authority", async () => {
		const home = await temporaryLifecycleHome();
		const exportPath = join(home, "session.html");
		const cases = [
			["launch", "--engine-mode", "local-owned", "--version"],
			["launch", "--engine-mode", "local-owned", "--help"],
			["config", "--help"],
			["update", "--help"],
			["launch", "--engine-mode", "local-owned", "--export", "test/fixtures/before-compaction.jsonl", exportPath],
		] as const;

		const results = [];
		for (const args of cases) results.push(await runLifecycleCli([...args], home));
		for (const result of results) {
			expect(result.exitCode).toBe(0);
			expect(`${result.stdout}${result.stderr}`).not.toContain("BreadBoard engine:");
			expect(result.stderr).not.toContain("missing_engine_artifact");
		}
	});

	test("engine-off RPC remains native and keeps stdout byte-clean JSONL", async () => {
		const home = await temporaryLifecycleHome();
		const result = await runLifecycleCli(["launch", "--engine-mode", "off", "--mode", "rpc"], home);
		if (result.exitCode !== 0) {
			throw new Error(
				`engine-off RPC exited ${result.exitCode}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
			);
		}
		const frames = result.stdout
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string });
		expect(frames[0]).toEqual({ type: "ready" });
		expect(frames.every(frame => typeof frame.type === "string")).toBe(true);
		expect(`${result.stdout}${result.stderr}`).not.toContain("BreadBoard engine:");
		expect(result.stderr).not.toContain("missing_engine_artifact");
	});

	test("explicit BreadBoard engine selection rejects native surfaces on stderr only", async () => {
		const home = await temporaryLifecycleHome();
		const endpoint = "http://127.0.0.1:1";
		const cases = [
			["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--print", "hello"],
			["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--mode", "rpc"],
			["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--mode", "rpc-ui"],
			["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--mode", "acp"],
		] as const;
		for (const args of cases) {
			const result = await runLifecycleCli([...args], home);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("BreadBoard launch error [unsupported_native_mode]");
			expect(result.stderr).not.toContain(endpoint);
		}
	});
});
