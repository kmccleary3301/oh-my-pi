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

	test("rejects unsupported canonical families and preserves redacted display", async () => {
		const projector = new SessionEventProjector(sessionId);
		register(projector);
		const unsupported = await projector.apply(wireEvent(1, "assistant.reasoning.delta", { text: "secret" }));
		expect(unsupported.error?.kind).toBe("unsupported-event-family");
		expect(projector.state.lastAppliedSequence).toBe(0);

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
	test("accepts session skills metadata but still freezes on tool families", async () => {
		const projector = new SessionEventProjector(sessionId);
		const catalog = decodeLoggedSessionEvent({
			stable_cursor: true,
			id: "skills-catalog",
			seq: 1,
			session_id: "session-1",
			input_id: null,
			turn_id: null,
			timestamp_ms: 1,
			type: "skills_catalog",
			payload: {},
		});
		const selection = decodeLoggedSessionEvent({
			stable_cursor: true,
			id: "skills-selection",
			seq: 2,
			session_id: "session-1",
			input_id: null,
			turn_id: null,
			timestamp_ms: 2,
			type: "skills_selection",
			payload: {},
		});
		expect((await projector.apply(catalog)).status).toBe("applied");
		expect((await projector.apply(selection)).status).toBe("applied");
		const tool = await projector.apply(wireEvent(3, "tool_call", {}));
		expect(tool.error?.kind).toBe("unsupported-event-family");
	});
});
