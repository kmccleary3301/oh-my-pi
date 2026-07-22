import {
	CanonicalE4ClientError,
	type CanonicalE4Failure,
	detectSensitiveValues,
	REDACTED_VALUE,
} from "@breadboard/sdk";
import type { Terminal, TUI } from "@oh-my-pi/pi-tui";
import { Container, ProcessTerminal, Text, TUI as Tui } from "@oh-my-pi/pi-tui";
import {
	type ProjectorEffect,
	SessionEventProjector,
	type SessionProjectorError,
} from "../breadboard/session-event-projector";
import type {
	BreadboardSessionPort,
	OpenedSession,
	OpenSession,
	SubmitRequest,
	SubmitResult,
} from "../breadboard/session-port";
import { BreadboardAssistantText } from "./components/breadboard-assistant-text";
import { CustomEditor } from "./components/custom-editor";
import { ErrorBannerComponent } from "./components/error-banner";
import { ToolExecutionComponent } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { UserMessageComponent } from "./components/user-message";
import { getEditorTheme, theme } from "./theme/theme";

export interface BreadboardInteractiveSessionModeOptions {
	/** Test seam for terminal ownership; production defaults to ProcessTerminal. */
	readonly terminal?: Terminal;
	/** Keep the controller deterministic in component-focused tests. */
	readonly startUi?: boolean;
}

interface StoredSubmission {
	readonly request: SubmitRequest;
	readonly receipt: SubmitResult;
}

interface PendingSubmitRequest {
	readonly text: string;
	readonly clientMessageId: string;
}

interface CancellationState {
	readonly key: string;
	acknowledged: boolean;
	inFlight: boolean;
}

const RECONNECT_DELAY_MS = 250;

const waitBeforeReconnect = (): Promise<void> => Bun.sleep(RECONNECT_DELAY_MS);

function safeRuntimeValue(value: unknown): unknown {
	const detection = detectSensitiveValues(value);
	return detection.findings.length > 0 || detection.truncated ? REDACTED_VALUE : value;
}

function safeRuntimeText(value: unknown): string {
	const safeValue = safeRuntimeValue(value);
	if (typeof safeValue === "string") return safeValue;
	try {
		return JSON.stringify(safeValue);
	} catch {
		return "[unavailable]";
	}
}

function toolArguments(payload: Extract<ProjectorEffect, { readonly kind: "tool-call-started" }>["payload"]): unknown {
	const raw = safeRuntimeValue(payload.arguments);
	const base: Record<string, unknown> =
		raw !== null && typeof raw === "object" && !Array.isArray(raw)
			? { ...raw }
			: raw === null
				? {}
				: { value: raw };
	if (payload.action !== null) base.action = safeRuntimeValue(payload.action);
	if (payload.diffPreview !== null) base.diff_preview = safeRuntimeValue(payload.diffPreview);
	if (payload.progress !== null) base.progress = safeRuntimeValue(payload.progress);
	return base;
}

function makeRequestKey(): string {
	return crypto.randomUUID();
}

function failureText(failure: CanonicalE4Failure): string {
	switch (failure.kind) {
		case "http":
			return `Session request failed (${failure.status})`;
		case "timeout":
			return "Session request timed out";
		case "caller-abort":
			return "Session observation aborted";
		case "protocol":
			return `Session protocol error (${failure.code})`;
		case "resume-gap":
			return `Session replay gap (${failure.code})`;
		case "session-not-found":
			return "Session not found";
		case "admission-conflict":
			return "Session admission conflict";
		case "idempotency-conflict":
			return "Session input idempotency conflict";
		case "cancellation-conflict":
			return "Session cancellation conflict";
		case "turn-failed":
			return "Session turn failed";
	}
}

function isUncertainSubmitFailure(failure: CanonicalE4Failure): boolean {
	return (
		failure.kind === "timeout" || failure.kind === "caller-abort" || (failure.kind === "http" && failure.status === 0)
	);
}

