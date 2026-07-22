import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { type BoundLifecycleE4Client, createLifecycleE4Client, LifecycleE4ClientError } from "@breadboard/sdk";
import { type BreadboardSdkProvenance, openVerifiedBackendSnapshot } from "../scripts/verify-breadboard-sdk-provenance";
import { retryAmbiguousReplay } from "./helpers/retry-ambiguous-replay";

const packageRoot = resolve(import.meta.dir, "..");
const provenance = JSON.parse(
	await readFile(resolve(packageRoot, "breadboard-sdk-provenance.json"), "utf8"),
) as BreadboardSdkProvenance;
const backendRoot = process.env[provenance.backendRootEnvironmentVariable];
const backendPython =
	process.env.BREADBOARD_P30_BACKEND_PYTHON ??
	(backendRoot === undefined ? undefined : resolve(backendRoot, ".venv/bin/python"));
const expectedSessionContract = {
	contractId: "p30-e4-session-v1" as const,
	schemaSha256: "sha256:5757652c22d6aa2eb7a1cc8be1a40021d3f6a15df18d69ca22dc1916a400dbd4" as const,
};
const authorityId = (): string => randomBytes(32).toString("base64url");
const clientId = (label: string): string => `p30-real-${label}-${authorityId()}`;
const workspaceId = (byte: string): string => `workspace:v1:sha256:${byte.repeat(64)}`;
interface SafeFetchFailure {
	readonly name: string | null;
	readonly code: string | null;
	readonly causeName: string | null;
	readonly causeCode: string | null;
	readonly messageClass:
		| "aborted"
		| "connection_closed"
		| "connection_refused"
		| "connection_reset"
		| "fetch_failed"
		| "timeout"
		| "transport_other";
}

interface IntegrationDiagnosticState {
	phase: string;
	fetchFailure: SafeFetchFailure | null;
}

function safeErrorAtom(value: unknown): string | null {
	return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
}

function classifyFetchFailure(error: unknown): SafeFetchFailure {
	const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
	const cause =
		typeof record.cause === "object" && record.cause !== null ? (record.cause as Record<string, unknown>) : {};
	const message = [record.message, cause.message]
		.filter(value => typeof value === "string")
		.join(" ")
		.toLowerCase();
	const messageClass: SafeFetchFailure["messageClass"] = message.includes("abort")
		? "aborted"
		: message.includes("timed out") || message.includes("timeout")
			? "timeout"
			: message.includes("refused")
				? "connection_refused"
				: message.includes("reset")
					? "connection_reset"
					: message.includes("closed") || message.includes("socket")
						? "connection_closed"
						: message.includes("fetch failed")
							? "fetch_failed"
							: "transport_other";
	return {
		name: safeErrorAtom(record.name),
		code: safeErrorAtom(record.code),
		causeName: safeErrorAtom(cause.name),
		causeCode: safeErrorAtom(cause.code),
		messageClass,
	};
}

function diagnosticFetchFor(state: IntegrationDiagnosticState): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		state.phase = `${method.toUpperCase()} ${new URL(requestUrl).pathname}`;
		state.fetchFailure = null;
		try {
			return await fetch(input, init);
		} catch (error) {
			state.fetchFailure = classifyFetchFailure(error);
			throw error;
		}
	}) as typeof fetch;
}

function safeThrownError(error: unknown): { readonly name: string | null; readonly lifecycleKind: string | null } {
	const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
	const failure =
		typeof record.failure === "object" && record.failure !== null ? (record.failure as Record<string, unknown>) : {};
	return { name: safeErrorAtom(record.name), lifecycleKind: safeErrorAtom(failure.kind) };
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	server.close();
	await once(server, "close");
	return port;
}

