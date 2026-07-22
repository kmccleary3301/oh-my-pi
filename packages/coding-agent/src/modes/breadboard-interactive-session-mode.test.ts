import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
	type CancellationReceipt,
	type CancellationRequestId,
	type CancellationRequestKey,
	CanonicalE4ClientError,
	type ClientMessageId,
	type EventId,
	ExactEmptyPayload,
	type InputId,
	type LoggedSessionEvent,
	type ObserveSessionRequest,
	type OpenedSession,
	projectDisplayText,
	type PermissionRequestId,
	type ReplayContractDigest,
	type SessionId,
	type SessionSnapshot,
	type SubmitInput,
	type SubmitReceipt,
	type TaskId,
	type ToolCallId,
	type TurnId,
} from "@breadboard/sdk";
import type { BreadboardSessionPort } from "../breadboard/session-port";
import {
	BreadboardInteractiveSessionController,
	BreadboardInteractiveSessionMode,
} from "./breadboard-interactive-session-mode";
import { initTheme } from "./theme/theme";

beforeAll(async () => {
	await initTheme();
});
const asId = <T extends string>(value: string): T => value as T;
const sessionId = asId<SessionId>("session-test");
const inputId = asId<InputId>("input-test");
const turnId = asId<TurnId>("turn-test");
const clientMessageId = asId<ClientMessageId>("client-test");

function snapshot(): SessionSnapshot {
	return {
		sessionId,
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		model: null,
		mode: null,
		turnAdmission: "idle",
		activeTurnId: null,
		queuedTurnCount: 0,
		terminalTurns: [],
		replayRetention: {
			maxEvents: 1000,
			maxAgeMs: 86_400_000,
			configurationDigest: asId<ReplayContractDigest>("sha256:test"),
		},
		earliestRetainedSequence: null,
		earliestRetainedEventId: null,
		headSequence: 0,
		headEventId: null,
		retainedHistory: "complete",
		sessionReplayContractDigest: asId<ReplayContractDigest>("sha256:test"),
	};
}

const receipt: SubmitReceipt = {
	clientMessageId,
	inputId,
	turnId,
	disposition: "started",
	originalDisposition: "started",
};

function event(
	kind: LoggedSessionEvent["kind"],
	sequence: number,
	payload: LoggedSessionEvent["payload"],
): LoggedSessionEvent {
	return {
		kind,
		eventId: asId<EventId>(`event-${sequence}`),
		sequence,
		sessionId,
		inputId,
		turnId,
		occurredAtMs: sequence,
		payload,
	} as LoggedSessionEvent;
}

function runtime(
	options: {
		submit?: (request: SubmitInput) => Promise<SubmitReceipt>;
		cancel?: () => Promise<CancellationReceipt>;
		events?: readonly LoggedSessionEvent[];
		respondPermission?: OpenedSession["respondPermission"];
	} = {},
) {
	let closeCalls = 0;
	let cancelCalls = 0;
	let permissionDecisionCalls = 0;
	let lastPermissionDecision: Parameters<OpenedSession["respondPermission"]>[0] | undefined;
	let markEventsDelivered: () => void;
	const eventsDelivered = new Promise<void>(resolve => {
		markEventsDelivered = resolve;
	});
	const opened: OpenedSession = {
		sessionId,
		snapshot: async () => snapshot(),
		submit: options.submit ?? (async () => receipt),
		cancel: async request => {
			cancelCalls++;
			if (options.cancel !== undefined) return options.cancel();
			return {
				cancellationRequestId: asId<CancellationRequestId>("cancel-id"),
				cancellationRequestKey: request.cancellationRequestKey
					? asId<CancellationRequestKey>(request.cancellationRequestKey)
					: asId<CancellationRequestKey>("cancel-key"),
				inputId,
				turnId,
				disposition: "cancellation_requested",
				originalDisposition: "cancellation_requested",
			};
		},
		respondPermission: async request => {
			permissionDecisionCalls++;
			lastPermissionDecision = request;
			if (options.respondPermission !== undefined) return options.respondPermission(request);
			return {
				requestId: asId<PermissionRequestId>(String(request.requestId)),
				decision: request.decision,
			};
		},
		events: async function* (_request?: ObserveSessionRequest) {
			for (const item of options.events ?? []) yield item;
			markEventsDelivered();
		},
		close: async () => {
			closeCalls++;
		},
	};
	return {
		opened,
		eventsDelivered,
		get closeCalls() {
			return closeCalls;
		},
		get cancelCalls() {
			return cancelCalls;
		},
		get permissionDecisionCalls() {
			return permissionDecisionCalls;
		},
		get lastPermissionDecision() {
			return lastPermissionDecision;
		},
	};
}