function projectorErrorText(error: SessionProjectorError): string {
	switch (error.kind) {
		case "protocol":
			return `Session protocol error (${error.code})`;
		case "resume-gap":
			return `Session replay gap (${error.code})`;
		case "unsupported-event-family":
			return "Unsupported session event family";
		case "turn-failed":
			return "Session turn failed";
	}
}

function projectorFatalFailure(error: SessionProjectorError): CanonicalE4Failure | null {
	switch (error.kind) {
		case "protocol":
			return { kind: "protocol", code: error.code };
		case "resume-gap":
			return {
				kind: "resume-gap",
				code: error.code,
				lastAppliedEventId: error.lastAppliedEventId,
				lastAppliedSequence: error.lastAppliedSequence,
			};
		case "unsupported-event-family":
			return { kind: "protocol", code: "unsupported_event_family" };
		case "turn-failed":
			return null;
	}
}

/**
 * Narrow, deterministic seam around the native OMP composition. It owns only
 * display state and calls the already-open canonical runtime for transport.
 */
export class BreadboardInteractiveSessionController {
	readonly ui: TUI;
	readonly transcript: TranscriptContainer;
	readonly statusContainer: Container;
	readonly errorContainer: Container;
	readonly editorContainer: Container;
	readonly editor: CustomEditor;
	readonly projector: SessionEventProjector;

	#runtime: OpenedSession;
	#started = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#abortController = new AbortController();
	#submissions = new Map<string, StoredSubmission>();
	#pendingSubmit: PendingSubmitRequest | null = null;
	#submissionInFlight = false;
	#userRows = new Map<string, UserMessageComponent>();
	#assistantRows = new Map<string, BreadboardAssistantText>();
	#toolRows = new Map<string, ToolExecutionComponent>();
	#cancellations = new Map<string, CancellationState>();
	#fatalFailure: CanonicalE4Failure | null = null;
	#startUi: boolean;

	constructor(runtime: OpenedSession, options: BreadboardInteractiveSessionModeOptions = {}) {
		this.#runtime = runtime;
		this.#startUi = options.startUi !== false;
		this.ui = new Tui(options.terminal ?? new ProcessTerminal(), false);
		this.transcript = new TranscriptContainer();
		this.statusContainer = new Container();
		this.errorContainer = new Container();
		this.editorContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.projector = new SessionEventProjector(runtime.sessionId);

		this.editor.onSubmit = text => {
			void this.submit(text);
		};
		this.editor.onEscape = () => {
			void this.cancelLatestTurn();
		};
		this.editor.onExit = () => {
			if (this.editor.getText().trim().length === 0) void this.close();
		};
		this.editorContainer.addChild(this.editor);
		this.ui.addChild(this.transcript);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.errorContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.setFocus(this.editor);
	}

	get runtime(): OpenedSession {
		return this.#runtime;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get canSubmit(): boolean {
		return !this.#closed && !this.editor.disableSubmit;
	}

	get userRows(): ReadonlyMap<string, UserMessageComponent> {
		return this.#userRows;
	}

	get assistantRows(): ReadonlyMap<string, BreadboardAssistantText> {
		return this.#assistantRows;
	}

	get toolRows(): ReadonlyMap<string, ToolExecutionComponent> {
		return this.#toolRows;
	}

