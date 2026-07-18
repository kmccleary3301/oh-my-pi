import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundLifecycleE4Client, LifecycleE4Client, LifecycleEngineBinding } from "@breadboard/sdk";
import { LifecycleE4ClientError } from "@breadboard/sdk";
import { LocalAuthorityStore } from "./local-authority-store";
import {
	dispatchLifecycleAction,
	type LifecycleController,
	type LifecycleDispatchResult,
	type LifecycleProcessAdapter,
	type LifecycleSignal,
	type LifecycleSignalTarget,
	LifecycleSupervisor,
	type ProcessObservation,
	type SpawnedEngineProcess,
} from "./lifecycle-supervisor";
import { writeLifecyclePresentation } from "./lifecycle-presenter";
import { lifecycleFailure } from "./lifecycle-state";
import { resolveBreadboardRunConfig, type BreadboardRunConfig, type EngineArtifact } from "./run-config";

const roots: string[] = [];
const executableSha256 = `sha256:${"a".repeat(64)}` as const;
const engineSourceSha256 = `sha256:${"b".repeat(64)}` as const;
const backendCommit = "c".repeat(40);
const artifact: EngineArtifact = {
	executablePath: "/usr/bin/false",
	argv: ["--serve"],
	executableSha256,
	engineSourceSha256,
	servedBackendCommit: backendCommit,
};
const common = { workspacePath: "/workspace", canonicalizeWorkspace: () => "/canonical/workspace", environment: {} as Record<string, string | undefined> };

