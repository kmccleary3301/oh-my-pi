import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTHORITY_RECORD_SCHEMA_VERSION, LocalAuthorityStore, LocalAuthorityStoreError } from "./local-authority-store";

const roots: string[] = [];
const endpoint = "http://127.0.0.1:7777";
const ownerCredential = "a".repeat(43);

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
		const committed = await store.withExclusiveLock(endpoint, () => store.commit(endpoint, null, record(), { ownerCredential }));
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
		expect(publicText).not.toContain(`"ownerCredential":"${ownerCredential}"`);
		const secret = await store.readSecret(committed);
		expect(secret.ownerCredential).toBe(ownerCredential);
	});

	test("enforces generation CAS and retires only the current generation", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root);
		await store.withExclusiveLock(endpoint, async () => {
			const first = await store.commit(endpoint, null, record(), { ownerCredential });
			await expect(store.commit(endpoint, null, record(2), { ownerCredential })).rejects.toMatchObject({ code: "generation_conflict" });
			const second = await store.commit(endpoint, first, record(2), { ownerCredential });
			expect(second.ownerGeneration).toBe(2);
			await expect(store.retireDeadGeneration(endpoint, first)).rejects.toMatchObject({ code: "generation_conflict" });
			await store.retireDeadGeneration(endpoint, second);
			expect(await store.readCurrent(endpoint)).toBeNull();
		});
		const names = await readdir(root);
		expect(names.some(name => name.includes("retired.2"))).toBe(true);
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
			await expect(store.retireDeadGeneration(endpoint, current)).rejects.toThrow("synthetic retirement interruption");
			expect(await store.readCurrent(endpoint)).toEqual(current);
			await expect(store.readSecret(current)).rejects.toBeDefined();
		});
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
		await expect(store.withExclusiveLock(endpoint, () => store.readCurrentForRecovery(endpoint))).rejects.toBeInstanceOf(LocalAuthorityStoreError);
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
		await expect(store.withExclusiveLock(endpoint, async () => "never")).rejects.toMatchObject({ code: "lock_integrity" });
	});

	test("removes an unreferenced secret when public record commit fails", async () => {
		const root = await temporaryRoot();
		const store = new LocalAuthorityStore(root, {
			beforeAtomicRename: (_from, to) => {
				if (to.endsWith(".authority.json")) throw new Error("synthetic public commit failure");
			},
		});
		await expect(store.withExclusiveLock(endpoint, () => store.commit(endpoint, null, record(), { ownerCredential })))
			.rejects.toThrow("synthetic public commit failure");
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
		await expect(store.withExclusiveLock(endpoint, () => store.commit(endpoint, null, record(), { ownerCredential })))
			.rejects.toMatchObject({ code: "root_integrity" });
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
			const prepared = await store.prepareStartClaim(endpoint, claimed.claim.token, {
				launchId: "launch_abcdefghijklmnopqrstuvwxyz0123456789012",
				executableSha256: `sha256:${"a".repeat(64)}`,
				engineArtifactSha256: `sha256:${"b".repeat(64)}`,
				servedBackendCommit: "c".repeat(40),
			}, { bootstrapCredential, ownerCredential });
			bootstrapCredential.fill(0);
			await store.bindStartClaimProcess(endpoint, prepared.token, enginePid, "darwin:4321:123456");
			const recovered = await store.claimStart(endpoint);
			expect(recovered.kind).toBe("recoverable");
			if (recovered.kind !== "recoverable") throw new Error("expected recoverable start");
			const firstSecret = await store.readPendingSecret(recovered.claim);
			expect([...firstSecret.bootstrapCredential]).toEqual([...Buffer.alloc(32, 7)]);
			firstSecret.bootstrapCredential.fill(0);
			const secondSecret = await store.readPendingSecret(recovered.claim);
			expect([...secondSecret.bootstrapCredential]).toEqual([...Buffer.alloc(32, 7)]);
			secondSecret.bootstrapCredential.fill(0);
			await store.releaseStartClaim(endpoint, recovered.claim.token);
		});
		const names = await readdir(root);
		expect(names.some(name => name.includes(".starting.secret."))).toBe(false);
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
			sleep: async () => { await Promise.resolve(); },
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
