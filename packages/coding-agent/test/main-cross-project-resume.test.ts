/**
 * Regression: declining the cross-project fork prompt during `--resume <id>`
 * must exit cleanly, while non-interactive resume still fails instead of
 * silently succeeding. See #1668.
 *
 * Also covers the moved/renamed-worktree path: when the matched session's
 * recorded directory no longer exists, `--resume <id>` offers to *move*
 * (re-root) the session rather than fork a duplicate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BreadboardSessionTransitionError,
	createBreadboardStartupForkPolicy,
	createSessionManager,
} from "@oh-my-pi/pi-coding-agent/main";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildGlobalMatch(cwd: string): { session: SessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: `${cwd}/019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl`,
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

describe("createSessionManager — BreadBoard startup fork policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects an explicit fork before SessionManager.forkFrom when BreadBoard is active", async () => {
		const source = "/native/input/session.jsonl";
		const parsed = {
			...buildArgs("unused"),
			resume: undefined,
			fork: source,
		};
		const forkFrom = vi.spyOn(SessionManager, "forkFrom");
		const policy = createBreadboardStartupForkPolicy(
			parsed,
			Settings.isolated({
				"breadboard.engineMode": "local-external",
				"breadboard.baseUrl": "http://127.0.0.1:7777",
			} as never),
			process.cwd(),
		);

		let failure: unknown;
		try {
			await createSessionManager(parsed, "/current/project", stubSettings, undefined, undefined, policy);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(BreadboardSessionTransitionError);
		expect(failure).toHaveProperty(
			"message",
			"BreadBoard cannot fork an OMP session at startup because the current E4 SDK cannot atomically rebind the bridge to the forked transcript. Start a new OMP session or run with BreadBoard mode off.",
		);
		expect((failure as Error).message).not.toContain(source);
		expect(forkFrom).not.toHaveBeenCalled();
	});

	it("rejects an accepted cross-project fork before SessionManager.forkFrom when BreadBoard is active", async () => {
		const otherProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-breadboard-xproj-"));
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(otherProject));
			const forkFrom = vi.spyOn(SessionManager, "forkFrom");
			const parsed = {
				...buildArgs("019e84ed"),
				engineMode: "local-external",
				engineUrl: "http://127.0.0.1:7777",
			};
			const policy = createBreadboardStartupForkPolicy(parsed, Settings.isolated({}), process.cwd());

			await expect(
				createSessionManager(
					parsed,
					"/current/project",
					stubSettings,
					async () => "accepted" as const,
					undefined,
					policy,
				),
			).rejects.toBeInstanceOf(BreadboardSessionTransitionError);
			expect(forkFrom).not.toHaveBeenCalled();
		} finally {
			await fsp.rm(otherProject, { recursive: true, force: true });
		}
	});

	it("still executes explicit and accepted cross-project forks when BreadBoard is off", async () => {
		const otherProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-native-xproj-"));
		const manager = SessionManager.inMemory();
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(otherProject));
			const forkFrom = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(manager);
			const explicit = {
				...buildArgs("unused"),
				resume: undefined,
				fork: "/native/input/session.jsonl",
				engineMode: "off",
			};
			const implicit = { ...buildArgs("019e84ed"), engineMode: "off" };
			const settings = Settings.isolated({ "breadboard.engineMode": "local-external" } as never);

			await expect(
				createSessionManager(
					explicit,
					"/current/project",
					stubSettings,
					undefined,
					undefined,
					createBreadboardStartupForkPolicy(explicit, settings, process.cwd()),
				),
			).resolves.toBe(manager);
			await expect(
				createSessionManager(
					implicit,
					"/current/project",
					stubSettings,
					async () => "accepted" as const,
					undefined,
					createBreadboardStartupForkPolicy(implicit, settings, process.cwd()),
				),
			).resolves.toBe(manager);
			expect(forkFrom).toHaveBeenCalledTimes(2);
		} finally {
			await manager.close();
			await fsp.rm(otherProject, { recursive: true, force: true });
		}
	});
});

describe("createSessionManager — cross-project --resume cancellation (#1668)", () => {
	// An existing directory so the match is treated as a genuinely different
	// project (fork path), not a moved/renamed worktree (move path).
	let existingProject: string;

	beforeEach(async () => {
		existingProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(existingProject, { recursive: true, force: true });
	});

	it("returns undefined when an interactive user declines the fork prompt instead of throwing", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(existingProject));

		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
	});

	it("throws when the cross-project fork prompt is unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(existingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" is in another project (${existingProject}); run interactively to fork it into the current project.`,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("createSessionManager — cross-project --resume relocation (moved worktree)", () => {
	let missingRoot: string;
	let missingProject: string;

	beforeEach(async () => {
		missingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-moved-xproj-"));
		missingProject = path.join(missingRoot, "worktree-gone");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(missingRoot, { recursive: true, force: true });
	});

	it("offers move (not fork) and returns undefined when the user declines", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);

		const forkPrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			forkPrompt,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
		// The fork prompt must NOT be used for a relocated (gone-dir) session.
		expect(forkPrompt).not.toHaveBeenCalled();
	});

	it("throws the move-specific error when unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); run interactively to move it into the current project.`,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});

	it("moves a local explicit-session-dir match whose recorded cwd is gone", async () => {
		const currentProject = path.join(missingRoot, "current-project");
		const explicitSessionDir = path.join(missingRoot, "sessions");
		await fsp.mkdir(currentProject, { recursive: true });

		const moved = SessionManager.create(missingProject, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "before local move", timestamp: 1 });
		await moved.flush();
		const oldFile = moved.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		const resumePrefix = moved.getSessionId().slice(0, 8);
		const sessionInfo: SessionInfo = {
			path: oldFile,
			id: moved.getSessionId(),
			cwd: missingProject,
			title: "moved-local",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "before local move",
			allMessagesText: "before local move",
		};
		await moved.close();
		expect(fs.existsSync(missingProject)).toBe(false);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			scope: "local",
			session: sessionInfo,
		});

		const forkPrompt = vi.fn(async () => "accepted" as const);
		const movePrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs(resumePrefix, explicitSessionDir),
			currentProject,
			stubSettings,
			forkPrompt,
			movePrompt,
		);

		if (!result) throw new Error("Expected moved session manager");
		try {
			expect(result.getSessionFile()).toBe(oldFile);
			expect(result.getCwd()).toBe(path.resolve(currentProject));
			const entries = await loadEntriesFromFile(oldFile);
			const header = entries.find(
				(entry): entry is SessionHeader =>
					typeof entry === "object" &&
					entry !== null &&
					"type" in entry &&
					(entry as { type: unknown }).type === "session",
			);
			expect(header?.cwd).toBe(path.resolve(currentProject));
		} finally {
			await result.close();
		}
		expect(forkPrompt).not.toHaveBeenCalled();
		expect(movePrompt).toHaveBeenCalledTimes(1);
	});
});