async function waitForBackend(baseUrl: string, child: ChildProcess, stderr: () => string): Promise<void> {
	// This integration test observes a real ASGI process; fake timers cannot drive its startup.
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (child.exitCode !== null) throw new Error("backend exited before readiness");
		try {
			const response = await fetch(`${baseUrl}/v1/engine/identity`);
			if (response.ok) return;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error(`backend readiness timed out: ${stderr()}`);
}

async function boundDroppingOneResponse(
	baseUrl: string,
	pathname: string,
	baseFetch: typeof fetch,
): Promise<BoundLifecycleE4Client> {
	let drop = true;
	const droppingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const response = await baseFetch(input, init);
		if (drop && new URL(response.url).pathname === pathname) {
			drop = false;
			await response.arrayBuffer();
			throw new TypeError("synthetic response loss");
		}
		return response;
	}) as typeof fetch;
	const client = createLifecycleE4Client({
		baseUrl,
		expectedSessionContract,
		fetch: droppingFetch,
	});
	return await client.handshake();
}

async function readChildOutput(stream: Readable | null): Promise<string> {
	if (!stream) throw new Error("child output pipe unavailable");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function waitForRegistrationExpiry(
	bound: BoundLifecycleE4Client,
	ownerGeneration: number,
	ownerCredential: string,
	expiresAtUnix: number,
): Promise<{ readonly elapsedMs: number; readonly ownerExpiryMarginSeconds: number }> {
	const startedAt = Date.now();
	const expiresAt = expiresAtUnix * 1_000;
	const renewAt = expiresAt - 8_000;
	const deadline = expiresAt + 2_000;
	// The backend owns this real process clock. Poll locally until the safe renewal point,
	// renew exactly once while the requester is live, then make no lifecycle calls through expiry.
	while (Date.now() < renewAt) await Bun.sleep(Math.min(100, renewAt - Date.now()));
	if (Date.now() >= expiresAt) throw new Error("registration expired before safe owner renewal");
	const renewedOwner = await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration, ownerCredential }));
	const ownerExpiryMarginSeconds = renewedOwner.expiresAtUnix - expiresAtUnix;
	if (ownerExpiryMarginSeconds < 15) throw new Error(`owner expiry margin too small: ${ownerExpiryMarginSeconds}s`);
	while (Date.now() <= expiresAt) {
		if (Date.now() > deadline) throw new Error("registration expiry deadline exceeded");
		await Bun.sleep(Math.min(100, Math.max(1, expiresAt - Date.now() + 1)));
	}
	return { elapsedMs: Date.now() - startedAt, ownerExpiryMarginSeconds };
}
test("real backend rolls back an expired cross-process drain exactly once and replays control outcomes", async () => {
	const verifiedBackend = await openVerifiedBackendSnapshot(provenance, backendRoot);
	const port = await unusedPort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const bootstrapCredential = Buffer.from(authorityId(), "ascii");
	const ownerCredential = authorityId();
	const launchId = authorityId();
	let stderrText = "";
	let backend: ChildProcess | undefined;
	const diagnosticState: IntegrationDiagnosticState = { phase: "backend-startup", fetchFailure: null };
	const diagnosticFetch = diagnosticFetchFor(diagnosticState);
	try {
		backend = spawn(backendPython!, ["-m", "agentic_coder_prototype.api.cli_bridge.server"], {
			cwd: verifiedBackend.root,
			env: {
				PATH: "/usr/bin:/bin",
				PYTHONPATH: verifiedBackend.root,
				PYTHONUNBUFFERED: "1",
				BREADBOARD_CLI_HOST: "127.0.0.1",
				BREADBOARD_CLI_PORT: String(port),
				BREADBOARD_LIFECYCLE_BOOTSTRAP_FD: "3",
				BREADBOARD_ENGINE_LAUNCH_ID: launchId,
			},
			stdio: ["ignore", "ignore", "pipe", "pipe"],
		});
		backend.stderr?.on("data", chunk => {
			stderrText += String(chunk);
		});
		const bootstrapPipe = backend.stdio[3] as Writable;
		bootstrapPipe.end(bootstrapCredential);
		await waitForBackend(baseUrl, backend, () => stderrText);
		const bound = await createLifecycleE4Client({
			baseUrl,
			expectedSessionContract,
			fetch: diagnosticFetch,
		}).handshake();
		const owner = await bound.acquireOwner({
			expectedOwnerGeneration: 0,
			bootstrapCredential,
			ownerCredential,
		});
		bootstrapCredential.fill(0);
		const requesterCredential = authorityId();
		const requesterClientInstanceId = clientId("controller");
		const requester = await bound.registerClient({
			clientInstanceId: requesterClientInstanceId,
			workspaceId: workspaceId("a"),
			lifecycleMode: "local-owned",
			registrationCredential: requesterCredential,
		});
		const controlRequestId = authorityId();
		const controller = spawn(
			process.execPath,
			[resolve(import.meta.dir, "fixtures/breadboard-drain-controller.ts")],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		controller.stdin?.end(
			JSON.stringify({
				baseUrl,
				ownerGeneration: owner.ownerGeneration,
				ownerCredential,
				controlRequestId,
				registrationId: requester.registrationId,
				requesterRegistrationGeneration: requester.registrationGeneration,
				requesterClientInstanceId,
				registrationCredential: requesterCredential,
				expectedAdmissionEpoch: requester.admissionEpoch,
			}),
		);
		const [controllerStdout, controllerStderr, controllerExit] = await Promise.all([
			readChildOutput(controller.stdout),
			readChildOutput(controller.stderr),
			once(controller, "exit"),
		]);
		expect(controllerExit[0], controllerStderr).toBe(0);
		const committed = JSON.parse(controllerStdout) as {
			result: string;
			drainGeneration: number;
			admissionEpoch: number;
		};
		expect(committed.result).toBe("draining");

		expect({
			leaseTtlSeconds: requester.leaseTtlSeconds,
			renewalIntervalSeconds: requester.renewalIntervalSeconds,
		}).toEqual({
			leaseTtlSeconds: 30,
			renewalIntervalSeconds: 10,
		});
		const requesterExpiry = await waitForRegistrationExpiry(
			bound,
			owner.ownerGeneration,
			ownerCredential,
			requester.expiresAtUnix,
		);

		const replacementCredential = authorityId();
		const replacementClientInstanceId = clientId("replacement");
		const replacementInput = {
			clientInstanceId: replacementClientInstanceId,
			workspaceId: workspaceId("b"),
			lifecycleMode: "local-owned" as const,
			registrationCredential: replacementCredential,
		};
		const replacement = await bound.registerClient(replacementInput);
		expect(replacement.admissionEpoch).toBe(committed.admissionEpoch + 1);
		const replacementRetry = await bound.renewClient({
			registrationId: replacement.registrationId,
			registrationGeneration: replacement.registrationGeneration,
			clientInstanceId: replacementClientInstanceId,
			registrationCredential: replacementCredential,
		});
		expect(replacementRetry.admissionEpoch).toBe(replacement.admissionEpoch);
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));

		const lostBeginInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			controlRequestId: authorityId(),
			registrationId: replacement.registrationId,
			requesterRegistrationGeneration: replacement.registrationGeneration,
			requesterClientInstanceId: replacementClientInstanceId,
			registrationCredential: replacementCredential,
			expectedAdmissionEpoch: replacement.admissionEpoch,
		};
		const lostBegin = await boundDroppingOneResponse(baseUrl, "/v1/engine/control/drain", diagnosticFetch);
		await expect(lostBegin.beginControlDrain(lostBeginInput)).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const recoveredBegin = await retryAmbiguousReplay(() => lostBegin.beginControlDrain(lostBeginInput));
		expect(recoveredBegin.result).toBe("draining");

		const lostRejection = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/graceful-result",
			diagnosticFetch,
		);
		const rejectionInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: recoveredBegin.drainGeneration,
			outcome: "definitive_rejection" as const,
		};
		await expect(lostRejection.recordGracefulControl(rejectionInput)).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const rejectionExpiry = await waitForRegistrationExpiry(
			bound,
			owner.ownerGeneration,
			ownerCredential,
			replacementRetry.expiresAtUnix,
		);
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));
		const recoveredRejection = await retryAmbiguousReplay(() => lostRejection.recordGracefulControl(rejectionInput));
		expect(recoveredRejection.result).toBe("rollback_permitted");
		const rejectionRollback = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/drain-rollback",
			diagnosticFetch,
		);
		const rejectionRollbackInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: recoveredBegin.drainGeneration,
		};
		await expect(rejectionRollback.rollbackDrain(rejectionRollbackInput)).rejects.toBeInstanceOf(
			LifecycleE4ClientError,
		);
		expect((await retryAmbiguousReplay(() => rejectionRollback.rollbackDrain(rejectionRollbackInput))).result).toBe(
			"rolled_back",
		);
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));

		const abandonedCredential = authorityId();
		const abandonedClientInstanceId = clientId("abandoned");
		const abandonedRegistration = await bound.registerClient({
			clientInstanceId: abandonedClientInstanceId,
			workspaceId: workspaceId("c"),
			lifecycleMode: "local-owned",
			registrationCredential: abandonedCredential,
		});
		const pendingBegin = await bound.beginControlDrain({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			controlRequestId: authorityId(),
			registrationId: abandonedRegistration.registrationId,
			requesterRegistrationGeneration: abandonedRegistration.registrationGeneration,
			requesterClientInstanceId: abandonedClientInstanceId,
			registrationCredential: abandonedCredential,
			expectedAdmissionEpoch: abandonedRegistration.admissionEpoch,
		});
		const pending = await bound.recordGracefulControl({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: pendingBegin.drainGeneration,
			outcome: "timeout",
		});
		expect(pending.result).toBe("hard_signal_decision_pending");
		const abandonedExpiresAt = abandonedRegistration.expiresAtUnix * 1_000;
		const hardSignalPrepareAt = abandonedExpiresAt - 8_000;
		while (Date.now() < hardSignalPrepareAt) await Bun.sleep(Math.min(100, hardSignalPrepareAt - Date.now()));
		const abandonedWaitStartedAt = Date.now();
		const abandonedOwnerRenewal = await retryAmbiguousReplay(() =>
			bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }),
		);
		const authorization = await bound.prepareHardSignal({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: pendingBegin.drainGeneration,
			pid: bound.binding.process.pid,
			osProcessStartToken: bound.binding.process.osProcessStartToken,
		});
		const abandonedOwnerExpiryMarginSeconds =
			abandonedOwnerRenewal.expiresAtUnix - abandonedRegistration.expiresAtUnix;
		const authorizationExpiryMarginSeconds = authorization.expiresAtUnix - abandonedRegistration.expiresAtUnix;
		expect(abandonedOwnerExpiryMarginSeconds).toBeGreaterThanOrEqual(15);
		expect(authorizationExpiryMarginSeconds).toBeGreaterThanOrEqual(15);
		while (Date.now() <= abandonedExpiresAt) {
			await Bun.sleep(Math.min(100, Math.max(1, abandonedExpiresAt - Date.now() + 1)));
		}
		const abandonedExpiry = {
			elapsedMs: Date.now() - abandonedWaitStartedAt,
			ownerExpiryMarginSeconds: abandonedOwnerExpiryMarginSeconds,
		};
		const authorizationExpiresAt = authorization.expiresAtUnix * 1_000;
		const authorizationRenewAt = authorizationExpiresAt - 8_000;
		while (Date.now() < authorizationRenewAt) {
			await Bun.sleep(Math.min(100, authorizationRenewAt - Date.now()));
		}
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));
		const authorizationExpiryDeadline = authorizationExpiresAt + 2_000;
		while (Date.now() <= authorizationExpiresAt) {
			if (Date.now() > authorizationExpiryDeadline)
				throw new Error("hard-signal authorization expiry deadline exceeded");
			await Bun.sleep(Math.min(100, Math.max(1, authorizationExpiresAt - Date.now() + 1)));
		}
		const lostAbandoned = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/hard-signal/outcome",
			diagnosticFetch,
		);
		const abandonedInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: pendingBegin.drainGeneration,
			authorizationId: authorization.authorizationId,
			outcome: "abandoned" as const,
		};
		await expect(lostAbandoned.recordHardSignalOutcome(abandonedInput)).rejects.toBeInstanceOf(
			LifecycleE4ClientError,
		);
		const recoveredAbandoned = await retryAmbiguousReplay(() =>
			lostAbandoned.recordHardSignalOutcome(abandonedInput),
		);
		expect(recoveredAbandoned.result).toBe("rolled_back");
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));

		const expiredPrepareCredential = authorityId();
		const expiredPrepareClientInstanceId = clientId("expired-prepare");
		const expiredPrepareRegistration = await bound.registerClient({
			clientInstanceId: expiredPrepareClientInstanceId,
			workspaceId: workspaceId("e"),
			lifecycleMode: "local-owned",
			registrationCredential: expiredPrepareCredential,
		});
		const expiredPrepareBegin = await bound.beginControlDrain({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			controlRequestId: authorityId(),
			registrationId: expiredPrepareRegistration.registrationId,
			requesterRegistrationGeneration: expiredPrepareRegistration.registrationGeneration,
			requesterClientInstanceId: expiredPrepareClientInstanceId,
			registrationCredential: expiredPrepareCredential,
			expectedAdmissionEpoch: expiredPrepareRegistration.admissionEpoch,
		});
		const expiredPreparePending = await bound.recordGracefulControl({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: expiredPrepareBegin.drainGeneration,
			outcome: "timeout",
		});
		expect(expiredPreparePending.result).toBe("hard_signal_decision_pending");
		const lostPrepare = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/hard-signal/prepare",
			diagnosticFetch,
		);
		const expiredPrepareInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: expiredPrepareBegin.drainGeneration,
			pid: bound.binding.process.pid,
			osProcessStartToken: bound.binding.process.osProcessStartToken,
		};
		const expiredPrepareStartedAt = Date.now();
		await expect(lostPrepare.prepareHardSignal(expiredPrepareInput)).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const expiredPrepareDeadline = expiredPrepareStartedAt + 33_000;
		while (Date.now() <= expiredPrepareDeadline) {
			await retryAmbiguousReplay(() =>
				bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }),
			);
			await Bun.sleep(Math.min(5_000, Math.max(1, expiredPrepareDeadline - Date.now() + 1)));
		}
		await expect(
			retryAmbiguousReplay(() => lostPrepare.prepareHardSignal(expiredPrepareInput)),
		).rejects.toMatchObject({
			failure: { kind: "hard-signal-authorization-expired" },
		});
		const lostExpiredRollback = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/drain-rollback",
			diagnosticFetch,
		);
		const expiredRollbackInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: expiredPrepareBegin.drainGeneration,
		};
		await expect(lostExpiredRollback.rollbackDrain(expiredRollbackInput)).rejects.toBeInstanceOf(
			LifecycleE4ClientError,
		);
		const recoveredExpiredRollback = await retryAmbiguousReplay(() =>
			lostExpiredRollback.rollbackDrain(expiredRollbackInput),
		);
		expect(recoveredExpiredRollback.result).toBe("rolled_back");
		const expiredPrepareRecoveryMs = Date.now() - expiredPrepareStartedAt;
		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));

		const rollbackCredential = authorityId();
		const rollbackClientInstanceId = clientId("rollback");
		const rollbackRegistration = await bound.registerClient({
			clientInstanceId: rollbackClientInstanceId,
			workspaceId: workspaceId("d"),
			lifecycleMode: "local-owned",
			registrationCredential: rollbackCredential,
		});
		const rollbackBegin = await bound.beginControlDrain({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			controlRequestId: authorityId(),
			registrationId: rollbackRegistration.registrationId,
			requesterRegistrationGeneration: rollbackRegistration.registrationGeneration,
			requesterClientInstanceId: rollbackClientInstanceId,
			registrationCredential: rollbackCredential,
			expectedAdmissionEpoch: rollbackRegistration.admissionEpoch,
		});
		const rollbackPermitted = await bound.recordGracefulControl({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: rollbackBegin.drainGeneration,
			outcome: "definitive_rejection",
		});
		expect(rollbackPermitted.result).toBe("rollback_permitted");
		const rollbackExpiry = await waitForRegistrationExpiry(
			bound,
			owner.ownerGeneration,
			ownerCredential,
			rollbackRegistration.expiresAtUnix,
		);
		const lostRollback = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/drain-rollback",
			diagnosticFetch,
		);
		const rollbackInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: rollbackBegin.drainGeneration,
		};
		await expect(lostRollback.rollbackDrain(rollbackInput)).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const recoveredRollback = await retryAmbiguousReplay(() => lostRollback.rollbackDrain(rollbackInput));
		expect(recoveredRollback.result).toBe("rolled_back");
		const expiryWaitsMs = {
			requester: requesterExpiry.elapsedMs,
			rejection: rejectionExpiry.elapsedMs,
			abandoned: abandonedExpiry.elapsedMs,
			rollback: rollbackExpiry.elapsedMs,
		};
		const ownerExpiryMarginsSeconds = {
			requester: requesterExpiry.ownerExpiryMarginSeconds,
			rejection: rejectionExpiry.ownerExpiryMarginSeconds,
			abandoned: abandonedExpiry.ownerExpiryMarginSeconds,
			rollback: rollbackExpiry.ownerExpiryMarginSeconds,
		};
		expect(Object.values(expiryWaitsMs).every(elapsed => elapsed > 0 && elapsed <= 32_000)).toBe(true);
		expect(Object.values(ownerExpiryMarginsSeconds).every(margin => margin >= 15)).toBe(true);
		expect(expiredPrepareRecoveryMs).toBeGreaterThanOrEqual(33_000);
		expect(expiredPrepareRecoveryMs).toBeLessThanOrEqual(40_000);
		process.stdout.write(
			`${JSON.stringify({
				leaseTtlSeconds: requester.leaseTtlSeconds,
				renewalIntervalSeconds: requester.renewalIntervalSeconds,
				expiryWaitsMs,
				ownerExpiryMarginsSeconds,
				expiredPrepareRecoveryMs,
				finalAdmissionEpoch: recoveredRollback.admissionEpoch,
			})}\n`,
		);

		await retryAmbiguousReplay(() => bound.renewOwner({ ownerGeneration: owner.ownerGeneration, ownerCredential }));
		const hostileCredential = authorityId();
		const hostileClientInstanceId = clientId("hostile");
		const hostileRegistration = await bound.registerClient({
			clientInstanceId: hostileClientInstanceId,
			workspaceId: workspaceId("e"),
			lifecycleMode: "local-owned",
			registrationCredential: hostileCredential,
		});
		const hostileBase = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			registrationId: hostileRegistration.registrationId,
			requesterRegistrationGeneration: hostileRegistration.registrationGeneration,
			requesterClientInstanceId: hostileClientInstanceId,
			registrationCredential: hostileCredential,
		};
		await expect(
			bound.beginControlDrain({
				...hostileBase,
				controlRequestId: authorityId(),
				expectedAdmissionEpoch: recoveredRollback.admissionEpoch - 1,
			}),
		).rejects.toMatchObject({ failure: { kind: "drain-conflict" } });
		await expect(
			bound.beginControlDrain({
				...hostileBase,
				controlRequestId: authorityId(),
				registrationCredential: authorityId(),
				expectedAdmissionEpoch: recoveredRollback.admissionEpoch,
			}),
		).rejects.toMatchObject({ failure: { kind: "auth" } });
		await expect(
			bound.beginControlDrain({
				...hostileBase,
				controlRequestId: "unsafe",
				expectedAdmissionEpoch: recoveredRollback.admissionEpoch,
			}),
		).rejects.toMatchObject({ failure: { kind: "protocol" } });
		const detachedHostile = await bound.detachClient({
			registrationId: hostileRegistration.registrationId,
			registrationGeneration: hostileRegistration.registrationGeneration,
			clientInstanceId: hostileClientInstanceId,
			registrationCredential: hostileCredential,
		});
		expect(detachedHostile).toMatchObject({
			result: "detached",
			registrationId: hostileRegistration.registrationId,
			registrationGeneration: hostileRegistration.registrationGeneration,
			clientInstanceId: hostileClientInstanceId,
		});

		const committedCredential = authorityId();
		const committedClientInstanceId = clientId("committed");
		const committedRegistration = await bound.registerClient({
			clientInstanceId: committedClientInstanceId,
			workspaceId: workspaceId("f"),
			lifecycleMode: "local-owned",
			registrationCredential: committedCredential,
		});
		const committedBegin = await bound.beginControlDrain({
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			controlRequestId: authorityId(),
			registrationId: committedRegistration.registrationId,
			requesterRegistrationGeneration: committedRegistration.registrationGeneration,
			requesterClientInstanceId: committedClientInstanceId,
			registrationCredential: committedCredential,
			expectedAdmissionEpoch: committedRegistration.admissionEpoch,
		});
		expect(
			(
				await bound.recordGracefulControl({
					ownerGeneration: owner.ownerGeneration,
					ownerCredential,
					drainGeneration: committedBegin.drainGeneration,
					outcome: "timeout",
				})
			).result,
		).toBe("hard_signal_decision_pending");
		const committedPrepareInput = {
			ownerGeneration: owner.ownerGeneration,
			ownerCredential,
			drainGeneration: committedBegin.drainGeneration,
			pid: bound.binding.process.pid,
			osProcessStartToken: bound.binding.process.osProcessStartToken,
		};
		const lostCommittedPrepare = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/hard-signal/prepare",
			diagnosticFetch,
		);
		await expect(lostCommittedPrepare.prepareHardSignal(committedPrepareInput)).rejects.toBeInstanceOf(
			LifecycleE4ClientError,
		);
		const recoveredPreparation = await retryAmbiguousReplay(() =>
			lostCommittedPrepare.prepareHardSignal(committedPrepareInput),
		);
		expect(recoveredPreparation).toMatchObject({
			result: "prepared",
			signalPermitted: false,
			drainGeneration: committedBegin.drainGeneration,
		});
		const committedInput = {
			...committedPrepareInput,
			authorizationId: recoveredPreparation.authorizationId,
		};
		await expect(
			bound.commitHardSignal({
				...committedInput,
				ownerGeneration: owner.ownerGeneration + 1,
			}),
		).rejects.toBeInstanceOf(LifecycleE4ClientError);
		await expect(
			bound.commitHardSignal({
				...committedInput,
				authorizationId: authorityId(),
			}),
		).rejects.toBeInstanceOf(LifecycleE4ClientError);
		await expect(
			bound.commitHardSignal({
				...committedInput,
				authorizationId: "unsafe",
			}),
		).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const lostCommit = await boundDroppingOneResponse(
			baseUrl,
			"/v1/engine/control/hard-signal/commit",
			diagnosticFetch,
		);
		await expect(lostCommit.commitHardSignal(committedInput)).rejects.toBeInstanceOf(LifecycleE4ClientError);
		const recoveredPermit = await retryAmbiguousReplay(() => lostCommit.commitHardSignal(committedInput));
		expect(recoveredPermit).toMatchObject({
			result: "signal_permitted",
			signalPermitted: true,
			authorizationId: recoveredPreparation.authorizationId,
			drainGeneration: committedBegin.drainGeneration,
		});
		process.stdout.write(
			`${JSON.stringify({
				hardSignalCommitReplay: {
					prepareResult: recoveredPreparation.result,
					prepareSignalPermitted: recoveredPreparation.signalPermitted,
					commitResult: recoveredPermit.result,
					commitSignalPermitted: recoveredPermit.signalPermitted,
					drainGeneration: recoveredPermit.drainGeneration,
				},
				backendRuntime: {
					python: backendPython,
					sourceRoot: "private-verified-snapshot",
					commit: verifiedBackend.commit,
					tree: verifiedBackend.tree,
				},
			})}\n`,
		);
	} catch (error) {
		const stderrBytes = Buffer.from(stderrText, "utf8");
		process.stderr.write(
			`[bb89n34-diagnostic]${JSON.stringify({
				schemaVersion: "bb89n34.v7.integration-diagnostic.v1",
				phase: diagnosticState.phase,
				backend:
					backend === undefined
						? null
						: {
								exitCode: backend.exitCode,
								signalCode: backend.signalCode,
								killed: backend.killed,
							},
				stderr: {
					byteCount: stderrBytes.byteLength,
					sha256: createHash("sha256").update(stderrBytes).digest("hex"),
				},
				fetchFailure: diagnosticState.fetchFailure,
				thrown: safeThrownError(error),
			})}\n`,
		);
		throw error;
	} finally {
		bootstrapCredential.fill(0);
		if (backend) {
			backend.kill("SIGTERM");
			await Promise.race([once(backend, "exit"), Bun.sleep(2_000)]);
			if (backend.exitCode === null) backend.kill("SIGKILL");
		}
		await verifiedBackend.close();
	}
}, 240_000);
