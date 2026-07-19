import type {
	AttachSessionRequest,
	CancelReceipt,
	CancelTurnRequest,
	CreateSessionRequest,
	EventId,
	InputId,
	LoggedSessionEvent,
	ObserveEvents,
	OpenedSessionRuntime,
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
	InputId,
	LoggedSessionEvent,
	ObserveEvents,
	OpenedSessionRuntime,
	SessionId,
	SessionSnapshot,
	SubmitReceipt,
	SubmitTextTurn,
	TurnId,
};

export type OpenSession =
	| { readonly kind: "create"; readonly request: CreateSessionRequest }
	| { readonly kind: "attach"; readonly sessionId: AttachSessionRequest["sessionId"] };

export interface BreadboardSessionPort {
	open(target: OpenSession, signal?: AbortSignal): Promise<OpenedSessionRuntime>;
}

export type OpenedSession = OpenedSessionRuntime;
export type SubmitRequest = SubmitTextTurn;
export type SubmitResult = SubmitReceipt;
