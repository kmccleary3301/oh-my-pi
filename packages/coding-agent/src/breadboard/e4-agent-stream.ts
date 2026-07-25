import type { AgentEvent, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	TextContent,
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
	readonly stream: AssistantMessageEventStream;
	readonly permissionAbort: AbortController;
	readonly toolNamesByCallId: Map<string, string>;
	turnId: TurnId | undefined;
	cancelRequested: boolean;
	text: string;
	messageText: string;
	started: boolean;
	textStarted: boolean;
	terminal: boolean;
}

export interface E4AgentStreamBridgeOptions {
	readonly session: OpenedSession;
	readonly replayHeadSequence: number;
	readonly emitAgentEvent: (event: AgentEvent) => void;
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
	readonly #emitAgentEvent: (event: AgentEvent) => void;
	readonly #modelPolicy: E4BackendModelPolicy | undefined;
	readonly #requestPermission: E4PermissionHandler | undefined;
	readonly #observeAbort = new AbortController();
	readonly #sinks = new Map<string, TurnSink>();
	readonly #submittingSinks = new Set<TurnSink>();
	readonly #pendingEvents = new Map<string, LoggedSessionEvent[]>();
	readonly #submittedTurnIds = new Set<string>();
	readonly #submissionsInFlight = new Set<Promise<void>>();
	readonly #cancellationsInFlight = new Set<Promise<void>>();
	#highestObservedSequence: number;
	#closed = false;
	#observeFailure: Error | undefined;
	#closePromise: Promise<void> | undefined;

