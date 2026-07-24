import type { AgentEvent, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent, Model, TextContent, Usage, UserMessage } from "@oh-my-pi/pi-ai";
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

interface TurnSink {
	readonly model: Model;
	readonly stream: AssistantMessageEventStream;
	text: string;
	started: boolean;
	textStarted: boolean;
	terminal: boolean;
}

export interface E4AgentStreamBridgeOptions {
	readonly session: OpenedSession;
	readonly replayHeadSequence: number;
	readonly emitAgentEvent: (event: AgentEvent) => void;
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
	readonly #observeAbort = new AbortController();
	readonly #sinks = new Map<string, TurnSink>();
	readonly #pendingEvents = new Map<string, LoggedSessionEvent[]>();
	readonly #submittedTurnIds = new Set<string>();
	readonly #submissionsInFlight = new Set<Promise<void>>();
	readonly #replayHeadSequence: number;
	#closed = false;
	#observeFailure: Error | undefined;

	constructor(options: E4AgentStreamBridgeOptions) {
		this.#session = options.session;
		this.#replayHeadSequence = options.replayHeadSequence;
		this.#emitAgentEvent = options.emitAgentEvent;
		this.stream = (model, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			void this.#startTurn(model, context, stream, streamOptions?.signal);
			return stream;
		};
		void this.#observe();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#observeAbort.abort();
		for (const sink of this.#sinks.values()) {
			this.#failSink(sink, "BreadBoard session closed", "aborted");
		}
		this.#sinks.clear();
		this.#submittedTurnIds.clear();
		this.#pendingEvents.clear();
		this.#submissionsInFlight.clear();
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
		if (this.#observeFailure) {
			this.#pushStandaloneError(stream, model, this.#observeFailure.message, "error");
			return;
		}

		try {
			const input = submitInputFromContext(context);
			const submission = this.#session.submit(input).then(receipt => {
				if (!this.#closed) this.#submittedTurnIds.add(String(receipt.turnId));
				return receipt;
			});
			let settled!: Promise<void>;
			settled = submission.then(
				() => {
					this.#submissionsInFlight.delete(settled);
				},
				() => {
					this.#submissionsInFlight.delete(settled);
				},
			);
			this.#submissionsInFlight.add(settled);
			const receipt = await submission;
			if (this.#closed) {
				this.#pushStandaloneError(stream, model, "BreadBoard session is closed", "error");
				return;
			}
			const turnKey = String(receipt.turnId);
			const sink: TurnSink = {
				model,
				stream,
				text: "",
				started: false,
				textStarted: false,
				terminal: false,
			};
			this.#sinks.set(turnKey, sink);
			for (const event of this.#pendingEvents.get(turnKey) ?? []) {
				this.#applyEvent(sink, event);
			}
			this.#pendingEvents.delete(turnKey);

			if (signal?.aborted) {
				await this.#cancel(receipt.turnId);
				return;
			}
			signal?.addEventListener("abort", () => void this.#cancel(receipt.turnId), { once: true });
		} catch (error) {
			this.#pushStandaloneError(stream, model, safeErrorMessage(error), "error");
		}
	}

	async #cancel(turnId: TurnId): Promise<void> {
		try {
			await this.#session.cancel({ turnId, reason: "user_requested" });
		} catch (error) {
			const sink = this.#sinks.get(String(turnId));
			if (sink) this.#failSink(sink, safeErrorMessage(error), "error");
		}
	}

	async #observe(): Promise<void> {
		try {
			for await (const event of this.#session.events({ signal: this.#observeAbort.signal })) {
				if (event.sequence <= this.#replayHeadSequence || event.turnId === null) continue;
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
			if (this.#closed || this.#observeAbort.signal.aborted) return;
			this.#observeFailure = new Error(safeErrorMessage(error));
			for (const sink of this.#sinks.values()) {
				this.#failSink(sink, this.#observeFailure.message, "error");
			}
			this.#sinks.clear();
		}
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
			case "assistant_message_started":
				this.#ensureStarted(sink);
				return;
			case "assistant_text_delta":
				this.#appendText(sink, event.payload.text);
				return;
			case "assistant_text_completed": {
				const complete = event.payload.text;
				if (complete === null || complete === sink.text) return;
				if (!complete.startsWith(sink.text)) {
					this.#failSink(sink, "BreadBoard assistant stream did not match its completion", "error");
					return;
				}
				this.#appendText(sink, complete.slice(sink.text.length));
				return;
			}
			case "tool_called":
				this.#emitAgentEvent({
					type: "tool_execution_start",
					toolCallId: String(event.payload.callId),
					toolName: event.payload.tool,
					args: event.payload.arguments ?? {},
					intent: event.payload.action ?? undefined,
				});
				return;
			case "tool_result_observed":
				this.#emitAgentEvent({
					type: "tool_execution_end",
					toolCallId: String(event.payload.callId),
					toolName: event.payload.tool ?? "tool",
					result: toolResult(event.payload.result, event.payload.artifactRef),
					isError: event.payload.error,
				});
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
		sink.stream.push({ type: "error", reason, error: assistantMessage(sink.model, "", reason, message) });
		this.#removeSink(sink);
	}

	#pushStandaloneError(
		stream: AssistantMessageEventStream,
		model: Model,
		message: string,
		reason: "error" | "aborted",
	): void {
		stream.push({ type: "error", reason, error: assistantMessage(model, "", reason, message) });
	}

	#removeSink(sink: TurnSink): void {
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
	model: Model,
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