	get fatalFailure(): CanonicalE4Failure | null {
		return this.#fatalFailure;
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		if (this.#startUi) this.ui.start();
	}

	async submit(text: string): Promise<void> {
		if (!this.canSubmit || this.#submissionInFlight) return;
		const normalized = text.trim();
		if (normalized.length === 0) return;
		const pending = this.#pendingSubmit;
		if (pending !== null && pending.text !== normalized) {
			this.editor.setText(normalized);
			this.#setStatus("Previous submission unresolved; retry the unchanged text");
			return;
		}
		const request: PendingSubmitRequest = pending ?? { text: normalized, clientMessageId: makeRequestKey() };
		this.#pendingSubmit = request;
		this.#submissionInFlight = true;
		try {
			const receipt = await this.#runtime.submit(request);
			this.#pendingSubmit = null;
			const registered = this.projector.registerSubmit(receipt, request);
			if (registered.status === "rejected" || registered.error !== null) {
				this.editor.setText(normalized);
				if (registered.error !== null) await this.#closeForProjectorError(registered.error);
				return;
			}
			this.#submissions.set(String(receipt.turnId), { request, receipt });
			if (registered.effect !== null) this.#applyEffect(registered.effect);
			this.editor.clearDraft();
			this.#setStatus(receipt.disposition === "queued" ? "Queued" : "Working…");
		} catch (error) {
			this.editor.setText(normalized);
			const failure = error instanceof CanonicalE4ClientError ? error.failure : undefined;
			if (failure !== undefined && !isUncertainSubmitFailure(failure)) this.#pendingSubmit = null;
			if (failure !== undefined) this.#showFailure(failure);
			else this.#showFailure({ kind: "protocol", code: "submit_failed" });
		} finally {
			this.#submissionInFlight = false;
		}
	}

	async observe(signal?: AbortSignal): Promise<void> {
		if (this.#closed) return;
		this.start();
		const abortParent = (): void => {
			this.#abortController.abort();
		};
		if (signal !== undefined) {
			if (signal.aborted) {
				await this.close();
				return;
			}
			signal.addEventListener("abort", abortParent, { once: true });
		}
		try {
			while (!this.#closed) {
				try {
					for await (const event of this.#runtime.events({ signal: this.#abortController.signal })) {
						if (this.#closed) return;
						const result = await this.projector.apply(event, effect => this.#applyEffect(effect));
						if (result.status === "rejected" && result.error !== null) {
							await this.#closeForProjectorError(result.error);
							return;
						}
					}
					if (this.#closed) return;
					await waitBeforeReconnect();
				} catch (error) {
					const failure = error instanceof CanonicalE4ClientError ? error.failure : undefined;
					if (failure?.kind === "timeout" || (failure?.kind === "http" && failure.status === 0)) {
						await waitBeforeReconnect();
						continue;
					}
					if (failure?.kind === "caller-abort") {
						await this.close();
						return;
					}
					if (failure !== undefined) await this.#closeForFailure(failure);
					else
						await this.#closeForProjectorError({
							kind: "protocol",
							code: "observation_failed",
							eventId: null,
							sequence: null,
						});
					return;
				}
			}
		} finally {
			if (signal !== undefined) signal.removeEventListener("abort", abortParent);
		}
	}

	async cancelLatestTurn(): Promise<void> {
		if (this.#closed) return;
		const target = [...this.projector.state.turns.values()].reverse().find(turn => turn.terminalOutcome === null);
		if (target === undefined) return;
		const turnKey = String(target.turnId);
		const state = this.#cancellations.get(turnKey) ?? { key: makeRequestKey(), acknowledged: false, inFlight: false };
		this.#cancellations.set(turnKey, state);
		if (state.acknowledged || state.inFlight) return;
		state.inFlight = true;
		try {
			const receipt = await this.#runtime.cancel({
				turnId: target.turnId,
				cancellationRequestKey: state.key,
				reason: "user_requested",
			});
			const registered = this.projector.registerCancellation(receipt);
			if (registered.status === "rejected" || registered.error !== null) {
				if (registered.error !== null) await this.#closeForProjectorError(registered.error);
				return;
			}
			state.acknowledged = true;
			this.#setStatus(
				receipt.disposition === "queued_cancelled" ? "Queued turn cancelled" : "Cancellation requested",
			);
		} catch (error) {
			const failure = error instanceof CanonicalE4ClientError ? error.failure : undefined;
			if (failure !== undefined) this.#showFailure(failure);
		} finally {
			state.inFlight = false;
		}
	}

	async close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		this.editor.disableSubmit = true;
		this.#abortController.abort();
		this.projector.close();
		this.#closePromise = (async () => {
			await this.#runtime.close();
			if (this.#started && this.#startUi) this.ui.stop();
		})();
		return this.#closePromise;
	}

	async closeForFailure(failure: CanonicalE4Failure): Promise<void> {
		await this.#closeForFailure(failure);
	}

