import { describe, expect, test } from "bun:test";
import type {
	CancellationReceipt,
	ClientMessageId,
	LoggedSessionEvent,
	OpenedSessionRuntime,
	PermissionDecisionReceipt,
	SubmitInput,
	SubmitReceipt,
} from "@breadboard/sdk";
import { decodeLoggedSessionEvent } from "@breadboard/sdk";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { E4AgentStreamBridge } from "./e4-agent-stream";

const wireEvent = (sequence: number, type: string, payload: unknown, turnId = "turn-1"): LoggedSessionEvent =>
	decodeLoggedSessionEvent({
		stable_cursor: true,
		id: `event-${sequence}`,
		seq: sequence,
		session_id: "session-1",
		input_id: "input-1",
		turn_id: turnId,
		timestamp_ms: sequence,
		type,
		payload,
	});

const started = wireEvent(2, "turn_start", {});
if (started.inputId === null || started.turnId === null) throw new Error("fixture correlation missing");

const receipt: SubmitReceipt = {
	clientMessageId: String(started.eventId) as ClientMessageId,
	inputId: started.inputId,
	turnId: started.turnId,
	disposition: "started",
	originalDisposition: "started",
};

function openedSession(events: readonly LoggedSessionEvent[], submitted: SubmitInput[]): OpenedSessionRuntime {
	return {
		sessionId: started.sessionId,
		async snapshot() {
			throw new Error("snapshot not used by stream bridge");
		},
		async submit(input) {
			submitted.push(input);
			return receipt;
		},
		async cancel(): Promise<CancellationReceipt> {
			throw new Error("cancel not expected");
		},
		async respondPermission(): Promise<PermissionDecisionReceipt> {
			throw new Error("permission response not expected");
		},
		async *events(request) {
			for (const event of events) {
				await Bun.sleep(0);
				if (request?.signal?.aborted) return;
				yield event;
			}
		},
		async close() {},
	};
}

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled test model missing");

