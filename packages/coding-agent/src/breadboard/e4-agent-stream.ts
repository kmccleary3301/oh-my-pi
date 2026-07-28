import {
	CanonicalE4ClientError,
	type CanonicalJsonObject,
	deterministicSerialize,
	LifecycleE4ClientError,
	type StructuredSubmit,
	type SubmitReceipt,
	sha256Bytes,
} from "@breadboard/sdk";
import type { AgentEvent, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { LoggedSessionEvent, OpenedSession, TurnId } from "./session-port";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type E4BackendModelAttribution = Readonly<Pick<Model, "api" | "provider" | "id">>;

export interface E4BackendModelPolicy {
	readonly kind: "fixed";
	readonly model: E4BackendModelAttribution;
}

export type E4PermissionRequest = Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>["payload"];
export type E4PermissionDecision = "allow" | "deny" | "cancel";
export type E4PermissionHandler = (request: E4PermissionRequest, signal: AbortSignal) => Promise<E4PermissionDecision>;

interface TurnSink {
	readonly model: E4BackendModelAttribution;
	readonly stream: AssistantMessageEventStream | undefined;
	readonly adopted: boolean;
	readonly permissionAbort: AbortController;
	readonly toolCallsByCallId: Map<string, Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>>;
	readonly projectedToolCallIds: Set<string>;
	readonly projectedToolResultIds: Set<string>;
	readonly pendingProjectionKeys: string[];
	turnId: TurnId | undefined;
	cancelRequested: boolean;
	text: string;
	messageText: string;
	started: boolean;
	textStarted: boolean;
	failureDelivered: boolean;
	terminal: boolean;
	pendingTextCompletion: Extract<LoggedSessionEvent, { readonly kind: "assistant_text_completed" }> | undefined;
}

interface PendingSubmit {
	readonly canonicalDigest: string;
	readonly input: StructuredSubmit;
	recoveringAfterAbort: boolean;
	turnId: TurnId | undefined;
}

export interface E4DurableCursor {
	readonly eventId: string;
	readonly sequence: number;
}

export const E4_PROJECTION_RECEIPT_PREFIX = "breadboard:e4:";

export function breadboardProjectionEventId(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	if ("responseId" in message && typeof message.responseId === "string") {
		if (message.responseId.startsWith(E4_PROJECTION_RECEIPT_PREFIX)) {
			return message.responseId.slice(E4_PROJECTION_RECEIPT_PREFIX.length) || undefined;
		}
	}
	if (!("details" in message) || !message.details || typeof message.details !== "object") return undefined;
	if (!("breadboardProjectionEventId" in message.details)) return undefined;
	const eventId = message.details.breadboardProjectionEventId;
	return typeof eventId === "string" && eventId ? eventId : undefined;
}

export interface E4OwnedSubmission {
	readonly clientMessageId: string;
	readonly inputId: string;
	readonly turnId: string;
}

export interface E4AgentStreamBridgeOptions {
	readonly session: OpenedSession;
	readonly durableCursor?: E4DurableCursor;
	readonly projectionReceiptEventIds?: ReadonlySet<string>;
	readonly ownedSubmissions?: readonly E4OwnedSubmission[];
	readonly emitAgentEvent: (event: AgentEvent, idempotencyKey: string) => Promise<void>;
	readonly releaseAgentEvent: (idempotencyKey: string) => void;
	readonly submissionOwned: (submission: E4OwnedSubmission) => Promise<void>;
	readonly projectionCommitted: (
		cursor: E4DurableCursor,
		ownedSubmissions: readonly E4OwnedSubmission[],
	) => Promise<void>;
	readonly modelPolicy?: E4BackendModelPolicy;
	readonly requestPermission?: E4PermissionHandler;
}

/**
 * Adapts one canonical BreadBoard E4 session to OMP's provider-stream seam.
 *
 * OMP remains authoritative for CLI parsing, the AgentSession state machine,
 * InteractiveMode, composer, commands, selectors, transcript, and terminal
 * cleanup. BreadBoard owns durable turn admission and execution. The bridge
 * projects backend assistant/tool events into the native OMP event contracts;
 * it never implements a second UI or command shell.
 */
export class E4AgentStreamBridge {
	readonly stream: StreamFn;
	readonly #session: OpenedSession;
	readonly #emitAgentEvent: E4AgentStreamBridgeOptions["emitAgentEvent"];
	readonly #releaseAgentEvent: E4AgentStreamBridgeOptions["releaseAgentEvent"];
	readonly #projectionCommitted: E4AgentStreamBridgeOptions["projectionCommitted"];
	readonly #submissionOwned: E4AgentStreamBridgeOptions["submissionOwned"];
	readonly #receipts: ReadonlySet<string>;
	readonly #modelPolicy: E4BackendModelPolicy | undefined;
	readonly #requestPermission: E4PermissionHandler | undefined;
	readonly #initialCursor: E4DurableCursor | undefined;
	readonly #observeAbort = new AbortController();
	readonly #sinks = new Map<string, TurnSink>();
	readonly #adoptedTerminalTurnIds = new Set<string>();
	readonly #ownedSubmissions = new Map<string, E4OwnedSubmission>();
	readonly #observedSubmitAttempts = new Map<string, PendingSubmit>();
	readonly #submittingSinks = new Set<TurnSink>();
	readonly #submissionsInFlight = new Set<Promise<void>>();
	readonly #lateSubmissionRecoveries = new Set<Promise<void>>();
	readonly #undurableSinks = new Set<TurnSink>();
	readonly #deferredProjectionKeys: string[] = [];
	readonly #cancellationsInFlight = new Set<Promise<boolean>>();
	readonly #eventApplicationsInFlight = new Set<Promise<void>>();
	readonly #ownershipWaiters = new Set<() => void>();
	#started = false;
	#closed = false;
	#observeFailure: Error | undefined;
	#pendingSubmit: PendingSubmit | undefined;
	#terminalCursor: E4DurableCursor | undefined;
	#closePromise: Promise<void> | undefined;

	constructor(options: E4AgentStreamBridgeOptions) {
		this.#session = options.session;
		this.#emitAgentEvent = options.emitAgentEvent;
		this.#releaseAgentEvent = options.releaseAgentEvent;
		this.#projectionCommitted = options.projectionCommitted;
		this.#submissionOwned = options.submissionOwned;
		this.#receipts = options.projectionReceiptEventIds ?? new Set();
		this.#modelPolicy = options.modelPolicy;
		this.#requestPermission = options.requestPermission;
		this.#initialCursor = options.durableCursor;
		for (const submission of options.ownedSubmissions ?? []) {
			const key = String(submission.turnId);
			const previous = this.#ownedSubmissions.get(key);
			if (
				previous &&
				(previous.inputId !== submission.inputId || previous.clientMessageId !== submission.clientMessageId)
			) {
				throw new Error(`BreadBoard owned submission ${key} has conflicting correlation`);
			}
			this.#ownedSubmissions.set(key, submission);
		}
		this.stream = (model, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			if (!this.#started) {
				this.#pushStandaloneError(stream, model, "BreadBoard E4 bridge is not started", "error");
				return stream;
			}
			let admission!: Promise<void>;
			admission = this.#startTurn(model, context, stream, streamOptions?.signal).finally(() => {
				this.#submissionsInFlight.delete(admission);
			});
			this.#submissionsInFlight.add(admission);
			return stream;
		};
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		void this.#observe();
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#performClose();
		return this.#closePromise;
	}

	async #performClose(): Promise<void> {
		this.#closed = true;
		this.#observeAbort.abort();
		this.#notifyOwnershipWaiters();
		for (const sink of [...this.#sinks.values(), ...this.#submittingSinks]) {
			this.#failSink(sink, "BreadBoard session closed", "aborted");
			this.#cancelSink(sink, "user_requested");
		}
		await Promise.all([...this.#submissionsInFlight]);
		await Promise.all([...this.#lateSubmissionRecoveries]);
		await Promise.all([...this.#cancellationsInFlight]);
		await Promise.all([...this.#eventApplicationsInFlight]);
		this.#sinks.clear();
		this.#adoptedTerminalTurnIds.clear();
		this.#observedSubmitAttempts.clear();
		this.#submittingSinks.clear();
		let projectionFailure: unknown;
		try {
			await this.#commitTerminalCursor();
		} catch (error) {
			projectionFailure = error;
		}
		try {
			await this.#session.close();
		} catch (error) {
			if (projectionFailure !== undefined) {
				throw new AggregateError(
					[projectionFailure, error],
					"BreadBoard projection commit and session close failed",
				);
			}
			throw error;
		}
		if (projectionFailure !== undefined) throw projectionFailure;
	}

	async #commitTerminalCursor(): Promise<void> {
		const cursor = this.#terminalCursor;
		if (!cursor) return;
		if (this.#undurableSinks.size > 0) {
			throw new Error("BreadBoard cannot commit a terminal cursor while replay projection is incomplete");
		}
		await this.#projectionCommitted(cursor, this.#ownedSubmissionSnapshot());
		for (const key of this.#deferredProjectionKeys.splice(0)) this.#releaseAgentEvent(key);
		this.#terminalCursor = undefined;
	}

	#newSink(model: E4BackendModelAttribution, stream?: AssistantMessageEventStream): TurnSink {
		return {
			model,
			stream,
			adopted: !stream,
			permissionAbort: new AbortController(),
			toolCallsByCallId: new Map(),
			projectedToolCallIds: new Set(),
			projectedToolResultIds: new Set(),
			pendingProjectionKeys: [],
			turnId: undefined,
			cancelRequested: false,
			text: "",
			messageText: "",
			started: false,
			textStarted: false,
			failureDelivered: false,
			terminal: false,
			pendingTextCompletion: undefined,
		};
	}

	#ownedSubmissionSnapshot(): readonly E4OwnedSubmission[] {
		return [...this.#ownedSubmissions.values()].sort((left, right) => left.turnId.localeCompare(right.turnId));
	}

	#notifyOwnershipWaiters(): void {
		for (const resolve of this.#ownershipWaiters) resolve();
		this.#ownershipWaiters.clear();
	}

	#waitForOwnershipChange(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		return new Promise(resolve => {
			this.#ownershipWaiters.add(resolve);
		});
	}

	async #recordOwnedCorrelation(submission: E4OwnedSubmission, turnId: TurnId, notifyWaiters = true): Promise<void> {
		const previous = this.#ownedSubmissions.get(submission.turnId);
		if (
			previous &&
			(previous.inputId !== submission.inputId || previous.clientMessageId !== submission.clientMessageId)
		) {
			throw new Error(`BreadBoard submission receipt collided with owned turn ${submission.turnId}`);
		}
		if (previous) return;
		try {
			await this.#submissionOwned(submission);
			const persisted = this.#ownedSubmissions.get(submission.turnId);
			if (
				persisted &&
				(persisted.inputId !== submission.inputId || persisted.clientMessageId !== submission.clientMessageId)
			) {
				throw new Error(`BreadBoard durable submission ownership collided for turn ${submission.turnId}`);
			}
			this.#ownedSubmissions.set(submission.turnId, persisted ?? submission);
			if (notifyWaiters) this.#notifyOwnershipWaiters();
		} catch (error) {
			this.#invalidateBridge(`BreadBoard submission ownership persistence failed: ${safeErrorMessage(error)}`);
			await this.#cancel(turnId, "user_requested");
			throw error;
		}
	}

	async #recordOwnedSubmission(receipt: SubmitReceipt, notifyWaiters = true): Promise<void> {
		await this.#recordOwnedCorrelation(
			{
				clientMessageId: String(receipt.clientMessageId),
				inputId: String(receipt.inputId),
				turnId: String(receipt.turnId),
			},
			receipt.turnId,
			notifyWaiters,
		);
	}

	async #submitAttempt(
		attempt: PendingSubmit,
		sink: TurnSink,
		signal: AbortSignal | undefined,
	): Promise<Awaited<ReturnType<OpenedSession["submit"]>> | undefined> {
		if (signal?.aborted) {
			this.#failSink(sink, "BreadBoard submission cancelled before admission", "aborted");
			return undefined;
		}
		const submission = this.#session.submit(attempt.input);
		if (!signal) return submission;
		let abortSubmission!: () => void;
		const aborted = new Promise<{ readonly kind: "aborted" }>(resolve => {
			abortSubmission = () => resolve({ kind: "aborted" });
			signal.addEventListener("abort", abortSubmission, { once: true });
		});
		let result:
			| { readonly kind: "receipt"; readonly receipt: Awaited<ReturnType<OpenedSession["submit"]>> }
			| { readonly kind: "aborted" };
		try {
			result = await Promise.race([submission.then(receipt => ({ kind: "receipt" as const, receipt })), aborted]);
		} finally {
			signal.removeEventListener("abort", abortSubmission);
		}
		if (result.kind === "receipt") return result.receipt;

		attempt.recoveringAfterAbort = true;
		this.#pendingSubmit ??= attempt;
		void submission.then(
			receipt => {
				let recovery!: Promise<void>;
				recovery = (async () => {
					const turnKey = String(receipt.turnId);
					if (this.#adoptedTerminalTurnIds.has(turnKey)) {
						attempt.turnId = receipt.turnId;
						this.#rememberObservedSubmit(attempt);
						if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
						return;
					}
					if (!this.#closed) await this.#recordOwnedSubmission(receipt);
					attempt.turnId = receipt.turnId;
					if (this.#adoptedTerminalTurnIds.has(turnKey)) {
						this.#rememberObservedSubmit(attempt);
						if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
						return;
					}
					await this.#cancel(receipt.turnId, "user_requested");
				})()
					.catch(error => {
						if (!this.#closed) {
							this.#invalidateBridge(
								`BreadBoard aborted submission recovery failed: ${safeErrorMessage(error)}`,
							);
						}
					})
					.finally(() => {
						this.#lateSubmissionRecoveries.delete(recovery);
					});
				this.#lateSubmissionRecoveries.add(recovery);
			},
			() => {
				if (this.#pendingSubmit === attempt) attempt.recoveringAfterAbort = false;
			},
		);
		this.#failSink(sink, "BreadBoard submission cancelled while admission was in progress", "aborted");
		return undefined;
	}

	async #startTurn(
		model: Model,
		context: Context,
		stream: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (this.#closed || this.#observeFailure) {
			this.#pushStandaloneError(
				stream,
				model,
				this.#observeFailure?.message ?? "BreadBoard session is closed",
				"error",
			);
			return;
		}
		if (this.#terminalCursor) {
			try {
				await this.#commitTerminalCursor();
			} catch (error) {
				const message = `BreadBoard projection cursor commit failed: ${safeErrorMessage(error)}`;
				this.#invalidateBridge(message);
				this.#pushStandaloneError(stream, model, message, "error");
				return;
			}
		}
		const backendModel = this.#modelPolicy?.model;
		if (!backendModel) {
			this.#pushStandaloneError(stream, model, "BreadBoard backend model attribution is not configured", "error");
			return;
		}
		if (backendModel.api !== model.api || backendModel.provider !== model.provider || backendModel.id !== model.id) {
			this.#pushStandaloneError(
				stream,
				model,
				`BreadBoard E4 session uses ${backendModel.provider}/${backendModel.id} (${backendModel.api}), but OMP selected ${model.provider}/${model.id} (${model.api}); E4 does not support per-turn model selection`,
				"error",
			);
			return;
		}
		const sink = this.#newSink(backendModel, stream);
		this.#submittingSinks.add(sink);
		let attempt: PendingSubmit | undefined;
		let ownershipNotificationPending = false;
		try {
			const input = submitInputFromContext(context);
			const canonicalDigest = await canonicalSubmitDigest(input);
			if (this.#pendingSubmit && this.#pendingSubmit.canonicalDigest !== canonicalDigest) {
				throw new Error("BreadBoard previous submission is unresolved; retry the unchanged input");
			}
			if (this.#pendingSubmit?.recoveringAfterAbort) {
				throw new Error("BreadBoard previous submission cancellation is still resolving");
			}
			attempt = this.#pendingSubmit ??
				this.#observedSubmitAttempts.get(canonicalDigest) ?? {
					canonicalDigest,
					input: { ...input, clientMessageId: crypto.randomUUID() },
					recoveringAfterAbort: false,
					turnId: undefined,
				};
			const receipt = await this.#submitAttempt(attempt, sink, signal);
			if (!receipt) return;
			attempt.turnId = receipt.turnId;
			const turnKey = String(receipt.turnId);
			const observedSink = this.#sinks.get(turnKey);
			if (observedSink?.adopted || this.#adoptedTerminalTurnIds.has(turnKey)) {
				this.#rememberObservedSubmit(attempt);
				if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
				this.#failSink(
					sink,
					"BreadBoard submission was already observed; its result is already in the transcript",
					"error",
				);
				return;
			}
			if (observedSink) {
				this.#invalidateBridge(`BreadBoard submission receipt collided with observed turn ${turnKey}`);
				return;
			}
			await this.#recordOwnedSubmission(receipt, false);
			ownershipNotificationPending = true;
			if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
			sink.turnId = receipt.turnId;
			const failure = this.#currentObserveFailure();
			if (failure || this.#closed) {
				this.#failSink(sink, failure ? failure.message : "BreadBoard session is closed", "error");
				this.#cancelSink(sink, failure ? "timeout" : "user_requested");
				return;
			}
			this.#sinks.set(turnKey, sink);
			const cancel = () => {
				sink.permissionAbort.abort();
				this.#cancelSink(sink, "user_requested");
			};
			if (signal?.aborted) cancel();
			else signal?.addEventListener("abort", cancel, { once: true });
		} catch (error) {
			if (attempt && isAmbiguousSubmitFailure(error)) this.#pendingSubmit ??= attempt;
			this.#failSink(sink, safeErrorMessage(error), "error");
		} finally {
			if (ownershipNotificationPending) this.#notifyOwnershipWaiters();
			this.#submittingSinks.delete(sink);
		}
	}

	async #trackEventApplication(application: Promise<void>): Promise<void> {
		this.#eventApplicationsInFlight.add(application);
		try {
			await application;
		} finally {
			this.#eventApplicationsInFlight.delete(application);
		}
	}

	async #observe(): Promise<void> {
		try {
			const after = this.#initialCursor && this.#initialCursor.sequence > 0 ? this.#initialCursor : undefined;
			for await (const event of this.#session.events({ signal: this.#observeAbort.signal, after })) {
				if (this.#closed) break;
				if (event.kind === "runtime_error_observed" && (event.scope === "session" || event.turnId === null)) {
					throw new Error(
						`BreadBoard runtime error [${event.payload.error.code}]: ${event.payload.error.message}`,
					);
				}
				if (event.turnId === null) {
					switch (event.kind) {
						case "todo_updated":
						case "checkpoint_list_observed":
						case "checkpoint_restored":
						case "skills_catalog_observed":
						case "skills_selection_observed":
						case "ctree_snapshot_observed":
							await this.#trackEventApplication(this.#commit(event, []));
							continue;
						default:
							throw new Error("BreadBoard unsupported canonical runtime event family");
					}
				}
				const turnKey = String(event.turnId);
				let sink = this.#sinks.get(turnKey);
				if (!sink && this.#submissionsInFlight.size) {
					await Promise.all([...this.#submissionsInFlight]);
					sink = this.#sinks.get(turnKey);
					if (this.#closed || this.#observeFailure) break;
				}
				let ownership = this.#ownedSubmissions.get(turnKey);
				const pendingAttempt = this.#pendingSubmit;
				if (!sink && !ownership && pendingAttempt && pendingAttempt.turnId === undefined) {
					await this.#waitForOwnershipChange();
					if (this.#closed || this.#observeFailure) break;
					sink = this.#sinks.get(turnKey);
					ownership = this.#ownedSubmissions.get(turnKey);
				}
				if (!sink && !ownership) {
					await this.#trackEventApplication(this.#commit(event, []));
					continue;
				}
				if (ownership && ownership.inputId !== String(event.inputId)) {
					throw new Error(`BreadBoard owned turn ${turnKey} changed input correlation`);
				}
				if (!sink) {
					const backendModel = this.#modelPolicy?.model;
					if (!backendModel) throw new Error("BreadBoard backend model attribution is not configured");
					sink = this.#newSink(backendModel);
					sink.turnId = event.turnId;
					this.#sinks.set(turnKey, sink);
				}
				await this.#trackEventApplication(this.#applyEvent(sink, event));
			}
			if (!this.#closed) throw new Error("BreadBoard event observer ended unexpectedly");
		} catch (error) {
			if (!this.#closed && !this.#observeAbort.signal.aborted) this.#invalidateBridge(safeErrorMessage(error));
		}
	}

	async #applyEvent(sink: TurnSink, event: LoggedSessionEvent): Promise<void> {
		if (sink.terminal) return;
		switch (event.kind) {
			case "turn_started":
				this.#ensureStarted(sink);
				await this.#commit(event, []);
				return;
			case "assistant_message_started":
				await this.#flushAssistantText(sink);
				this.#ensureStarted(sink);
				await this.#commit(event, []);
				return;
			case "assistant_text_delta":
				this.#appendText(sink, event.payload.text);
				if (event.payload.text) this.#undurableSinks.add(sink);
				return;
			case "assistant_text_completed":
				if (event.payload.text !== null && event.payload.text !== sink.messageText) {
					if (!event.payload.text.startsWith(sink.messageText)) {
						throw new Error("BreadBoard assistant stream did not match its completion");
					}
					this.#appendText(sink, event.payload.text.slice(sink.messageText.length));
				}
				sink.pendingTextCompletion = event;
				return;
			case "tool_called":
				if (!sink.projectedToolCallIds.has(String(event.payload.callId))) {
					await this.#flushAssistantText(sink);
					await this.#projectToolCall(sink, event);
				}
				return;
			case "tool_result_observed":
				await this.#projectToolResult(sink, event);
				return;
			case "permission_requested":
				if ((await this.#handlePermissionRequest(sink, event)) && !sink.messageText) {
					await this.#commit(event, []);
				}
				return;
			case "turn_completed":
				await this.#completeSink(sink, event);
				return;
			case "turn_failed":
				await this.#terminalFailure(sink, event, `BreadBoard turn failed [${event.payload.error.code}]`, "error");
				return;
			case "turn_cancelled":
				await this.#terminalFailure(sink, event, `BreadBoard turn cancelled [${event.payload.reason}]`, "aborted");
				return;
			case "runtime_error_observed": {
				const message = `BreadBoard runtime error [${event.payload.error.code}]: ${event.payload.error.message}`;
				if (sink.adopted) throw new Error(message);
				this.#failSinkPendingTerminal(sink, message, "error");
				const cancellation = this.#trackCancellation(sink, "timeout");
				if (cancellation && !(await cancellation)) return;
				this.#undurableSinks.delete(sink);
				this.#deferredProjectionKeys.push(...sink.pendingProjectionKeys.splice(0));
				if (sink.turnId !== undefined) this.#ownedSubmissions.delete(String(sink.turnId));
				this.#terminalCursor = cursorFor(event);
				sink.terminal = true;
				this.#removeSink(sink);
				return;
			}
			case "input_observed":
			case "conversation_compaction_started":
			case "conversation_compaction_completed":
			case "assistant_reasoning_delta":
			case "assistant_thought_summary_delta":
			case "tool_execution_started":
			case "tool_execution_stdout_delta":
			case "tool_execution_stderr_delta":
			case "tool_execution_completed":
			case "todo_updated":
			case "permission_responded":
			case "checkpoint_list_observed":
			case "checkpoint_restored":
			case "skills_catalog_observed":
			case "skills_selection_observed":
			case "ctree_node_observed":
			case "ctree_snapshot_observed":
			case "task_event_observed":
			case "warning_observed":
			case "reward_updated":
			case "limits_updated":
			case "completion_observed":
			case "log_linked":
			case "run_finished":
				if (!sink.messageText && sink.projectedToolCallIds.size === sink.projectedToolResultIds.size) {
					await this.#commit(event, []);
				}
				return;
			default:
				throw new Error("BreadBoard unsupported canonical runtime event family");
		}
	}

	async #projectToolCall(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>,
	): Promise<void> {
		const toolCallId = String(event.payload.callId);
		if (sink.projectedToolCallIds.has(toolCallId)) return;
		this.#undurableSinks.add(sink);
		sink.projectedToolCallIds.add(toolCallId);
		sink.toolCallsByCallId.set(toolCallId, event);
		if (this.#receipts.has(String(event.eventId))) return;
		const message = assistantToolCallMessage(sink.model, event);
		await this.#emit(event, "message_start", { type: "message_start", message }, sink);
		await this.#emit(event, "message_end", { type: "message_end", message }, sink);
		await this.#emit(
			event,
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId,
				toolName: event.payload.tool,
				args: event.payload.arguments,
				intent: event.payload.action ?? undefined,
			},
			sink,
		);
	}

	async #projectToolResult(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "tool_result_observed" }>,
	): Promise<void> {
		const toolCallId = String(event.payload.callId);
		if (sink.projectedToolResultIds.has(toolCallId)) return;
		const toolCall = sink.toolCallsByCallId.get(toolCallId);
		if (!toolCall) throw new Error("BreadBoard replay began mid-tool without the retained tool call");
		sink.projectedToolResultIds.add(toolCallId);
		if (!this.#receipts.has(String(event.eventId))) {
			const toolName = event.payload.tool ?? toolCall.payload.tool;
			const result = toolResult(event.payload.result, event.payload.artifactRef, String(event.eventId));
			await this.#emit(
				event,
				"tool_execution_end",
				{ type: "tool_execution_end", toolCallId, toolName, result, isError: event.payload.error },
				sink,
			);
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName,
				content: result.content,
				details: result.details,
				isError: event.payload.error,
				timestamp: event.occurredAtMs,
			};
			await this.#emit(event, "message_start", { type: "message_start", message }, sink);
			await this.#emit(event, "message_end", { type: "message_end", message }, sink);
		}
		this.#undurableSinks.delete(sink);
		await this.#commit(event, sink.pendingProjectionKeys.splice(0));
		sink.toolCallsByCallId.delete(toolCallId);
	}

	async #handlePermissionRequest(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>,
	): Promise<boolean> {
		const requestPermission = this.#requestPermission;
		if (!requestPermission) {
			this.#failSinkPendingTerminal(
				sink,
				"BreadBoard permission request requires OMP permission UI wiring",
				"error",
			);
			return this.#cancelAfterPermissionFailure(sink);
		}
		let decision: E4PermissionDecision;
		try {
			decision = await requestPermission(event.payload, sink.permissionAbort.signal);
		} catch (error) {
			this.#failSinkPendingTerminal(sink, safeErrorMessage(error), "error");
			return this.#cancelAfterPermissionFailure(sink);
		}
		if (sink.terminal || sink.permissionAbort.signal.aborted || this.#closed) return false;
		if (decision === "cancel") {
			this.#failSinkPendingTerminal(sink, "BreadBoard permission request cancelled in OMP", "aborted");
			return this.#cancelAfterPermissionFailure(sink);
		}
		try {
			await this.#session.respondPermission({ requestId: event.payload.requestId, decision });
			return true;
		} catch (error) {
			this.#failSinkPendingTerminal(sink, safeErrorMessage(error), "error");
			return this.#cancelAfterPermissionFailure(sink);
		}
	}

	#ensureStarted(sink: TurnSink): void {
		if (sink.started) return;
		sink.started = true;
		sink.stream?.push({ type: "start", partial: assistantMessage(sink.model, sink.text, "stop") });
	}

	#appendText(sink: TurnSink, delta: string): void {
		if (!delta) return;
		this.#ensureStarted(sink);
		if (!sink.textStarted) {
			sink.textStarted = true;
			sink.stream?.push({
				type: "text_start",
				contentIndex: 0,
				partial: assistantMessage(sink.model, sink.text, "stop"),
			});
		}
		sink.text += delta;
		sink.messageText += delta;
		sink.stream?.push({
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: assistantMessage(sink.model, sink.text, "stop"),
		});
	}

	async #flushAssistantText(sink: TurnSink): Promise<void> {
		if (!sink.messageText) return;
		const completion = sink.pendingTextCompletion;
		if (!completion) throw new Error("BreadBoard replay began mid-message without a completion boundary");
		const text = sink.messageText;
		const message = assistantMessage(sink.model, text, "stop", undefined, String(completion.eventId));
		if (sink.textStarted) sink.stream?.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		if (!this.#receipts.has(String(completion.eventId))) {
			await this.#emit(completion, "message_start", { type: "message_start", message }, sink);
			await this.#emit(completion, "message_end", { type: "message_end", message }, sink);
		}
		this.#undurableSinks.delete(sink);
		await this.#commit(completion, sink.pendingProjectionKeys.splice(0));
		sink.text = "";
		sink.messageText = "";
		sink.textStarted = false;
		sink.pendingTextCompletion = undefined;
		sink.stream?.push({ type: "start", partial: assistantMessage(sink.model, "", "stop") });
	}

	#rememberObservedSubmit(attempt: PendingSubmit): void {
		this.#observedSubmitAttempts.delete(attempt.canonicalDigest);
		this.#observedSubmitAttempts.set(attempt.canonicalDigest, attempt);
		while (this.#observedSubmitAttempts.size > 16) {
			const oldest = this.#observedSubmitAttempts.keys().next().value;
			if (oldest === undefined) break;
			this.#observedSubmitAttempts.delete(oldest);
		}
	}

	#settlePendingSubmit(sink: TurnSink): void {
		const attempt = this.#pendingSubmit;
		if (!attempt || sink.turnId === undefined || attempt.turnId !== sink.turnId) return;
		this.#rememberObservedSubmit(attempt);
		this.#pendingSubmit = undefined;
	}

	#rememberAdoptedTerminal(sink: TurnSink): void {
		if (sink.turnId === undefined) return;
		this.#adoptedTerminalTurnIds.add(String(sink.turnId));
		while (this.#adoptedTerminalTurnIds.size > 16) {
			const oldest = this.#adoptedTerminalTurnIds.values().next().value;
			if (oldest === undefined) break;
			this.#adoptedTerminalTurnIds.delete(oldest);
		}
	}

	async #completeSink(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "turn_completed" }>,
	): Promise<void> {
		this.#ensureStarted(sink);
		if (sink.turnId !== undefined) this.#ownedSubmissions.delete(String(sink.turnId));
		if (sink.adopted) {
			if (sink.messageText) {
				if (!sink.pendingTextCompletion) {
					throw new Error("BreadBoard replay ended mid-message without a completion boundary");
				}
				await this.#projectAdoptedTerminal(sink, event, "stop", undefined, sink.messageText);
				this.#undurableSinks.delete(sink);
			}
			await this.#commit(event, sink.pendingProjectionKeys.splice(0));
		} else {
			const message = assistantMessage(sink.model, sink.text, "stop", undefined, String(event.eventId));
			if (sink.textStarted) {
				sink.stream?.push({ type: "text_end", contentIndex: 0, content: sink.text, partial: message });
			}
			sink.stream?.push({ type: "done", reason: "stop", message });
			this.#undurableSinks.delete(sink);
			this.#deferredProjectionKeys.push(...sink.pendingProjectionKeys.splice(0));
			this.#terminalCursor = cursorFor(event);
		}
		this.#settlePendingSubmit(sink);
		if (sink.adopted) this.#rememberAdoptedTerminal(sink);
		sink.terminal = true;
		this.#removeSink(sink);
	}

	async #terminalFailure(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "turn_failed" | "turn_cancelled" }>,
		message: string,
		reason: "error" | "aborted",
	): Promise<void> {
		if (sink.turnId !== undefined) this.#ownedSubmissions.delete(String(sink.turnId));
		if (sink.adopted) {
			if (sink.messageText && !sink.pendingTextCompletion) {
				throw new Error("BreadBoard replay ended mid-message without a completion boundary");
			}
			await this.#projectAdoptedTerminal(sink, event, reason, message, sink.messageText);
			this.#undurableSinks.delete(sink);
			await this.#commit(event, sink.pendingProjectionKeys.splice(0));
		} else {
			if (!sink.failureDelivered) {
				sink.stream?.push({
					type: "error",
					reason,
					error: assistantMessage(sink.model, sink.text, reason, message, String(event.eventId)),
				});
			}
			this.#undurableSinks.delete(sink);
			this.#deferredProjectionKeys.push(...sink.pendingProjectionKeys.splice(0));
			this.#terminalCursor = cursorFor(event);
		}
		this.#settlePendingSubmit(sink);
		if (sink.adopted) this.#rememberAdoptedTerminal(sink);
		sink.terminal = true;
		this.#removeSink(sink);
	}

	async #projectAdoptedTerminal(
		sink: TurnSink,
		event: LoggedSessionEvent,
		reason: AssistantMessage["stopReason"],
		errorMessage?: string,
		text = "",
	): Promise<void> {
		if ((!text && !errorMessage) || this.#receipts.has(String(event.eventId))) return;
		const message = assistantMessage(sink.model, text, reason, errorMessage, String(event.eventId));
		await this.#emit(event, "message_start", { type: "message_start", message }, sink);
		await this.#emit(event, "message_end", { type: "message_end", message }, sink);
	}

	async #emit(event: LoggedSessionEvent, suffix: string, agentEvent: AgentEvent, sink: TurnSink): Promise<void> {
		const key = `${String(event.eventId)}:${suffix}`;
		await this.#emitAgentEvent(agentEvent, key);
		sink.pendingProjectionKeys.push(key);
	}

	async #commit(event: LoggedSessionEvent, keys: string[]): Promise<void> {
		this.#deferredProjectionKeys.push(...keys);
		if (this.#undurableSinks.size > 0) return;
		if (this.#terminalCursor) {
			this.#terminalCursor = cursorFor(event);
			return;
		}
		await this.#projectionCommitted(cursorFor(event), this.#ownedSubmissionSnapshot());
		for (const key of this.#deferredProjectionKeys.splice(0)) this.#releaseAgentEvent(key);
	}

	async #cancel(turnId: TurnId, reason: "user_requested" | "timeout"): Promise<boolean> {
		try {
			await this.#session.cancel({ turnId, reason });
			return true;
		} catch (error) {
			const message = safeErrorMessage(error);
			const sink = this.#sinks.get(String(turnId));
			if (sink) this.#failSinkPendingTerminal(sink, message, "error");
			this.#invalidateBridge(`BreadBoard turn cancellation failed: ${message}`);
			return false;
		}
	}

	#trackCancellation(sink: TurnSink, reason: "user_requested" | "timeout"): Promise<boolean> | undefined {
		if (sink.cancelRequested || sink.turnId === undefined) return undefined;
		sink.cancelRequested = true;
		let cancellation!: Promise<boolean>;
		cancellation = this.#cancel(sink.turnId, reason).finally(() => {
			this.#cancellationsInFlight.delete(cancellation);
		});
		this.#cancellationsInFlight.add(cancellation);
		return cancellation;
	}

	async #cancelAfterPermissionFailure(sink: TurnSink): Promise<boolean> {
		const cancellation = this.#trackCancellation(sink, "user_requested");
		if (!cancellation) return false;
		if (!sink.adopted) {
			void cancellation;
			return false;
		}
		return cancellation;
	}

	#cancelSink(sink: TurnSink, reason: "user_requested" | "timeout"): void {
		if (sink.adopted) return;
		void this.#trackCancellation(sink, reason);
	}

	#invalidateBridge(message: string): void {
		if (this.#observeFailure) return;
		this.#observeFailure = new Error(message);
		this.#observeAbort.abort();
		this.#notifyOwnershipWaiters();
		for (const sink of [...this.#sinks.values(), ...this.#submittingSinks]) {
			this.#cancelSink(sink, "timeout");
			this.#failSink(sink, message, "error");
		}
		this.#sinks.clear();
	}

	#currentObserveFailure(): Error | undefined {
		return this.#observeFailure;
	}

	#failSink(sink: TurnSink, message: string, reason: "error" | "aborted"): void {
		if (sink.terminal) return;
		sink.terminal = true;
		sink.stream?.push({ type: "error", reason, error: assistantMessage(sink.model, sink.text, reason, message) });
		this.#removeSink(sink);
	}

	#failSinkPendingTerminal(sink: TurnSink, message: string, reason: "error" | "aborted"): void {
		if (sink.terminal || sink.failureDelivered) return;
		sink.failureDelivered = true;
		sink.stream?.push({ type: "error", reason, error: assistantMessage(sink.model, sink.text, reason, message) });
	}

	#pushStandaloneError(
		stream: AssistantMessageEventStream,
		model: E4BackendModelAttribution,
		message: string,
		reason: "error" | "aborted",
	): void {
		stream.push({ type: "error", reason, error: assistantMessage(model, "", reason, message) });
	}

	#removeSink(sink: TurnSink): void {
		sink.permissionAbort.abort();
		if (sink.turnId === undefined) return;
		this.#sinks.delete(String(sink.turnId));
	}
}

