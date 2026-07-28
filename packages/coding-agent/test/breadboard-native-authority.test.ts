import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeSessionReplayDigest, type PermissionRequestedPayload, type SessionSnapshot } from "@breadboard/sdk";
import type { AgentEvent, StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type {
	E4AgentStreamBridgeOptions,
	E4PermissionHandler,
} from "@oh-my-pi/pi-coding-agent/breadboard/e4-agent-stream";
import {
	LIFECYCLE_FAILURE_STATES,
	type LifecycleState,
	lifecycleFailure,
} from "@oh-my-pi/pi-coding-agent/breadboard/lifecycle/lifecycle-state";
import {
	type LifecycleDispatchResult,
	LifecycleSupervisor,
} from "@oh-my-pi/pi-coding-agent/breadboard/lifecycle/lifecycle-supervisor";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import Engine from "@oh-my-pi/pi-coding-agent/commands/engine";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	BreadboardSessionTransitionError,
	createBreadboardPermissionHandler,
	prepareBreadboardRuntime,
	prepareConnectedBreadboardRuntime,
	resolveBreadboardBackendModel,
	resolveBreadboardSessionTarget,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { SessionTransitionGuard, SessionTransitionPlan } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const BREADBOARD_MODEL = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!BREADBOARD_MODEL) throw new Error("bundled BreadBoard authority test model missing");
const CLI_SELECTED_MODEL = getBundledModel("openai", "gpt-5.2");
if (!CLI_SELECTED_MODEL) throw new Error("bundled CLI-selected test model missing");
const BREADBOARD_MODEL_SELECTOR = `${BREADBOARD_MODEL.provider}/${BREADBOARD_MODEL.id}`;
const TEST_RUNTIME_AUTHORITY = {
	modelRegistry: { getAll: () => [BREADBOARD_MODEL] },
	requestPermission: async () => "cancel" as const,
	emitAgentEvent: async () => {},
	releaseAgentEvent: () => {},
};
const BINDING_SCHEMA_VERSION = "breadboard.session-binding.v3" as const;
const REPLAY_CONFIGURATION_DIGEST = "sha256:test-replay-configuration";
const REPLAY_CONTRACT_DIGEST = "sha256:test-replay-snapshot";

function sessionBinding(
	sessionId: string,
	sequence = 0,
	eventId: string | null = sequence === 0 ? null : `event-${sequence}`,
	ownedSubmissions: readonly {
		readonly clientMessageId: string;
		readonly inputId: string;
		readonly turnId: string;
	}[] = [],
) {
	return {
		schemaVersion: BINDING_SCHEMA_VERSION,
		sessionId,
		replayConfigurationDigest: REPLAY_CONFIGURATION_DIGEST,
		cursor: { eventId, sequence },
		ownedSubmissions,
	};
}

function runtimeSnapshot(sessionId: string, overrides: Record<string, unknown> = {}) {
	return {
		sessionId,
		model: BREADBOARD_MODEL_SELECTOR,
		replayRetention: {
			maxEvents: 100_000,
			maxAgeMs: 86_400_000,
			configurationDigest: REPLAY_CONFIGURATION_DIGEST,
		},
		earliestRetainedSequence: null,
		earliestRetainedEventId: null,
		headSequence: 0,
		headEventId: null,
		retainedHistory: "complete",
		sessionReplayContractDigest: REPLAY_CONTRACT_DIGEST,
		...overrides,
	} as never;
}
type ActiveBreadboardMode = "local-owned" | "local-external" | "remote";
type NonReadyLifecycleKind = Exclude<LifecycleDispatchResult["kind"], "ready">;

const ACTIVE_BREADBOARD_MODES: readonly ActiveBreadboardMode[] = ["local-owned", "local-external", "remote"];
const NON_READY_LIFECYCLE_KINDS: readonly NonReadyLifecycleKind[] = [
	"off",
	"observed",
	"detached",
	"stopped",
	"failure",
];

function activeLifecycleSettings(mode: ActiveBreadboardMode): Settings {
	return Settings.isolated({
		"breadboard.engineMode": mode,
		"breadboard.sessionConfigPath": "/tmp/session.yml",
		...(mode === "local-owned"
			? {
					"breadboard.engineArtifact": {
						executablePath: "/usr/bin/false",
						argv: [],
						executableSha256: `sha256:${"a".repeat(64)}`,
						engineSourceSha256: `sha256:${"b".repeat(64)}`,
						servedBackendCommit: "c".repeat(40),
					},
				}
			: {}),
		...(mode === "local-external" ? { "breadboard.baseUrl": "http://127.0.0.1:7777" } : {}),
		...(mode === "remote"
			? {
					"breadboard.baseUrl": "https://engine.example",
					"breadboard.auth": { kind: "keychain-reference", reference: "breadboard/test-token" },
				}
			: {}),
		"marketplace.autoUpdate": "off",
		"startup.checkUpdate": false,
		"startup.showSplash": false,
	} as never);
}

function nonReadyLifecycleResult(
	mode: ActiveBreadboardMode,
	kind: NonReadyLifecycleKind,
): Exclude<LifecycleDispatchResult, { readonly kind: "ready" }> {
	switch (kind) {
		case "off":
			return { kind, state: { name: "off", mode: "off", attempt: 0, reason: "engine_mode_off" } };
		case "observed":
			return {
				kind,
				state: { name: "compatible-observed", mode, attempt: 0 },
				handle: { mode, binding: { engineInstanceId: `engine-${mode}` } },
			} as Exclude<LifecycleDispatchResult, { readonly kind: "ready" }>;
		case "detached":
			return { kind, state: { name: "detached", mode, attempt: 0 } };
		case "stopped":
			return { kind, state: { name: "stopped", mode, attempt: 0 } };
		case "failure":
			return lifecycleFailure(mode, "failed", "endpoint_unreachable") as Exclude<
				LifecycleDispatchResult,
				{ readonly kind: "ready" }
			>;
	}
}

type LifecycleFailureResult = Extract<LifecycleDispatchResult, { readonly kind: "failure" }>;

const RENEWAL_LOSS_FAILURES: ReadonlyArray<readonly [ActiveBreadboardMode, LifecycleFailureResult]> = [
	[
		"local-owned",
		lifecycleFailure("local-owned", "owner-lease-expired", "owner_lease_expired") as LifecycleFailureResult,
	],
	[
		"local-external",
		lifecycleFailure("local-external", "registration-expired", "registration_expired") as LifecycleFailureResult,
	],
	["remote", lifecycleFailure("remote", "registration-expired", "registration_expired") as LifecycleFailureResult],
];