async function acceptedController(options: Parameters<typeof runtime>[0] = {}) {
	const transport = runtime(options);
	const controller = new BreadboardInteractiveSessionController(transport.opened, { startUi: false });
	controller.start();
	await controller.submit("  hello  ");
	return { controller, transport };
}

describe("BreadboardInteractiveSessionController", () => {
	it("clears an accepted draft and appends one keyed native user row", async () => {
		const { controller } = await acceptedController();
		expect(controller.editor.getText()).toBe("");
		expect(controller.userRows.size).toBe(1);
		expect(controller.transcript.children).toHaveLength(1);
	});

	it("restores the normalized draft when submit is unresolved", async () => {
		const { controller } = await acceptedController({
			submit: async () => {
				throw new CanonicalE4ClientError({ kind: "timeout" });
			},
		});
		await controller.submit("  retry me  ");
		expect(controller.editor.getText()).toBe("retry me");
		expect(controller.userRows.size).toBe(0);
		await controller.close();
	});

	it("retries an uncertain submit with the exact same key and body", async () => {
		const requests: SubmitInput[] = [];
		let attempt = 0;
		const transport = runtime({
			submit: async request => {
				requests.push(request);
				attempt++;
				if (attempt === 1) throw new CanonicalE4ClientError({ kind: "timeout" });
				return receipt;
			},
		});
		const controller = new BreadboardInteractiveSessionController(transport.opened, { startUi: false });
		controller.start();

		await controller.submit("retry me");
		expect(controller.editor.getText()).toBe("retry me");
		await controller.submit("retry me");

		expect(requests).toHaveLength(2);
		expect(requests[1]).toBe(requests[0]);
		await controller.close();
	});

	it("releases a definitively rejected submit before accepting different text", async () => {
		const requests: SubmitInput[] = [];
		let attempt = 0;
		const transport = runtime({
			submit: async request => {
				requests.push(request);
				attempt++;
				if (attempt === 1) {
					throw new CanonicalE4ClientError({ kind: "admission-conflict", sessionId, code: "not_idle" });
				}
				return receipt;
			},
		});
		const controller = new BreadboardInteractiveSessionController(transport.opened, { startUi: false });
		controller.start();

		await controller.submit("rejected");
		await controller.submit("accepted next");

		const [first, second] = requests;
		if (typeof first === "string" || typeof second === "string" || first === undefined || second === undefined) {
			throw new Error("expected structured submits");
		}
		expect([first.text, second.text]).toEqual(["rejected", "accepted next"]);
		expect(second.clientMessageId).not.toBe(first.clientMessageId);
		await controller.close();
	});

	it("updates one Markdown holder for deltas and completion", async () => {
		const { controller, transport } = await acceptedController({
			events: [
				event("input_observed", 1, { text: "hello" }),
				event("turn_started", 2, ExactEmptyPayload.value),
				event("assistant_text_delta", 3, { text: "hel" }),
				event("assistant_text_delta", 4, { text: "lo" }),
				event("assistant_text_completed", 5, { text: "hello" }),
				event("turn_completed", 6, ExactEmptyPayload.value),
			],
		});
		const requestRender = spyOn(controller.ui, "requestRender");
		requestRender.mockClear();
		const observing = controller.observe();
		await transport.eventsDelivered;
		expect(controller.assistantRows.size).toBe(1);
		expect([...controller.assistantRows.values()][0]?.text).toBe("hello");
		expect([...controller.assistantRows.values()][0]?.finalized).toBe(true);
		expect(requestRender).toHaveBeenCalled();
		requestRender.mockRestore();
		await controller.close();
		await observing;
	});

	it("renders correlated tool, permission, artifact, and subagent events in the native transcript", async () => {
		const callId = asId<ToolCallId>("call-test");
		const permissionRequestId = asId<PermissionRequestId>("permission-test");
		const taskId = asId<TaskId>("task-test");
		const { controller, transport } = await acceptedController({
			events: [
				event("input_observed", 1, { text: "hello" }),
				event("turn_started", 2, ExactEmptyPayload.value),
				event("tool_called", 3, {
					callId,
					tool: "remote_tool",
					arguments: { path: "src/app.ts" },
					action: "inspect",
					diffPreview: "@@ preview @@",
					progress: { completed: 0, total: 1 },
				}),
				event("permission_requested", 4, {
					requestId: permissionRequestId,
					tool: "remote_tool",
					kind: "read",
					summary: "Inspect src/app.ts",
					defaultScope: "project",
					rewindable: true,
				}),
				event("permission_responded", 5, {
					requestId: permissionRequestId,
					decision: "allow",
				}),
				event("task_event_observed", 6, {
					taskId,
					kind: "subagent_spawned",
					status: "running",
					description: "Review source",
					parentTaskId: null,
					childSessionId: asId<SessionId>("session-child"),
					parentSessionId: sessionId,
					laneId: null,
					laneLabel: null,
				}),
				event("tool_result_observed", 7, {
					callId,
					tool: "remote_tool",
					status: "ok",
					error: false,
					result: { changed: false },
					artifactRef: "artifact://tool-output",
				}),
			],
		});

		const observing = controller.observe();
		await transport.eventsDelivered;
		expect(controller.toolRows.size).toBe(1);
		expect(controller.transcript.children).toHaveLength(5);
		const rendered = Bun.stripANSI(controller.transcript.render(100).join("\n"));
		expect(rendered).toContain("remote_tool");
		expect(rendered).toContain("Permission requested");
		expect(rendered).toContain("Task subagent_spawned");
		expect(rendered).toContain("artifact://tool-output");
		expect(controller.projector.state.frozen).toBe(false);
		await controller.close();
		await observing;
	});

	it("renders canonical todo snapshots through the native OMP todo component", async () => {
		const { controller, transport } = await acceptedController({
			events: [
				event("input_observed", 1, { text: "hello" }),
				event("turn_started", 2, ExactEmptyPayload.value),
				event("todo_updated", 3, {
					todo: {
						op: "snapshot",
						scope_label: "Implementation",
						items: [
							{ id: "task-1", title: "Render canonical todo rows", status: "in_progress" },
							{ id: "task-2", title: "Verify the result", status: "done" },
						],
					},
				}),
			],
		});

		const observing = controller.observe();
		await transport.eventsDelivered;
		const rendered = Bun.stripANSI(controller.transcript.render(100).join("\n"));
		expect(rendered).toContain("Todo 2 tasks");
		expect(rendered).toContain("Render canonical todo rows");
		expect(controller.projector.state.frozen).toBe(false);
		await controller.close();
		await observing;
	});

	it("submits native permission decisions through the canonical session command", async () => {
		const permissionRequestId = asId<PermissionRequestId>("permission-live");
		const { controller, transport } = await acceptedController({
			events: [
				event("input_observed", 1, { text: "hello" }),
				event("turn_started", 2, ExactEmptyPayload.value),
				event("permission_requested", 3, {
					requestId: permissionRequestId,
					tool: "run_shell",
					kind: "execute",
					summary: "Run focused verification",
					defaultScope: "project",
					rewindable: false,
				}),
			],
		});

		const observing = controller.observe();
		await transport.eventsDelivered;
		expect(controller.pendingPermissionCount).toBe(1);
		expect(Bun.stripANSI(controller.editorContainer.render(100).join("\n"))).toContain("Allow once");
		await controller.respondToPendingPermission("allow");
		expect(transport.permissionDecisionCalls).toBe(1);
		expect(transport.lastPermissionDecision).toEqual({ requestId: permissionRequestId, decision: "allow" });
		expect(controller.pendingPermissionCount).toBe(0);
		await controller.close();
		await observing;
	});

	it("redacts sensitive tool and permission labels before native rendering", async () => {
		const secret = "sk-canary-never-serialize-123456";
		const { controller, transport } = await acceptedController({
			events: [
				event("input_observed", 1, { text: "hello" }),
				event("turn_started", 2, ExactEmptyPayload.value),
				event("permission_requested", 3, {
					requestId: asId<PermissionRequestId>("permission-redacted"),
					tool: secret,
					kind: "authorization is Bearer canary-token-never-serialize",
					summary: secret,
					defaultScope: null,
					rewindable: false,
				}),
			],
		});

		const observing = controller.observe();
		await transport.eventsDelivered;
		const rendered = Bun.stripANSI(
			[...controller.transcript.render(100), ...controller.editorContainer.render(100)].join("\n"),
		);
		expect(rendered).not.toContain(secret);
		expect(rendered).not.toContain("canary-token-never-serialize");
		expect(rendered).toContain("[redacted]");
		await controller.close();
		await observing;
	});

	it("sends one targeted cancellation key and keeps acknowledgement nonterminal", async () => {
		const { controller, transport } = await acceptedController();
		await controller.projector.apply(event("input_observed", 1, { text: "hello" }));
		await controller.projector.apply(event("turn_started", 2, ExactEmptyPayload.value));
		await controller.cancelLatestTurn();
		await controller.cancelLatestTurn();
		expect(transport.cancelCalls).toBe(1);
		expect(controller.projector.state.turns.get(turnId)?.terminalOutcome).toBeNull();
		await controller.close();
	});

	it("cancels a queued receipt before turn_started arrives", async () => {
		const queuedReceipt: SubmitReceipt = { ...receipt, disposition: "queued", originalDisposition: "queued" };
		const { controller, transport } = await acceptedController({ submit: async () => queuedReceipt });

		await controller.cancelLatestTurn();
		await controller.cancelLatestTurn();

		expect(transport.cancelCalls).toBe(1);
		expect(controller.projector.state.turns.get(turnId)?.hasStarted).toBe(false);
		expect(controller.projector.state.turns.get(turnId)?.terminalOutcome).toBeNull();
		await controller.close();
	});

	it("closes locally on empty-draft Ctrl+D without cancellation", async () => {
		const transport = runtime();
		const controller = new BreadboardInteractiveSessionController(transport.opened, { startUi: false });
		controller.start();
		controller.editor.onExit?.();
		await controller.close();
		expect(controller.closed).toBe(true);
		expect(transport.cancelCalls).toBe(0);
		expect(transport.closeCalls).toBe(1);
	});

	it("closes and disables actions on a gap or unsupported event", async () => {
		const { controller } = await acceptedController({ events: [event("tool_called", 1, {})] });
		await controller.observe();
		expect(controller.closed).toBe(true);
		expect(controller.canSubmit).toBe(false);
		expect(controller.errorContainer.children).toHaveLength(1);
	});

	it("uses canonical display projection for the user row", async () => {
		const raw = "Authorization: Bearer secret-value";
		const transport = runtime();
		const controller = new BreadboardInteractiveSessionController(transport.opened, { startUi: false });
		controller.start();
		await controller.submit(raw);
		expect(controller.projector.state.userMessages.get(inputId)).toBe(projectDisplayText("user-text", raw).text);
		await controller.close();
	});
});

