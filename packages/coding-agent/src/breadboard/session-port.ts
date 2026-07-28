import type {
	AttachSessionRequest,
	CancelReceipt,
	CancelTurnRequest,
	CreateSessionRequest,
	EventId,
	LoggedSessionEvent,
	ObserveEvents,
	PermissionDecisionReceipt,
	RespondPermissionRequest,
	SessionId,
	SessionSnapshot,
	SubmitReceipt,
	SubmitTextTurn,
	TurnId,
} from "@breadboard/sdk";

export type {
	AttachSessionRequest,
	CancelReceipt,
	CancelTurnRequest,
	CreateSessionRequest,
	EventId,
	LoggedSessionEvent,
	ObserveEvents,
	PermissionDecisionReceipt,
	RespondPermissionRequest,
	SessionId,
	SessionSnapshot,
	SubmitReceipt,
	SubmitTextTurn,
	TurnId,
};

export type OpenSession =
	| { readonly kind: "create"; readonly request: CreateSessionRequest }
	| { readonly kind: "attach"; readonly sessionId: AttachSessionRequest["sessionId"] };

/**
 * The session contract owned by the BreadBoard adapter boundary.
 *
 * Canonical SDK runtimes are adapted to this interface before they leave the
 * BreadBoard port, so downstream OMP code never depends on SDK runtime names.
 */
export interface OpenedSession {
	readonly sessionId: SessionId;
	snapshot(): Promise<SessionSnapshot>;
	submit(input: SubmitTextTurn): Promise<SubmitReceipt>;
	cancel(request: CancelTurnRequest): Promise<CancelReceipt>;
	respondPermission(request: RespondPermissionRequest): Promise<PermissionDecisionReceipt>;
	events(request?: ObserveEvents): AsyncGenerator<LoggedSessionEvent, void, void>;
	close(): Promise<void>;
}

export interface BreadboardSessionPort {
	open(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession>;
}

export type SubmitRequest = SubmitTextTurn;
export type SubmitResult = SubmitReceipt;