function lifecycleStateSignalHarness() {
	let failure: LifecycleFailureResult["state"] | undefined;
	const listeners = new Set<(state: LifecycleState) => void>();
	return {
		signal: {
			failure: () => failure,
			subscribe(listener: (state: LifecycleState) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		emit(state: LifecycleState) {
			for (const listener of listeners) listener(state);
		},
		emitFailure(result: LifecycleFailureResult) {
			if (!LIFECYCLE_FAILURE_STATES.includes(result.state.name))
				throw new Error("expected canonical lifecycle failure");
			failure = result.state;
			for (const listener of listeners) listener(result.state);
		},
	};
}
const PERMISSION_REQUEST = {
	requestId: "permission-1",
	tool: "edit",
	kind: "write",
	summary: "Update a source file",
	defaultScope: null,
	rewindable: false,
} as unknown as PermissionRequestedPayload;

describe("BreadBoard native interactive authority", () => {
	test("injects the BreadBoard turn transport into the ordinary OMP AgentSession path", async () => {
		using tempDir = TempDir.createSync("@breadboard-native-authority-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const parsed = parseArgs(["--model", `${CLI_SELECTED_MODEL.provider}/${CLI_SELECTED_MODEL.id}`]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		const breadboardStream: StreamFn = () => new AssistantMessageEventStream();
		const closeRuntime = mock(async () => {});
		let prepared = false;
		let observedOptions: CreateAgentSessionOptions | undefined;

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				prepareBreadboardRuntime: async () => {
					prepared = true;
					return {
						stream: breadboardStream,
						sessionId: "session-1",
						model: BREADBOARD_MODEL,
						activate: async () => {},
						start() {},
						close: closeRuntime,
					};
				},
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("native-authority-options-observed");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "native-authority-options-observed") throw error;
		} finally {
			authStorage.close();
		}

		expect(prepared).toBe(true);
		expect(observedOptions?.mainStreamFn).toBe(breadboardStream);
		expect(observedOptions?.hasUI).toBe(true);
		expect(observedOptions?.model).toBe(BREADBOARD_MODEL);
		expect(observedOptions?.model).not.toBe(CLI_SELECTED_MODEL);
		expect(closeRuntime).toHaveBeenCalledTimes(1);
	});

	for (const mode of ACTIVE_BREADBOARD_MODES) {
		for (const outcomeKind of NON_READY_LIFECYCLE_KINDS) {
			test(`terminates ${mode} interactive startup after a ${outcomeKind} lifecycle outcome`, async () => {
				using tempDir = TempDir.createSync(`@breadboard-${mode}-${outcomeKind}-`);
				const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
				const parsed = parseArgs(["--engine-mode", mode]);
				parsed.noExtensions = true;
				parsed.noSkills = true;
				parsed.noRules = true;
				parsed.noTools = true;
				parsed.noLsp = true;
				parsed.sessionDir = tempDir.join("sessions");
				const manager = SessionManager.create(tempDir.path(), parsed.sessionDir);
				const connect = spyOn(LifecycleSupervisor.prototype, "connect").mockImplementation(async () =>
					nonReadyLifecycleResult(mode, outcomeKind),
				);
				const close = spyOn(LifecycleSupervisor.prototype, "close").mockImplementation(
					async () =>
						({
							kind: "detached",
							state: { name: "detached", mode, attempt: 0 },
						}) as LifecycleDispatchResult,
				);
				const createAgentSession = mock(
					async () =>
						({
							session: {
								agent: { emitExternalEvent() {} },
								sessionManager: manager,
								setSessionTransitionGuard() {},
							},
							setToolUIContext() {},
						}) as never,
				);
				const runInteractiveMode = mock(async () => {});
				const originalStdoutWrite = process.stdout.write;
				const previousExitCode = process.exitCode ?? 0;
				let stdout = "";
				process.stdout.write = ((chunk: string | Uint8Array): boolean => {
					stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
					return true;
				}) as typeof process.stdout.write;

				try {
					await runRootCommand(parsed, [], {
						discoverAuthStorage: async () => authStorage,
						settings: activeLifecycleSettings(mode),
						createAgentSession: createAgentSession as never,
						runInteractiveMode: runInteractiveMode as never,
					});
					expect(process.exitCode).toBe(1);
					expect(stdout).toContain("BreadBoard engine:");
					expect(connect).toHaveBeenCalledTimes(1);
					expect(close).toHaveBeenCalledTimes(1);
					expect(createAgentSession).not.toHaveBeenCalled();
					expect(runInteractiveMode).not.toHaveBeenCalled();
				} finally {
					process.stdout.write = originalStdoutWrite;
					process.exitCode = previousExitCode;
					close.mockRestore();
					connect.mockRestore();
					await manager.close();
					authStorage.close();
				}
			});
		}
	}

	test("preserves native provider selection when the effective BreadBoard mode is off", async () => {
		using tempDir = TempDir.createSync("@breadboard-off-native-provider-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const settings = Settings.isolated({
			"breadboard.engineMode": "local-external",
			"breadboard.sessionConfigPath": "/tmp/session.yml",
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		} as never);
		const parsed = parseArgs([
			"--engine-mode",
			"off",
			"--provider",
			CLI_SELECTED_MODEL.provider,
			"--model",
			CLI_SELECTED_MODEL.id,
		]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		const connect = spyOn(LifecycleSupervisor.prototype, "connect");
		let observedOptions: CreateAgentSessionOptions | undefined;

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("off-mode-native-options-observed");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "off-mode-native-options-observed") throw error;
		} finally {
			connect.mockRestore();
			authStorage.close();
		}

		expect(connect).not.toHaveBeenCalled();
		expect(observedOptions?.mainStreamFn).toBeUndefined();
		expect(observedOptions?.model).toMatchObject({
			id: CLI_SELECTED_MODEL.id,
			provider: CLI_SELECTED_MODEL.provider,
		});
	});

	test("continues through the native AgentSession and InteractiveMode path when BreadBoard mode is off", async () => {
		using tempDir = TempDir.createSync("@breadboard-off-transition-guard-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const settings = Settings.isolated({
			"breadboard.engineMode": "off",
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		} as never);
		const parsed = parseArgs(["--engine-mode", "off"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		const manager = SessionManager.create(tempDir.path(), parsed.sessionDir);
		const setSessionTransitionGuard = mock((_guard: SessionTransitionGuard | null) => {});
		const createAgentSession = mock(
			async () =>
				({
					session: {
						agent: { emitExternalEvent() {} },
						sessionManager: manager,
						setSessionTransitionGuard,
					},
					setToolUIContext() {},
				}) as never,
		);
		const runInteractiveMode = mock(async () => {});

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: createAgentSession as never,
				runInteractiveMode: runInteractiveMode as never,
			});
		} finally {
			await manager.close();
			authStorage.close();
		}

		expect(createAgentSession).toHaveBeenCalledTimes(1);
		expect(runInteractiveMode).toHaveBeenCalledTimes(1);
		expect(setSessionTransitionGuard).not.toHaveBeenCalled();
	});

	test("closes the transferred runtime when interactive mode returns", async () => {
		using tempDir = TempDir.createSync("@breadboard-native-return-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");

		const manager = SessionManager.create(tempDir.path(), parsed.sessionDir);
		const closeRuntime = mock(async () => {});
		let requestPermission: E4PermissionHandler | undefined;
		let permissionDecision: string | undefined;
		let emitProjection: ((event: AgentEvent, idempotencyKey: string) => Promise<void>) | undefined;
		let releaseProjection: ((idempotencyKey: string) => void) | undefined;
		const emitExternalEventAndWait = mock(async () => {});
		const releaseExternalEvent = mock(() => {});
		const select = mock(async () => "Allow");
		const uiContext = { select } as never;
		const setToolUIContext = mock(() => {});
		const startRuntime = mock(() => {});
		let transitionGuard: SessionTransitionGuard | undefined;
		const setSessionTransitionGuard = mock((guard: SessionTransitionGuard | null) => {
			transitionGuard = guard ?? undefined;
		});
		const runInteractiveMode = mock(async (...args: unknown[]) => {
			const captureUIContext = args[6] as (uiContext: never, hasUI: boolean) => void;
			expect(startRuntime).not.toHaveBeenCalled();
			captureUIContext(uiContext, true);
			expect(startRuntime).toHaveBeenCalledTimes(1);
			permissionDecision = await requestPermission!(PERMISSION_REQUEST, new AbortController().signal);
			await emitProjection!({ type: "done" } as never, "projection-key");
			releaseProjection!("projection-key");
		});

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				prepareBreadboardRuntime: async (
					_parsed,
					emitAgentEvent,
					authority,
					_settings,
					_manager,
					releaseAgentEvent,
				) => {
					requestPermission = authority.requestPermission;
					emitProjection = async (event, idempotencyKey) => {
						await emitAgentEvent(event, idempotencyKey);
					};
					releaseProjection = releaseAgentEvent;
					return {
						stream: () => new AssistantMessageEventStream(),
						sessionId: "session-return",
						model: BREADBOARD_MODEL,
						activate: async (sessionManager: SessionManager) => {
							sessionManager.appendCustomEntry(
								BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
								sessionBinding("session-return"),
							);
							await sessionManager.flush();
						},
						start: startRuntime,
						close: closeRuntime,
					};
				},
				createAgentSession: async () =>
					({
						session: {
							agent: { emitExternalEventAndWait, releaseExternalEvent },
							sessionManager: manager,
							setSessionTransitionGuard,
						},
						setToolUIContext,
					}) as never,
				runInteractiveMode: runInteractiveMode as never,
			});
		} finally {
			await manager.close();
			authStorage.close();
		}

		expect(runInteractiveMode).toHaveBeenCalledTimes(1);
		expect(closeRuntime).toHaveBeenCalledTimes(1);
		expect(permissionDecision).toBe("allow");
		expect(select).toHaveBeenCalledTimes(1);
		expect(setToolUIContext).toHaveBeenCalledWith(uiContext, true);
		expect(emitExternalEventAndWait).toHaveBeenCalledWith({ type: "done" }, "projection-key");
		expect(releaseExternalEvent).toHaveBeenCalledWith("projection-key");
		const bindingEntry = manager
			.getBranch()
			.find(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE);
		expect(bindingEntry?.type === "custom" ? bindingEntry.data : undefined).toEqual(sessionBinding("session-return"));
		expect(setSessionTransitionGuard).toHaveBeenCalledTimes(1);
		if (!transitionGuard) throw new Error("Expected BreadBoard session transition guard");
		for (const [plan, operation] of [
			[{ reason: "new" }, "start a new OMP session"],
			[{ reason: "resume", targetSessionFile: "/tmp/target.jsonl" }, 'switch to OMP session "/tmp/target.jsonl"'],
			[{ reason: "fork" }, "fork the current OMP session"],
			[{ reason: "handoff" }, "hand off to a new OMP session"],
			[{ reason: "branch", targetEntryId: "entry-branch" }, 'branch the OMP session from entry "entry-branch"'],
			[{ reason: "branchFromBtw", targetEntryId: "entry-btw" }, 'branch /btw from OMP entry "entry-btw"'],
			[
				{ reason: "navigateTree", targetEntryId: "entry-tree" },
				'navigate the OMP session tree to entry "entry-tree"',
			],
		] satisfies Array<[SessionTransitionPlan, string]>) {
			let failure: unknown;
			try {
				await transitionGuard(plan);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(BreadboardSessionTransitionError);
			expect(failure).toHaveProperty(
				"message",
				`BreadBoard cannot ${operation} while the current E4 session is bound to this OMP transcript; the current E4 SDK cannot atomically rebind the bridge to the requested transcript.`,
			);
			if (plan.reason === "handoff") {
				const message = (failure as Error).message;
				expect(message).not.toContain("session-return");
				const privateSessionId = manager.getSessionId();
				if (privateSessionId) expect(message).not.toContain(privateSessionId);
				const privateSessionFile = manager.getSessionFile();
				if (privateSessionFile) expect(message).not.toContain(privateSessionFile);
			}
		}
	});

	test("closes the transferred runtime when interactive mode throws", async () => {
		using tempDir = TempDir.createSync("@breadboard-native-throw-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");

		const manager = SessionManager.create(tempDir.path(), parsed.sessionDir);
		const closeRuntime = mock(async () => {});
		const runInteractiveMode = mock(async () => {
			throw new Error("interactive-mode-failure");
		});

		try {
			await expect(
				runRootCommand(parsed, [], {
					discoverAuthStorage: async () => authStorage,
					settings,
					prepareBreadboardRuntime: async () => ({
						stream: () => new AssistantMessageEventStream(),
						sessionId: "session-throw",
						model: BREADBOARD_MODEL,
						activate: async () => {},
						start() {},
						close: closeRuntime,
					}),
					createAgentSession: async () =>
						({
							session: {
								agent: { emitExternalEvent() {} },
								sessionManager: manager,
								setSessionTransitionGuard() {},
							},
							setToolUIContext() {},
						}) as never,
					runInteractiveMode: runInteractiveMode as never,
				}),
			).rejects.toThrow("interactive-mode-failure");
		} finally {
			await manager.close();
			authStorage.close();
		}

		expect(runInteractiveMode).toHaveBeenCalledTimes(1);
		expect(closeRuntime).toHaveBeenCalledTimes(1);
	});

	test("closes the transferred runtime when session creation fails", async () => {
		using tempDir = TempDir.createSync("@breadboard-native-create-failure-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		const closeRuntime = mock(async () => {});

		try {
			await expect(
				runRootCommand(parsed, [], {
					discoverAuthStorage: async () => authStorage,
					settings,
					prepareBreadboardRuntime: async () => ({
						stream: () => new AssistantMessageEventStream(),
						sessionId: "session-create-failure",
						model: BREADBOARD_MODEL,
						activate: async () => {},
						start() {},
						close: closeRuntime,
					}),
					createAgentSession: async () => {
						throw new Error("post-transfer-create-failure");
					},
				}),
			).rejects.toThrow("post-transfer-create-failure");
		} finally {
			authStorage.close();
		}

		expect(closeRuntime).toHaveBeenCalledTimes(1);
	});
	test("fails loudly instead of dropping an agent event before AgentSession exists", async () => {
		using tempDir = TempDir.createSync("@breadboard-pre-session-event-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		let eventFailure: unknown;
		const createAgentSession = mock(async () => {
			throw new Error("AgentSession must not be created after pre-activation event");
		});
		const previousExitCode = process.exitCode;

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({
					"marketplace.autoUpdate": "off",
					"startup.checkUpdate": false,
					"startup.showSplash": false,
				}),
				prepareBreadboardRuntime: async (_parsed, emitAgentEvent) => {
					try {
						await emitAgentEvent({ type: "done" } as never, "event-before-session");
					} catch (error) {
						eventFailure = error;
					}
					throw new Error("stop after invariant probe");
				},
				createAgentSession: createAgentSession as never,
			});
			expect(eventFailure).toHaveProperty(
				"message",
				"BreadBoard emitted an agent event before AgentSession activation",
			);
			expect(createAgentSession).not.toHaveBeenCalled();
		} finally {
			process.exitCode = previousExitCode;
			authStorage.close();
		}
	});

	test("closes the prepared runtime and does not enter interactive mode when activation fails", async () => {
		using tempDir = TempDir.createSync("@breadboard-activation-startup-failure-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		const closeRuntime = mock(async () => {});
		const runInteractiveMode = mock(async () => {});
		const disposeSession = mock(async () => {});

		try {
			await expect(
				runRootCommand(parsed, [], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({
						"marketplace.autoUpdate": "off",
						"startup.checkUpdate": false,
						"startup.showSplash": false,
					}),
					prepareBreadboardRuntime: async () => ({
						stream: () => new AssistantMessageEventStream(),
						sessionId: "activation-failure",
						model: BREADBOARD_MODEL,
						activate: async () => {
							throw new Error("activation failed");
						},
						start() {},
						close: closeRuntime,
					}),
					createAgentSession: async () =>
						({
							session: {
								agent: { emitExternalEventAndWait: async () => {}, releaseExternalEvent() {} },
								sessionManager: manager,
								setSessionTransitionGuard() {},
								dispose: disposeSession,
							},
							setToolUIContext() {},
						}) as never,
					runInteractiveMode: runInteractiveMode as never,
				}),
			).rejects.toThrow("activation failed");
			expect(closeRuntime).toHaveBeenCalledTimes(1);
			expect(disposeSession).toHaveBeenCalledTimes(1);
			expect(runInteractiveMode).not.toHaveBeenCalled();
		} finally {
			await manager.close();
			authStorage.close();
		}
	});

	test("presents a typed activation failure and returns without entering interactive mode", async () => {
		using tempDir = TempDir.createSync("@breadboard-typed-activation-failure-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const parsed = parseArgs([]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.join("sessions");
		const closeRuntime = mock(async () => {});
		const runInteractiveMode = mock(async () => {});
		const disposeSession = mock(async () => {});
		const stderr: string[] = [];
		const stderrWrite = spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;

		try {
			process.exitCode = undefined;
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({
					"marketplace.autoUpdate": "off",
					"startup.checkUpdate": false,
					"startup.showSplash": false,
				}),
				prepareBreadboardRuntime: async () => ({
					stream: () => new AssistantMessageEventStream(),
					sessionId: "typed-activation-failure",
					model: BREADBOARD_MODEL,
					activate: async () => {
						throw new BreadboardSessionTransitionError("activation binding conflict");
					},
					start() {},
					close: closeRuntime,
				}),
				createAgentSession: async () =>
					({
						session: {
							agent: { emitExternalEventAndWait: async () => {}, releaseExternalEvent() {} },
							sessionManager: manager,
							setSessionTransitionGuard() {},
							dispose: disposeSession,
						},
						setToolUIContext() {},
					}) as never,
				runInteractiveMode: runInteractiveMode as never,
			});

			expect(Number(process.exitCode)).toBe(1);
			expect(stderr.join("")).toContain(
				"BreadBoard session transition error [unsupported_resume_transition]: activation binding conflict",
			);
			expect(closeRuntime).toHaveBeenCalledTimes(1);
			expect(disposeSession).toHaveBeenCalledTimes(1);
			expect(runInteractiveMode).not.toHaveBeenCalled();
		} finally {
			process.exitCode = previousExitCode;
			stderrWrite.mockRestore();
			await manager.close();
			authStorage.close();
		}
	});
});
describe("BreadBoard runtime preparation ownership", () => {
	test("closes the lifecycle supervisor once when opening the canonical session fails", async () => {
		const closeSupervisor = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () => {
					throw new Error("open failed");
				},
				emitAgentEvent: async () => {},
			}),
		).rejects.toThrow("open failed");

		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("closes the opened session and lifecycle supervisor once when snapshotting fails", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "snapshot-failure",
						snapshot: async () => {
							throw new Error("snapshot failed");
						},
						close: closeSession,
					}) as never,
				emitAgentEvent: async () => {},
			}),
		).rejects.toThrow("snapshot failed");

		expect(closeSession).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("closes the opened session and lifecycle supervisor once when bridge setup fails", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "bridge-failure",
						snapshot: async () => runtimeSnapshot("bridge-failure"),
						close: closeSession,
					}) as never,
				createBridge: () => {
					throw new Error("bridge failed");
				},
				emitAgentEvent: async () => {},
			}),
		).rejects.toThrow("bridge failed");

		expect(closeSession).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("closes the bridge and lifecycle supervisor when cleanup registration fails", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});
		const closeBridge = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "registration-failure",
						snapshot: async () => runtimeSnapshot("registration-failure"),
						close: closeSession,
					}) as never,
				createBridge: () => ({ stream: () => new AssistantMessageEventStream(), start() {}, close: closeBridge }),
				registerCleanup: () => {
					throw new Error("registration failed");
				},
				emitAgentEvent: async () => {},
			}),
		).rejects.toThrow("registration failed");

		expect(closeBridge).toHaveBeenCalledTimes(1);
		expect(closeSession).not.toHaveBeenCalled();
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("transfers lifecycle ownership to one idempotent close handle after successful setup", async () => {
		const closeSupervisor = mock(async () => {});
		const closeBridge = mock(async () => {});
		const cancelCleanup = mock(() => {});
		let bridgeModel: unknown;
		let bridgeRequestPermission: unknown;

		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			closeSupervisor,
			openSession: async () =>
				({
					sessionId: "ready",
					snapshot: async () => runtimeSnapshot("ready"),
				}) as never,
			createBridge: options => {
				bridgeModel = options.modelPolicy?.model;
				bridgeRequestPermission = options.requestPermission;
				return { stream: () => new AssistantMessageEventStream(), start() {}, close: closeBridge };
			},
			registerCleanup: () => cancelCleanup,
			emitAgentEvent: async () => {},
		});

		expect(closeSupervisor).not.toHaveBeenCalled();
		await prepared.close();
		await prepared.close();
		expect(cancelCleanup).toHaveBeenCalledTimes(1);
		expect(prepared.model).toBe(BREADBOARD_MODEL);
		expect(bridgeModel).toBe(BREADBOARD_MODEL);
		expect(bridgeRequestPermission).toBe(TEST_RUNTIME_AUTHORITY.requestPermission);
		expect(closeBridge).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test.each(RENEWAL_LOSS_FAILURES)(
		"fails %s preparation when renewal authority is lost before bridge construction",
		async (_mode, result) => {
			const lifecycle = lifecycleStateSignalHarness();
			const snapshotStarted = Promise.withResolvers<void>();
			const releaseSnapshot = Promise.withResolvers<void>();
			const closeSession = mock(async () => {});
			const closeSupervisor = mock(async () => {});
			const createBridge = mock(() => {
				throw new Error("bridge must not be created after lifecycle authority loss");
			});
			const onLifecycleFailure = mock(() => {});

			const preparation = prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "renewal-loss-before-bridge",
						snapshot: async () => {
							snapshotStarted.resolve();
							await releaseSnapshot.promise;
							return runtimeSnapshot("renewal-loss-before-bridge");
						},
						close: closeSession,
					}) as never,
				createBridge,
				emitAgentEvent: async () => {},
				lifecycleStateSignal: lifecycle.signal,
				onLifecycleFailure,
			});
			await snapshotStarted.promise;
			lifecycle.emitFailure(result);
			releaseSnapshot.resolve();

			await expect(preparation).rejects.toMatchObject({
				name: "BreadboardLifecycleStartupError",
				result: { kind: "failure", state: { name: result.state.name, reason: result.state.reason } },
			});
			expect(createBridge).not.toHaveBeenCalled();
			expect(onLifecycleFailure).toHaveBeenCalledTimes(1);
			expect(closeSession).toHaveBeenCalledTimes(1);
			expect(closeSupervisor).toHaveBeenCalledTimes(1);
		},
	);

	test.each(RENEWAL_LOSS_FAILURES)(
		"invalidates the %s runtime when renewal authority is lost after ready",
		async (_mode, result) => {
			const lifecycle = lifecycleStateSignalHarness();
			const cleanupFinished = Promise.withResolvers<void>();
			const closeSupervisor = mock(async () => {
				cleanupFinished.resolve();
			});
			const closeBridge = mock(async () => {});
			const cancelCleanup = mock(() => {});
			const onLifecycleFailure = mock(() => {});
			const prepared = await prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "renewal-loss-after-ready",
						snapshot: async () => runtimeSnapshot("renewal-loss-after-ready"),
					}) as never,
				createBridge: () => ({ stream: () => new AssistantMessageEventStream(), start() {}, close: closeBridge }),
				registerCleanup: () => cancelCleanup,
				emitAgentEvent: async () => {},
				lifecycleStateSignal: lifecycle.signal,
				onLifecycleFailure,
			});

			lifecycle.emitFailure(result);
			await cleanupFinished.promise;
			await prepared.close();

			expect(onLifecycleFailure).toHaveBeenCalledTimes(1);
			expect(cancelCleanup).toHaveBeenCalledTimes(1);
			expect(closeBridge).toHaveBeenCalledTimes(1);
			expect(closeSupervisor).toHaveBeenCalledTimes(1);
		},
	);

	test("normal lifecycle transitions do not invalidate the runtime before normal shutdown", async () => {
		const lifecycle = lifecycleStateSignalHarness();
		const closeSupervisor = mock(async () => {});
		const closeBridge = mock(async () => {});
		const onLifecycleFailure = mock(() => {});
		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			closeSupervisor,
			openSession: async () =>
				({
					sessionId: "normal-shutdown",
					snapshot: async () => runtimeSnapshot("normal-shutdown"),
				}) as never,
			createBridge: () => ({ stream: () => new AssistantMessageEventStream(), start() {}, close: closeBridge }),
			registerCleanup: () => () => {},
			emitAgentEvent: async () => {},
			lifecycleStateSignal: lifecycle.signal,
			onLifecycleFailure,
		});

		for (const name of ["connecting", "ready", "stopping", "detached"] as const) {
			lifecycle.emit({ name, mode: "local-owned", attempt: 0 });
		}
		expect(closeBridge).not.toHaveBeenCalled();
		expect(closeSupervisor).not.toHaveBeenCalled();
		expect(onLifecycleFailure).not.toHaveBeenCalled();

		await prepared.close();
		expect(closeBridge).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});
});

