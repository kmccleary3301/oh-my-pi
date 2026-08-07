import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ResidentSessionRegistry } from "../../src/recursive-control/resident-sessions";
import type { ToolSession } from "../../src/tools";

let roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** Two registries over one directory stand in for two processes sharing a project. */
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resident-"));
	roots.push(root);
	const session: ToolSession = {
		cwd: path.join(root, "repo"),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "session-fixture",
		getAgentId: () => "Main",
	};
	let clock = T0;
	const at = (ms: number) => {
		clock = ms;
	};
	const open = (ownerId: string) => new ResidentSessionRegistry(session, { rootDir: root, ownerId, now: () => clock });
	return { open, at, first: open("proc-1"), second: open("proc-2") };
}

const ENTRY = { handle: "agent-handle:1", agentId: "Worker", sessionId: "sess-1", label: "indexer" };

describe("resident session records", () => {
	test("survives the registry that created it", async () => {
		const { first, second } = await fixture();
		await first.register(ENTRY);

		const seen = await second.get(ENTRY.handle);

		expect(seen?.agentId).toBe("Worker");
		expect(seen?.sessionId).toBe("sess-1");
		expect(seen?.label).toBe("indexer");
		expect(seen?.state).toBe("active");
	});

	test("refuses to register the same handle twice", async () => {
		const { first } = await fixture();
		await first.register(ENTRY);

		await expect(first.register(ENTRY)).rejects.toThrow("already registered");
	});

	test("forget removes the record", async () => {
		const { first } = await fixture();
		await first.register(ENTRY);

		await first.forget(ENTRY.handle);

		expect(await first.get(ENTRY.handle)).toBeNull();
	});

	test("records the last observed status without needing the lease", async () => {
		const { first } = await fixture();
		await first.register(ENTRY);

		await first.noteStatus(ENTRY.handle, "running");

		expect((await first.get(ENTRY.handle))?.lastStatus).toBe("running");
	});
});

describe("resident session leases", () => {
	test("blocks a second process while the first lease is live", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		await expect(second.attach(ENTRY.handle)).rejects.toThrow("leased by proc-1");
	});

	test("hands the record over after a clean detach", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		const detached = await first.detach(ENTRY.handle);
		const attached = await second.attach(ENTRY.handle);

		expect(detached.state).toBe("detached");
		expect(detached.lease).toBeUndefined();
		expect(attached.state).toBe("active");
		expect(attached.lease?.owner).toBe("proc-2");
	});

	test("reclaims a lapsed lease and marks the unclean exit", async () => {
		const { first, second, at } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		at(T0 + 60_001);
		const lapsed = await second.get(ENTRY.handle);
		const attached = await second.attach(ENTRY.handle);

		// `expired` distinguishes a crashed owner from a deliberate detach.
		expect(lapsed?.state).toBe("expired");
		expect(lapsed?.lease).toBeUndefined();
		expect(attached.lease?.owner).toBe("proc-2");
	});

	test("keeps the lease alive across a renewal", async () => {
		const { first, second, at } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		at(T0 + 50_000);
		await first.renew(ENTRY.handle, 60_000);
		at(T0 + 100_000);

		expect((await second.get(ENTRY.handle))?.state).toBe("active");
		await expect(second.attach(ENTRY.handle)).rejects.toThrow("leased by proc-1");
	});

	test("refuses renewal by a process that does not hold the lease", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		await expect(second.renew(ENTRY.handle)).rejects.toThrow("cannot renew");
	});

	test("refuses detach by a process that does not hold the lease", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		await expect(second.detach(ENTRY.handle)).rejects.toThrow("cannot detach");
	});
});

describe("resident session passivation", () => {
	test("passivation frees the lease but keeps the record attachable", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		const passivated = await first.detach(ENTRY.handle, { passivate: true });
		const recovered = await second.attach(ENTRY.handle);

		expect(passivated.state).toBe("passivated");
		expect(recovered.state).toBe("active");
		expect(recovered.agentId).toBe("Worker");
	});
});

describe("resident session schedules", () => {
	test("reports nothing before the wake time", async () => {
		const { first } = await fixture();
		await first.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 60_000).toISOString() } });

		expect(await first.claimDue()).toEqual([]);
	});

	test("reports a record once its wake time arrives", async () => {
		const { first, at } = await fixture();
		await first.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 60_000).toISOString() } });

		at(T0 + 60_000);
		const due = await first.claimDue();

		expect(due.map(record => record.handle)).toEqual([ENTRY.handle]);
	});

	test("a one-shot wake does not fire twice", async () => {
		const { first, at } = await fixture();
		await first.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 60_000).toISOString() } });

		at(T0 + 60_000);
		await first.claimDue();
		at(T0 + 120_000);

		expect(await first.claimDue()).toEqual([]);
		expect((await first.get(ENTRY.handle))?.schedule).toBeUndefined();
	});

	test("a repeating wake rolls forward instead of firing continuously", async () => {
		const { first, at } = await fixture();
		await first.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 10_000).toISOString(), everyMs: 30_000 },
		});

		at(T0 + 10_000);
		expect(await first.claimDue()).toHaveLength(1);
		at(T0 + 20_000);
		expect(await first.claimDue()).toHaveLength(0);
		at(T0 + 40_000);
		expect(await first.claimDue()).toHaveLength(1);
	});

	test("clearing a schedule stops the wake", async () => {
		const { first, at } = await fixture();
		await first.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 60_000).toISOString() } });

		await first.schedule(ENTRY.handle, null);
		at(T0 + 60_000);

		expect(await first.claimDue()).toEqual([]);
	});

	test("refuses an unparseable wake time", async () => {
		const { first } = await fixture();
		await first.register(ENTRY);

		await expect(first.schedule(ENTRY.handle, { wakeAt: "soon" })).rejects.toThrow("invalid schedule.wakeAt");
	});

	test("refuses scheduling by a process that does not hold the lease", async () => {
		const { first, second } = await fixture();
		await first.register({ ...ENTRY, leaseMs: 60_000 });

		await expect(second.schedule(ENTRY.handle, { wakeAt: new Date(T0).toISOString() })).rejects.toThrow(
			"cannot schedule",
		);
	});
});
