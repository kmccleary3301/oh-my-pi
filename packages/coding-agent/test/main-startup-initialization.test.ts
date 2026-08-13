import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDbPath, getConfigRootDir, getModelDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const SESSION_FIXTURE = path.join(import.meta.dir, "fixtures", "large-session.jsonl");

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

async function runEarlyExit(args: string[]): Promise<{
	exitCode: number;
	stdout: string;
	discoverCalls: number;
}> {
	using agentDir = TempDir.createSync("@omp-main-startup-");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	setAgentDir(agentDir.path());

	const authDbPath = getAgentDbPath(agentDir.path());
	const modelDbPath = getModelDbPath(agentDir.path());
	const fixtureBefore = await Bun.file(SESSION_FIXTURE).text();
	const output: string[] = [];
	const events: string[] = [];
	let captureStdoutEvents = false;
	let discoverCalls = 0;
	let authStorage: AuthStorage | undefined;
	let thrown: unknown;
	const previousExitCode = process.exitCode;

	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		if (captureStdoutEvents) events.push("stdout");
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		events.push("exit");
		expect(fs.existsSync(authDbPath)).toBe(true);
		expect(fs.existsSync(modelDbPath)).toBe(true);
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	captureStdoutEvents = true;

	try {
		const parsed = args[0] === "--version" ? parseArgs(args) : parseArgs(["--export", ...args]);
		await runRootCommand(parsed, args, {
			discoverAuthStorage: async () => {
				discoverCalls += 1;
				events.push("discover");
				authStorage = await AuthStorage.create(authDbPath);
				return authStorage;
			},
		});
	} catch (error) {
		thrown = error;
	} finally {
		vi.restoreAllMocks();
		process.exitCode = previousExitCode;
		authStorage?.close();
		if (previousAgentDir === undefined) {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			setAgentDir(previousAgentDir);
		}
	}

	const fixtureAfter = await Bun.file(SESSION_FIXTURE).text();
	expect(fixtureAfter).toBe(fixtureBefore);
	expect(thrown).toBeInstanceOf(ProcessExitSignal);
	expect(events).toEqual(["discover", "stdout", "exit"]);
	expect(discoverCalls).toBe(1);

	return {
		exitCode: (thrown as ProcessExitSignal).code,
		stdout: output.join(""),
		discoverCalls,
	};
}

describe("runRootCommand — startup auth/model initialization", () => {
	it("initializes auth and models once before --version exits", async () => {
		const result = await runEarlyExit(["--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.discoverCalls).toBe(1);
		expect(result.stdout).toMatch(/\S+\n/);
	});

	it("initializes auth and models once before --export exits without mutating its fixture", async () => {
		using outputDir = TempDir.createSync("@omp-main-export-");
		const outputPath = path.join(outputDir.path(), "session.html");
		const result = await runEarlyExit([SESSION_FIXTURE, outputPath]);

		expect(result.exitCode).toBe(0);
		expect(result.discoverCalls).toBe(1);
		expect(fs.existsSync(outputPath)).toBe(true);
		expect(result.stdout).toContain(`Exported to: ${outputPath}`);
	});
});