function resolved(mode: "off" | "local-external" | "remote" | "local-owned", ownerExitPolicy?: "attached" | "detached"): BreadboardRunConfig {
	if (mode === "off") return resolveBreadboardRunConfig({ ...common, cli: { engineMode: "off" } });
	if (mode === "local-external") return resolveBreadboardRunConfig({ ...common, cli: { engineMode: mode, engineUrl: "http://127.0.0.1:7777" } });
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

function bindingFor(pid: number, launchId: string, overrides: Partial<LifecycleEngineBinding> = {}): LifecycleEngineBinding {
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
		process: { engineInstanceId, engineBootId, startedAt: "2026-07-17T00:00:00.000Z", startedAtUnix: 1, pid, osProcessStartToken: startToken },
		launch: { launchId, source: "supervisor" },
		artifactRevision: { engineArtifactSha256: engineSourceSha256, servedBackendCommit: backendCommit, servedBackendDirty: false },
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

interface ClientBehavior {
	readonly registerError?: Error;
	readonly drainError?: Error;
	readonly gracefulError?: Error;
	readonly hardSignalError?: Error;
	readonly gracefulOutcome?: "shutdown_started" | "rollback_permitted";
}

function boundClient(binding: LifecycleEngineBinding, calls: string[], behavior: ClientBehavior = {}): BoundLifecycleE4Client {
	return {
		binding,
		acquireOwner: async input => {
			calls.push("acquire-owner");
			if (!("bootstrapCredential" in input) || !ArrayBuffer.isView(input.bootstrapCredential) || input.bootstrapCredential.byteLength !== 32) throw new Error("bootstrap rotation missing");
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
		beginControlDrain: async () => {
			calls.push("begin-drain");
			if (behavior.drainError) throw behavior.drainError;
			return { result: "draining", drainGeneration: 2 } as never;
		},
		recordGracefulControl: async input => {
			calls.push(`graceful:${input.outcome}`);
			if (behavior.gracefulError) throw behavior.gracefulError;
			return input.outcome === "timeout" || input.outcome === "uncertain"
				? { result: "hard_signal_decision_pending", signalPermitted: true } as never
				: { result: behavior.gracefulOutcome ?? (input.outcome === "definitive_rejection" ? "rollback_permitted" : "shutdown_started") } as never;
		},
		prepareHardSignal: async () => {
			calls.push("prepare-hard-signal");
			return { result: "authorized", authorizationId: "authorization_abcdefghijklmnopqrstuvwxyz" } as never;
		},
		recordHardSignalOutcome: async input => {
			calls.push(`hard-signal:${input.outcome}`);
			if (behavior.hardSignalError) throw behavior.hardSignalError;
			return { result: input.outcome === "abandoned" ? "rollback_permitted" : input.outcome === "process_exited" ? "process_exited" : "signal_sent" } as never;
		},
		rollbackDrain: async () => {
			calls.push("rollback");
			return { result: "rolled_back" } as never;
		},
	} as BoundLifecycleE4Client;
}

async function temporaryStore(seams: ConstructorParameters<typeof LocalAuthorityStore>[1] = {}): Promise<LocalAuthorityStore> {
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
			createClient: () => { touched++; throw new Error("forbidden"); },
			resolveRemoteSecurity: async () => { touched++; return {}; },
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
			const supervisor = new LifecycleSupervisor(resolved(mode), { createClient: () => { touched++; throw new Error("must not connect"); } });
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
			const supervisor = new LifecycleSupervisor(resolved(mode), { createClient: () => ({ handshake: async () => bound }) });
			expect((await supervisor.status()).kind).toBe("observed");
			expect(calls.some(call => call.startsWith("register:"))).toBe(false);
			expect((await supervisor.connect()).kind).toBe("ready");
			expect(calls.filter(call => call.startsWith("register:"))).toHaveLength(1);
			expect((await supervisor.close({ consumerClosed: true })).kind).toBe("detached");
		}
	});

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
			const binding = bindingFor(99, "external_launch_abcdefghijklmnopqrstuvwxyz", { endpoint: "https://engine.example", launch: { launchId: "external_launch_abcdefghijklmnopqrstuvwxyz", source: "external_unmanaged" } });
			const supervisor = new LifecycleSupervisor(config, {
				resolveRemoteSecurity: async value => value.kind === "keychain-reference"
					? { bearerToken: "resolved-token" }
					: { certificatePem: "certificate", privateKeyPem: "key" },
				createClient: options => { received = options; return { handshake: async () => boundClient(binding, []) }; },
			});
			expect((await supervisor.status()).kind).toBe("observed");
			if (auth.kind === "keychain-reference") expect(received.bearerToken).toBe("resolved-token");
			else expect(typeof received.fetch).toBe("function");
		}
	});

	test("typed transport failures remain distinct", async () => {
		const cases = [
			[new LifecycleE4ClientError({ kind: "auth", status: 401, code: "auth", correlation: {}, body: "[redacted]" }), "auth-failed"],
			[new LifecycleE4ClientError({ kind: "tls", code: "tls_transport_error" }), "tls-failed"],
			[new LifecycleE4ClientError({ kind: "identity-changed", status: 409, code: "identity", correlation: {}, body: "[redacted]" }), "identity-changed"],
		] as const;
		for (const [failure, state] of cases) {
			const supervisor = new LifecycleSupervisor(resolved("remote"), { createClient: () => ({ handshake: async () => { throw failure; } }) });
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
		const adapter: LifecycleProcessAdapter = {
			spawnVerified: async (_artifact, launchId, bootstrap) => {
				spawnCount++;
				currentPid = ++nextPid;
				currentLaunch = launchId;
				processTokens.set(currentPid, `darwin:${currentPid}:1`);
				bootstrapBuffers.push(bootstrap);
				const { promise: exited, resolve } = Promise.withResolvers<number | null>();
				exitResolvers.set(currentPid, resolve);
				const pid = currentPid;
				const handle: SpawnedEngineProcess = {
					pid,
					startToken: `darwin:${pid}:1`,
					exited,
					unref: () => events.push("unref"),
					sendHardSignal: async () => {
						if (processTokens.get(pid) !== `darwin:${pid}:1`) return "abandoned";
						events.push("hard-control");
						dead.add(pid);
						resolve(0);
						return "sent";
					},
					waitForExit: async timeoutMs => {
						if (timeoutMs > 0 && gracefulExitOnWait) {
							gracefulExitOnWait = false;
							dead.add(pid);
							resolve(0);
							return true;
						}
						return timeoutMs === 0 ? dead.has(pid) : waitResults.shift() ?? dead.has(pid);
					},
				};
				handles.set(pid, handle);
				return handle;
			},
			observe: async pid => dead.has(pid)
				? ({ kind: "dead" } as ProcessObservation)
				: ({ kind: "alive", startToken: processTokens.get(pid) ?? `darwin:${pid}:unknown` } as ProcessObservation),
			controlFor: async (pid, token) => token === processTokens.get(pid) ? handles.get(pid) ?? null : null,
		};
		return {
			adapter,
			dead,
			events,
			waitResults,
			bootstrapBuffers,
			current: () => ({ pid: currentPid, launchId: currentLaunch }),
			spawnCount: () => spawnCount,
			crash: (pid = currentPid) => { dead.add(pid); exitResolvers.get(pid)?.(1); },
			rotateIdentity: (pid = currentPid) => processTokens.set(pid, `darwin:${pid}:2`),
			exitOnNextWait: () => { gracefulExitOnWait = true; },
		};
	}

	function clientFactory(process: ReturnType<typeof processHarness>, calls: string[], behavior: ClientBehavior = {}): () => LifecycleE4Client {
		return () => ({ handshake: async () => {
			const current = process.current();
			return boundClient(bindingFor(current.pid, current.launchId), calls, behavior);
		} });
	}

	test("cold start commits recoverable owner before registration and wipes exact bootstrap buffer", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await supervisor.connect()).kind).toBe("ready");
		expect(calls.slice(0, 3)).toEqual(["acquire-owner", "register:local-owned", "renew-owner"].slice(0, 2));
		expect(process.bootstrapBuffers).toHaveLength(1);
		expect([...process.bootstrapBuffers[0] as Buffer].every(byte => byte === 0)).toBe(true);
		const current = await store.readCurrent("http://127.0.0.1:7777");
		expect(current?.pid).toBe(process.current().pid);
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
		const second = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient: clientFactory(process, []) });
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

	test("terminates the exact spawned child and releases its claim on precommit handshake failure", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const failure = new LifecycleE4ClientError({ kind: "auth", status: 401, code: "unauthorized", correlation: {}, body: "[redacted]" });
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => ({ handshake: async () => { throw failure; } }),
		});
		expect((await supervisor.connect()).state.reason).toBe("auth_failed");
		expect(process.events).toContain("hard-control");
		const next = await store.withExclusiveLock("http://127.0.0.1:7777", () => store.claimStart("http://127.0.0.1:7777"));
		expect(next.kind).toBe("claimed");
	});


	test("pure local status never spawns, owns, or registers", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		let clientTouches = 0;
		const status = new LifecycleSupervisor(resolved("local-owned"), {
			store,
			process: process.adapter,
			createClient: () => { clientTouches++; throw new Error("forbidden"); },
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
		const createClient = () => ({ handshake: async () => {
			if (firstHandshake) {
				firstHandshake = false;
				entered.resolve();
				await release.promise;
			}
			const current = process.current();
			return boundClient(bindingFor(current.pid, current.launchId), calls);
		} });
		const clock = { now: Date.now, sleep: async () => { await Promise.resolve(); } };
		const first = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient, clock });
		const second = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient, clock });
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
			const prepared = await store.prepareStartClaim(endpoint, claimed.claim.token, {
				launchId,
				executableSha256: artifact.executableSha256,
				engineArtifactSha256: artifact.engineSourceSha256,
				servedBackendCommit: artifact.servedBackendCommit,
			}, { bootstrapCredential: pendingBootstrap, ownerCredential: "o".repeat(43) });
			const transfer = Buffer.from(pendingBootstrap);
			const child = await process.adapter.spawnVerified(artifact, launchId, transfer);
			transfer.fill(0);
			enginePid = child.pid;
			await store.bindStartClaimProcess(endpoint, prepared.token, child.pid, child.startToken);
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


	test("configured artifact drift rejects adoption before renew or registration", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const first = new LifecycleSupervisor(resolved("local-owned", "detached"), { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await first.connect()).kind).toBe("ready");
		expect((await first.close({ consumerClosed: true })).kind).toBe("detached");
		calls.length = 0;
		const changed = resolveBreadboardRunConfig({
			...common,
			cli: { engineMode: "local-owned" },
			selectedConfig: { engineArtifact: { ...artifact, engineSourceSha256: `sha256:${"d".repeat(64)}` } },
		});
		const adopter = new LifecycleSupervisor(changed, { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await adopter.connect()).state.reason).toBe("identity_changed");
		expect(calls).toEqual([]);
	});

	test("adopted detached policy is retained on close", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const first = new LifecycleSupervisor(resolved("local-owned", "detached"), { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await first.connect()).kind).toBe("ready");
		expect((await first.close({ consumerClosed: true })).kind).toBe("detached");
		const adopter = new LifecycleSupervisor(resolved("local-owned", "attached"), { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await adopter.connect()).kind).toBe("ready");
		expect((await adopter.close({ consumerClosed: true })).kind).toBe("detached");
		expect(calls.filter(call => call === "release-owner")).toHaveLength(2);
		expect(calls.slice(-2)).toEqual(["release-owner", "detach-client"]);
		expect(process.events.some(event => event.startsWith("graceful-control"))).toBe(false);
	});

	test("drain denial detaches requester and never signals or rolls back", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const drainConflict = new LifecycleE4ClientError({ kind: "drain-conflict", status: 409, code: "clients_live", correlation: {}, body: "[redacted]" });
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient: clientFactory(process, calls, { drainError: drainConflict }) });
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
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient: clientFactory(process, calls) });
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).state.reason).toBe("drain_recovery_failed");
		expect(calls).toContain("hard-signal:sent");
		expect(calls).not.toContain("rollback");
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
		const next = await store.withExclusiveLock("http://127.0.0.1:7777", () => store.claimStart("http://127.0.0.1:7777"));
		expect(next.kind).toBe("claimed");
	});

	test("caller abort wipes bootstrap bytes and removes the recoverable start claim", async () => {
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
		supervisor.abort();
		handshake.reject(new LifecycleE4ClientError({ kind: "caller-abort" }));
		const result = await connecting;
		expect(result.state.reason).toBe("request_aborted");
		expect([...process.bootstrapBuffers[0] as Buffer].every(byte => byte === 0)).toBe(true);
		expect(process.events).toContain("hard-control");
		expect(await store.readCurrent("http://127.0.0.1:7777")).toBeNull();
	});
	test("retains the durable claim and reports recovery when abort loses exact process identity", async () => {
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
		expect(result.state).toMatchObject({ name: "recovery-needed", reason: "process_control_failed" });
		expect(process.events).not.toContain("hard-control");
		const claim = await store.withExclusiveLock("http://127.0.0.1:7777", () => store.claimStart("http://127.0.0.1:7777"));
		expect(claim.kind).toBe("occupied");
	});


	test("records the actual hard-signal outcome only after the exact process was signaled", async () => {
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
							return { result: "authorized", authorizationId: "authorization_abcdefghijklmnopqrstuvwxyz" } as never;
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
		expect(process.events.indexOf("authorize-hard-signal")).toBeLessThan(process.events.indexOf("hard-control"));
		expect(process.events.indexOf("hard-control")).toBeLessThan(process.events.indexOf("record-hard-signal-outcome"));
	});

	test("abandons and rolls back when process identity rotates after signal authorization", async () => {
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
						recordGracefulControl: async input => {
							calls.push(`graceful:${input.outcome}`);
							if (input.outcome === "timeout") process.rotateIdentity();
							return input.outcome === "timeout"
								? { result: "hard_signal_decision_pending", signalPermitted: true } as never
								: { result: "shutdown_started" } as never;
						},
					};
				},
			}),
		});
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("ready");
		expect(calls).toContain("hard-signal:abandoned");
		expect(calls).toContain("rollback");
		expect(process.events).not.toContain("hard-control");
	});


	test("post-drain exceptions roll back before any hard signal", async () => {
		const store = await temporaryStore();
		const process = processHarness();
		const calls: string[] = [];
		const supervisor = new LifecycleSupervisor(resolved("local-owned"), { store, process: process.adapter, createClient: clientFactory(process, calls, { gracefulError: new Error("record failed") }) });
		expect((await supervisor.connect()).kind).toBe("ready");
		expect((await supervisor.stop({ consumerClosed: true })).kind).toBe("failure");
		expect(calls).toContain("rollback");
		expect(process.events.some(event => event.startsWith("hard-control"))).toBe(false);
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
		expect(states).toEqual(["draining", "restart-stopping", "restart-starting", "connecting", "handshaking", "acquiring-owner", "registering-client", "ready"]);
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
			clock: { now: () => 1_000, sleep: async milliseconds => { sleeps.push(milliseconds); } },
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
			{ closeReady: true, restoreTerminal: () => { restores++; }, signalTarget: signals },
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
				abort: () => { events.push("abort"); },
				close: async () => {
					events.push("close");
					return coordinatorDetached;
				},
			}),
			"connect",
			{ closeReady: true, restoreTerminal: () => { events.push("restore"); }, signalTarget: signals },
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
				abort: () => { events.push("abort"); },
			}),
			"connect",
			{
				restoreTerminal: () => { events.push("restore"); },
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
				abort: () => { events.push("abort"); },
				close: () => {
					events.push("close");
					closeEntered.resolve();
					return closing.promise;
				},
			}),
			"connect",
			{ closeReady: true, restoreTerminal: () => { events.push("restore"); }, signalTarget: signals },
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
		await expect(dispatchLifecycleAction(
			lifecycleController({ connect: async () => { throw new Error("synthetic secret"); } }),
			"connect",
			{ restoreTerminal: () => { restores++; }, signalTarget: signals },
		)).rejects.toThrow("synthetic secret");
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
		env: { ...Bun.env, HOME: home, BREADBOARD_ENGINE_MODE: undefined },
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
			[
				"launch",
				"--engine-mode",
				"local-owned",
				"--export",
				"test/fixtures/before-compaction.jsonl",
				exportPath,
			],
		] as const;

		const results = [];
		for (const args of cases) results.push(await runLifecycleCli([...args], home));
		for (const result of results) {
			expect(result.exitCode).toBe(0);
			expect(`${result.stdout}${result.stderr}`).not.toContain("BreadBoard engine:");
			expect(result.stderr).not.toContain("missing_engine_artifact");
		}
	});

	test("off print and protocol paths return typed unavailable without AgentSession fallback", async () => {
		const home = await temporaryLifecycleHome();
		const printResult = await runLifecycleCli(["launch", "--engine-mode", "off", "--print", "synthetic-user-echo"], home);
		const rpcResult = await runLifecycleCli(["launch", "--engine-mode", "off", "--mode", "rpc"], home);
		for (const result of [printResult, rpcResult]) {
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("BreadBoard engine: off");
			expect(result.stdout).not.toContain("synthetic-user-echo");
			expect(result.stderr).not.toContain("No models available");
		}
	});

	test("connected modes stop print and protocol paths before AgentSession", async () => {
		const home = await temporaryLifecycleHome();
		const endpoint = "http://127.0.0.1:1";
		const printResult = await runLifecycleCli(["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--print", "hello"], home);
		const rpcResult = await runLifecycleCli(["launch", "--engine-mode", "local-external", "--engine-url", endpoint, "--mode", "rpc"], home);
		for (const result of [printResult, rpcResult]) {
			expect(result.exitCode).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain("BreadBoard engine: external-disconnected (endpoint_unreachable)");
			expect(result.stderr).not.toContain("No models available");
		}
	});
});
