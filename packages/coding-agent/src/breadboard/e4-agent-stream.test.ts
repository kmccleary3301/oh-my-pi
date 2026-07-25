import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CancellationReceipt,
	ClientMessageId,
	LoggedSessionEvent,
	OpenedSessionRuntime,
	PermissionDecisionReceipt,
	StructuredSubmit,
	SubmitInput,
	SubmitReceipt,
} from "@breadboard/sdk";
import { decodeLoggedSessionEvent, LifecycleE4ClientError } from "@breadboard/sdk";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { collectPendingToolCalls } from "../session/exit-diagnostics";
import { convertToLlm } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { E4AgentStreamBridge } from "./e4-agent-stream";

const wireEvent = (
	sequence: number,
	type: string,
	payload: unknown,
	turnId: string | null = "turn-1",
): LoggedSessionEvent =>
	decodeLoggedSessionEvent({
		stable_cursor: true,
		id: `event-${sequence}`,
		seq: sequence,
		session_id: "session-1",
		input_id: turnId === null ? null : "input-1",
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
		const agentEvents: AgentEvent[] = [];
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
			emitAgentEvent: event => agentEvents.push(event),
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toMatchObject({ text: "new prompt" });
		expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(result.provider).toBe(model.provider);
		expect(agentEvents).toEqual([]);
		await bridge.close();
	});

	test("reuses the exact structured submission after an ambiguous failure without retrying automatically", async () => {
		const submitted: SubmitInput[] = [];
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) throw new LifecycleE4ClientError({ kind: "timeout" });
				retryStarted.resolve();
				const structured = input as StructuredSubmit;
				return {
					...receipt,
					clientMessageId: structured.clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const firstStream = await bridge.stream(model, context);
			const firstResult = await firstStream.result();
			expect(firstResult.stopReason).toBe("error");
			expect(submitted).toHaveLength(1);

			const retryStream = await bridge.stream(model, context);
			const retryResult = await retryStream.result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
			expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
		} finally {
			await bridge.close();
		}
	});

	test("fails closed on a different prompt while an ambiguous submission is unresolved", async () => {
		const submitted: SubmitInput[] = [];
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				throw new LifecycleE4ClientError({ kind: "caller-abort" });
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const differentContext: Context = {
			messages: [{ role: "user", content: "different prompt", timestamp: 4 }],
		};

		try {
			expect((await (await bridge.stream(model, context)).result()).stopReason).toBe("error");
			const differentResult = await (await bridge.stream(model, differentContext)).result();

			expect(differentResult.stopReason).toBe("error");
			expect(differentResult.errorMessage).toContain("previous submission is unresolved");
			expect(submitted).toHaveLength(1);
		} finally {
			await bridge.close();
		}
	});

	test("compares attachment uploads by content digest before reusing an ambiguous submission", async () => {
		const submitted: SubmitInput[] = [];
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					throw new LifecycleE4ClientError({
						kind: "http",
						status: 0,
						code: null,
						correlation: {},
						body: "[redacted]",
					});
				}
				retryStarted.resolve();
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const withImage = (data: string): Context => ({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect image" },
						{ type: "image", mimeType: "image/png", data },
					],
					timestamp: 4,
				},
			],
		});
		const original = withImage(Buffer.from([0, 1, 2]).toString("base64"));
		const differentBytes = withImage(Buffer.from([0, 1, 3]).toString("base64"));
		const equivalent = withImage(Buffer.from([0, 1, 2]).toString("base64"));

		try {
			expect((await (await bridge.stream(model, original)).result()).stopReason).toBe("error");
			const differentResult = await (await bridge.stream(model, differentBytes)).result();
			expect(differentResult.errorMessage).toContain("previous submission is unresolved");
			expect(submitted).toHaveLength(1);

			expect((await (await bridge.stream(model, equivalent)).result()).stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("fails and cancels only the sink correlated to a turn-owned runtime error", async () => {
		const submissionsReady = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		let submissionCount = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit(input) {
				submissionCount += 1;
				if (submissionCount === 2) submissionsReady.resolve();
				const selected = submissionCount === 1 ? receipt : secondReceipt;
				return {
					...selected,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await Promise.race([
					submissionsReady.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_start", {}, "turn-2");
				yield wireEvent(4, "assistant.message.delta", { text: "partial" });
				yield wireEvent(5, "error", { code: "worker_crash", message: "sensitive backend detail" });
				yield wireEvent(6, "turn_completed", {});
				yield wireEvent(7, "assistant.message.delta", { text: "healthy" }, "turn-2");
				yield wireEvent(8, "turn_completed", {}, "turn-2");
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const secondContext: Context = {
			messages: [{ role: "user", content: "second prompt", timestamp: 4 }],
		};

		try {
			const firstStream = await bridge.stream(model, context);
			const secondStream = await bridge.stream(model, secondContext);
			const [firstResult, secondResult] = await Promise.all([firstStream.result(), secondStream.result()]);

			expect(firstResult.stopReason).toBe("error");
			expect(firstResult.content).toEqual([{ type: "text", text: "partial" }]);
			expect(firstResult.errorMessage).toBe("BreadBoard runtime error [worker_crash]: [redacted]");
			expect(firstResult.errorMessage).not.toContain("sensitive backend detail");
			expect(secondResult.stopReason).toBe("stop");
			expect(secondResult.content).toEqual([{ type: "text", text: "healthy" }]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
		} finally {
			await bridge.close();
		}
	});

	test("invalidates the bridge on a session-scoped runtime error", async () => {
		const secondSubmitStarted = Promise.withResolvers<void>();
		const releaseSecondSubmit = Promise.withResolvers<void>();
		const runtimeErrorObserved = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		let submissionCount = 0;
		const session: OpenedSessionRuntime = {
			...openedSession([], []),
			async submit(input) {
				submissionCount += 1;
				if (submissionCount === 1) {
					return {
						...receipt,
						clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
					};
				}
				secondSubmitStarted.resolve();
				await releaseSecondSubmit.promise;
				return {
					...secondReceipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await Promise.race([
					secondSubmitStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "partial" });
				runtimeErrorObserved.resolve();
				yield wireEvent(4, "error", { code: "engine_crash", message: "sensitive backend detail" }, null);
				await releaseSecondSubmit.promise;
				if (request?.signal?.aborted) return;
				yield wireEvent(5, "turn_completed", {});
				yield wireEvent(6, "turn_start", {}, "turn-2");
				yield wireEvent(7, "assistant.message.delta", { text: "should not run" }, "turn-2");
				yield wireEvent(8, "turn_completed", {}, "turn-2");
			},
		};
		const bridge = new E4AgentStreamBridge({
			session,
			replayHeadSequence: 0,
			emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const secondContext: Context = {
			messages: [{ role: "user", content: "second prompt", timestamp: 4 }],
		};
		const laterContext: Context = {
			messages: [{ role: "user", content: "later prompt", timestamp: 5 }],
		};

		try {
			const activeStream = await bridge.stream(model, context);
			const submittingStream = await bridge.stream(model, secondContext);
			await runtimeErrorObserved.promise;
			releaseSecondSubmit.resolve();
			const [activeResult, submittingResult] = await Promise.all([activeStream.result(), submittingStream.result()]);

			expect(activeResult.stopReason).toBe("error");
			expect(activeResult.content).toEqual([{ type: "text", text: "partial" }]);
			expect(activeResult.errorMessage).toBe("BreadBoard runtime error [engine_crash]: [redacted]");
			expect(activeResult.errorMessage).not.toContain("sensitive backend detail");
			expect(submittingResult.stopReason).toBe("error");
			expect(submittingResult.errorMessage).toBe("BreadBoard runtime error [engine_crash]: [redacted]");

			const laterResult = await (await bridge.stream(model, laterContext)).result();
			expect(laterResult.stopReason).toBe("error");
			expect(laterResult.errorMessage).toBe("BreadBoard runtime error [engine_crash]: [redacted]");
			expect(submissionCount).toBe(2);
			expect(cancelled).toEqual([
				{ turnId: receipt.turnId, reason: "timeout" },
				{ turnId: secondReceipt.turnId, reason: "timeout" },
			]);
		} finally {
			releaseSecondSubmit.resolve();
			await bridge.close();
		}
	});

	for (const runtimeFamily of [
		{
			label: "an unsupported backend runtime family",
			event: wireEvent(4, "error", { code: "unsupported_runtime_event_family" }),
			expectedMessage: "BreadBoard runtime error [unsupported_runtime_event_family]: [redacted]",
		},
		{
			label: "an unknown canonical runtime family",
			event: {
				...wireEvent(4, "warning", {}),
				kind: "future_runtime_observed",
			} as unknown as LoggedSessionEvent,
			expectedMessage: "BreadBoard unsupported canonical runtime event family",
		},
	] as const) {
		test(`does not silently drop ${runtimeFamily.label}`, async () => {
			const cancelled: Array<Parameters<OpenedSessionRuntime["cancel"]>[0]> = [];
			const session: OpenedSessionRuntime = {
				...openedSession(
					[
						started,
						wireEvent(3, "assistant.message.delta", { text: "partial" }),
						runtimeFamily.event,
						wireEvent(5, "turn_completed", {}),
					],
					[],
				),
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
			};
			const bridge = new E4AgentStreamBridge({
				session,
				replayHeadSequence: 0,
				emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			try {
				const result = await (await bridge.stream(model, context)).result();
				expect(result.stopReason).toBe("error");
				expect(result.content).toEqual([{ type: "text", text: "partial" }]);
				expect(result.errorMessage).toBe(runtimeFamily.expectedMessage);
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				await bridge.close();
			}
		});
	}

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
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		const toolCallMessageStart = agentEvents[0];
		const toolCallMessageEnd = agentEvents[1];
		if (toolCallMessageStart?.type !== "message_start" || toolCallMessageEnd?.type !== "message_end") {
			throw new Error("Expected native assistant tool-call message lifecycle");
		}
		expect(toolCallMessageStart.message).toEqual({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
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
			stopReason: "toolUse",
			timestamp: 3,
		});
		expect(toolCallMessageEnd.message).toEqual(toolCallMessageStart.message);
		expect(agentEvents[2]).toEqual({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "README.md" },
			intent: "inspect",
		});
		expect(agentEvents[3]).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: normalizedResult,
			isError: false,
		});
		const messageStart = agentEvents[4];
		const messageEnd = agentEvents[5];
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
			call_id: "call-2",
			tool: null,
			status: "completed",
			error: false,
			result: "edit result",
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
				call_id: "call-1",
				tool: null,
				status: "completed",
				error: false,
				result: "read result",
				artifact_ref: null,
			}),
			wireEvent(10, "assistant.message.start", { message_id: "message-2" }),
			wireEvent(11, "assistant.message.delta", { text: "After." }),
			secondCompletion,
			secondCompletion,
			wireEvent(13, "tool_call", {
				call_id: "call-1",
				tool: "read",
				arguments: { path: "README.md" },
				action: null,
				diff_preview: null,
				progress: null,
			}),
			wireEvent(14, "tool.result", {
				call_id: "call-1",
				tool: null,
				status: "completed",
				error: false,
				result: "duplicate read result",
				artifact_ref: null,
			}),
			wireEvent(15, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(events, submitted),
			replayHeadSequence: 1,
			emitAgentEvent: event => agentEvents.push(event),
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await bridge.stream(model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "After." }]);
		expect(agentEvents.filter(event => event.type === "tool_execution_start")).toHaveLength(2);
		const ends = agentEvents.filter(event => event.type === "tool_execution_end");
		expect(ends).toHaveLength(2);
		expect(ends.map(event => event.toolName)).toEqual(["edit", "read"]);
		const projectedMessages = agentEvents.filter(event => event.type === "message_end").map(event => event.message);
		expect(projectedMessages.map(message => message.role)).toEqual([
			"assistant",
			"assistant",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(projectedMessages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Before." }],
		});
		await bridge.close();
	});
	test("ignores duplicate and out-of-order event sequences for exact-once SSE projection", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const toolCall = wireEvent(3, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: null,
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
			toolResultEvent,
			toolResultEvent,
			toolCall,
			toolCall,
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
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(agentEvents.filter(event => event.type === "message_end")).toHaveLength(2);
		const toolCallMessage = agentEvents[1];
		if (toolCallMessage?.type !== "message_end" || toolCallMessage.message.role !== "assistant") {
			throw new Error("Expected exact native assistant tool-call message");
		}
		expect(toolCallMessage.message.content as unknown).toEqual([
			{ type: "toolCall", id: "call-1", name: "read", arguments: null },
		]);
		expect(agentEvents[2]).toMatchObject({ type: "tool_execution_start", args: null });
		await bridge.close();
	});

	test("persists backend tool calls before results in AgentSession JSONL and native context", async () => {
		using tempDir = TempDir.createSync("@breadboard-e4-agent-session-order-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent AgentSession JSONL");

		const submitted: SubmitInput[] = [];
		const admitted = Promise.withResolvers<void>();
		const events = [
			started,
			wireEvent(3, "assistant.message.start", { message_id: "message-before-tool" }),
			wireEvent(4, "assistant.message.delta", { text: "Before." }),
			wireEvent(5, "assistant.message.end", { text: "Before." }),
			wireEvent(6, "tool_call", {
				call_id: "call-native-order",
				tool: "read",
				arguments: { path: "README.md", selectors: [1, 3] },
				action: "inspect",
				diff_preview: null,
				progress: null,
			}),
			wireEvent(7, "tool.result", {
				call_id: "call-native-order",
				tool: null,
				status: "completed",
				error: false,
				result: { output: "contents" },
				artifact_ref: null,
			}),
			wireEvent(8, "assistant.message.start", { message_id: "message-after-tool" }),
			wireEvent(9, "assistant.message.delta", { text: "Finished." }),
			wireEvent(10, "assistant.message.end", { text: "Finished." }),
			wireEvent(11, "turn_completed", {}),
		];
		const runtime: OpenedSessionRuntime = {
			...openedSession([], submitted),
			async submit(input) {
				submitted.push(input);
				admitted.resolve();
				return receipt;
			},
			async *events(request) {
				await admitted.promise;
				for (const event of events) {
					if (request?.signal?.aborted) return;
					yield event;
				}
			},
		};
		let agent!: Agent;
		const bridge = new E4AgentStreamBridge({
			session: runtime,
			replayHeadSequence: 1,
			emitAgentEvent: event => agent.emitExternalEvent(event),
			modelPolicy: { kind: "fixed", model },
		});
		agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: bridge.stream,
			convertToLlm,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		try {
			await agentSession.sendUserMessage("Inspect the README");
			await agentSession.waitForIdle();
			for (let pass = 0; pass < 20; pass += 1) {
				const persistedMessageCount = sessionManager.getBranch().filter(entry => entry.type === "message").length;
				if (persistedMessageCount === 5) break;
				await Promise.resolve();
			}
			await sessionManager.flush();

			expect(submitted).toHaveLength(1);
			expect(submitted[0]).toMatchObject({ text: "Inspect the README" });
			expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
			expect(agent.state.messages.map(message => message.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(convertToLlm(agent.state.messages).map(message => message.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(agent.state.messages[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Before." }],
			});
			expect(agent.state.messages[2]).toMatchObject({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-native-order",
						name: "read",
						arguments: { path: "README.md", selectors: [1, 3] },
					},
				],
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
				stopReason: "toolUse",
				timestamp: 6,
			});
			expect(agent.state.messages[3]).toMatchObject({
				role: "toolResult",
				toolCallId: "call-native-order",
				toolName: "read",
				isError: false,
			});
			expect(agent.state.messages[4]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Finished." }],
			});
			expect(agent.state.pendingToolCalls.size).toBe(0);
			expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);

			const jsonlEntries = fs
				.readFileSync(sessionFile, "utf8")
				.trimEnd()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							type?: string;
							message?: { role?: string; content?: unknown };
						},
				);
			const persistedMessages = jsonlEntries.filter(entry => entry.type === "message").map(entry => entry.message);
			expect(persistedMessages.map(message => message?.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(persistedMessages[1]?.content).toEqual([{ type: "text", text: "Before." }]);
			expect(persistedMessages[4]?.content).toEqual([{ type: "text", text: "Finished." }]);

			const reloaded = await SessionManager.open(sessionFile, tempDir.path());
			try {
				const reloadedMessages = reloaded
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message);
				expect(reloadedMessages.map(message => message.role)).toEqual([
					"user",
					"assistant",
					"assistant",
					"toolResult",
					"assistant",
				]);
				expect(reloadedMessages[1]).toEqual(agent.state.messages[1]);
				expect(reloadedMessages[2]).toEqual(agent.state.messages[2]);
				expect(reloadedMessages[3]).toEqual(agent.state.messages[3]);
				expect(reloadedMessages[4]).toEqual(agent.state.messages[4]);
				expect(collectPendingToolCalls(reloaded.getBranch())).toEqual([]);
			} finally {
				await reloaded.close();
			}
		} finally {
			await bridge.close();
			await agentSession.dispose();
			authStorage.close();
		}
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

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toMatchObject({ text: "new prompt" });
		expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
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
