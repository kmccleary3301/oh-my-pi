import { describe, expect, mock, test } from "bun:test";
import type { OpenedSession as CanonicalOpenedSession, SessionId } from "@breadboard/sdk";
import { CanonicalE4SessionPort } from "./canonical-e4-session-port";

const asSessionId = (value: string): SessionId => value as SessionId;

const runtimeFor = (
	sessionId: SessionId,
	close: CanonicalOpenedSession["close"] = async () => undefined,
): CanonicalOpenedSession => ({
	sessionId,
	snapshot: async () => {
		throw new Error("unused");
	},
	submit: async () => {
		throw new Error("unused");
	},
	cancel: async () => {
		throw new Error("unused");
	},
	respondPermission: async () => {
		throw new Error("unused");
	},
	events: async function* () {
		yield* [];
	},
	close,
});

const ignoreLateCloseError = (): void => {};

describe("CanonicalE4SessionPort", () => {
	test("forwards create requests without changing the canonical runtime", async () => {
		const runtime = runtimeFor(asSessionId("session-create"));
		const create = mock(async () => runtime);
		const attach = mock(async () => runtime);
		const port = new CanonicalE4SessionPort({ create, attach }, { onLateCloseError: ignoreLateCloseError });
		const request = { configPath: "agent_configs/session.yaml" };

		await expect(port.open({ kind: "create", request })).resolves.toMatchObject({ sessionId: runtime.sessionId });
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(request);
		expect(attach).not.toHaveBeenCalled();
	});

	test("forwards the full opaque session ID on attach", async () => {
		const sessionId = asSessionId("123e4567-e89b-42d3-a456-426614174000");
		const runtime = runtimeFor(sessionId);
		const create = mock(async () => runtime);
		const attach = mock(async () => runtime);
		const port = new CanonicalE4SessionPort({ create, attach }, { onLateCloseError: ignoreLateCloseError });

		await expect(port.open({ kind: "attach", sessionId })).resolves.toMatchObject({ sessionId: runtime.sessionId });
		expect(attach).toHaveBeenCalledTimes(1);
		expect(attach).toHaveBeenCalledWith({ sessionId });
		expect(create).not.toHaveBeenCalled();
	});

	test("rejects an already-aborted open before issuing a request", async () => {
		const runtime = runtimeFor(asSessionId("session-aborted"));
		const create = mock(async () => runtime);
		const attach = mock(async () => runtime);
		const port = new CanonicalE4SessionPort({ create, attach }, { onLateCloseError: ignoreLateCloseError });
		const abort = new AbortController();
		abort.abort();

		await expect(
			port.open({ kind: "create", request: { configPath: "agent_configs/session.yaml" } }, abort.signal),
		).rejects.toMatchObject({ failure: { kind: "caller-abort" } });
		expect(create).not.toHaveBeenCalled();
		expect(attach).not.toHaveBeenCalled();
	});
	test("closes a runtime that resolves after its open is aborted", async () => {
		const close = mock(async () => undefined);
		const runtime = runtimeFor(asSessionId("session-late"), close);
		let resolveCreate: ((value: CanonicalOpenedSession) => void) | undefined;
		const create = mock(
			() =>
				new Promise<CanonicalOpenedSession>(resolve => {
					resolveCreate = resolve;
				}),
		);
		const attach = mock(async () => runtime);
		const port = new CanonicalE4SessionPort({ create, attach }, { onLateCloseError: ignoreLateCloseError });
		const abort = new AbortController();

		const opening = port.open(
			{ kind: "create", request: { configPath: "agent_configs/session.yaml" } },
			abort.signal,
		);
		abort.abort();
		await expect(opening).rejects.toMatchObject({ failure: { kind: "caller-abort" } });
		resolveCreate?.(runtime);
		await Promise.resolve();
		await Promise.resolve();

		expect(close).toHaveBeenCalledTimes(1);
	});
	test("reports a runtime close failure after an aborted open", async () => {
		const failure = new Error("late close failed");
		const runtime = runtimeFor(asSessionId("session-late-close-failure"), async () => {
			throw failure;
		});
		let resolveCreate: ((value: CanonicalOpenedSession) => void) | undefined;
		const create = mock(
			() =>
				new Promise<CanonicalOpenedSession>(resolve => {
					resolveCreate = resolve;
				}),
		);
		const onLateCloseError = mock((_error: unknown) => {});
		const port = new CanonicalE4SessionPort({ create, attach: mock(async () => runtime) }, { onLateCloseError });
		const abort = new AbortController();

		const opening = port.open(
			{ kind: "create", request: { configPath: "agent_configs/session.yaml" } },
			abort.signal,
		);
		abort.abort();
		await expect(opening).rejects.toMatchObject({ failure: { kind: "caller-abort" } });
		resolveCreate?.(runtime);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(onLateCloseError).toHaveBeenCalledWith(failure);
	});
});
