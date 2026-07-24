import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import Engine from "@oh-my-pi/pi-coding-agent/commands/engine";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	prepareBreadboardRuntime,
	prepareConnectedBreadboardRuntime,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("BreadBoard native interactive authority", () => {
	test("injects the BreadBoard turn transport into the ordinary OMP AgentSession path", async () => {
		using tempDir = TempDir.createSync("@breadboard-native-authority-");
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
		parsed.sessionDir = tempDir.path();

		const breadboardStream: StreamFn = () => new AssistantMessageEventStream();
		let prepared = false;
		let observedOptions: CreateAgentSessionOptions | undefined;

		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				prepareBreadboardRuntime: async () => {
					prepared = true;
					return { stream: breadboardStream, sessionId: "session-1", async close() {} };
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
	});
});
describe("BreadBoard runtime preparation ownership", () => {
	test("closes the lifecycle supervisor once when opening the canonical session fails", async () => {
		const closeSupervisor = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				closeSupervisor,
				openSession: async () => {
					throw new Error("open failed");
				},
				emitAgentEvent: () => {},
			}),
		).rejects.toThrow("open failed");

		expect(closeSupervisor).toHaveBeenCalledTimes(1);
	});

	test("closes the opened session and lifecycle supervisor once when snapshotting fails", async () => {
		const closeSupervisor = mock(async () => {});
		const closeSession = mock(async () => {});

		await expect(
			prepareConnectedBreadboardRuntime({
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "snapshot-failure",
						snapshot: async () => {
							throw new Error("snapshot failed");
						},
						close: closeSession,
					}) as never,
				emitAgentEvent: () => {},
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
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "bridge-failure",
						snapshot: async () => ({ headSequence: 0 }),
						close: closeSession,
					}) as never,
				createBridge: () => {
					throw new Error("bridge failed");
				},
				emitAgentEvent: () => {},
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
				closeSupervisor,
				openSession: async () =>
					({
						sessionId: "registration-failure",
						snapshot: async () => ({ headSequence: 0 }),
						close: closeSession,
					}) as never,
				createBridge: () => ({
					stream: () => new AssistantMessageEventStream(),
					close: closeBridge,
				}),
				registerCleanup: () => {
					throw new Error("registration failed");
				},
				emitAgentEvent: () => {},
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

		const prepared = await prepareConnectedBreadboardRuntime({
			closeSupervisor,
			openSession: async () =>
				({
					sessionId: "ready",
					snapshot: async () => ({ headSequence: 0 }),
				}) as never,
			createBridge: () => ({
				stream: () => new AssistantMessageEventStream(),
				close: closeBridge,
			}),
			registerCleanup: () => cancelCleanup,
			emitAgentEvent: () => {},
		});

		expect(closeSupervisor).not.toHaveBeenCalled();
		await prepared.close();
		await prepared.close();
		expect(cancelCleanup).toHaveBeenCalledTimes(1);
		expect(closeBridge).toHaveBeenCalledTimes(1);
		expect(closeSupervisor).toHaveBeenCalledTimes(1);
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

			await expect(prepareBreadboardRuntime(parseArgs([]), () => {})).resolves.toBeNull();
			expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(true);
			expect(await Bun.file(path.join(agentDir, "settings.json.bak")).exists()).toBe(true);
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
});
