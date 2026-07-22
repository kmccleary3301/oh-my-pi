import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTHORITY_RECORD_SCHEMA_VERSION,
	LocalAuthorityStore,
	LocalAuthorityStoreError,
} from "./local-authority-store";
import { executablePathSha256 } from "./run-config";

const roots: string[] = [];
const endpoint = "http://127.0.0.1:7777";
const ownerCredential = Buffer.from("owner_credential_abcdefghijklmnopqrstuvwxyz012345", "ascii");

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-lifecycle-store-"));
	roots.push(root);
	return root;
}

function record(generation = 1) {
	return {
		engineInstanceId: "engine_instance_abcdefghijklmnopqrstuvwxyz012345",
		engineBootId: "engine_boot_abcdefghijklmnopqrstuvwxyz012345678",
		launchId: "launch_abcdefghijklmnopqrstuvwxyz0123456789012",
		ownerGeneration: generation,
		pid: 1234,
		osProcessStartToken: "darwin:123:456",
		normalizedEndpoint: endpoint,
		executableSha256: `sha256:${"a".repeat(64)}`,
		executablePathSha256: executablePathSha256("/usr/bin/false"),
		argvSha256: `sha256:${"d".repeat(64)}`,
		engineArtifactSha256: `sha256:${"b".repeat(64)}`,
		servedBackendCommit: "c".repeat(40),
		ownerExitPolicy: "attached" as const,
		createdAt: "2026-07-17T00:00:00.000Z",
		lastVerifiedAt: "2026-07-17T00:00:00.000Z",
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("LocalAuthorityStore", () => {
	test("creates a user-only root and separate durable public/secret records", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		const committed = await store.withExclusiveLock(endpoint, () =>
			store.commit(endpoint, null, record(), { ownerCredential }),
		);
		const key = LocalAuthorityStore.endpointKey(endpoint);
		const rootMetadata = await lstat(root);
		const publicMetadata = await lstat(join(root, `${key}.authority.json`));
		const secretMetadata = await lstat(join(root, committed.ownerCredentialRef));
		expect(rootMetadata.mode & 0o777).toBe(0o700);
		expect(publicMetadata.mode & 0o777).toBe(0o600);
		expect(secretMetadata.mode & 0o777).toBe(0o600);
		expect(publicMetadata.nlink).toBe(1);
		expect(committed.schemaVersion).toBe(AUTHORITY_RECORD_SCHEMA_VERSION);
		const publicText = await Bun.file(join(root, `${key}.authority.json`)).text();
		expect(publicText).not.toContain(ownerCredential.toString("ascii"));
		const secret = await store.readSecret(committed);
		expect(secret.ownerCredential).toEqual(ownerCredential);
		secret.ownerCredential.fill(0);
		const secretBytes = Buffer.from(await Bun.file(join(root, committed.ownerCredentialRef)).arrayBuffer());
		expect(secretBytes.subarray(0, 32).toString("utf8")).toContain("p30.local-authority-secret");
		expect(() => JSON.parse(secretBytes.toString("utf8"))).toThrow();
		secretBytes.fill(0);
	});

	test("persists one strict control attempt and its drain binding across authority rotation", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root, { now: () => 1_784_373_178_000 });
		const committed = await store.withExclusiveLock(endpoint, () =>
			store.commit(endpoint, null, record(), { ownerCredential }),
		);
		const key = LocalAuthorityStore.endpointKey(endpoint);
		const orphanControlSecret = `${key}.control.secret.orphan_control_credential_abcdefghijkl.bin`;
		await writeFile(join(root, orphanControlSecret), "simulated interrupted secret write", { mode: 0o600 });
		const requester = {
			registrationId: "registration_abcdefghijklmnopqrstuvwxyz012345",
			registrationGeneration: 1,
			clientInstanceId: "p30-real-controller-abcdefghijklmnopqrstuvwxyz",
			registrationCredential: "requester_credential_abcdefghijklmnopqrstuvwxyz",
			admissionEpoch: 7,
		};
		const first = await store.withExclusiveLock(endpoint, () =>
			store.prepareControlAttempt(
				endpoint,
				committed,
				"stop",
				"control_request_abcdefghijklmnopqrstuvwxyz012345",
				requester,
			),
		);
		await expect(lstat(join(root, orphanControlSecret))).rejects.toMatchObject({ code: "ENOENT" });
		const replay = await store.withExclusiveLock(endpoint, () =>
			store.prepareControlAttempt(
				endpoint,
				committed,
				"stop",
				"replacement_request_abcdefghijklmnopqrstuvwxyz0",
				requester,
			),
		);
		expect(replay).toEqual(first);
		const draining = await store.withExclusiveLock(endpoint, () =>
			store.markControlAttemptDraining(endpoint, first, 2),
		);
		expect(draining).toMatchObject({
			phase: "draining",
			drainGeneration: 2,
			registrationId: requester.registrationId,
			requesterRegistrationGeneration: requester.registrationGeneration,
			requesterClientInstanceId: requester.clientInstanceId,
		});
		expect((await lstat(join(root, first.requesterCredentialRef))).mode & 0o777).toBe(0o600);
		const requesterSecret = await store.readControlAttemptSecret(first);
		expect(requesterSecret.requesterRegistrationCredential.toString("utf8")).toBe(requester.registrationCredential);
		requesterSecret.requesterRegistrationCredential.fill(0);
		let committing = await store.withExclusiveLock(endpoint, () =>
			store.advanceControlAttempt(endpoint, draining, "graceful-accepted"),
		);
		committing = await store.withExclusiveLock(endpoint, () =>
			store.advanceControlAttempt(endpoint, committing, "hard-signal-pending"),
		);
		committing = await store.withExclusiveLock(endpoint, () =>
			store.advanceControlAttempt(endpoint, committing, "hard-signal-commit-pending"),
		);
		expect(committing.phase).toBe("hard-signal-commit-pending");
		const rotatedCredential = Buffer.from("rotated_owner_credential_abcdefghijklmnopq", "ascii");
		const rotated = await store.withExclusiveLock(endpoint, () =>
			store.commit(endpoint, committed, record(2), { ownerCredential: rotatedCredential }),
		);
		expect(await store.readControlAttempt(endpoint, rotated)).toEqual(committing);
		expect(
			await store.withExclusiveLock(endpoint, () =>
				store.prepareControlAttempt(
					endpoint,
					rotated,
					"stop",
					"another_request_abcdefghijklmnopqrstuvwxyz012",
					requester,
				),
			),
		).toEqual(committing);
		const controlPath = join(root, `${key}.control.json`);
		const controlText = await Bun.file(controlPath).text();
		expect(controlText).not.toContain(ownerCredential.toString("ascii"));
		expect(controlText).not.toContain(rotatedCredential.toString("ascii"));
		expect(controlText).not.toContain(requester.registrationCredential);
		expect(controlText).not.toContain("/usr/");
		expect(controlText).not.toContain("authorization_");
		expect(controlText).not.toContain("owner_credential");
		expect(controlText).not.toContain("darwin:123:456");
		await writeFile(controlPath, controlText.replace(',"createdAtUnix"', ',"unexpected":true,"createdAtUnix"'), {
			mode: 0o600,
		});
		await expect(store.readControlAttempt(endpoint, rotated)).rejects.toMatchObject({
			code: "control_attempt_integrity",
		});
		await writeFile(controlPath, controlText, { mode: 0o600 });
		await store.withExclusiveLock(endpoint, () => store.clearControlAttempt(endpoint, committing));
		await expect(lstat(join(root, first.requesterCredentialRef))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.readControlAttempt(endpoint, rotated)).toBeNull();
	});
	test("atomically converges concurrent replacements of one expired begin requester", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		const committed = await store.withExclusiveLock(endpoint, () =>
			store.commit(endpoint, null, record(), { ownerCredential }),
		);
		const expiredRequester = {
			registrationId: "registration_expired_abcdefghijklmnopqrstuvwxyz",
			registrationGeneration: 1,
			clientInstanceId: "client_expired_abcdefghijklmnopqrstuvwxyz012345",
			registrationCredential: "requester_expired_credential_abcdefghijklmnopqrstuvwxyz",
			admissionEpoch: 7,
		};
		const expired = await store.withExclusiveLock(endpoint, () =>
			store.prepareControlAttempt(
				endpoint,
				committed,
				"stop",
				"control_request_expired_abcdefghijklmnopqrstuvwxyz",
				expiredRequester,
			),
		);
		const requesterA = {
			registrationId: "registration_current_a_abcdefghijklmnopqrstuvwxyz",
			registrationGeneration: 2,
			clientInstanceId: "client_current_a_abcdefghijklmnopqrstuvwxyz012345",
			registrationCredential: "requester_current_a_credential_abcdefghijklmnopqrstuvwxyz",
			admissionEpoch: 8,
		};
		const requesterB = {
			registrationId: "registration_current_b_abcdefghijklmnopqrstuvwxyz",
			registrationGeneration: 3,
			clientInstanceId: "client_current_b_abcdefghijklmnopqrstuvwxyz012345",
			registrationCredential: "requester_current_b_credential_abcdefghijklmnopqrstuvwxyz",
			admissionEpoch: 8,
		};
		const [winnerA, winnerB] = await Promise.all([
			store.withExclusiveLock(endpoint, () =>
				store.replaceExpiredBeginControlAttempt(
					endpoint,
					committed,
					expired,
					"stop",
					"control_request_current_a_abcdefghijklmnopqrstuvwxyz",
					requesterA,
				),
			),
			store.withExclusiveLock(endpoint, () =>
				store.replaceExpiredBeginControlAttempt(
					endpoint,
					committed,
					expired,
					"stop",
					"control_request_current_b_abcdefghijklmnopqrstuvwxyz",
					requesterB,
				),
			),
		]);
		expect(winnerA).toEqual(winnerB);
		expect(winnerA.controlRequestId).not.toBe(expired.controlRequestId);
		expect([requesterA.registrationId, requesterB.registrationId]).toContain(winnerA.registrationId);
		await expect(lstat(join(root, expired.requesterCredentialRef))).rejects.toMatchObject({ code: "ENOENT" });
		const names = await readdir(root);
		const secretNames = names.filter(name => name.includes(".control.secret."));
		expect(secretNames).toEqual([winnerA.requesterCredentialRef]);
		const publicText = await Bun.file(join(root, `${LocalAuthorityStore.endpointKey(endpoint)}.control.json`)).text();
		expect(publicText).not.toContain(expiredRequester.registrationCredential);
		expect(publicText).not.toContain(requesterA.registrationCredential);
		expect(publicText).not.toContain(requesterB.registrationCredential);
		const winnerSecret = await store.readControlAttemptSecret(winnerA);
		expect([requesterA.registrationCredential, requesterB.registrationCredential]).toContain(
			winnerSecret.requesterRegistrationCredential.toString("utf8"),
		);
		winnerSecret.requesterRegistrationCredential.fill(0);
	});

	test("enforces generation CAS and retires only the current generation", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		await store.withExclusiveLock(endpoint, async () => {
			const first = await store.commit(endpoint, null, record(), { ownerCredential });
			await expect(store.commit(endpoint, null, record(2), { ownerCredential })).rejects.toMatchObject({
				code: "generation_conflict",
			});
			const second = await store.commit(endpoint, first, record(2), { ownerCredential });
			expect(second.ownerGeneration).toBe(2);
			await expect(store.retireDeadGeneration(endpoint, first)).rejects.toMatchObject({
				code: "generation_conflict",
			});
			await store.retireDeadGeneration(endpoint, second);
			expect(await store.readCurrent(endpoint)).toBeNull();
		});
		const names = await readdir(root);
		expect(names.some(name => name.includes("retired.2"))).toBe(true);
		expect(names.some(name => name.includes(".secret."))).toBe(false);
	});

	test("keeps the public generation fail-closed when retirement is interrupted", async () => {
		const root = await temporaryRoot();
		let interrupt = false;
		const store = new LocalAuthorityStore(root, {
			beforeAtomicRename: (_from, to) => {
				if (interrupt && to.includes(".authority.retired.")) throw new Error("synthetic retirement interruption");
			},
		});
		await store.withExclusiveLock(endpoint, async () => {
			const current = await store.commit(endpoint, null, record(), { ownerCredential });
			interrupt = true;
			await expect(store.retireDeadGeneration(endpoint, current)).rejects.toThrow(
				"synthetic retirement interruption",
			);
			expect(await store.readCurrent(endpoint)).toEqual(current);
			const preservedSecret = await store.readSecret(current);
			expect(preservedSecret.ownerCredential).toEqual(ownerCredential);
			preservedSecret.ownerCredential.fill(0);
		});
	});

	test("retires the public record before secret cleanup and removes the orphan on restart", async () => {
		const root = await temporaryRoot();
		let interruptCleanup = false;
		const store = new LocalAuthorityStore(root, {
			beforeUnlink: path => {
				if (interruptCleanup && path.includes(".secret.")) throw new Error("synthetic secret cleanup interruption");
			},
		});
		const current = await store.withExclusiveLock(endpoint, () =>
			store.commit(endpoint, null, record(), { ownerCredential }),
		);
		interruptCleanup = true;
		await expect(
			store.withExclusiveLock(endpoint, () => store.retireDeadGeneration(endpoint, current)),
		).rejects.toThrow("synthetic secret cleanup interruption");
		expect(await store.readCurrent(endpoint)).toBeNull();
		expect((await readdir(root)).some(name => name === current.ownerCredentialRef)).toBe(true);

		const restarted = new LocalAuthorityStore(root);
		const claim = await restarted.withExclusiveLock(endpoint, () => restarted.claimStart(endpoint));
		expect(claim.kind).toBe("claimed");
		expect((await readdir(root)).some(name => name.includes(".secret."))).toBe(false);
	});

	test("quarantines malformed current records without using their PID", async () => {
		const root = await temporaryRoot();
		let initialized = false;
		const store = new LocalAuthorityStore(root, {
			beforeAtomicRename: (_from, to) => {
				if (to.includes("authority.invalid")) initialized = true;
			},
		});
		await store.initialize();
		const key = LocalAuthorityStore.endpointKey(endpoint);
		const path = join(root, `${key}.authority.json`);
		await writeFile(path, '{"pid":999999,"ownerCredential":"synthetic-secret"}\n', { mode: 0o600 });
		await expect(
			store.withExclusiveLock(endpoint, () => store.readCurrentForRecovery(endpoint)),
		).rejects.toBeInstanceOf(LocalAuthorityStoreError);
		expect(initialized).toBe(true);
		const names = await readdir(root);
		expect(names.some(name => name.startsWith(`${key}.authority.invalid.`))).toBe(true);
		expect(names).not.toContain(`${key}.authority.json`);
	});

	test("pure status probe rejects malformed state without quarantine or mutation", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		await store.initialize();
		const key = LocalAuthorityStore.endpointKey(endpoint);
		await writeFile(join(root, `${key}.authority.json`), '{"pid":999999}\n', { mode: 0o600 });
		const before = (await readdir(root)).sort();
		await expect(store.probeCurrent(endpoint)).rejects.toMatchObject({ code: "authority_record_invalid" });
		expect((await readdir(root)).sort()).toEqual(before);
	});

	test("rejects no-follow and root ownership/permission integrity failures", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		await store.initialize();
		const key = LocalAuthorityStore.endpointKey(endpoint);
		const target = join(root, "outside.json");
		await writeFile(target, "{}\n", { mode: 0o600 });
		await symlink(target, join(root, `${key}.authority.json`));
		await expect(store.readCurrent(endpoint)).rejects.toBeTruthy();
		await rm(join(root, `${key}.authority.json`));
		await chmod(root, 0o755);
		await expect(store.initialize()).rejects.toMatchObject({ code: "root_integrity" });
		const wrongOwner = new LocalAuthorityStore(root, { uid: () => 99_999 });
		await expect(wrongOwner.initialize()).rejects.toMatchObject({ code: "root_integrity" });
	});

	test("rejects an unsafe pre-existing root without repairing its mode", async () => {
		const root = await temporaryRoot();
		await chmod(root, 0o755);
		const store = new LocalAuthorityStore(root);
		await expect(store.initialize()).rejects.toMatchObject({ code: "root_integrity" });
		expect((await lstat(root)).mode & 0o777).toBe(0o755);
	});

	test("fails closed when the lock pathname is replaced after descriptor locking", async () => {
		const root = await temporaryRoot();
		const key = LocalAuthorityStore.endpointKey(endpoint);
		let replaced = false;
		const store = new LocalAuthorityStore(root, {
			beforeLockIdentityCheck: async lockPath => {
				if (replaced) return;
				replaced = true;
				await rename(lockPath, join(root, `${key}.lock.displaced`));
				await writeFile(lockPath, "{}\n", { mode: 0o600 });
			},
		});
		await expect(store.withExclusiveLock(endpoint, async () => "never")).rejects.toMatchObject({
			code: "lock_integrity",
		});
	});

	test("removes an unreferenced secret when public record commit fails", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root, {
			beforeAtomicRename: (_from, to) => {
				if (to.endsWith(".authority.json")) throw new Error("synthetic public commit failure");
			},
		});
		await expect(
			store.withExclusiveLock(endpoint, () => store.commit(endpoint, null, record(), { ownerCredential })),
		).rejects.toThrow("synthetic public commit failure");
		expect((await readdir(root)).some(name => name.includes(".secret."))).toBe(false);
	});

	test("fails closed if the authority root is replaced before atomic rename", async () => {
		const root = await temporaryRoot();
		const displaced = `${root}.displaced`;
		roots.push(displaced);
		let replaced = false;
		const store = new LocalAuthorityStore(root, {
			beforeAtomicRename: async () => {
				if (replaced) return;
				replaced = true;
				await rename(root, displaced);
				await mkdir(root, { mode: 0o700 });
			},
		});
		await expect(
			store.withExclusiveLock(endpoint, () => store.commit(endpoint, null, record(), { ownerCredential })),
		).rejects.toMatchObject({ code: "root_integrity" });
		expect(await readdir(root)).toEqual([]);
	});

	test("recovers a bound start claim with independently mutable binary bootstrap material", async () => {
		const root = await temporaryRoot();
		let random = 0;
		const enginePid = 4321;
		const store = new LocalAuthorityStore(root, {
			randomId: () => `token_${String(++random).padStart(20, "0")}`,
			processStartToken: () => "starter-process-token",
			isLockOwnerAlive: async owner => owner.pid === enginePid,
		});
		await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			expect(claimed.kind).toBe("claimed");
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			const bootstrapCredential = Buffer.alloc(32, 7);
			const prepared = await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId: "launch_abcdefghijklmnopqrstuvwxyz0123456789012",
					executableSha256: `sha256:${"a".repeat(64)}`,
					engineArtifactSha256: `sha256:${"b".repeat(64)}`,
					servedBackendCommit: "c".repeat(40),
					executablePathSha256: executablePathSha256("/usr/bin/false"),
					argvSha256: `sha256:${"d".repeat(64)}`,
				},
				{ bootstrapCredential, ownerCredential },
			);
			bootstrapCredential.fill(0);
			const bound = await store.bindStartClaimProcess(endpoint, prepared.token, enginePid, "darwin:4321:123456");
			const firstAttempt = await store.markOwnerAttempt(endpoint, bound);
			const secondAttempt = await store.markOwnerAttempt(endpoint, firstAttempt);
			const rolledBack = await store.rollbackOwnerAttempt(endpoint, secondAttempt);
			expect(rolledBack.ownerAttemptGeneration).toBe(1);
			await expect(store.rollbackOwnerAttempt(endpoint, secondAttempt)).rejects.toMatchObject({
				code: "generation_conflict",
			});
			const recovered = await store.claimStart(endpoint);
			expect(recovered.kind).toBe("recoverable");
			if (recovered.kind !== "recoverable") throw new Error("expected recoverable start");
			const firstSecret = await store.readPendingSecret(recovered.claim);
			expect([...firstSecret.bootstrapCredential]).toEqual([...Buffer.alloc(32, 7)]);
			firstSecret.bootstrapCredential.fill(0);
			const secondSecret = await store.readPendingSecret(recovered.claim);
			expect([...secondSecret.bootstrapCredential]).toEqual([...Buffer.alloc(32, 7)]);
			secondSecret.bootstrapCredential.fill(0);
			firstSecret.ownerCredential.fill(0);
			secondSecret.ownerCredential.fill(0);
			await store.releaseStartClaim(endpoint, recovered.claim.token);
		});
		const names = await readdir(root);
		expect(names.some(name => name.includes(".starting.secret."))).toBe(false);
	});

	test("wipes both decoded pending credentials when their verifier mismatches", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		const bootstrapCredential = Buffer.alloc(32, 29);
		const pendingOwnerCredential = Buffer.from("pending_owner_credential_abcdefghijklmnopqrstuvwxyz", "ascii");
		const prepared = await store.withExclusiveLock(endpoint, async () => {
			const claimed = await store.claimStart(endpoint);
			if (claimed.kind !== "claimed") throw new Error("expected claimed start");
			return await store.prepareStartClaim(
				endpoint,
				claimed.claim.token,
				{
					launchId: "launch_pending_mismatch_abcdefghijklmnopqrstuvwxyz",
					executableSha256: `sha256:${"a".repeat(64)}`,
					executablePathSha256: executablePathSha256("/usr/bin/false"),
					argvSha256: `sha256:${"d".repeat(64)}`,
					engineArtifactSha256: `sha256:${"b".repeat(64)}`,
					servedBackendCommit: "c".repeat(40),
				},
				{ bootstrapCredential, ownerCredential: pendingOwnerCredential },
			);
		});
		const originalFrom = Buffer.from;
		const decoded: Buffer[] = [];
		(Buffer as unknown as { from: (...args: unknown[]) => Buffer }).from = (...args: unknown[]) => {
			const value = Reflect.apply(originalFrom, Buffer, args) as Buffer;
			if (value.equals(bootstrapCredential) || value.equals(pendingOwnerCredential)) decoded.push(value);
			return value;
		};
		try {
			await expect(
				store.readPendingSecret({
					...prepared,
					pendingSecretVerifier: `sha256:${"f".repeat(64)}`,
				}),
			).rejects.toMatchObject({ code: "secret_verifier_mismatch" });
		} finally {
			(Buffer as unknown as { from: typeof Buffer.from }).from = originalFrom;
		}
		expect(decoded).toHaveLength(2);
		expect(decoded.every(value => value.every(byte => byte === 0))).toBe(true);
		bootstrapCredential.fill(0);
		pendingOwnerCredential.fill(0);
		await store.withExclusiveLock(endpoint, () => store.releaseStartClaim(endpoint, prepared.token));
	});

	test("uses a stable Darwin process-start identity for live start claims", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		const first = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
		expect(first.kind).toBe("claimed");
		const second = await store.withExclusiveLock(endpoint, () => store.claimStart(endpoint));
		expect(second.kind).toBe("occupied");
		if (first.kind === "claimed") {
			await store.withExclusiveLock(endpoint, () => store.releaseStartClaim(endpoint, first.claim.token));
		}
	});

	test("OS lock serializes contenders and start-claim recovery is generation safe", async () => {
		const root = await temporaryRoot();
		let random = 0;
		const store = new LocalAuthorityStore(root, {
			randomId: () => `token_${String(++random).padStart(20, "0")}`,
			processStartToken: () => "current-start-token",
			isLockOwnerAlive: async () => false,
			sleep: async () => {
				await Promise.resolve();
			},
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let maximumActive = 0;
		const first = store.withExclusiveLock(endpoint, async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			entered.resolve();
			await release.promise;
			active--;
		});
		await entered.promise;
		const second = store.withExclusiveLock(endpoint, async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			active--;
		});
		await Promise.resolve();
		expect(maximumActive).toBe(1);
		release.resolve();
		await Promise.all([first, second]);
		expect(maximumActive).toBe(1);

		await store.withExclusiveLock(endpoint, async () => {
			const firstClaim = await store.claimStart(endpoint);
			expect(firstClaim.kind).toBe("claimed");
		});
		await store.withExclusiveLock(endpoint, async () => {
			const replacement = await store.claimStart(endpoint);
			expect(replacement.kind).toBe("claimed");
			if (replacement.kind === "claimed") await store.releaseStartClaim(endpoint, replacement.claim.token);
		});
		const names = await readdir(root);
		expect(names.some(name => name.includes(".starting.dead."))).toBe(true);
	});
});
