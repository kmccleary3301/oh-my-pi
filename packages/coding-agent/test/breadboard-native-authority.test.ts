import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

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
