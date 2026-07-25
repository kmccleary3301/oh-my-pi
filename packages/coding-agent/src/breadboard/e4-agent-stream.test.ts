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
				yield wireEvent(3, "assistant.message.delta", { text: "partial output" });
				yield wireEvent(4, "permission_request", {
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
				yield wireEvent(5, "assistant.message.delta", { text: "permission handled" });
				yield wireEvent(6, "turn_completed", {});
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

	test("drops replayed history and projects durable native tool result events in agent-loop order", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const normalizedResult = {
			content: [{ type: "text" as const, text: '{"output":"contents"}\nArtifact: artifact-1' }],
			details: { result: { output: "contents" }, artifactRef: "artifact-1" },
		};
		const events = [
			wireEvent(1, "tool.result", {
				call_id: "call-1",
				tool: "read",
				status: "completed",
				error: false,
				result: { output: "stale" },
				artifact_ref: null,
			}),
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
				result: { output: "contents" },
				artifact_ref: "artifact-1",
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
		expect(agentEvents.map(event => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(agentEvents[0]).toEqual({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "README.md" },
			intent: "inspect",
		});
		expect(agentEvents[1]).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: normalizedResult,
			isError: false,
		});
		const messageStart = agentEvents[2];
		const messageEnd = agentEvents[3];
		if (messageStart?.type !== "message_start" || messageEnd?.type !== "message_end") {
			throw new Error("Expected native tool result message lifecycle");
		}
		expect(messageStart.message).toEqual({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: normalizedResult.content,
			details: normalizedResult.details,
			isError: false,
			timestamp: expect.any(Number),
		});
		expect(messageEnd.message).toEqual(messageStart.message);
		await bridge.close();
	});
	test("projects multiple assistant messages around tools exactly once and correlates nullable tool names by call ID", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const firstCall = wireEvent(6, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: { path: "README.md" },
			action: null,
			diff_preview: null,
			progress: null,
		});
		const firstResult = wireEvent(8, "tool.result", {
			call_id: "call-1",
			tool: null,
			status: "completed",
			error: false,
			result: "read result",
			artifact_ref: null,
		});
		const secondCompletion = wireEvent(12, "assistant.message.end", { text: "After." });
		const events = [
			started,
			wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
			wireEvent(4, "assistant.message.delta", { text: "Before." }),
			wireEvent(5, "assistant.message.end", { text: "Before." }),
			firstCall,
			firstCall,
			wireEvent(7, "tool_call", {
				call_id: "call-2",
				tool: "edit",
				arguments: { path: "README.md" },
				action: null,
				diff_preview: null,
				progress: null,
			}),
			firstResult,
			firstResult,
			wireEvent(9, "tool.result", {
				call_id: "call-2",
				tool: null,
				status: "completed",
				error: false,
				result: "edit result",
				artifact_ref: null,
			}),
			wireEvent(10, "assistant.message.start", { message_id: "message-2" }),
			wireEvent(11, "assistant.message.delta", { text: "After." }),
			secondCompletion,
			secondCompletion,
			wireEvent(13, "tool.result", {
				call_id: "uncorrelated-call",
				tool: null,
				status: "completed",
				error: false,
				result: "unknown result",
				artifact_ref: null,
			}),
			wireEvent(14, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(events, submitted),
			replayHeadSequence: 1,
			emitAgentEvent: event => agentEvents.push(event),
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "Before.After." }]);
		expect(agentEvents.filter(event => event.type === "tool_execution_start")).toHaveLength(2);
		const ends = agentEvents.filter(event => event.type === "tool_execution_end");
		expect(ends).toHaveLength(3);
		expect(ends.map(event => event.toolName)).toEqual(["read", "edit", "tool"]);
		expect(agentEvents.filter(event => event.type === "message_end")).toHaveLength(3);
		await bridge.close();
	});
	test("ignores duplicate and out-of-order event sequences for exact-once SSE projection", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const toolCall = wireEvent(3, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: { path: "README.md" },
			action: "inspect",
			diff_preview: null,
			progress: null,
		});
		const toolResultEvent = wireEvent(4, "tool.result", {
			call_id: "call-1",
			tool: "read",
			status: "completed",
			error: false,
			result: { output: "contents" },
			artifact_ref: null,
		});
		const textDelta = wireEvent(5, "assistant.message.delta", { text: "fresh" });
		const textCompleted = wireEvent(6, "assistant.message.end", { text: "fresh" });
		const events = [
			started,
			toolCall,
			toolCall,
			toolResultEvent,
			toolResultEvent,
			textDelta,
			textDelta,
			toolResultEvent,
			textCompleted,
			textCompleted,
			wireEvent(7, "turn_completed", {}),
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
		expect(agentEvents.map(event => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(agentEvents.filter(event => event.type === "message_end")).toHaveLength(1);
		await bridge.close();
	});
	for (const terminal of [
		{
			label: "failure",
			event: wireEvent(5, "turn_failed", {
				error: { code: "turn_execution_failed", message: "[redacted]" },
			}),
			stopReason: "error",
		},
		{
			label: "cancellation",
			event: wireEvent(5, "turn_cancelled", { reason: "user_requested" }),
			stopReason: "aborted",
		},
	] as const) {
		test(`preserves partial assistant text on turn ${terminal.label}`, async () => {
			const bridge = new E4AgentStreamBridge({
				session: openedSession(
					[
						started,
						wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
						wireEvent(4, "assistant.message.delta", { text: "partial output" }),
						terminal.event,
					],
					[],
				),
				replayHeadSequence: 0,
				emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			const stream = await bridge.stream(model, context);
			const result = await stream.result();

			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
			expect(result.stopReason).toBe(terminal.stopReason);
			await bridge.close();
		});
	}

	test("preserves partial assistant text when the event observer ends", async () => {
		const bridge = new E4AgentStreamBridge({
			session: openedSession(
				[
					started,
					wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
					wireEvent(4, "assistant.message.delta", { text: "partial output" }),
				],
				[],
			),
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
		expect(result.stopReason).toBe("error");
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
	test("preserves partial text while failing and cancelling an active turn before closing the SDK session", async () => {
		const submitObserved = Promise.withResolvers<void>();
		const partialObserved = Promise.withResolvers<void>();
		const lifecycle: string[] = [];
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				submitObserved.resolve();
				return receipt;
			},
			async cancel(request) {
				lifecycle.push(`cancel:${String(request.turnId)}`);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "partial output" });
				partialObserved.resolve();
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				lifecycle.push("close");
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		await submitObserved.promise;
		await drainMicrotasks();
		await partialObserved.promise;
		await bridge.close();

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
		expect(lifecycle).toEqual([`cancel:${String(receipt.turnId)}`, "close"]);
	});

	test("settles multiple pending submissions and their cancellations before closing the SDK session", async () => {
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: `${String(receipt.clientMessageId)}-2` as ClientMessageId,
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		const pendingSubmissions = [
			Promise.withResolvers<SubmitReceipt>(),
			Promise.withResolvers<SubmitReceipt>(),
			Promise.withResolvers<SubmitReceipt>(),
		];
		const allSubmissionsObserved = Promise.withResolvers<void>();
		const allCancellationsObserved = Promise.withResolvers<void>();
		const cancellationGates: Record<string, PromiseWithResolvers<CancellationReceipt>> = {
			[String(receipt.turnId)]: Promise.withResolvers<CancellationReceipt>(),
			[String(secondReceipt.turnId)]: Promise.withResolvers<CancellationReceipt>(),
		};
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		let submitIndex = 0;
		let sdkCloseCount = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				const pending = pendingSubmissions[submitIndex];
				submitIndex += 1;
				if (submitIndex === pendingSubmissions.length) allSubmissionsObserved.resolve();
				if (!pending) throw new Error("unexpected submission");
				return pending.promise;
			},
			async cancel(request) {
				cancelled.push(request);
				if (cancelled.length === 2) allCancellationsObserved.resolve();
				const gate = cancellationGates[String(request.turnId)];
				if (!gate) throw new Error(`unexpected cancellation ${String(request.turnId)}`);
				return gate.promise;
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				sdkCloseCount += 1;
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const streams = await Promise.all([
			bridge.stream(model, context),
			bridge.stream(model, context),
			bridge.stream(model, context),
		]);
		await allSubmissionsObserved.promise;
		const close = bridge.close();
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(0);

		pendingSubmissions[0]?.resolve(receipt);
		pendingSubmissions[1]?.resolve(secondReceipt);
		pendingSubmissions[2]?.reject(new Error("submit rejected during close"));
		await allCancellationsObserved.promise;
		expect(sdkCloseCount).toBe(0);
		expect(cancelled).toEqual([
			{ turnId: receipt.turnId, reason: "user_requested" },
			{ turnId: secondReceipt.turnId, reason: "user_requested" },
		]);

		cancellationGates[String(receipt.turnId)]?.resolve({} as CancellationReceipt);
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(0);
		cancellationGates[String(secondReceipt.turnId)]?.resolve({} as CancellationReceipt);
		await close;

		expect(sdkCloseCount).toBe(1);
		const results = await Promise.all(streams.map(stream => stream.result()));
		expect(results.map(result => result.stopReason)).toEqual(["aborted", "aborted", "aborted"]);
	});

	test("closes the SDK session after cancellation rejects", async () => {
		const submitObserved = Promise.withResolvers<void>();
		const lifecycle: string[] = [];
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				submitObserved.resolve();
				return receipt;
			},
			async cancel(request) {
				lifecycle.push(`cancel:${String(request.turnId)}`);
				throw new Error("cancel rejected");
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				lifecycle.push("close");
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		await submitObserved.promise;
		await drainMicrotasks();
		await bridge.close();

		expect((await stream.result()).stopReason).toBe("aborted");
		expect(lifecycle).toEqual([`cancel:${String(receipt.turnId)}`, "close"]);
	});

	test("coalesces concurrent and repeated close calls", async () => {
		const releaseClose = Promise.withResolvers<void>();
		let sdkCloseCount = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				sdkCloseCount += 1;
				await releaseClose.promise;
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const firstClose = bridge.close();
		const secondClose = bridge.close();
		let secondCloseSettled = false;
		void secondClose.then(() => {
			secondCloseSettled = true;
		});
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(1);
		expect(secondCloseSettled).toBeFalse();

		releaseClose.resolve();
		await Promise.all([firstClose, secondClose]);
		await bridge.close();
		expect(sdkCloseCount).toBe(1);
	});

	const drainMicrotasks = async (): Promise<void> => {
		for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
	};
	const observerExits = [
		{ label: "rejects", errorMessage: "event observer failed", expectedMessage: "event observer failed" },
		{
			label: "ends unexpectedly",
			errorMessage: undefined,
			expectedMessage: "BreadBoard event observer ended unexpectedly",
		},
	] as const;

	for (const observerExit of observerExits) {
		test(`terminates a pending submit when the sole event observer ${observerExit.label} before receipt`, async () => {
			const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
			const submitStarted = Promise.withResolvers<void>();
			const submitSettled = Promise.withResolvers<void>();
			const observerExited = Promise.withResolvers<void>();
			const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
			const session: OpenedSessionRuntime = {
				...openedSession([], []),
				async submit() {
					submitStarted.resolve();
					try {
						return await pendingSubmit.promise;
					} finally {
						submitSettled.resolve();
					}
				},
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
				async *events() {
					await submitStarted.promise;
					observerExited.resolve();
					if (observerExit.errorMessage) {
						yield await Promise.reject<LoggedSessionEvent>(new Error(observerExit.errorMessage));
					}
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
				await observerExited.promise;
				await drainMicrotasks();
				expect(stream.resultSettled).toBeTrue();
				const result = await stream.result();

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe(observerExit.expectedMessage);

				pendingSubmit.resolve(receipt);
				await submitSettled.promise;
				await drainMicrotasks();
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				pendingSubmit.resolve(receipt);
				await submitSettled.promise;
				await drainMicrotasks();
				await bridge.close();
			}
		});

		test(`cancels the admitted turn when its receipt races an observer that ${observerExit.label}`, async () => {
			const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
			const submitStarted = Promise.withResolvers<void>();
			const submitSettled = Promise.withResolvers<void>();
			const observerExited = Promise.withResolvers<void>();
			const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
			const session: OpenedSessionRuntime = {
				...openedSession([], []),
				async submit() {
					submitStarted.resolve();
					try {
						return await pendingSubmit.promise;
					} finally {
						submitSettled.resolve();
					}
				},
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
				async *events() {
					await submitStarted.promise;
					pendingSubmit.resolve(receipt);
					observerExited.resolve();
					if (observerExit.errorMessage) {
						yield await Promise.reject<LoggedSessionEvent>(new Error(observerExit.errorMessage));
					}
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
				await observerExited.promise;
				await submitSettled.promise;
				await drainMicrotasks();
				expect(stream.resultSettled).toBeTrue();
				const result = await stream.result();

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe(observerExit.expectedMessage);
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				await bridge.close();
			}
		});
	}

	test("keeps observer failure authoritative when the pending submit rejects", async () => {
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const submitSettled = Promise.withResolvers<void>();
		const observerExited = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				try {
					return await pendingSubmit.promise;
				} finally {
					submitSettled.resolve();
				}
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events() {
				await submitStarted.promise;
				observerExited.resolve();
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
			await observerExited.promise;
			await drainMicrotasks();
			expect(stream.resultSettled).toBeTrue();

			pendingSubmit.reject(new Error("submit failed"));
			await submitSettled.promise;
			await drainMicrotasks();
			const result = await stream.result();
			expect(result.errorMessage).toBe("event observer failed");
			expect(cancelled).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("cancels an admitted turn once when close races its observer failure", async () => {
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const submitSettled = Promise.withResolvers<void>();
		const observerExited = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				try {
					return await pendingSubmit.promise;
				} finally {
					submitSettled.resolve();
				}
			},
			async cancel(request) {
				cancelled.push(request);
				throw new Error("session already closed");
			},
			async *events() {
				await submitStarted.promise;
				observerExited.resolve();
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
			await observerExited.promise;
			await drainMicrotasks();
			expect(stream.resultSettled).toBeTrue();
			const close = bridge.close();

			pendingSubmit.resolve(receipt);
			await close;
			await submitSettled.promise;
			await drainMicrotasks();
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
		} finally {
			pendingSubmit.resolve(receipt);
			await submitSettled.promise;
			await drainMicrotasks();
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

				expect(result.content).toEqual([{ type: "text", text: "partial outputpermission handled" }]);
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
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
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
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
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
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
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