describe("BreadboardInteractiveSessionMode", () => {
	it("fails closed when attach history is partial", async () => {
		const transport = runtime();
		const partial: SessionSnapshot = { ...snapshot(), retainedHistory: "partial" };
		let snapshotCalls = 0;
		const opened: OpenedSession = {
			...transport.opened,
			snapshot: async () => {
				snapshotCalls++;
				return partial;
			},
		};
		const port: BreadboardSessionPort = { open: async () => opened };
		const mode = new BreadboardInteractiveSessionMode(port, { kind: "attach", sessionId }, { startUi: false });

		await expect(mode.run()).rejects.toMatchObject({
			failure: { kind: "resume-gap", code: "partial_retained_history" },
		});
		expect(mode.controller?.closed).toBe(true);
		expect(snapshotCalls).toBe(1);
	});

	it("fails closed when a created session is not fresh and idle", async () => {
		const transport = runtime();
		const opened: OpenedSession = {
			...transport.opened,
			snapshot: async () => ({
				...snapshot(),
				turnAdmission: "active",
				activeTurnId: turnId,
			}),
		};
		const port: BreadboardSessionPort = { open: async () => opened };
		const mode = new BreadboardInteractiveSessionMode(
			port,
			{ kind: "create", request: { configPath: "agent_configs/session.yaml" } },
			{ startUi: false },
		);

		await expect(mode.run()).rejects.toMatchObject({
			failure: { kind: "protocol", code: "fresh_session_not_idle" },
		});
		expect(mode.controller?.closed).toBe(true);
	});
	it("propagates fatal projector failures after rendering and closing", async () => {
		const transport = runtime({ events: [event("tool_called", 1, {})] });
		const port: BreadboardSessionPort = { open: async () => transport.opened };
		const mode = new BreadboardInteractiveSessionMode(port, { kind: "attach", sessionId }, { startUi: false });

		await expect(mode.run()).rejects.toMatchObject({
			failure: { kind: "protocol", code: "unknown_turn_correlation" },
		});
		expect(mode.controller?.errorContainer.children).toHaveLength(1);
		expect(mode.controller?.closed).toBe(true);
	});
});
