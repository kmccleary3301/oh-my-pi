import { describe, expect, test } from "bun:test";
import type { CancellationReceipt, ClientMessageId, LoggedSessionEvent, SubmitReceipt } from "@breadboard/sdk";
import { decodeLoggedSessionEvent } from "@breadboard/sdk";
import { SessionEventProjector } from "./session-event-projector";

const wireEvent = (
	sequence: number,
	type: string,
	payload: unknown,
	eventId = `event-${sequence}`,
	inputId = "input-1",
	turnId = "turn-1",
): LoggedSessionEvent =>
	decodeLoggedSessionEvent({
		stable_cursor: true,
		id: eventId,
		seq: sequence,
		session_id: "session-1",
		input_id: inputId,
		turn_id: turnId,
		timestamp_ms: sequence,
		type,
		payload,
	});

const firstInput = wireEvent(1, "user_message", { text: "hello" });
if (firstInput.inputId === null || firstInput.turnId === null) throw new Error("fixture correlation missing");
const sessionId = firstInput.sessionId;
const inputId = firstInput.inputId;
const turnId = firstInput.turnId;
const receipt: SubmitReceipt = {
	clientMessageId: String(firstInput.eventId) as ClientMessageId,
	inputId,
	turnId,
	disposition: "started",
	originalDisposition: "started",
};

const started = wireEvent(2, "turn_start", {});
const deltaA = wireEvent(3, "assistant.message.delta", { text: "he" });
const deltaB = wireEvent(4, "assistant.message.delta", { text: "llo" });
const completed = wireEvent(5, "assistant.message.end", { text: "hello" });
const terminal = wireEvent(6, "turn_completed", {});

const register = (projector: SessionEventProjector): void => {
	const result = projector.registerSubmit(receipt, "hello");
	expect(result.status).toBe("accepted");
};

async function applyAll(projector: SessionEventProjector, events: readonly LoggedSessionEvent[]): Promise<void> {
	for (const event of events) {
		const result = await projector.apply(event);
		expect(result.status).toBe("applied");
	}
}