const context: Context = {
	messages: [
		{ role: "user", content: "older", timestamp: 1 },
		{
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
		{ role: "user", content: "new prompt", timestamp: 3 },
	],
};

function permissionSession(
	responded: Array<Parameters<OpenedSessionRuntime["respondPermission"]>[0]>,
	cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]>,
	respondError?: Error,
): {
	readonly session: OpenedSessionRuntime;
	readonly permissionObserved: Promise<void>;
	readonly actionObserved: Promise<void>;
} {
	const resumeEvents = Promise.withResolvers<void>();
	const permissionObserved = Promise.withResolvers<void>();
	const actionObserved = Promise.withResolvers<void>();
	return {
		permissionObserved: permissionObserved.promise,
		actionObserved: actionObserved.promise,
		session: {
			...openedSession([], []),
			async cancel(request) {
				cancelled.push(request);
				actionObserved.resolve();
				resumeEvents.resolve();
				return {} as CancellationReceipt;
			},
			async respondPermission(request) {
				responded.push(request);
				actionObserved.resolve();
				if (respondError) throw respondError;
				resumeEvents.resolve();
				return {
					requestId: request.requestId as PermissionDecisionReceipt["requestId"],
					decision: request.decision,
				};
			},
			async *events(request) {
				yield started;
				yield wireEvent(3, "permission_request", {
					request_id: "permission-1",
					tool: "edit",
					kind: "write",
					summary: "Update the requested file",
					default_scope: null,
					rewindable: true,
				});
				permissionObserved.resolve();
				await Promise.race([
					resumeEvents.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield wireEvent(4, "assistant.message.delta", { text: "permission handled" });
				yield wireEvent(5, "turn_completed", {});
			},
		},
	};
}

describe("E4AgentStreamBridge", () => {
	test("submits the latest user turn and projects canonical text into the native stream", async () => {
		const submitted: SubmitInput[] = [];
		const events = [
			started,
			wireEvent(3, "assistant.message.delta", { text: "hello " }),
			wireEvent(4, "assistant.message.delta", { text: "world" }),
			wireEvent(5, "assistant.message.end", { text: "hello world" }),
			wireEvent(6, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(events, submitted),
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(submitted).toEqual(["new prompt"]);
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(result.provider).toBe(model.provider);
		await bridge.close();
	});

	test("drops replayed history and forwards live backend tool lifecycle events", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const events = [
			wireEvent(1, "assistant.message.delta", { text: "stale" }),
			started,
			wireEvent(3, "tool_call", {
				call_id: "call-1",
				tool: "read",
				arguments: { path: "README.md" },
				action: "inspect",
				diff_preview: null,
				progress: null,
			}),
			wireEvent(4, "tool.result", {
				call_id: "call-1",
				tool: "read",
				status: "completed",
				error: false,
				result: "contents",
				artifact_ref: null,
			}),
			wireEvent(5, "assistant.message.delta", { text: "fresh" }),
			wireEvent(6, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(events, submitted),
			replayHeadSequence: 1,
			emitAgentEvent: event => agentEvents.push(event),
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "fresh" }]);
		expect(agentEvents.map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		await bridge.close();
	});
	test("discards events from turns submitted by other session clients", async () => {
		const observed = Promise.withResolvers<void>();
		let external: LoggedSessionEvent | undefined = wireEvent(
			7,
			"assistant.message.delta",
			{ text: "external" },
			"external-turn-1",
		);
		const externalRef = new WeakRef(external);
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async *events(request) {
				yield external!;
				external = undefined;
				yield wireEvent(8, "turn_completed", {}, "external-turn-2");
				observed.resolve();
				if (request?.signal?.aborted) return;
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			await observed.promise;
			await Promise.resolve();
			Bun.gc(true);
			expect(externalRef.deref()).toBeUndefined();
		} finally {
			await bridge.close();
		}
	});

	test("replays local events that arrive before submit installs the turn sink", async () => {
		const submitted: SubmitInput[] = [];
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const racedDelta = {
			...wireEvent(3, "assistant.message.delta", { text: "raced" }),
			get turnId() {
				pendingSubmit.resolve(receipt);
				return started.turnId;
			},
		} as LoggedSessionEvent;
		const session: OpenedSessionRuntime = {
			...openedSession([racedDelta, wireEvent(4, "turn_completed", {})], submitted),
			async submit(input) {
				submitted.push(input);
				return pendingSubmit.promise;
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(submitted).toEqual(["new prompt"]);
		expect(result.content).toEqual([{ type: "text", text: "raced" }]);
		await bridge.close();
	});

	test("terminates a pending submit when the sole event observer fails", async () => {
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const observerFailed = Promise.withResolvers<void>();
		const submitReturned = Promise.withResolvers<void>();
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				const submittedReceipt = await pendingSubmit.promise;
				submitReturned.resolve();
				return submittedReceipt;
			},
			async *events() {
				observerFailed.resolve();
				yield await Promise.reject<LoggedSessionEvent>(new Error("event observer failed"));
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await bridge.stream(model, context);
			await observerFailed.promise;
			pendingSubmit.resolve(receipt);
			await submitReturned.promise;
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(stream.resultSettled).toBeTrue();
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("event observer failed");
		} finally {
			await bridge.close();
		}
	});

	for (const decision of ["allow", "deny"] as const) {
		test(`hands ${decision} permission decisions back to E4`, async () => {
			const responded: Array<Parameters<OpenedSessionRuntime["respondPermission"]>[0]> = [];
			const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
			const permission = permissionSession(responded, cancelled);
			let promptCount = 0;
			const bridge = new E4AgentStreamBridge({
				session: permission.session,
				replayHeadSequence: 0,
				emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
				requestPermission: async request => {
					promptCount += 1;
					expect(request.tool).toBe("edit");
					expect(request.kind).toBe("write");
					return decision;
				},
			});

			try {
				const stream = await bridge.stream(model, context);
				await permission.permissionObserved;
				expect(promptCount).toBe(1);
				await permission.actionObserved;
				const result = await stream.result();

				expect(result.content).toEqual([{ type: "text", text: "permission handled" }]);
				expect(responded).toEqual([{ requestId: "permission-1", decision }]);
				expect(cancelled).toEqual([]);
			} finally {
				await bridge.close();
			}
		});
	}

	test("cancels the turn when the OMP permission UI is cancelled", async () => {
		const responded: Array<Parameters<OpenedSessionRuntime["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		let promptCount = 0;
		const bridge = new E4AgentStreamBridge({
			session: permission.session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
			requestPermission: async () => {
				promptCount += 1;
				return "cancel";
			},
		});

		try {
			const stream = await bridge.stream(model, context);
			await permission.permissionObserved;
			expect(promptCount).toBe(1);
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("aborted");
			expect(responded).toEqual([]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails and cancels the turn when the OMP permission UI errors", async () => {
		const responded: Array<Parameters<OpenedSessionRuntime["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		let promptCount = 0;
		const bridge = new E4AgentStreamBridge({
			session: permission.session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
			requestPermission: async () => {
				promptCount += 1;
				throw new Error("permission UI failed");
			},
		});

		try {
			const stream = await bridge.stream(model, context);
			await permission.permissionObserved;
			expect(promptCount).toBe(1);
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("permission UI failed");
			expect(responded).toEqual([]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed when permission UI wiring is missing", async () => {
		const responded: Array<Parameters<OpenedSessionRuntime["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		const bridge = new E4AgentStreamBridge({
			session: permission.session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await bridge.stream(model, context);
			await permission.permissionObserved;
			expect(stream.resultSettled).toBeTrue();
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("permission UI");
			expect(responded).toEqual([]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed when OMP selects a model the fixed E4 session cannot accept", async () => {
		const submitted: SubmitInput[] = [];
		const selectedModel = { ...model, id: `${model.id}-selected` };
		const bridge = new E4AgentStreamBridge({
			session: openedSession([started, wireEvent(3, "turn_completed", {})], submitted),
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await bridge.stream(selectedModel, context);
			expect(stream.resultSettled).toBeTrue();
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not support per-turn model selection");
			expect(submitted).toEqual([]);
		} finally {
			await bridge.close();
		}
	});
});