describe("BreadBoard durable session activation", () => {
	test("persists the exact fresh binding, scans receipts, starts once, and durably advances a monotonic cursor", async () => {
		using tempDir = TempDir.createSync("@breadboard-durable-activation-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		manager.appendMessage({
			role: "custom",
			customType: "projection-receipt",
			content: "",
			display: false,
			details: { breadboardProjectionEventId: "event-2" },
		} as never);
		const flush = spyOn(manager, "flush");
		const getBranch = spyOn(manager, "getBranch");
		const start = mock(() => {});
		const closeBridge = mock(async () => {});
		let bridgeOptions: E4AgentStreamBridgeOptions | undefined;
		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			closeSupervisor: async () => {},
			openSession: async () =>
				({
					sessionId: "fresh-session",
					snapshot: async () =>
						runtimeSnapshot("fresh-session", {
							earliestRetainedSequence: 1,
							earliestRetainedEventId: "event-1",
							headSequence: 2,
							headEventId: "event-2",
						}),
				}) as never,
			createBridge: options => {
				bridgeOptions = options;
				return { stream: () => new AssistantMessageEventStream(), start, close: closeBridge };
			},
			registerCleanup: () => () => {},
		});

		try {
			expect(start).not.toHaveBeenCalled();
			expect(bridgeOptions?.durableCursor).toEqual({ eventId: "event-2", sequence: 2 });
			await prepared.activate(manager);
			await prepared.activate(manager);
			expect(start).not.toHaveBeenCalled();
			prepared.start();
			prepared.start();
			expect(start).toHaveBeenCalledTimes(1);
			expect(bridgeOptions?.projectionReceiptEventIds?.has("event-2")).toBe(true);
			const bindings = manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.type === "custom" ? bindings[0].data : undefined).toEqual(
				sessionBinding("fresh-session", 2, "event-2"),
			);
			const ownedSubmission = {
				clientMessageId: "client-message-owned",
				inputId: "input-owned",
				turnId: "turn-owned",
			};
			await bridgeOptions?.submissionOwned(ownedSubmission);
			const ownershipBinding = manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE)
				.at(-1);
			expect(ownershipBinding?.type === "custom" ? ownershipBinding.data : undefined).toEqual(
				sessionBinding("fresh-session", 2, "event-2", [ownedSubmission]),
			);
			const branchScansBeforeProjection = getBranch.mock.calls.length;

			await bridgeOptions?.projectionCommitted({ eventId: "event-3", sequence: 3 }, [ownedSubmission]);
			expect(getBranch).toHaveBeenCalledTimes(branchScansBeforeProjection);
			const latest = manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE)
				.at(-1);
			expect(latest?.type === "custom" ? latest.data : undefined).toEqual(
				sessionBinding("fresh-session", 3, "event-3", [ownedSubmission]),
			);
			expect(flush).toHaveBeenCalledTimes(3);
			await expect(
				bridgeOptions?.projectionCommitted({ eventId: "event-2", sequence: 2 }, [ownedSubmission]),
			).rejects.toBeInstanceOf(BreadboardSessionTransitionError);
			flush.mockImplementation(async () => {
				throw new Error("cursor flush failed");
			});
			await expect(
				bridgeOptions?.projectionCommitted({ eventId: "event-4", sequence: 4 }, [ownedSubmission]),
			).rejects.toThrow("cursor flush failed");
			flush.mockRestore();
			getBranch.mockRestore();
			await expect(
				bridgeOptions?.projectionCommitted({ eventId: "event-4", sequence: 4 }, []),
			).resolves.toBeUndefined();
			const finalBinding = manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE)
				.at(-1);
			expect(finalBinding?.type === "custom" ? finalBinding.data : undefined).toEqual(
				sessionBinding("fresh-session", 4, "event-4"),
			);
		} finally {
			await prepared.close();
			await manager.close();
		}
	});

	test("hands the full validated resume cursor to the inert bridge", async () => {
		using tempDir = TempDir.createSync("@breadboard-durable-resume-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const ownedResumeSubmission = {
			clientMessageId: "resume-client-message",
			inputId: "resume-input",
			turnId: "resume-turn",
		};
		const binding = sessionBinding("resume-session", 2, "event-2", [ownedResumeSubmission]);
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, binding);
		await manager.flush();
		const start = mock(() => {});
		const advancedReplayFacts: SessionSnapshot = runtimeSnapshot("resume-session", {
			earliestRetainedSequence: 2,
			earliestRetainedEventId: "event-2",
			headSequence: 4,
			headEventId: "event-4",
			retainedHistory: "partial",
		});
		const advancedReplayContractDigest = await computeSessionReplayDigest({
			replayRetention: advancedReplayFacts.replayRetention,
			earliestRetainedSequence: advancedReplayFacts.earliestRetainedSequence,
			earliestRetainedEventId: advancedReplayFacts.earliestRetainedEventId,
			headSequence: advancedReplayFacts.headSequence,
			headEventId: advancedReplayFacts.headEventId,
			retainedHistory: advancedReplayFacts.retainedHistory,
		});
		const advancedSnapshot = runtimeSnapshot("resume-session", {
			earliestRetainedSequence: 2,
			earliestRetainedEventId: "event-2",
			headSequence: 4,
			headEventId: "event-4",
			retainedHistory: "partial",
			sessionReplayContractDigest: advancedReplayContractDigest,
		});
		let bridgeOptions: E4AgentStreamBridgeOptions | undefined;
		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			sessionBinding: binding,
			closeSupervisor: async () => {},
			openSession: async () =>
				({
					sessionId: "resume-session",
					snapshot: async () => advancedSnapshot,
				}) as never,
			createBridge: options => {
				bridgeOptions = options;
				return {
					stream: () => new AssistantMessageEventStream(),
					start,
					close: async () => {},
				};
			},
			registerCleanup: () => () => {},
		});

		try {
			expect(bridgeOptions?.durableCursor).toEqual({ eventId: "event-2", sequence: 2 });
			expect(bridgeOptions?.ownedSubmissions).toEqual([ownedResumeSubmission]);
			expect(start).not.toHaveBeenCalled();
			await prepared.activate(manager);
			expect(start).not.toHaveBeenCalled();
			prepared.start();
			expect(start).toHaveBeenCalledTimes(1);
			expect(
				manager
					.getBranch()
					.filter(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE),
			).toHaveLength(1);
		} finally {
			await prepared.close();
			await manager.close();
		}
	});

	test("closes the runtime when activation cannot flush the initial binding", async () => {
		using tempDir = TempDir.createSync("@breadboard-activation-flush-failure-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const closeBridge = mock(async () => {});
		const closeSupervisor = mock(async () => {});
		const start = mock(() => {});
		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			closeSupervisor,
			openSession: async () =>
				({
					sessionId: "flush-failure",
					snapshot: async () => runtimeSnapshot("flush-failure"),
				}) as never,
			createBridge: () => ({
				stream: () => new AssistantMessageEventStream(),
				start,
				close: closeBridge,
			}),
			registerCleanup: () => () => {},
		});
		const flush = spyOn(manager, "flush").mockImplementation(async () => {
			throw new Error("binding flush failed");
		});

		try {
			await expect(prepared.activate(manager)).rejects.toThrow("binding flush failed");
			expect(start).not.toHaveBeenCalled();
			expect(closeBridge).toHaveBeenCalledTimes(1);
			expect(closeSupervisor).toHaveBeenCalledTimes(1);
		} finally {
			flush.mockRestore();
			await manager.close();
		}
	});
	test("closes the runtime once when deferred bridge start fails", async () => {
		using tempDir = TempDir.createSync("@breadboard-activation-start-failure-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const closeBridge = mock(async () => {});
		const closeSupervisor = mock(async () => {});
		const prepared = await prepareConnectedBreadboardRuntime({
			...TEST_RUNTIME_AUTHORITY,
			closeSupervisor,
			openSession: async () =>
				({
					sessionId: "start-failure",
					snapshot: async () => runtimeSnapshot("start-failure"),
				}) as never,
			createBridge: () => ({
				stream: () => new AssistantMessageEventStream(),
				start() {
					throw new Error("bridge start failed");
				},
				close: closeBridge,
			}),
			registerCleanup: () => () => {},
		});

		try {
			await prepared.activate(manager);
			expect(() => prepared.start()).toThrow("bridge start failed");
			await prepared.close();
			expect(closeBridge).toHaveBeenCalledTimes(1);
			expect(closeSupervisor).toHaveBeenCalledTimes(1);
		} finally {
			await manager.close();
		}
	});
});