describe("SessionEventProjector", () => {
	test("accepts one user message and exact delta completion", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		expect(projector.state.userMessages.get(inputId)).toBe("hello");
		await applyAll(projector, [firstInput, started, deltaA, deltaB, completed, terminal]);
		const turn = projector.state.turns.get(turnId);
		expect(turn?.assistantText).toBe("hello");
		expect(turn?.terminalOutcome).toBe("completed");
		expect(turn?.hasAssistantCompletion).toBe(true);
	});

	test("supports completion-only turns", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [
			firstInput,
			started,
			wireEvent(3, "assistant.message.end", { text: "hello" }),
			wireEvent(4, "turn_completed", {}),
		]);
		expect(projector.state.turns.get(turnId)?.assistantText).toBe("hello");
	});

	test("freezes on mismatch and post-completion delta", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [firstInput, started, deltaA]);
		const mismatch = await projector.apply(wireEvent(4, "assistant.message.end", { text: "wrong" }));
		expect(mismatch.status).toBe("rejected");
		expect(mismatch.error?.kind).toBe("protocol");
		expect(projector.state.lastAppliedSequence).toBe(3);
	});

	test("requires completion before completed terminal and rejects duplicate terminals", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [firstInput, started]);
		const premature = await projector.apply(wireEvent(3, "turn_completed", {}));
		expect(premature.status).toBe("rejected");
		expect(premature.error?.kind).toBe("protocol");

		const healthy = new SessionEventProjector(sessionId);
		register(healthy);
		await applyAll(healthy, [
			firstInput,
			started,
			wireEvent(3, "assistant.message.end", { text: "hello" }),
			wireEvent(4, "turn_completed", {}),
		]);
		const duplicateTerminal = await healthy.apply(wireEvent(7, "turn_completed", {}));
		expect(duplicateTerminal.status).toBe("rejected");
	});

	test("ignores same-digest replay, rejects collisions, and freezes on gaps", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await projector.apply(firstInput);
		expect((await projector.apply(firstInput)).status).toBe("duplicate");
		expect(projector.state.lastAppliedSequence).toBe(1);
		const collision = await projector.apply(wireEvent(1, "user_message", { text: "changed" }, firstInput.eventId));
		expect(collision.status).toBe("rejected");

		const gapProjector = new SessionEventProjector(sessionId);
		register(gapProjector);
		const gap = await gapProjector.apply(wireEvent(2, "turn_start", {}));
		expect(gap.error?.kind).toBe("resume-gap");
		expect(gapProjector.state.frozen).toBe(true);
	});

	test("does not commit cursor when the caller apply fails", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await expect(
			projector.apply(firstInput, () => {
				throw new Error("render failed");
			}),
		).rejects.toThrow("render failed");
		expect(projector.state.lastAppliedSequence).toBe(0);
		expect(projector.state.userMessages.get(inputId)).toBe("hello");
		const applied = await projector.apply(firstInput);
		expect(applied.status).toBe("applied");
	});

	test("projects closed runtime families and preserves redacted display", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [firstInput, started]);
		const observed = await projector.apply(wireEvent(3, "assistant.reasoning.delta", { text: "secret" }));
		expect(observed.effect?.kind).toBe("runtime-event-observed");
		expect(projector.state.lastAppliedSequence).toBe(3);
		expect(projector.state.frozen).toBe(false);

		const redacted = new SessionEventProjector(sessionId);
		const secretReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: String(firstInput.eventId) as ClientMessageId,
		};
		redacted.registerSubmit(secretReceipt, "Bearer sk-test_123456789012");
		expect(redacted.state.userMessages.get(inputId)).toBe("[redacted]");
	});
	test("redacts a sensitive value split across assistant deltas", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [firstInput, started]);
		await projector.apply(wireEvent(3, "assistant.message.delta", { text: "Bearer sk-" }));
		const second = await projector.apply(wireEvent(4, "assistant.message.delta", { text: "test_123456789012" }));
		if (second.effect?.kind !== "assistant-delta") throw new Error("expected assistant delta effect");
		expect(second.effect.display.text).toBe("[redacted]");
		expect(projector.state.turns.get(turnId)?.assistantText).toBe("[redacted]");
	});
	test("bootstraps complete-history attach replay without fabricating a receipt", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [
			firstInput,
			started,
			wireEvent(3, "assistant.message.end", { text: "hello" }),
			wireEvent(4, "turn_completed", {}),
		]);
		const turn = projector.state.turns.get(turnId);
		expect(turn?.hasInputEcho).toBe(true);
		expect(turn?.terminalOutcome).toBe("completed");
	});
	test("replays an externally cancelled active turn without local receipt", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [firstInput, wireEvent(2, "turn_cancelled", { reason: "user_requested" })]);
		expect(projector.state.turns.get(turnId)?.terminalOutcome).toBe("cancelled");
	});
	test("accepts a queued cancellation before input observation", async () => {
		const projector = new SessionEventProjector(sessionId);
		projector.registerSubmit({ ...receipt, disposition: "queued", originalDisposition: "queued" }, "hello");
		const cancellation: CancellationReceipt = {
			cancellationRequestId: "cancel-id" as CancellationReceipt["cancellationRequestId"],
			cancellationRequestKey: "cancel-key" as CancellationReceipt["cancellationRequestKey"],
			inputId,
			turnId,
			disposition: "queued_cancelled",
			originalDisposition: "queued_cancelled",
		};
		expect(projector.registerCancellation(cancellation).status).toBe("accepted");

		await applyAll(projector, [wireEvent(1, "turn_cancelled", { reason: "user_requested" })]);

		const turn = projector.state.turns.get(turnId);
		expect(turn?.hasInputEcho).toBe(false);
		expect(turn?.hasStarted).toBe(false);
		expect(turn?.terminalOutcome).toBe("cancelled");
	});

	test("freezes when replay reuses an input ID for another turn", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [firstInput]);
		const collision = wireEvent(2, "user_message", { text: "other" }, "event-2", "input-1", "turn-2");

		const result = await projector.apply(collision);

		expect(result.status).toBe("rejected");
		expect(result.error).toMatchObject({ kind: "protocol", code: "input_correlation_collision" });
		expect(projector.state.lastAppliedSequence).toBe(1);
	});
	test("keeps replay predecessors in FIFO order before a queued local turn", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [firstInput, started]);
		const secondInput = wireEvent(5, "user_message", { text: "queued" }, "event-5", "input-2", "turn-2");
		if (secondInput.inputId === null || secondInput.turnId === null)
			throw new Error("queued fixture correlation missing");
		const queuedReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: String("client-2") as ClientMessageId,
			inputId: secondInput.inputId,
			turnId: secondInput.turnId,
			disposition: "queued",
			originalDisposition: "queued",
		};
		const registered = projector.registerSubmit(queuedReceipt, "queued");
		expect(registered.status).toBe("accepted");
		await applyAll(projector, [
			wireEvent(3, "assistant.message.end", { text: "hello" }),
			wireEvent(4, "turn_completed", {}),
			secondInput,
			wireEvent(6, "turn_start", {}, "event-6", "input-2", "turn-2"),
		]);
		expect(projector.state.turns.get(secondInput.turnId)?.hasStarted).toBe(true);
	});
	test("passes text-turn lifecycle metadata through to a completed terminal", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [
			firstInput,
			started,
			wireEvent(3, "ctree_node", {}),
			wireEvent(4, "assistant.message.delta", { text: "hello" }),
			wireEvent(5, "ctree_snapshot", {}),
			wireEvent(6, "completion", {}),
			wireEvent(7, "log_link", {}),
			wireEvent(8, "run_finished", {}),
			wireEvent(9, "assistant.message.end", { text: "hello" }),
			wireEvent(10, "turn_completed", {}),
		]);
		expect(projector.state.turns.get(turnId)?.terminalOutcome).toBe("completed");
	});
	test("keeps runtime error context nonterminal until the correlated failure", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [
			firstInput,
			started,
			wireEvent(3, "error", { error: { code: "turn_execution_failed", message: "[redacted]" } }),
		]);
		expect(projector.state.turns.get(turnId)?.terminalOutcome).toBeNull();

		await applyAll(projector, [
			wireEvent(4, "turn_failed", { error: { code: "turn_execution_failed", message: "[redacted]" } }),
		]);
		expect(projector.state.turns.get(turnId)?.terminalOutcome).toBe("failed");
	});
	test("projects a tool-call-only assistant message without fabricating empty text completion", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		await applyAll(projector, [
			firstInput,
			started,
			wireEvent(3, "assistant_message", {
				text: "",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-1",
							type: "function",
							function: { name: "list_dir", arguments: "{\"path\":\".\"}" },
						},
					],
				},
			}),
			wireEvent(4, "tool_call", {
				call_id: "call-1",
				tool: "list_dir",
				call: {
					id: "call-1",
					type: "function",
					function: { name: "list_dir", arguments: "{\"path\":\".\"}" },
				},
			}),
			wireEvent(5, "tool_result", {
				call_id: "call-1",
				tool: "list_dir",
				status: "ok",
				error: false,
				result: { path: ".", entries: [] },
			}),
			wireEvent(6, "assistant_message", { text: "smoke result" }),
			wireEvent(7, "turn_completed", {}),
		]);
		expect(projector.state.turns.get(turnId)).toMatchObject({
			assistantText: "smoke result",
			hasAssistantCompletion: true,
			terminalOutcome: "completed",
		});
	});
	test("projects correlated tool, permission, and task events without freezing the session", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		const events = [
			firstInput,
			started,
			wireEvent(3, "tool_call", {
				call_id: "call-1",
				tool: "edit",
				arguments: { path: "src/app.ts" },
				action: "update",
				diff_preview: "@@ -1 +1 @@",
				progress: { completed: 0, total: 1 },
			}),
			wireEvent(4, "permission_request", {
				request_id: "permission-1",
				tool: "edit",
				kind: "write",
				summary: "Update src/app.ts",
				default_scope: "project",
				rewindable: true,
			}),
			wireEvent(5, "permission_response", {
				request_id: "permission-1",
				decision: "allow",
			}),
			wireEvent(6, "task_event", {
				task_id: "task-1",
				kind: "subagent_spawned",
				status: "running",
				description: "Review the edit",
				child_session_id: "session-child-1",
				parent_session_id: "session-1",
			}),
			wireEvent(7, "tool_result", {
				call_id: "call-1",
				tool: "edit",
				status: "ok",
				error: false,
				result: { changed: true },
				artifact_ref: "artifact://edit-1",
			}),
		];
		const effects = [];
		for (const event of events) effects.push((await projector.apply(event)).effect);

		expect(effects.map(effect => effect?.kind)).toEqual([
			"input-observed",
			"turn-started",
			"tool-call-started",
			"permission-requested",
			"permission-responded",
			"task-event-observed",
			"tool-call-completed",
		]);
		expect([...projector.state.toolCalls.values()][0]).toMatchObject({
			tool: "edit",
			status: "completed",
			artifactRef: "artifact://edit-1",
		});
		expect(projector.state.frozen).toBe(false);
	});
	test("projects todo snapshots through a dedicated native effect", async () => {
		const projector = new SessionEventProjector(sessionId);
		const effects = [];
		for (const event of [
			firstInput,
			started,
			wireEvent(3, "todo_event", {
				todo: {
					op: "snapshot",
					scope_label: "Implementation",
					items: [{ id: "task-1", title: "Render todo rows", status: "in_progress" }],
				},
			}),
		]) {
			effects.push((await projector.apply(event)).effect);
		}
		expect(effects.at(-1)).toMatchObject({
			kind: "todo-updated",
			payload: { todo: { op: "snapshot" } },
		});
		expect(projector.state.frozen).toBe(false);
	});

	test("rejects unknown and duplicate permission correlations", async () => {
		const unknown = new SessionEventProjector(sessionId);
		await applyAll(unknown, [firstInput, started]);
		const unknownResponse = await unknown.apply(
			wireEvent(3, "permission_response", { request_id: "missing", decision: "deny" }),
		);
		expect(unknownResponse.error).toMatchObject({ kind: "protocol", code: "unknown_permission_correlation" });

		const duplicate = new SessionEventProjector(sessionId);
		await applyAll(duplicate, [
			firstInput,
			started,
			wireEvent(3, "permission_request", {
				request_id: "permission-1",
				tool: "edit",
				kind: "write",
				rewindable: true,
			}),
			wireEvent(4, "permission_response", { request_id: "permission-1", decision: "allow" }),
		]);
		const repeated = await duplicate.apply(
			wireEvent(5, "permission_response", { request_id: "permission-1", decision: "deny" }),
		);
		expect(repeated.error).toMatchObject({ kind: "protocol", code: "duplicate_permission_response" });
	});

	test("fails closed when the backend reports an unsupported runtime family", async () => {
		const projector = new SessionEventProjector(sessionId);
		await applyAll(projector, [firstInput, started]);
		const result = await projector.apply(
			wireEvent(3, "error", { code: "unsupported_runtime_event_family" }),
		);
		expect(result.status).toBe("rejected");
		expect(result.error).toMatchObject({ kind: "unsupported-event-family", eventKind: "runtime_error_observed" });
		expect(projector.state.frozen).toBe(true);
	});
});
