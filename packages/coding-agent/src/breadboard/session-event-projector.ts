import type {
	CancellationReceipt,
	DisplayTextEvidence,
	EventEvidence,
	EventId,
	FailureEvidence,
	InputId,
	LoggedSessionEvent,
	SessionId,
	SubmitInput,
	SubmitReceipt,
	TurnId,
	ToolCallId,
} from "@breadboard/sdk";
import {
	digestLoggedSessionEvent,
	ExactEmptyPayload,
	normalizeSubmitInput,
	projectDisplayText,
	projectEventEvidence,
	projectFailureEvidence,
	REDACTED_VALUE,
	REPLAY_RETENTION_MAX_EVENTS,
	turnFailureFromEvent,
} from "@breadboard/sdk";

export type ProjectedTurnStatus = "accepted" | "started" | "completed" | "failed" | "cancelled";

export interface ProjectedTurnState {
	readonly inputId: InputId;
	readonly turnId: TurnId;
	readonly status: ProjectedTurnStatus;
	readonly submittedText: string;
	readonly assistantText: string;
	readonly hasInputEcho: boolean;
	readonly hasStarted: boolean;
	readonly hasAssistantCompletion: boolean;
	readonly cancellationRequested: boolean;
	readonly terminalOutcome: "completed" | "failed" | "cancelled" | null;
}

export interface ProjectedToolCallState {
	readonly callId: ToolCallId;
	readonly turnId: TurnId;
	readonly tool: string;
	readonly arguments: unknown;
	readonly status: "running" | "completed" | "failed";
	readonly result: unknown;
	readonly artifactRef: unknown;
}

export interface ProjectorState {
	readonly sessionId: SessionId;
	readonly frozen: boolean;
	readonly error: SessionProjectorError | null;
	readonly lastAppliedEventId: EventId | null;
	readonly lastAppliedSequence: number;
	readonly userMessages: ReadonlyMap<InputId, string>;
	readonly turns: ReadonlyMap<TurnId, ProjectedTurnState>;
	readonly toolCalls: ReadonlyMap<ToolCallId, ProjectedToolCallState>;
}

export type SessionProjectorError =
	| {
			readonly kind: "protocol";
			readonly code: string;
			readonly eventId: EventId | null;
			readonly sequence: number | null;
	  }
	| {
			readonly kind: "resume-gap";
			readonly code: "sequence-discontinuity" | "unretained-replay";
			readonly eventId: EventId | null;
			readonly sequence: number | null;
			readonly lastAppliedSequence: number;
			readonly lastAppliedEventId: EventId | null;
	  }
	| {
			readonly kind: "unsupported-event-family";
			readonly eventId: EventId;
			readonly sequence: number;
			readonly eventKind: LoggedSessionEvent["kind"];
	  }
	| {
			readonly kind: "turn-failed";
			readonly inputId: InputId;
			readonly turnId: TurnId;
			readonly code: string;
	  };

export type ProjectorEffect =
	| {
			readonly kind: "input-accepted";
			readonly inputId: InputId;
			readonly turnId: TurnId;
			readonly display: DisplayTextEvidence;
	  }
	| {
			readonly kind: "input-observed";
			readonly evidence: EventEvidence;
			readonly display: DisplayTextEvidence;
	  }
	| {
			readonly kind: "turn-started";
			readonly evidence: EventEvidence;
	  }
	| {
			readonly kind: "assistant-delta";
			readonly evidence: EventEvidence;
			readonly display: DisplayTextEvidence;
	  }
	| {
			readonly kind: "assistant-completed";
			readonly evidence: EventEvidence;
			readonly display: DisplayTextEvidence;
	  }
	| {
			readonly kind: "turn-completed";
			readonly evidence: EventEvidence;
	  }
	| {
			readonly kind: "turn-failed";
			readonly evidence: EventEvidence;
			readonly failure: FailureEvidence;
	  }
	| {
			readonly kind: "turn-cancelled";
			readonly evidence: EventEvidence;
			readonly reason: "user_requested" | "timeout" | "superseded";
	  }
	| {
			readonly kind: "tool-call-started";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>["payload"];
	  }
	| {
			readonly kind: "tool-call-completed";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "tool_result_observed" }>["payload"];
	  }
	| {
			readonly kind: "permission-requested";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>["payload"];
	  }
	| {
			readonly kind: "permission-responded";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "permission_responded" }>["payload"];
	  }
	| {
			readonly kind: "task-event-observed";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "task_event_observed" }>["payload"];
	  }
	| {
			readonly kind: "todo-updated";
			readonly evidence: EventEvidence;
			readonly payload: Extract<LoggedSessionEvent, { readonly kind: "todo_updated" }>["payload"];
	  }
	| {
			readonly kind: "runtime-event-observed";
			readonly evidence: EventEvidence;
			readonly eventKind: LoggedSessionEvent["kind"];
			readonly payload: unknown;
	  }
	| {
			readonly kind: "session-metadata-observed";
			readonly evidence: EventEvidence;
	  }
	| {
			readonly kind: "duplicate";
			readonly eventId: EventId;
			readonly sequence: number;
	  };