	async #closeForFailure(failure: CanonicalE4Failure): Promise<void> {
		this.#fatalFailure = failure;
		this.#showFailure(failure);
		await this.close();
	}
	async #closeForProjectorError(error: SessionProjectorError): Promise<void> {
		this.#showProjectorError(error);
		const failure = projectorFatalFailure(error);
		if (failure !== null) {
			this.#fatalFailure = failure;
			await this.close();
		}
	}

	#showFailure(failure: CanonicalE4Failure): void {
		this.errorContainer.disposeChildren();
		this.errorContainer.addChild(new ErrorBannerComponent(failureText(failure)));
		this.editor.disableSubmit = failure.kind === "protocol" || failure.kind === "resume-gap";
		this.ui.requestRender();
	}

	#showProjectorError(error: SessionProjectorError): void {
		this.errorContainer.disposeChildren();
		this.errorContainer.addChild(new ErrorBannerComponent(projectorErrorText(error)));
		this.editor.disableSubmit = true;
		this.ui.requestRender();
	}

	#setStatus(text: string): void {
		this.statusContainer.disposeChildren();
		this.statusContainer.addChild(new Text(theme.fg("dim", text), 1, 0));
		this.ui.requestRender();
	}

	#appendUserRow(inputId: string, text: string): void {
		if (this.#userRows.has(inputId)) return;
		const row = new UserMessageComponent(text);
		this.#userRows.set(inputId, row);
		this.transcript.addChild(row);
	}

	#applyEffect(effect: ProjectorEffect): void {
		switch (effect.kind) {
			case "input-accepted":
				this.#appendUserRow(String(effect.inputId), effect.display.text);
				break;
			case "input-observed":
				this.#appendUserRow(String(effect.evidence.inputId), effect.display.text);
				break;
			case "turn-started":
				this.#setStatus("Working…");
				break;
			case "assistant-delta": {
				const key = String(effect.evidence.turnId);
				let row = this.#assistantRows.get(key);
				if (row === undefined) {
					row = new BreadboardAssistantText();
					this.#assistantRows.set(key, row);
					this.transcript.addChild(row);
				}
				row.setText(effect.display.text);
				break;
			}
			case "assistant-completed": {
				const key = String(effect.evidence.turnId);
				let row = this.#assistantRows.get(key);
				if (row === undefined) {
					row = new BreadboardAssistantText();
					this.#assistantRows.set(key, row);
					this.transcript.addChild(row);
				}
				row.finalize(effect.display.text);
				break;
			}
			case "turn-completed":
				this.#setStatus("Completed");
				this.#releaseSubmission(String(effect.evidence.turnId));
				break;
			case "turn-failed": {
				this.#setStatus("Failed");
				const details = effect.failure.details;
				const suffix = details.kind === "turn-failed" ? ` (${details.code})` : "";
				this.errorContainer.disposeChildren();
				this.errorContainer.addChild(new ErrorBannerComponent(`Session turn failed${suffix}`));
				this.#releaseSubmission(String(effect.evidence.turnId));
				break;
			}
			case "turn-cancelled":
				this.#setStatus(`Cancelled (${effect.reason})`);
				this.#releaseSubmission(String(effect.evidence.turnId));
				break;
			case "tool-call-started": {
				const callId = String(effect.payload.callId);
				if (this.#toolRows.has(callId)) break;
				const row = new ToolExecutionComponent(
					effect.payload.tool,
					toolArguments(effect.payload),
					{ showImages: false, liveRegion: this.transcript },
					undefined,
					this.ui,
					process.cwd(),
					callId,
				);
				row.setArgsComplete(callId);
				this.#toolRows.set(callId, row);
				this.transcript.addChild(row);
				this.#setStatus(`Running ${effect.payload.tool}`);
				break;
			}
			case "tool-call-completed": {
				const callId = String(effect.payload.callId);
				const row = this.#toolRows.get(callId);
				if (row === undefined) break;
				const artifact =
					effect.payload.artifactRef === null ? "" : `\nArtifact: ${safeRuntimeText(effect.payload.artifactRef)}`;
				row.updateResult(
					{
						content: [
							{
								type: "text",
								text: `${safeRuntimeText(effect.payload.result ?? effect.payload.status)}${artifact}`,
							},
						],
						details: {
							status: effect.payload.status,
							artifactRef: safeRuntimeValue(effect.payload.artifactRef),
						},
						isError: effect.payload.error,
					},
					false,
					callId,
				);
				row.seal();
				this.#setStatus(effect.payload.error ? `${effect.payload.tool ?? "Tool"} failed` : "Working…");
				break;
			}
			case "permission-requested": {
				const detail = [
					effect.payload.tool,
					effect.payload.kind,
					effect.payload.summary === null ? null : safeRuntimeText(effect.payload.summary),
				]
					.filter((value): value is string => typeof value === "string" && value.length > 0)
					.join(" · ");
				this.transcript.addChild(new Text(theme.fg("warning", `Permission requested · ${detail}`), 1, 0));
				break;
			}
			case "permission-responded":
				this.transcript.addChild(
					new Text(theme.fg("dim", `Permission ${safeRuntimeText(effect.payload.decision)}`), 1, 0),
				);
				break;
			case "task-event-observed": {
				const detail = effect.payload.description ?? effect.payload.childSessionId ?? effect.payload.taskId;
				const status = effect.payload.status === null ? "" : ` · ${safeRuntimeText(effect.payload.status)}`;
				this.transcript.addChild(
					new Text(
						theme.fg(
							"accent",
							`Task ${safeRuntimeText(effect.payload.kind)} · ${safeRuntimeText(detail)}${status}`,
						),
						1,
						0,
					),
				);
				break;
			}
			case "runtime-event-observed":
				break;
			case "session-metadata-observed":
				break;
			case "duplicate":
				break;
		}
		this.ui.requestRender();
	}

	#releaseSubmission(turnId: string): void {
		this.#submissions.delete(turnId);
		this.#cancellations.delete(turnId);
	}
}