function submitInputFromContext(context: Context): LogicalSubmit {
	const message = lastUserMessage(context);
	if (typeof message.content === "string") return { text: message.content };
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	if (images.length === 0) return { text };
	return {
		text,
		attachments: images.map((image, index) => ({
			kind: "upload" as const,
			filename: `attachment-${index + 1}.${extensionForMimeType(image.mimeType)}`,
			data: new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }),
		})),
	};
}

type LogicalSubmit = Omit<StructuredSubmit, "clientMessageId">;

async function canonicalSubmitDigest(input: LogicalSubmit): Promise<string> {
	const attachments: Array<
		| { readonly kind: "handle"; readonly id: string }
		| {
				readonly kind: "upload";
				readonly filename: string;
				readonly contentType: string;
				readonly size: number;
				readonly contentDigest: string;
		  }
	> = [];
	for (const attachment of input.attachments ?? []) {
		if (typeof attachment === "string") {
			attachments.push({ kind: "handle", id: attachment.trim() });
			continue;
		}
		if (attachment.kind === "handle") {
			attachments.push(attachment);
			continue;
		}
		const bytes = new Uint8Array(await attachment.data.arrayBuffer());
		try {
			attachments.push({
				kind: "upload",
				filename: attachment.filename,
				contentType: attachment.data.type,
				size: attachment.data.size,
				contentDigest: await sha256Bytes(bytes),
			});
		} finally {
			bytes.fill(0);
		}
	}
	const serialized = deterministicSerialize({ text: input.text, attachments });
	try {
		return await sha256Bytes(serialized);
	} finally {
		serialized.fill(0);
	}
}