export interface ProjectorApplyResult {
	readonly status: "applied" | "duplicate" | "rejected";
	readonly eventId: EventId;
	readonly sequence: number;
	readonly effect: ProjectorEffect | null;
	readonly state: ProjectorState;
	readonly error: SessionProjectorError | null;
}

export interface SubmitRegistrationResult {
	readonly status: "accepted" | "duplicate" | "rejected";
	readonly effect: Extract<ProjectorEffect, { readonly kind: "input-accepted" }> | null;
	readonly state: ProjectorState;
	readonly error: SessionProjectorError | null;
}

export interface CancellationRegistrationResult {
	readonly status: "accepted" | "duplicate" | "rejected";
	readonly state: ProjectorState;
	readonly error: SessionProjectorError | null;
}

export interface SessionEventProjectorOptions {
	readonly sessionId: SessionId;
	readonly lastAppliedEventId?: EventId | null;
	readonly lastAppliedSequence?: number;
}

export type ProjectorApply = (effect: ProjectorEffect, state: ProjectorState) => void | Promise<void>;

interface MutableTurn {
	readonly receipt: SubmitReceipt | null;
	readonly inputId: InputId;
	readonly turnId: TurnId;
	submittedText: string | null;
	readonly submittedDisplay: DisplayTextEvidence;
	inputObserved: boolean;
	started: boolean;
	readonly deltaParts: string[];
	assistantCanonicalText: string | null;
	assistantCompleted: boolean;
	assistantText: string;
	terminal: "completed" | "failed" | "cancelled" | null;
	cancellation: CancellationReceipt | null;
}

interface MutableToolCall {
	readonly callId: ToolCallId;
	readonly turnId: TurnId;
	readonly tool: string;
	readonly arguments: unknown;
	status: "running" | "completed" | "failed";
	result: unknown;
	artifactRef: unknown;
}

interface MutablePermissionRequest {
	readonly turnId: TurnId;
	responded: boolean;
}

interface Transition {
	readonly turns: Map<TurnId, MutableTurn>;
	readonly userMessages: Map<InputId, string>;
	readonly effect: ProjectorEffect;
	readonly toolCalls?: Map<ToolCallId, MutableToolCall>;
	readonly permissionRequests?: Map<string, MutablePermissionRequest>;
}

interface TransitionFailure {
	readonly error: SessionProjectorError;
}

type TransitionResult = Transition | TransitionFailure;

const protocolError = (
	code: string,
	eventId: EventId | null = null,
	sequence: number | null = null,
): SessionProjectorError => ({ kind: "protocol", code, eventId, sequence });

const copyTurn = (turn: MutableTurn): MutableTurn => ({
	receipt: turn.receipt,
	inputId: turn.inputId,
	turnId: turn.turnId,
	submittedText: turn.submittedText,
	submittedDisplay: turn.submittedDisplay,
	inputObserved: turn.inputObserved,
	started: turn.started,
	deltaParts: [...turn.deltaParts],
	assistantCanonicalText: turn.assistantCanonicalText,
	assistantCompleted: turn.assistantCompleted,
	assistantText: turn.assistantText,
	terminal: turn.terminal,
	cancellation: turn.cancellation,
});

const hasTerminal = (turn: MutableTurn): boolean => turn.terminal !== null;

export class SessionEventProjector {
	readonly #sessionId: SessionId;
	#lastAppliedEventId: EventId | null;
	#lastAppliedSequence: number;
	#turns = new Map<TurnId, MutableTurn>();
	#turnOrder: TurnId[] = [];
	#userMessages = new Map<InputId, string>();
	#toolCalls = new Map<ToolCallId, MutableToolCall>();
	#permissionRequests = new Map<string, MutablePermissionRequest>();
	#digests = new Map<string, string>();
	#frozenError: SessionProjectorError | null = null;