describe("BreadBoard durable binding rejection", () => {
	test.each([
		["legacy", { sessionId: "session" }],
		["extra field", { ...sessionBinding("session"), legacy: true }],
		["malformed event zero", sessionBinding("session", 0, "event-0")],
		["malformed sequence", sessionBinding("session", -1, "event--1")],
	] as const)("rejects a %s latest binding without fallback", async (_name, latest) => {
		using tempDir = TempDir.createSync("@breadboard-binding-malformed-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, sessionBinding("session", 1, "event-1"));
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, latest);
		const parsed = Object.assign(parseArgs([]), { continue: true });
		try {
			expect(() => resolveBreadboardSessionTarget(parsed, manager, "/tmp/session.yml")).toThrow(
				BreadboardSessionTransitionError,
			);
		} finally {
			await manager.close();
		}
	});

	test.each([
		["session conflict", sessionBinding("other", 2, "event-2")],
		["digest conflict", { ...sessionBinding("session", 2, "event-2"), replayConfigurationDigest: "sha256:other" }],
		["cursor rollback", sessionBinding("session", 1, "event-1")],
		["event conflict", sessionBinding("session", 2, "different-event")],
	] as const)("rejects %s across active-branch bindings", async (_name, latest) => {
		using tempDir = TempDir.createSync("@breadboard-binding-conflict-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, sessionBinding("session", 2, "event-2"));
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, latest);
		const parsed = Object.assign(parseArgs([]), { resume: true });
		try {
			expect(() => resolveBreadboardSessionTarget(parsed, manager, "/tmp/session.yml")).toThrow(
				BreadboardSessionTransitionError,
			);
		} finally {
			await manager.close();
		}
	});

	test.each([
		["session mismatch", sessionBinding("bound", 1, "event-1"), "opened", {}, "opened"],
		[
			"configuration digest mismatch",
			sessionBinding("bound", 1, "event-1"),
			"bound",
			{
				replayRetention: {
					maxEvents: 100_000,
					maxAgeMs: 86_400_000,
					configurationDigest: "sha256:other",
				},
				earliestRetainedSequence: 1,
				earliestRetainedEventId: "event-1",
				headSequence: 1,
				headEventId: "event-1",
			},
			"bound",
		],
		[
			"cursor beyond head",
			sessionBinding("bound", 3, "event-3"),
			"bound",
			{ earliestRetainedSequence: 1, headSequence: 2, headEventId: "event-2" },
			"bound",
		],
		[
			"equal-head event mismatch",
			sessionBinding("bound", 2, "wrong-event"),
			"bound",
			{ earliestRetainedSequence: 1, headSequence: 2, headEventId: "event-2" },
			"bound",
		],
		[
			"retention gap",
			sessionBinding("bound", 2, "event-2"),
			"bound",
			{
				earliestRetainedSequence: 3,
				earliestRetainedEventId: "event-3",
				headSequence: 4,
				headEventId: "event-4",
				retainedHistory: "partial",
			},
			"bound",
		],
	] as const)(
		"rejects resume snapshot %s before constructing the bridge",
		async (_name, binding, openedSessionId, overrides, snapshotSessionId) => {
			const createBridge = mock(() => {
				throw new Error("bridge must not be constructed");
			});
			await expect(
				prepareConnectedBreadboardRuntime({
					...TEST_RUNTIME_AUTHORITY,
					sessionBinding: binding,
					closeSupervisor: async () => {},
					openSession: async () =>
						({
							sessionId: openedSessionId,
							snapshot: async () => runtimeSnapshot(snapshotSessionId, overrides),
						}) as never,
					createBridge,
				}),
			).rejects.toBeInstanceOf(BreadboardSessionTransitionError);
			expect(createBridge).not.toHaveBeenCalled();
		},
	);

	test("rejects impossible snapshot head combinations and partial history without a durable cursor", async () => {
		for (const overrides of [
			{ headEventId: "event-0" },
			{
				earliestRetainedSequence: 2,
				earliestRetainedEventId: "event-2",
				headSequence: 2,
				headEventId: "event-2",
				retainedHistory: "partial",
			},
		]) {
			await expect(
				prepareConnectedBreadboardRuntime({
					...TEST_RUNTIME_AUTHORITY,
					closeSupervisor: async () => {},
					openSession: async () =>
						({
							sessionId: "impossible",
							snapshot: async () => runtimeSnapshot("impossible", overrides),
						}) as never,
				}),
			).rejects.toBeInstanceOf(BreadboardSessionTransitionError);
		}
	});
});