/** Native OMP sibling mode backed exclusively by BreadboardSessionPort. */
export class BreadboardInteractiveSessionMode {
	readonly #port: BreadboardSessionPort;
	readonly #target: OpenSession;
	readonly #options: BreadboardInteractiveSessionModeOptions;
	#controller: BreadboardInteractiveSessionController | undefined;

	constructor(
		port: BreadboardSessionPort,
		target: OpenSession,
		options: BreadboardInteractiveSessionModeOptions = {},
	) {
		this.#port = port;
		this.#target = target;
		this.#options = options;
	}

	get controller(): BreadboardInteractiveSessionController | undefined {
		return this.#controller;
	}

	async run(signal?: AbortSignal): Promise<void> {
		const runtime = await this.#port.open(this.#target, signal);
		this.#controller = new BreadboardInteractiveSessionController(runtime, this.#options);
		this.#controller.start();
		try {
			const initial = await runtime.snapshot();
			if (initial.retainedHistory === "partial") {
				const failure: CanonicalE4Failure = {
					kind: "resume-gap",
					code: "partial_retained_history",
					lastAppliedEventId: null,
					lastAppliedSequence: 0,
				};
				await this.#controller.closeForFailure(failure);
				throw new CanonicalE4ClientError(failure);
			}
			if (
				this.#target.kind === "create" &&
				(initial.turnAdmission !== "idle" || initial.activeTurnId !== null || initial.queuedTurnCount !== 0)
			) {
				const failure: CanonicalE4Failure = { kind: "protocol", code: "fresh_session_not_idle" };
				await this.#controller.closeForFailure(failure);
				throw new CanonicalE4ClientError(failure);
			}
			await this.#controller.observe(signal);
		} catch (error) {
			const failure: CanonicalE4Failure =
				error instanceof CanonicalE4ClientError ? error.failure : { kind: "protocol", code: "session_open_failed" };
			await this.#controller.closeForFailure(failure);
			throw error instanceof CanonicalE4ClientError ? error : new CanonicalE4ClientError(failure);
		}
		if (this.#controller.fatalFailure !== null) {
			throw new CanonicalE4ClientError(this.#controller.fatalFailure);
		}
	}
}