	constructor(options: E4AgentStreamBridgeOptions) {
		this.#session = options.session;
		this.#highestObservedSequence = options.replayHeadSequence;
		this.#emitAgentEvent = options.emitAgentEvent;
		this.#modelPolicy = options.modelPolicy;
		this.#requestPermission = options.requestPermission;
		this.stream = (model, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			let admission!: Promise<void>;
			admission = this.#startTurn(model, context, stream, streamOptions?.signal).then(
				() => {
					this.#submissionsInFlight.delete(admission);
				},
				() => {
					this.#submissionsInFlight.delete(admission);
				},
			);
			this.#submissionsInFlight.add(admission);
			return stream;
		};
		void this.#observe();
	}

	close(): Promise<void> {
		if (!this.#closePromise) this.#closePromise = this.#performClose();
		return this.#closePromise;
	}

	async #performClose(): Promise<void> {
		this.#closed = true;
		this.#observeAbort.abort();

		const admittedSinks = [...this.#sinks.values()];
		for (const sink of admittedSinks) {
			this.#failSink(sink, "BreadBoard session closed", "aborted");
		}
		for (const sink of this.#submittingSinks) {
			this.#failSink(sink, "BreadBoard session closed", "aborted");
		}
		for (const sink of admittedSinks) {
			this.#cancelSink(sink, "user_requested");
		}

		await Promise.all([...this.#submissionsInFlight]);
		await Promise.all([...this.#cancellationsInFlight]);

		this.#submittingSinks.clear();
		this.#sinks.clear();
		this.#submittedTurnIds.clear();
		this.#pendingEvents.clear();
		await this.#session.close();
	}

	async #startTurn(
		model: Model,
		context: Context,
		stream: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (this.#closed) {
			this.#pushStandaloneError(stream, model, "BreadBoard session is closed", "error");
			return;
		}
		const initialObserveFailure = this.#observeFailure;
		if (initialObserveFailure) {
			this.#pushStandaloneError(stream, model, initialObserveFailure.message, "error");
			return;
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

		const sink: TurnSink = {
			model: backendModel,
			stream,
			permissionAbort: new AbortController(),
			toolNamesByCallId: new Map(),
			turnId: undefined,
			cancelRequested: false,
			text: "",
			messageText: "",
			started: false,
			textStarted: false,
			terminal: false,
		};
		this.#submittingSinks.add(sink);
		try {
			const input = submitInputFromContext(context);
			const submission = this.#session.submit(input).then(receipt => {
				if (!this.#closed && !this.#observeFailure) this.#submittedTurnIds.add(String(receipt.turnId));
				return receipt;
			});
			const receipt = await submission;
			this.#submittingSinks.delete(sink);
			sink.turnId = receipt.turnId;
			const turnKey = String(receipt.turnId);
			if (this.#observeFailure) {
				this.#submittedTurnIds.delete(turnKey);
				this.#pendingEvents.delete(turnKey);
				this.#failSink(sink, this.#observeFailure.message, "error");
				this.#cancelSink(sink, "timeout");
				return;
			}
			if (this.#closed) {
				this.#failSink(sink, "BreadBoard session is closed", "error");
				this.#cancelSink(sink, "user_requested");
				return;
			}
			this.#sinks.set(turnKey, sink);
			for (const event of this.#pendingEvents.get(turnKey) ?? []) {
				this.#applyEvent(sink, event);
			}
			this.#pendingEvents.delete(turnKey);

			const cancel = () => {
				sink.permissionAbort.abort();
				this.#cancelSink(sink, "user_requested");
			};
			if (signal?.aborted) {
				cancel();
				return;
			}
			signal?.addEventListener("abort", cancel, { once: true });
		} catch (error) {
			this.#submittingSinks.delete(sink);
			this.#failSink(sink, safeErrorMessage(error), "error");
		}
	}

	async #cancel(turnId: TurnId, reason: "user_requested" | "timeout"): Promise<void> {
		try {
			await this.#session.cancel({ turnId, reason });
		} catch (error) {
			const sink = this.#sinks.get(String(turnId));
			if (sink) this.#failSink(sink, safeErrorMessage(error), "error");
		}
	}

	#cancelSink(sink: TurnSink, reason: "user_requested" | "timeout"): void {
		if (sink.cancelRequested || sink.turnId === undefined) return;
		sink.cancelRequested = true;
		let cancellation!: Promise<void>;
		cancellation = this.#cancel(sink.turnId, reason).then(
			() => {
				this.#cancellationsInFlight.delete(cancellation);
			},
			() => {
				this.#cancellationsInFlight.delete(cancellation);
			},
		);
		this.#cancellationsInFlight.add(cancellation);
	}

	async #observe(): Promise<void> {
		let failure: unknown = new Error("BreadBoard event observer ended unexpectedly");
		try {
			for await (const event of this.#session.events({ signal: this.#observeAbort.signal })) {
				if (event.sequence <= this.#highestObservedSequence) continue;
				this.#highestObservedSequence = event.sequence;
				if (event.turnId === null) continue;
				const turnKey = String(event.turnId);
				let sink = this.#sinks.get(turnKey);
				if (!sink && !this.#submittedTurnIds.has(turnKey)) {
					await this.#waitForSubmission(turnKey);
					sink = this.#sinks.get(turnKey);
				}
				if (sink) {
					this.#applyEvent(sink, event);
				} else if (this.#submittedTurnIds.has(turnKey)) {
					const pending = this.#pendingEvents.get(turnKey) ?? [];
					pending.push(event);
					this.#pendingEvents.set(turnKey, pending);
				}
			}
		} catch (error) {
			failure = error;
		}
		if (this.#closed || this.#observeAbort.signal.aborted) return;
		this.#observeFailure = new Error(safeErrorMessage(failure));
		for (const sink of this.#submittingSinks) {
			this.#failSink(sink, this.#observeFailure.message, "error");
		}
		for (const sink of this.#sinks.values()) {
			this.#failSink(sink, this.#observeFailure.message, "error");
			this.#cancelSink(sink, "timeout");
		}
		this.#sinks.clear();
		this.#submittedTurnIds.clear();
		this.#pendingEvents.clear();
	}

	async #waitForSubmission(turnKey: string): Promise<void> {
		while (!this.#submittedTurnIds.has(turnKey) && this.#submissionsInFlight.size > 0) {
			await Promise.race(this.#submissionsInFlight);
		}
	}

	#applyEvent(sink: TurnSink, event: LoggedSessionEvent): void {
		if (sink.terminal) return;
		switch (event.kind) {
			case "turn_started":
				this.#ensureStarted(sink);
				return;
			case "assistant_message_started":
				sink.messageText = "";
				this.#ensureStarted(sink);
				return;
			case "assistant_text_delta":
				this.#appendText(sink, event.payload.text);
				return;
			case "assistant_text_completed": {
				const complete = event.payload.text;
				if (complete === null || complete === sink.messageText) return;
				if (!complete.startsWith(sink.messageText)) {
					this.#failSink(sink, "BreadBoard assistant stream did not match its completion", "error");
					return;
				}
				this.#appendText(sink, complete.slice(sink.messageText.length));
				return;
			}
			case "tool_called":
				sink.toolNamesByCallId.set(String(event.payload.callId), event.payload.tool);
				this.#emitAgentEvent({
					type: "tool_execution_start",
					toolCallId: String(event.payload.callId),
					toolName: event.payload.tool,
					args: event.payload.arguments ?? {},
					intent: event.payload.action ?? undefined,
				});
				return;
			case "tool_result_observed": {
				const toolCallId = String(event.payload.callId);
				const toolName = event.payload.tool ?? sink.toolNamesByCallId.get(toolCallId) ?? "tool";
				sink.toolNamesByCallId.delete(toolCallId);
				const result = toolResult(event.payload.result, event.payload.artifactRef);
				const isError = event.payload.error;
				this.#emitAgentEvent({
					type: "tool_execution_end",
					toolCallId,
					toolName,
					result,
					isError,
				});
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId,
					toolName,
					content: result.content,
					details: result.details,
					isError,
					timestamp: Date.now(),
				};
				this.#emitAgentEvent({ type: "message_start", message });
				this.#emitAgentEvent({ type: "message_end", message });
				return;
			}
			case "permission_requested":
				void this.#handlePermissionRequest(sink, event);
				return;
			case "turn_completed":
				this.#completeSink(sink);
				return;
			case "turn_failed":
				this.#failSink(sink, `BreadBoard turn failed [${event.payload.error.code}]`, "error");
				return;
			case "turn_cancelled":
				this.#failSink(sink, `BreadBoard turn cancelled [${event.payload.reason}]`, "aborted");
				return;
			default:
				return;
		}
	}

	async #handlePermissionRequest(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>,
	): Promise<void> {
		const requestPermission = this.#requestPermission;
		if (!requestPermission) {
			this.#abortForPermission(sink, "BreadBoard permission request requires OMP permission UI wiring", "error");
			return;
		}

		let decision: E4PermissionDecision;
		try {
			decision = await requestPermission(event.payload, sink.permissionAbort.signal);
		} catch (error) {
			if (sink.terminal || sink.permissionAbort.signal.aborted) return;
			this.#abortForPermission(sink, safeErrorMessage(error), "error");
			return;
		}
		if (sink.terminal || sink.permissionAbort.signal.aborted || this.#closed) return;
		if (decision === "cancel") {
			this.#abortForPermission(sink, "BreadBoard permission request cancelled in OMP", "aborted");
			return;
		}

		try {
			await this.#session.respondPermission({ requestId: event.payload.requestId, decision });
		} catch (error) {
			if (sink.terminal || this.#closed) return;
			this.#abortForPermission(sink, safeErrorMessage(error), "error");
		}
	}

	#abortForPermission(sink: TurnSink, message: string, reason: "error" | "aborted"): void {
		this.#failSink(sink, message, reason);
		this.#cancelSink(sink, "user_requested");
	}

	#ensureStarted(sink: TurnSink): void {
		if (sink.started) return;
		sink.started = true;
		sink.stream.push({ type: "start", partial: assistantMessage(sink.model, sink.text, "stop") });
	}

	#appendText(sink: TurnSink, delta: string): void {
		if (!delta) return;
		this.#ensureStarted(sink);
		if (!sink.textStarted) {
			sink.textStarted = true;
			sink.stream.push({
				type: "text_start",
				contentIndex: 0,
				partial: assistantMessage(sink.model, sink.text, "stop"),
			});
		}
		sink.text += delta;
		sink.messageText += delta;
		sink.stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: assistantMessage(sink.model, sink.text, "stop"),
		});
	}

	#completeSink(sink: TurnSink): void {
		if (sink.terminal) return;
		this.#ensureStarted(sink);
		const message = assistantMessage(sink.model, sink.text, "stop");
		if (sink.textStarted) {
			sink.stream.push({ type: "text_end", contentIndex: 0, content: sink.text, partial: message });
		}
		sink.terminal = true;
		sink.stream.push({ type: "done", reason: "stop", message });
		this.#removeSink(sink);
	}

	#failSink(sink: TurnSink, message: string, reason: "error" | "aborted"): void {
		if (sink.terminal) return;
		sink.terminal = true;
		sink.stream.push({ type: "error", reason, error: assistantMessage(sink.model, sink.text, reason, message) });
		this.#removeSink(sink);
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
		sink.toolNamesByCallId.clear();
		sink.messageText = "";
		for (const [turnId, candidate] of this.#sinks) {
			if (candidate !== sink) continue;
			this.#sinks.delete(turnId);
			this.#submittedTurnIds.delete(turnId);
			this.#pendingEvents.delete(turnId);
			break;
		}
	}
}

function submitInputFromContext(context: Context):
	| string
	| {
			readonly text: string;
			readonly attachments: readonly { readonly kind: "upload"; readonly filename: string; readonly data: Blob }[];
	  } {
	const message = lastUserMessage(context);
	if (typeof message.content === "string") return message.content;
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	if (images.length === 0) return text;
	return {
		text,
		attachments: images.map((image, index) => ({
			kind: "upload" as const,
			filename: `attachment-${index + 1}.${extensionForMimeType(image.mimeType)}`,
			data: new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }),
		})),
	};
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
		timestamp: Date.now(),
	};
}

function toolResult(result: unknown, artifactRef: unknown): AgentToolResult<unknown> {
	const content: string[] = [];
	if (result !== null) content.push(canonicalText(result));
	if (artifactRef !== null) content.push(`Artifact: ${canonicalText(artifactRef)}`);
	return {
		content: [{ type: "text", text: content.join("\n") || "Completed" }],
		details: { result, artifactRef },
	};
}

function canonicalText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "BreadBoard runtime request failed";
}