describe("BreadBoard backend model authority", () => {
	test("resolves a provider-qualified snapshot model to the exact loaded ModelRegistry entry", async () => {
		using tempDir = TempDir.createSync("@breadboard-model-resolution-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		try {
			const expected = modelRegistry
				.getAll()
				.find(model => model.provider === BREADBOARD_MODEL.provider && model.id === BREADBOARD_MODEL.id);
			if (!expected) throw new Error("expected bundled model missing from ModelRegistry");
			expect(resolveBreadboardBackendModel(BREADBOARD_MODEL_SELECTOR, modelRegistry)).toBe(expected);
		} finally {
			authStorage.close();
		}
	});

	test("fails preparation on missing snapshot model metadata before creating the bridge", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});
		const createBridge = mock(() => {
			throw new Error("bridge must not be created");
		});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "missing-model",
						snapshot: async () => runtimeSnapshot("missing-model", { model: null }),
						close: closeSession,
					}) as never,
				createBridge,
				emitAgentEvent: async () => {},
			}),
		).rejects.toMatchObject({ code: "missing_backend_model" });

		expect(createBridge).not.toHaveBeenCalled();
		expect(closeSession).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("fails preparation when snapshot model metadata is not in the loaded registry", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});
		const createBridge = mock(() => {
			throw new Error("bridge must not be created");
		});

		await expect(
			prepareConnectedBreadboardRuntime({
				...TEST_RUNTIME_AUTHORITY,
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "unknown-model",
						snapshot: async () => runtimeSnapshot("unknown-model", { model: "unknown-provider/unknown-model" }),
						close: closeSession,
					}) as never,
				createBridge,
				emitAgentEvent: async () => {},
			}),
		).rejects.toMatchObject({ code: "unresolved_backend_model" });

		expect(createBridge).not.toHaveBeenCalled();
		expect(closeSession).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("rejects a bare backend model id that is ambiguous in ModelRegistry", async () => {
		using tempDir = TempDir.createSync("@breadboard-model-ambiguous-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		try {
			const matchingModels = modelRegistry.getAll().filter(model => model.id === BREADBOARD_MODEL.id);
			expect(new Set(matchingModels.map(model => model.provider)).size).toBeGreaterThan(1);
			expect(() => resolveBreadboardBackendModel(BREADBOARD_MODEL.id, modelRegistry)).toThrow(
				expect.objectContaining({ code: "ambiguous_backend_model" }),
			);
		} finally {
			authStorage.close();
		}
	});
});

