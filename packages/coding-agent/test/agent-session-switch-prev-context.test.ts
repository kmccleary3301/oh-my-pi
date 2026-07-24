import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type SessionTransitionPlan } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { BuildSessionContextOptions, SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Regression for issue #3846: in-TUI `/resume` rebuilt the *previous*
 * session's display context before switching files. That call expands persisted
 * snapcompact archives and `openaiRemoteCompaction.replacementHistory` payloads
 * into messages, which can OOM on huge pre-fix sessions even though the loader
 * itself streams. The previous context is only needed for same-session reloads
 * (where `#didSessionMessagesChange` compares against the freshly rebuilt one);
 * different-session switches MUST skip that work.
 */
describe("AgentSession.switchSession previous-context build", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-switch-prev-ctx-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function buildSession(
		tempDir: TempDir,
		extensionRunner?: ExtensionRunner,
	): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	async function seedConversation(session: AgentSession, sessionManager: SessionManager) {
		const firstUserId = sessionManager.appendMessage(userMsg("first user"));
		sessionManager.appendMessage(assistantMsg("first assistant"));
		const secondUserId = sessionManager.appendMessage(userMsg("second user"));
		sessionManager.appendMessage(assistantMsg("second assistant"));
		await sessionManager.flush();
		session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
		session.agent.replaceQueues([userMsg("queued steer")], [userMsg("queued follow-up")]);
		return { firstUserId, secondUserId };
	}

	async function captureSessionState(session: AgentSession, sessionManager: SessionManager) {
		const sessionFile = session.sessionFile;
		return {
			sessionFile,
			sessionId: session.sessionId,
			leafId: sessionManager.getLeafId(),
			entries: JSON.stringify(sessionManager.getEntries()),
			messages: JSON.stringify(session.messages),
			model: session.model && `${session.model.provider}/${session.model.id}`,
			steeringQueue: JSON.stringify(session.agent.peekSteeringQueue()),
			followUpQueue: JSON.stringify(session.agent.peekFollowUpQueue()),
			persisted: sessionFile ? await Bun.file(sessionFile).text() : undefined,
		};
	}

	async function expectConnectionIntact(session: AgentSession): Promise<void> {
		let observed = false;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start") observed = true;
		});
		try {
			session.agent.emitExternalEvent({ type: "agent_start" });
			for (let turn = 0; turn < 4 && !observed; turn++) await Promise.resolve();
			expect(observed).toBe(true);
		} finally {
			unsubscribe();
		}
	}

	async function expectGuardedTransition(options: {
		session: AgentSession;
		sessionManager: SessionManager;
		expectedPlan: SessionTransitionPlan;
		run: () => Promise<unknown>;
		order?: string[];
	}): Promise<void> {
		const plans: SessionTransitionPlan[] = [];
		const transitionError = new Error(`blocked ${options.expectedPlan.reason}`);
		options.session.setSessionTransitionGuard(plan => {
			options.order?.push("guard");
			plans.push(plan);
			throw transitionError;
		});
		const before = await captureSessionState(options.session, options.sessionManager);

		let failure: unknown;
		try {
			await options.run();
		} catch (error) {
			failure = error;
		}

		expect(failure).toBe(transitionError);
		expect(plans).toEqual([options.expectedPlan]);
		expect(await captureSessionState(options.session, options.sessionManager)).toEqual(before);
		await expectConnectionIntact(options.session);
	}

	/** Wrap `sessionManager.buildSessionContext` so each call's caller-visible
	 *  state (the manager's currently-loaded session file) is recorded in
	 *  invocation order. The constructor itself calls `buildSessionContext`
	 *  once; spying *after* construction means only switchSession-driven calls
	 *  are observed. */
	function instrumentBuildSessionContext(sessionManager: SessionManager): {
		calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }>;
		restore: () => void;
	} {
		const calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }> = [];
		const original = sessionManager.buildSessionContext.bind(sessionManager);
		const patched = (options?: BuildSessionContextOptions): SessionContext => {
			calls.push({ sessionFile: sessionManager.getSessionFile(), transcript: options?.transcript });
			return original(options);
		};
		sessionManager.buildSessionContext = patched as SessionManager["buildSessionContext"];
		return {
			calls,
			restore: () => {
				sessionManager.buildSessionContext = original;
			},
		};
	}

	it("skips building the previous display context when switching to a different session", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-different-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(previousSessionFile);
		await otherManager.close();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(targetSessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(targetSessionFile);
		} finally {
			restore();
		}

		// The previous session's display context MUST NOT be materialized. Only
		// the new target context (post-`setSessionFile`) should be built.
		expect(calls).toEqual([{ sessionFile: targetSessionFile!, transcript: undefined }]);
	});

	it("builds the previous display context for same-session reloads", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-reload-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeString();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(sessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			restore();
		}

		// Same-session reload must snapshot the pre-reload context so
		// `#didSessionMessagesChange` can detect rollback edits.
		expect(calls).toEqual([
			{ sessionFile: sessionFile!, transcript: undefined },
			{ sessionFile: sessionFile!, transcript: undefined },
		]);
	});

	it("guards newSession and fork after their public before-hooks and before state mutation", async () => {
		const tempDir = TempDir.createSync("@pi-session-transition-new-fork-");
		tempDirs.push(tempDir);
		const order: string[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_switch",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_switch") order.push(event.type);
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(tempDir, extensionRunner);
		await seedConversation(session, sessionManager);

		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "new" },
			run: () => session.newSession(),
			order,
		});
		expect(order).toEqual(["session_before_switch", "guard"]);

		order.length = 0;
		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "fork" },
			run: () => session.fork(),
			order,
		});
		expect(order).toEqual(["session_before_switch", "guard"]);
	});

	it("guards switchSession and reload after their public before-hooks and before state mutation", async () => {
		const tempDir = TempDir.createSync("@pi-session-transition-resume-");
		tempDirs.push(tempDir);
		const order: string[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_switch",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_switch") order.push(event.type);
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(tempDir, extensionRunner);
		await seedConversation(session, sessionManager);
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage(userMsg("target session"));
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		if (!targetSessionFile) throw new Error("Expected target session file");

		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "resume", targetSessionFile },
			run: () => session.switchSession(targetSessionFile),
			order,
		});
		expect(order).toEqual(["session_before_switch", "guard"]);

		order.length = 0;
		const currentSessionFile = session.sessionFile;
		if (!currentSessionFile) throw new Error("Expected current session file");
		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "resume", targetSessionFile: currentSessionFile },
			run: () => session.reload(),
			order,
		});
		expect(order).toEqual(["session_before_switch", "guard"]);
	});

	it("guards branch and branchFromBtw after their public before-hooks and before state mutation", async () => {
		const tempDir = TempDir.createSync("@pi-session-transition-branch-");
		tempDirs.push(tempDir);
		const order: string[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_branch",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_branch") order.push(event.type);
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(tempDir, extensionRunner);
		const { firstUserId } = await seedConversation(session, sessionManager);

		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "branch", targetEntryId: firstUserId },
			run: () => session.branch(firstUserId),
			order,
		});
		expect(order).toEqual(["session_before_branch", "guard"]);

		order.length = 0;
		const leafId = sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected current leaf");
		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "branchFromBtw", targetEntryId: leafId },
			run: () => session.branchFromBtw("side question", assistantMsg("side answer")),
			order,
		});
		expect(order).toEqual(["session_before_branch", "guard"]);
	});

	it("guards navigateTree after its public before-hook and before state mutation", async () => {
		const tempDir = TempDir.createSync("@pi-session-transition-tree-");
		tempDirs.push(tempDir);
		const order: string[] = [];
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_tree",
			emit: async (event: { type: string }) => {
				if (event.type === "session_before_tree") order.push(event.type);
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(tempDir, extensionRunner);
		const { firstUserId } = await seedConversation(session, sessionManager);

		await expectGuardedTransition({
			session,
			sessionManager,
			expectedPlan: { reason: "navigateTree", targetEntryId: firstUserId },
			run: () => session.navigateTree(firstUserId),
			order,
		});
		expect(order).toEqual(["session_before_tree", "guard"]);
	});

	it("leaves native AgentSession tree navigation unchanged when no guard is installed", async () => {
		const tempDir = TempDir.createSync("@pi-session-transition-native-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		const { firstUserId } = await seedConversation(session, sessionManager);

		const result = await session.navigateTree(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(sessionManager.getLeafId()).toBeNull();
	});
});
