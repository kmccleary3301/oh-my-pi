import {
	type CanonicalE4Client,
	CanonicalE4ClientError,
	type OpenedSession as CanonicalOpenedSession,
} from "@breadboard/sdk";
import type { BreadboardSessionPort, OpenedSession, OpenSession } from "./session-port";

type CanonicalSessionClient = Pick<CanonicalE4Client, "attach" | "create">;

type CanonicalSession = CanonicalOpenedSession;

export interface CanonicalE4SessionPortOptions {
	readonly onLateCloseError: (error: unknown) => void;
}

function adaptSession(runtime: CanonicalSession): OpenedSession {
	let closePromise: Promise<void> | undefined;
	return {
		sessionId: runtime.sessionId,
		snapshot: () => runtime.snapshot(),
		submit: input => runtime.submit(input),
		cancel: request => runtime.cancel(request),
		respondPermission: request => runtime.respondPermission(request),
		events: request => runtime.events(request),
		close: () => {
			closePromise ??= runtime.close();
			return closePromise;
		},
	};
}

export class CanonicalE4SessionPort implements BreadboardSessionPort {
	readonly #client: CanonicalSessionClient;
	readonly #onLateCloseError: CanonicalE4SessionPortOptions["onLateCloseError"];

	constructor(client: CanonicalSessionClient, options: CanonicalE4SessionPortOptions) {
		this.#client = client;
		this.#onLateCloseError = options.onLateCloseError;
	}

	async open(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession> {
		if (signal?.aborted) throw new CanonicalE4ClientError({ kind: "caller-abort" });
		const pending =
			target.kind === "create"
				? this.#client.create(target.request)
				: this.#client.attach({ sessionId: target.sessionId });
		if (signal === undefined) return adaptSession(await pending);

		const { promise, resolve, reject } = Promise.withResolvers<CanonicalSession>();
		let settled = false;
		const abort = (): void => {
			if (settled) return;
			settled = true;
			reject(new CanonicalE4ClientError({ kind: "caller-abort" }));
		};
		signal.addEventListener("abort", abort, { once: true });
		void pending.then(
			runtime => {
				signal.removeEventListener("abort", abort);
				if (settled) {
					void runtime.close().catch(error => this.#onLateCloseError(error));
					return;
				}
				settled = true;
				resolve(runtime);
			},
			error => {
				signal.removeEventListener("abort", abort);
				if (settled) return;
				settled = true;
				reject(error);
			},
		);
		return adaptSession(await promise);
	}
}