describe("BreadBoard native permission UI", () => {
	test("maps explicit Allow and Deny selections and passes only safe request context", async () => {
		for (const [selection, expected] of [
			["Allow", "allow"],
			["Deny", "deny"],
		] as const) {
			const select = mock(
				async (_title: string, _options: unknown[], _dialogOptions?: { signal?: AbortSignal }) => selection,
			);
			const handler = createBreadboardPermissionHandler(() => ({ select }) as never);
			const controller = new AbortController();
			const request = {
				...PERMISSION_REQUEST,
				tool: "edit\x1b[31m",
				kind: "write\noperation",
				summary: "Authorization: Bearer canary-token-never-serialize",
				arguments: { apiKey: "raw-secret-never-show" },
			} as unknown as PermissionRequestedPayload;

			await expect(handler(request, controller.signal)).resolves.toBe(expected);
			expect(select).toHaveBeenCalledTimes(1);
			const [title, options, dialogOptions] = select.mock.calls[0]!;
			expect(options).toEqual(["Allow", "Deny"]);
			expect(dialogOptions).toEqual({ signal: controller.signal });
			expect(title).toContain("edit");
			expect(title).toContain("write operation");
			expect(title).toContain("[redacted]");
			expect(title).not.toContain("\x1b");
			expect(title).not.toContain("canary-token-never-serialize");
			expect(title).not.toContain("raw-secret-never-show");
		}
	});

	test("maps selector dismissal to cancel", async () => {
		const select = mock(async () => undefined);
		const handler = createBreadboardPermissionHandler(() => ({ select }) as never);

		await expect(handler(PERMISSION_REQUEST, new AbortController().signal)).resolves.toBe("cancel");
	});

	test("maps an aborted native selector to cancel using the bridge signal", async () => {
		const controller = new AbortController();
		const select = mock(
			async (_title: string, _options: unknown[], dialogOptions?: { signal?: AbortSignal }): Promise<undefined> => {
				expect(dialogOptions?.signal).toBe(controller.signal);
				await new Promise<void>((_resolve, reject) => {
					dialogOptions?.signal?.addEventListener(
						"abort",
						() => {
							const error = new Error("selector aborted");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				});
				return undefined;
			},
		);
		const handler = createBreadboardPermissionHandler(() => ({ select }) as never);

		const decision = handler(PERMISSION_REQUEST, controller.signal);
		controller.abort();
		await expect(decision).resolves.toBe("cancel");
	});

	test("cancels immediately when permission arrives before UI initialization", async () => {
		const handler = createBreadboardPermissionHandler(() => undefined);

		await expect(handler(PERMISSION_REQUEST, new AbortController().signal)).resolves.toBe("cancel");
	});
});

describe("BreadBoard off-mode native authority", () => {
	test("returns native authority for a fresh transcript without requiring BreadBoard session config", async () => {
		const connect = spyOn(LifecycleSupervisor.prototype, "connect");
		const activeSettings = Settings.isolated({ "breadboard.engineMode": "off" } as never);
		const modelRegistryGetAll = mock(() => {
			throw new Error("BreadBoard model authority must not be read in off mode");
		});

		try {
			await expect(
				prepareBreadboardRuntime(
					parseArgs([]),
					() => {},
					{
						modelRegistry: { getAll: modelRegistryGetAll },
						requestPermission: async () => {
							throw new Error("BreadBoard permission authority must not be read in off mode");
						},
					},
					activeSettings,
				),
			).resolves.toBeNull();
			expect(connect).not.toHaveBeenCalled();
			expect(modelRegistryGetAll).not.toHaveBeenCalled();
		} finally {
			connect.mockRestore();
		}
	});

	test("leaves path resume of an ordinary OMP transcript on the native path", async () => {
		using tempDir = TempDir.createSync("@breadboard-off-path-resume-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const parsed = parseArgs(["--engine-mode", "off"]);
		parsed.resume = manager.getSessionFile();

		try {
			await expect(
				prepareBreadboardRuntime(parsed, () => {}, TEST_RUNTIME_AUTHORITY, Settings.isolated(), manager),
			).resolves.toBeNull();
		} finally {
			await manager.close();
		}
	});

	test("leaves picker resume and continue of ordinary OMP transcripts on the native path", async () => {
		using tempDir = TempDir.createSync("@breadboard-off-native-resume-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));

		try {
			for (const parsed of [
				Object.assign(parseArgs(["--engine-mode", "off"]), { resume: true }),
				Object.assign(parseArgs(["--engine-mode", "off"]), { continue: true }),
			]) {
				await expect(
					prepareBreadboardRuntime(parsed, () => {}, TEST_RUNTIME_AUTHORITY, Settings.isolated(), manager),
				).resolves.toBeNull();
			}
		} finally {
			await manager.close();
		}
	});
});

describe("BreadBoard resume identity authority", () => {
	test("resolves picker, --continue, and path-based --resume through the durable session binding", async () => {
		using tempDir = TempDir.createSync("@breadboard-resume-binding-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		manager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, sessionBinding("e4-durable-session"));
		await manager.flush();

		try {
			const variants = [
				{ continue: true, resume: undefined },
				{ continue: false, resume: true },
				{ continue: false, resume: manager.getSessionFile() },
			] as const;
			for (const variant of variants) {
				const parsed = parseArgs([]);
				parsed.continue = variant.continue;
				parsed.resume = variant.resume;
				expect(resolveBreadboardSessionTarget(parsed, manager, "/tmp/session-config.yml")).toEqual({
					kind: "attach",
					sessionId: "e4-durable-session",
				});
			}
		} finally {
			await manager.close();
		}
	});

	test("fails closed for a resumed native transcript without a durable BreadBoard binding", async () => {
		using tempDir = TempDir.createSync("@breadboard-resume-unbound-");
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const parsed = parseArgs([]);
		parsed.resume = manager.getSessionFile();

		try {
			expect(() => resolveBreadboardSessionTarget(parsed, manager, "/tmp/session-config.yml")).toThrow(
				"cannot resume this OMP transcript because it has no durable BreadBoard session binding",
			);
		} finally {
			await manager.close();
		}
	});

	test("rejects an unbound resumed transcript before attempting a backend connection", async () => {
		using tempDir = TempDir.createSync("@breadboard-resume-before-connect-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"breadboard:\n  engineMode: local-external\n  baseUrl: http://127.0.0.1:1\n  sessionConfigPath: /tmp/session.yml\n",
		);
		const activeSettings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		const manager = SessionManager.create(projectDir, tempDir.join("sessions"));
		const parsed = parseArgs([]);
		parsed.resume = manager.getSessionFile();

		try {
			await expect(
				prepareBreadboardRuntime(parsed, () => {}, TEST_RUNTIME_AUTHORITY, activeSettings, manager),
			).rejects.toThrow("cannot resume this OMP transcript because it has no durable BreadBoard session binding");
		} finally {
			await manager.close();
		}
	});
});

describe("BreadBoard migrated config authority", () => {
	test("interactive startup reads migrated BreadBoard settings from config.yml", async () => {
		using tempDir = TempDir.createSync("@breadboard-interactive-config-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ breadboard: { engineMode: "off", sessionConfigPath: "/tmp/session.yml" } }),
		);
		const previousAgentDir = getAgentDir();
		const previousExitCode = process.exitCode;

		try {
			setAgentDir(agentDir);
			resetSettingsForTest();
			await Settings.init({ cwd: projectDir, agentDir });

			await expect(prepareBreadboardRuntime(parseArgs([]), () => {}, TEST_RUNTIME_AUTHORITY)).resolves.toBeNull();
			expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(true);
			expect(await Bun.file(path.join(agentDir, "settings.json.bak")).exists()).toBe(true);
		} finally {
			resetSettingsForTest();
			setAgentDir(previousAgentDir);
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("interactive startup uses config.yaml plus the explicit config overlay from Settings", async () => {
		using tempDir = TempDir.createSync("@breadboard-interactive-overlay-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		const overlayPath = tempDir.join("overlay.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"breadboard:\n  engineMode: invalid-from-main-config\n  sessionConfigPath: /tmp/session.yml\n",
		);
		await Bun.write(overlayPath, "breadboard:\n  engineMode: off\n");
		const previousAgentDir = getAgentDir();
		const previousExitCode = process.exitCode;

		try {
			setAgentDir(agentDir);
			resetSettingsForTest();
			const activeSettings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });

			await expect(
				prepareBreadboardRuntime(
					parseArgs(["--config", overlayPath]),
					() => {},
					TEST_RUNTIME_AUTHORITY,
					activeSettings,
				),
			).resolves.toBeNull();
		} finally {
			resetSettingsForTest();
			setAgentDir(previousAgentDir);
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("engine commands initialize migration and read BreadBoard settings from config.yml", async () => {
		using tempDir = TempDir.createSync("@breadboard-engine-config-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(path.join(agentDir, "settings.json"), JSON.stringify({ breadboard: { engineMode: "off" } }));
		const previousAgentDir = getAgentDir();
		const previousCwd = process.cwd();
		const previousExitCode = process.exitCode;

		try {
			setAgentDir(agentDir);
			process.chdir(projectDir);
			resetSettingsForTest();
			const command = new Engine(["status"], {
				bin: "omp",
				version: "0.0.0-test",
				commands: new Map(),
			});

			await command.run();

			expect(process.exitCode).toBe(0);
			expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(true);
			expect(await Bun.file(path.join(agentDir, "settings.json.bak")).exists()).toBe(true);
		} finally {
			resetSettingsForTest();
			process.chdir(previousCwd);
			setAgentDir(previousAgentDir);
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("engine commands use config.yaml and --config overlays from Settings", async () => {
		using tempDir = TempDir.createSync("@breadboard-engine-overlay-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		const overlayPath = tempDir.join("overlay.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"breadboard:\n  engineMode: invalid-from-main-config\n  sessionConfigPath: /tmp/session.yml\n",
		);
		await Bun.write(overlayPath, "breadboard:\n  engineMode: off\n");
		const previousAgentDir = getAgentDir();
		const previousCwd = process.cwd();
		const previousExitCode = process.exitCode;

		try {
			setAgentDir(agentDir);
			process.chdir(projectDir);
			resetSettingsForTest();
			const command = new Engine(["status", "--config", overlayPath], {
				bin: "omp",
				version: "0.0.0-test",
				commands: new Map(),
			});

			await command.run();

			expect(process.exitCode).toBe(0);
		} finally {
			resetSettingsForTest();
			process.chdir(previousCwd);
			setAgentDir(previousAgentDir);
			process.exitCode = previousExitCode ?? 0;
		}
	});

	test("engine commands use PI_CONFIG_FILES overlays from Settings", async () => {
		using tempDir = TempDir.createSync("@breadboard-engine-env-overlay-");
		const agentDir = tempDir.join("agent");
		const projectDir = tempDir.join("project");
		const overlayPath = tempDir.join("overlay.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"breadboard:\n  engineMode: invalid-from-main-config\n  sessionConfigPath: /tmp/session.yml\n",
		);
		await Bun.write(overlayPath, "breadboard:\n  engineMode: off\n");
		const previousAgentDir = getAgentDir();
		const previousCwd = process.cwd();
		const previousExitCode = process.exitCode;
		const previousConfigFiles = process.env.PI_CONFIG_FILES;

		try {
			setAgentDir(agentDir);
			process.chdir(projectDir);
			process.env.PI_CONFIG_FILES = overlayPath;
			resetSettingsForTest();
			const command = new Engine(["status"], {
				bin: "omp",
				version: "0.0.0-test",
				commands: new Map(),
			});

			await command.run();

			expect(process.exitCode).toBe(0);
		} finally {
			resetSettingsForTest();
			if (previousConfigFiles === undefined) delete process.env.PI_CONFIG_FILES;
			else process.env.PI_CONFIG_FILES = previousConfigFiles;
			process.chdir(previousCwd);
			setAgentDir(previousAgentDir);
			process.exitCode = previousExitCode ?? 0;
		}
	});
});