function isAmbiguousSubmitFailure(error: unknown): boolean {
	if (!(error instanceof CanonicalE4ClientError || error instanceof LifecycleE4ClientError)) return false;
	return (
		error.failure.kind === "timeout" ||
		error.failure.kind === "caller-abort" ||
		(error.failure.kind === "http" && error.failure.status === 0)
	);
}

function lastUserMessage(context: Context): UserMessage {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") return message;
	}
	throw new Error("BreadBoard turn requires a user message");
}

function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
	if (!subtype) return "bin";
	return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9.+-]/g, "") || "bin";
}

function assistantMessage(
	model: E4BackendModelAttribution,
	text: string,
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
	projectionEventId?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason,
		errorMessage,
		responseId: projectionEventId ? `${E4_PROJECTION_RECEIPT_PREFIX}${projectionEventId}` : undefined,
		timestamp: Date.now(),
	};
}

function isCanonicalJsonObject(value: unknown): value is CanonicalJsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeToolArguments(value: unknown): Record<string, unknown> {
	if (value === null) return {};
	if (isCanonicalJsonObject(value)) return { ...value };
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isCanonicalJsonObject(parsed)) return { ...parsed };
			return { value: parsed };
		} catch {
			return { value };
		}
	}
	return { value };
}

function assistantToolCallMessage(
	model: E4BackendModelAttribution,
	event: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>,
): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: String(event.payload.callId),
		name: event.payload.tool,
		arguments: nativeToolArguments(event.payload.arguments),
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		responseId: `${E4_PROJECTION_RECEIPT_PREFIX}${String(event.eventId)}`,
		timestamp: event.occurredAtMs,
	};
}

function toolResult(result: unknown, artifactRef: unknown, projectionEventId: string): AgentToolResult<unknown> {
	const content: string[] = [];
	if (result !== null) content.push(canonicalText(result));
	if (artifactRef !== null) content.push(`Artifact: ${canonicalText(artifactRef)}`);
	return {
		content: [{ type: "text", text: content.join("\n") || "Completed" }],
		details: { result, artifactRef, breadboardProjectionEventId: projectionEventId },
	};
}

function cursorFor(event: LoggedSessionEvent): E4DurableCursor {
	return { eventId: String(event.eventId), sequence: event.sequence };
}

function canonicalText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "BreadBoard runtime request failed";
}