	constructor(sessionId: SessionId);
	constructor(options: SessionEventProjectorOptions);
	constructor(sessionOrOptions: SessionId | SessionEventProjectorOptions) {
		if (typeof sessionOrOptions === "string") {
			this.#sessionId = sessionOrOptions;
			this.#lastAppliedEventId = null;
			this.#lastAppliedSequence = 0;
			return;
		}
		this.#sessionId = sessionOrOptions.sessionId;
		this.#lastAppliedEventId = sessionOrOptions.lastAppliedEventId ?? null;
		this.#lastAppliedSequence = sessionOrOptions.lastAppliedSequence ?? 0;
		if (this.#lastAppliedSequence < 0 || !Number.isSafeInteger(this.#lastAppliedSequence)) {
			throw new TypeError("lastAppliedSequence must be a non-negative safe integer");
		}
		if (this.#lastAppliedSequence === 0 && this.#lastAppliedEventId !== null) {
			throw new TypeError("lastAppliedEventId requires a positive lastAppliedSequence");
		}
	}

	get state(): ProjectorState {
		return this.#state();
	}

	registerSubmit(receipt: SubmitReceipt, input: SubmitInput): SubmitRegistrationResult {
		if (this.#frozenError !== null) {
			return { status: "rejected", effect: null, state: this.#state(), error: this.#frozenError };
		}
		const normalized = normalizeSubmitInput(input);
		if (normalized.attachments !== undefined && normalized.attachments.length !== 0) {
			return this.#rejectRegistration(protocolError("attachments_not_supported"));
		}
		if (normalized.text.trim().length === 0) {
			return this.#rejectRegistration(protocolError("empty_submit_text"));
		}
		const existingByClientId = this.#turnOrder
			.map(turnId => this.#turns.get(turnId))
			.find(turn => turn?.receipt?.clientMessageId === receipt.clientMessageId);
		if (existingByClientId !== undefined) {
			if (
				existingByClientId.receipt === null ||
				existingByClientId.receipt.inputId !== receipt.inputId ||
				existingByClientId.receipt.turnId !== receipt.turnId ||
				existingByClientId.submittedText !== normalized.text
			) {
				return this.#rejectRegistration(protocolError("submit_receipt_collision"));
			}
			return { status: "duplicate", effect: null, state: this.#state(), error: null };
		}
		if (this.#turns.has(receipt.turnId) || this.#userMessages.has(receipt.inputId)) {
			return this.#rejectRegistration(protocolError("submit_correlation_collision"));
		}
		const submittedDisplay = projectDisplayText("user-text", normalized.text);
		const turn: MutableTurn = {
			receipt,
			inputId: receipt.inputId,
			turnId: receipt.turnId,
			submittedText: normalized.text,
			submittedDisplay,
			inputObserved: false,
			started: false,
			deltaParts: [],
			assistantCanonicalText: null,
			assistantCompleted: false,
			assistantText: "",
			terminal: null,
			cancellation: null,
		};
		this.#turns.set(receipt.turnId, turn);
		this.#turnOrder.push(receipt.turnId);
		this.#userMessages.set(receipt.inputId, submittedDisplay.text);
		return {
			status: "accepted",
			effect: {
				kind: "input-accepted",
				inputId: receipt.inputId,
				turnId: receipt.turnId,
				display: submittedDisplay,
			},
			state: this.#state(),
			error: null,
		};
	}

	registerCancellation(receipt: CancellationReceipt): CancellationRegistrationResult {
		if (this.#frozenError !== null) {
			return { status: "rejected", state: this.#state(), error: this.#frozenError };
		}
		const turn = this.#turns.get(receipt.turnId);
		if (turn === undefined || turn.inputId !== receipt.inputId) {
			return this.#rejectCancellation(protocolError("cancel_unknown_turn"));
		}
		if (turn.cancellation !== null) {
			if (
				turn.cancellation.cancellationRequestKey === receipt.cancellationRequestKey &&
				turn.cancellation.cancellationRequestId === receipt.cancellationRequestId
			) {
				return { status: "duplicate", state: this.#state(), error: null };
			}
			return this.#rejectCancellation(protocolError("cancel_receipt_collision"));
		}
		if (hasTerminal(turn)) {
			return this.#rejectCancellation(protocolError("cancel_after_terminal"));
		}
		turn.cancellation = receipt;
		return { status: "accepted", state: this.#state(), error: null };
	}

	async apply(event: LoggedSessionEvent, apply: ProjectorApply = () => undefined): Promise<ProjectorApplyResult> {
		const digest = await digestLoggedSessionEvent(event);
		const knownDigest = this.#digests.get(event.eventId);
		if (knownDigest !== undefined) {
			if (knownDigest !== digest) {
				return this.#rejectEvent(event, protocolError("event_id_digest_collision", event.eventId, event.sequence));
			}
			return {
				status: "duplicate",
				eventId: event.eventId,
				sequence: event.sequence,
				effect: { kind: "duplicate", eventId: event.eventId, sequence: event.sequence },
				state: this.#state(),
				error: null,
			};
		}
		if (this.#frozenError !== null) {
			return {
				status: "rejected",
				eventId: event.eventId,
				sequence: event.sequence,
				effect: null,
				state: this.#state(),
				error: this.#frozenError,
			};
		}
		if (event.sessionId !== this.#sessionId) {
			return this.#rejectEvent(event, protocolError("cross_session_event", event.eventId, event.sequence));
		}
		if (event.sequence <= this.#lastAppliedSequence) {
			return this.#rejectEvent(event, {
				kind: "resume-gap",
				code: "unretained-replay",
				eventId: event.eventId,
				sequence: event.sequence,
				lastAppliedSequence: this.#lastAppliedSequence,
				lastAppliedEventId: this.#lastAppliedEventId,
			});
		}
		if (event.sequence !== this.#lastAppliedSequence + 1) {
			return this.#rejectEvent(event, {
				kind: "resume-gap",
				code: "sequence-discontinuity",
				eventId: event.eventId,
				sequence: event.sequence,
				lastAppliedSequence: this.#lastAppliedSequence,
				lastAppliedEventId: this.#lastAppliedEventId,
			});
		}

		const transition = this.#transition(event);
		if ("error" in transition) {
			return this.#rejectEvent(event, transition.error);
		}
		const nextState = this.#state(transition.turns, transition.userMessages, transition.toolCalls);
		const appendReplayTurnOrder = event.kind === "input_observed" && !this.#turns.has(event.turnId);
		await apply(transition.effect, nextState);
		if (appendReplayTurnOrder) this.#turnOrder.push(event.turnId);
		this.#turns = transition.turns;
		this.#userMessages = transition.userMessages;
		if (transition.toolCalls !== undefined) this.#toolCalls = transition.toolCalls;
		if (transition.permissionRequests !== undefined) this.#permissionRequests = transition.permissionRequests;
		this.#lastAppliedEventId = event.eventId;
		this.#lastAppliedSequence = event.sequence;
		this.#digests.set(event.eventId, digest);
		while (this.#digests.size > REPLAY_RETENTION_MAX_EVENTS) {
			const oldest = this.#digests.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.#digests.delete(oldest);
		}
		return {
			status: "applied",
			eventId: event.eventId,
			sequence: event.sequence,
			effect: transition.effect,
			state: this.#state(),
			error: null,
		};
	}

	close(): void {
		for (const turn of this.#turns.values()) {
			turn.submittedText = null;
			turn.deltaParts.length = 0;
			turn.assistantCanonicalText = null;
		}
	}

	#transition(event: LoggedSessionEvent): TransitionResult {
		switch (event.kind) {
			case "input_observed":
				return this.#inputObserved(event);
			case "turn_started":
				return this.#turnStarted(event);
			case "assistant_text_delta":
				return this.#assistantDelta(event);
			case "assistant_text_completed":
				return this.#assistantCompleted(event);
			case "turn_completed":
				return this.#turnCompleted(event);
			case "turn_failed":
				return this.#turnFailed(event);
			case "turn_cancelled":
				return this.#turnCancelled(event);
			case "tool_called":
				return this.#toolCalled(event);
			case "tool_result_observed":
				return this.#toolResultObserved(event);
			case "permission_requested":
				return this.#permissionRequested(event);
			case "permission_responded":
				return this.#permissionResponded(event);
			case "task_event_observed":
				return this.#taskEventObserved(event);
			case "todo_updated":
				return this.#todoUpdated(event);
			case "conversation_compaction_started":
			case "conversation_compaction_completed":
			case "assistant_message_started":
			case "assistant_reasoning_delta":
			case "assistant_thought_summary_delta":
			case "tool_execution_started":
			case "tool_execution_stdout_delta":
			case "tool_execution_stderr_delta":
			case "tool_execution_completed":
			case "checkpoint_list_observed":
			case "checkpoint_restored":
			case "warning_observed":
			case "reward_updated":
			case "limits_updated":
				return this.#runtimeEventObserved(event);
			case "skills_catalog_observed":
			case "skills_selection_observed":
			case "ctree_node_observed":
			case "ctree_snapshot_observed":
			case "completion_observed":
			case "log_linked":
			case "run_finished":
				return this.#sessionMetadata(event);
			case "runtime_error_observed":
				return event.payload.error.code === "unsupported_runtime_event_family"
					? {
							error: {
								kind: "unsupported-event-family",
								eventId: event.eventId,
								sequence: event.sequence,
								eventKind: event.kind,
							},
						}
					: this.#runtimeEventObserved(event);
			default:
				return this.#unreachable(event);
		}
	}

	#toolCalled(event: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (!turn.started || hasTerminal(turn))
			return { error: protocolError("tool_call_outside_active_turn", event.eventId, event.sequence) };
		if (this.#toolCalls.has(event.payload.callId))
			return { error: protocolError("duplicate_tool_call", event.eventId, event.sequence) };
		const toolCalls = new Map(this.#toolCalls);
		toolCalls.set(event.payload.callId, {
			callId: event.payload.callId,
			turnId: event.turnId,
			tool: event.payload.tool,
			arguments: event.payload.arguments,
			status: "running",
			result: null,
			artifactRef: null,
		});
		return {
			turns,
			userMessages,
			toolCalls,
			effect: { kind: "tool-call-started", evidence: projectEventEvidence(event), payload: event.payload },
		};
	}

	#toolResultObserved(
		event: Extract<LoggedSessionEvent, { readonly kind: "tool_result_observed" }>,
	): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const current = this.#toolCalls.get(event.payload.callId);
		if (current === undefined || current.turnId !== event.turnId)
			return { error: protocolError("unknown_tool_call_correlation", event.eventId, event.sequence) };
		if (current.status !== "running")
			return { error: protocolError("duplicate_tool_result", event.eventId, event.sequence) };
		const toolCalls = new Map(this.#toolCalls);
		toolCalls.set(event.payload.callId, {
			...current,
			status: event.payload.error ? "failed" : "completed",
			result: event.payload.result,
			artifactRef: event.payload.artifactRef,
		});
		return {
			turns: prepared.turns,
			userMessages: prepared.userMessages,
			toolCalls,
			effect: {
				kind: "tool-call-completed",
				evidence: projectEventEvidence(event),
				payload: event.payload,
			},
		};
	}

	#permissionRequested(
		event: Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>,
	): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		if (!prepared.turn.started || hasTerminal(prepared.turn))
			return { error: protocolError("permission_outside_active_turn", event.eventId, event.sequence) };
		if (this.#permissionRequests.has(event.payload.requestId))
			return { error: protocolError("duplicate_permission_request", event.eventId, event.sequence) };
		const permissionRequests = new Map(this.#permissionRequests);
		permissionRequests.set(event.payload.requestId, { turnId: event.turnId, responded: false });
		return {
			turns: prepared.turns,
			userMessages: prepared.userMessages,
			permissionRequests,
			effect: { kind: "permission-requested", evidence: projectEventEvidence(event), payload: event.payload },
		};
	}

	#permissionResponded(
		event: Extract<LoggedSessionEvent, { readonly kind: "permission_responded" }>,
	): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const current = this.#permissionRequests.get(event.payload.requestId);
		if (current === undefined || current.turnId !== event.turnId)
			return { error: protocolError("unknown_permission_correlation", event.eventId, event.sequence) };
		if (current.responded)
			return { error: protocolError("duplicate_permission_response", event.eventId, event.sequence) };
		const permissionRequests = new Map(this.#permissionRequests);
		permissionRequests.set(event.payload.requestId, { ...current, responded: true });
		return {
			turns: prepared.turns,
			userMessages: prepared.userMessages,
			permissionRequests,
			effect: { kind: "permission-responded", evidence: projectEventEvidence(event), payload: event.payload },
		};
	}

	#taskEventObserved(
		event: Extract<LoggedSessionEvent, { readonly kind: "task_event_observed" }>,
	): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		if (!prepared.turn.started || hasTerminal(prepared.turn))
			return { error: protocolError("task_event_outside_active_turn", event.eventId, event.sequence) };
		return {
			turns: prepared.turns,
			userMessages: prepared.userMessages,
			effect: { kind: "task-event-observed", evidence: projectEventEvidence(event), payload: event.payload },
		};
	}

	#todoUpdated(event: Extract<LoggedSessionEvent, { readonly kind: "todo_updated" }>): Transition {
		const turns = new Map<TurnId, MutableTurn>();
		for (const [turnId, turn] of this.#turns) turns.set(turnId, copyTurn(turn));
		return {
			turns,
			userMessages: new Map(this.#userMessages),
			effect: { kind: "todo-updated", evidence: projectEventEvidence(event), payload: event.payload },
		};
	}

	#runtimeEventObserved(event: LoggedSessionEvent): Transition {
		const turns = new Map<TurnId, MutableTurn>();
		for (const [turnId, turn] of this.#turns) turns.set(turnId, copyTurn(turn));
		return {
			turns,
			userMessages: new Map(this.#userMessages),
			effect: {
				kind: "runtime-event-observed",
				evidence: projectEventEvidence(event),
				eventKind: event.kind,
				payload: event.payload,
			},
		};
	}

	#sessionMetadata(
		event: Extract<
			LoggedSessionEvent,
			{
				readonly kind:
					| "skills_catalog_observed"
					| "skills_selection_observed"
					| "ctree_node_observed"
					| "ctree_snapshot_observed"
					| "completion_observed"
					| "log_linked"
					| "run_finished";
			}
		>,
	): Transition {
		const turns = new Map<TurnId, MutableTurn>();
		for (const [turnId, turn] of this.#turns) turns.set(turnId, copyTurn(turn));
		return {
			turns,
			userMessages: new Map(this.#userMessages),
			effect: { kind: "session-metadata-observed", evidence: projectEventEvidence(event) },
		};
	}

	#unreachable(_event: never): TransitionFailure {
		return { error: protocolError("unhandled_event_family") };
	}

	#inputObserved(event: Extract<LoggedSessionEvent, { readonly kind: "input_observed" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) {
			const existing = this.#turns.get(event.turnId);
			if (existing !== undefined) return prepared;
			const turns = new Map<TurnId, MutableTurn>();
			for (const [turnId, current] of this.#turns) turns.set(turnId, copyTurn(current));
			const userMessages = new Map(this.#userMessages);
			if (this.#userMessages.has(event.inputId)) {
				return { error: protocolError("input_correlation_collision", event.eventId, event.sequence) };
			}
			const display = projectDisplayText("user-text", event.payload.text);
			const turn: MutableTurn = {
				receipt: null,
				inputId: event.inputId,
				turnId: event.turnId,
				submittedText: event.payload.text,
				submittedDisplay: display,
				inputObserved: true,
				started: false,
				deltaParts: [],
				assistantCanonicalText: null,
				assistantCompleted: false,
				assistantText: "",
				terminal: null,
				cancellation: null,
			};
			turns.set(event.turnId, turn);
			userMessages.set(event.inputId, display.text);
			return {
				turns,
				userMessages,
				effect: { kind: "input-observed", evidence: projectEventEvidence(event), display },
			};
		}
		const { turn, turns, userMessages } = prepared;
		if (hasTerminal(turn)) return { error: protocolError("input_after_terminal", event.eventId, event.sequence) };
		if (turn.inputObserved)
			return { error: protocolError("duplicate_input_observed", event.eventId, event.sequence) };
		if (turn.submittedText === null || event.payload.text !== turn.submittedText) {
			return { error: protocolError("input_echo_mismatch", event.eventId, event.sequence) };
		}
		turn.inputObserved = true;
		const display = projectDisplayText("user-text", event.payload.text);
		userMessages.set(turn.inputId, display.text);
		return {
			turns,
			userMessages,
			effect: { kind: "input-observed", evidence: projectEventEvidence(event), display },
		};
	}

	#turnStarted(event: Extract<LoggedSessionEvent, { readonly kind: "turn_started" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (event.payload !== ExactEmptyPayload.value)
			return { error: protocolError("invalid_exact_empty_payload", event.eventId, event.sequence) };
		if (!turn.inputObserved)
			return { error: protocolError("turn_started_before_input", event.eventId, event.sequence) };
		if (turn.started) return { error: protocolError("duplicate_turn_started", event.eventId, event.sequence) };
		if (hasTerminal(turn))
			return { error: protocolError("turn_started_after_terminal", event.eventId, event.sequence) };
		const turnIndex = this.#turnOrder.indexOf(event.turnId);
		for (let index = 0; index < turnIndex; index += 1) {
			const prior = this.#turns.get(this.#turnOrder[index]);
			if (prior !== undefined && !hasTerminal(prior)) {
				return { error: protocolError("turn_start_out_of_order", event.eventId, event.sequence) };
			}
		}
		if (turn.receipt !== null && turn.receipt.originalDisposition === "queued" && turnIndex === 0) {
			return { error: protocolError("queued_turn_without_predecessor", event.eventId, event.sequence) };
		}
		turn.started = true;
		return { turns, userMessages, effect: { kind: "turn-started", evidence: projectEventEvidence(event) } };
	}

	#assistantDelta(event: Extract<LoggedSessionEvent, { readonly kind: "assistant_text_delta" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (hasTerminal(turn)) return { error: protocolError("delta_after_terminal", event.eventId, event.sequence) };
		if (!turn.inputObserved || !turn.started)
			return { error: protocolError("delta_before_turn_start", event.eventId, event.sequence) };
		turn.deltaParts.push(event.payload.text);
		const display = projectDisplayText("assistant-text", turn.deltaParts.join(""));
		turn.assistantText = display.text;
		return {
			turns,
			userMessages,
			effect: { kind: "assistant-delta", evidence: projectEventEvidence(event), display },
		};
	}

	#assistantCompleted(
		event: Extract<LoggedSessionEvent, { readonly kind: "assistant_text_completed" }>,
	): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (hasTerminal(turn))
			return { error: protocolError("completion_after_terminal", event.eventId, event.sequence) };
		if (!turn.inputObserved || !turn.started)
			return { error: protocolError("completion_before_turn_start", event.eventId, event.sequence) };
		if (turn.assistantCompleted)
			return { error: protocolError("duplicate_assistant_completion", event.eventId, event.sequence) };
		const completedText = event.payload.text;
		if (completedText === null || completedText.trim().length === 0) {
			return { error: protocolError("empty_assistant_completion", event.eventId, event.sequence) };
		}
		const concatenated = turn.deltaParts.join("");
		if (turn.deltaParts.length > 0 && completedText !== concatenated) {
			return { error: protocolError("assistant_completion_mismatch", event.eventId, event.sequence) };
		}
		turn.assistantCanonicalText = completedText;
		turn.assistantCompleted = true;
		turn.assistantText = projectDisplayText("assistant-text", completedText).text;
		const display = projectDisplayText("assistant-text", completedText);
		return {
			turns,
			userMessages,
			effect: { kind: "assistant-completed", evidence: projectEventEvidence(event), display },
		};
	}

	#turnCompleted(event: Extract<LoggedSessionEvent, { readonly kind: "turn_completed" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (event.payload !== ExactEmptyPayload.value)
			return { error: protocolError("invalid_exact_empty_payload", event.eventId, event.sequence) };
		if (!turn.inputObserved || !turn.started)
			return { error: protocolError("completed_before_turn_start", event.eventId, event.sequence) };
		if (!turn.assistantCompleted)
			return { error: protocolError("completed_without_assistant_text", event.eventId, event.sequence) };
		if (hasTerminal(turn)) return { error: protocolError("duplicate_terminal", event.eventId, event.sequence) };
		turn.terminal = "completed";
		turn.submittedText = null;
		turn.deltaParts.length = 0;
		turn.assistantCanonicalText = null;
		return { turns, userMessages, effect: { kind: "turn-completed", evidence: projectEventEvidence(event) } };
	}

	#turnFailed(event: Extract<LoggedSessionEvent, { readonly kind: "turn_failed" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (!turn.inputObserved || !turn.started)
			return { error: protocolError("failed_before_turn_start", event.eventId, event.sequence) };
		if (hasTerminal(turn)) return { error: protocolError("duplicate_terminal", event.eventId, event.sequence) };
		if (event.payload.error.message !== REDACTED_VALUE)
			return { error: protocolError("unredacted_turn_error", event.eventId, event.sequence) };
		const failure = turnFailureFromEvent(event);
		turn.terminal = "failed";
		turn.submittedText = null;
		turn.deltaParts.length = 0;
		turn.assistantCanonicalText = null;
		return {
			turns,
			userMessages,
			effect: {
				kind: "turn-failed",
				evidence: projectEventEvidence(event),
				failure: projectFailureEvidence(failure),
			},
		};
	}

	#turnCancelled(event: Extract<LoggedSessionEvent, { readonly kind: "turn_cancelled" }>): TransitionResult {
		const prepared = this.#prepareTurn(event);
		if ("error" in prepared) return prepared;
		const { turn, turns, userMessages } = prepared;
		if (!turn.inputObserved && turn.cancellation?.originalDisposition !== "queued_cancelled") {
			return { error: protocolError("cancelled_before_input", event.eventId, event.sequence) };
		}
		if (hasTerminal(turn)) return { error: protocolError("duplicate_terminal", event.eventId, event.sequence) };
		if (turn.cancellation?.originalDisposition === "cancellation_requested" && !turn.started) {
			return { error: protocolError("active_cancel_before_turn_start", event.eventId, event.sequence) };
		}
		turn.terminal = "cancelled";
		turn.submittedText = null;
		turn.deltaParts.length = 0;
		turn.assistantCanonicalText = null;
		return {
			turns,
			userMessages,
			effect: { kind: "turn-cancelled", evidence: projectEventEvidence(event), reason: event.payload.reason },
		};
	}

	#prepareTurn(event: Extract<LoggedSessionEvent, { readonly inputId: InputId; readonly turnId: TurnId }>):
		| {
				readonly turn: MutableTurn;
				readonly turns: Map<TurnId, MutableTurn>;
				readonly userMessages: Map<InputId, string>;
		  }
		| TransitionFailure {
		const original = this.#turns.get(event.turnId);
		if (original === undefined || original.inputId !== event.inputId) {
			return { error: protocolError("unknown_turn_correlation", event.eventId, event.sequence) };
		}
		const turns = new Map<TurnId, MutableTurn>();
		for (const [turnId, turn] of this.#turns) turns.set(turnId, copyTurn(turn));
		const userMessages = new Map(this.#userMessages);
		const turn = turns.get(event.turnId);
		if (turn === undefined)
			return { error: protocolError("unknown_turn_correlation", event.eventId, event.sequence) };
		return { turn, turns, userMessages };
	}

	#rejectRegistration(error: SessionProjectorError): SubmitRegistrationResult {
		this.#frozenError = error;
		return { status: "rejected", effect: null, state: this.#state(), error };
	}

	#rejectCancellation(error: SessionProjectorError): CancellationRegistrationResult {
		this.#frozenError = error;
		return { status: "rejected", state: this.#state(), error };
	}

	#rejectEvent(event: LoggedSessionEvent, error: SessionProjectorError): ProjectorApplyResult {
		this.#frozenError = error;
		return {
			status: "rejected",
			eventId: event.eventId,
			sequence: event.sequence,
			effect: null,
			state: this.#state(),
			error,
		};
	}

	#state(
		turns = this.#turns,
		userMessages = this.#userMessages,
		toolCalls = this.#toolCalls,
	): ProjectorState {
		const visibleTurns = new Map<TurnId, ProjectedTurnState>();
		for (const [turnId, turn] of turns) {
			const status: ProjectedTurnStatus = turn.terminal ?? (turn.started ? "started" : "accepted");
			visibleTurns.set(turnId, {
				inputId: turn.inputId,
				turnId,
				status,
				submittedText: turn.submittedDisplay.text,
				assistantText: turn.assistantText,
				hasInputEcho: turn.inputObserved,
				hasStarted: turn.started,
				hasAssistantCompletion: turn.assistantCompleted,
				cancellationRequested: turn.cancellation !== null,
				terminalOutcome: turn.terminal,
			});
		}
		const visibleToolCalls = new Map<ToolCallId, ProjectedToolCallState>();
		for (const [callId, toolCall] of toolCalls) {
			visibleToolCalls.set(callId, {
				callId,
				turnId: toolCall.turnId,
				tool: toolCall.tool,
				arguments: toolCall.arguments,
				status: toolCall.status,
				result: toolCall.result,
				artifactRef: toolCall.artifactRef,
			});
		}
		return {
			sessionId: this.#sessionId,
			frozen: this.#frozenError !== null,
			error: this.#frozenError,
			lastAppliedEventId: this.#lastAppliedEventId,
			lastAppliedSequence: this.#lastAppliedSequence,
			userMessages: new Map(userMessages),
			turns: visibleTurns,
			toolCalls: visibleToolCalls,
		};
	}
}
