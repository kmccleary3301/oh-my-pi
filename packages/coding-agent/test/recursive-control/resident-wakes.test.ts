import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ResidentSessionRegistry } from "../../src/recursive-control/resident-sessions";
import {
	ResidentWakeScheduler,
	runDueResidentWakes,
	type WakeDelivery,
} from "../../src/recursive-control/resident-wakes";
import type { ToolSession } from "../../src/tools";

let roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots = [];
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wake-"));
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
	const registry = new ResidentSessionRegistry(session, { rootDir: root, ownerId: "proc-1", now: () => clock });
	const sent: Array<[string, string]> = [];
	const statuses = new Map<string, string>([["agent-handle:1", "running"]]);
	const delivery: WakeDelivery = {
		send: async (handle, message) => {
			sent.push([handle, message]);
		},
		status: handle => statuses.get(handle),
	};
	return {
		registry,
		delivery,
		sent,
		statuses,
		at: (ms: number) => {
			clock = ms;
		},
	};
}

const ENTRY = { handle: "agent-handle:1", agentId: "Worker", sessionId: "sess-1" };

describe("resident wake delivery", () => {
	test("delivers the scheduled prompt when the wake is due", async () => {
		const { registry, delivery, sent, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), prompt: "status?" },
		});

		at(T0 + 1_000);
		const outcomes = await runDueResidentWakes(registry, delivery);

		expect(sent).toEqual([["agent-handle:1", "status?"]]);
		expect(outcomes).toEqual([{ handle: "agent-handle:1", delivered: true }]);
	});

	test("delivers nothing before the wake is due", async () => {
		const { registry, delivery, sent } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 60_000).toISOString(), prompt: "status?" },
		});

		expect(await runDueResidentWakes(registry, delivery)).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("a schedule without a prompt is a marker, not a message", async () => {
		const { registry, delivery, sent, at } = await fixture();
		await registry.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 1_000).toISOString() } });

		at(T0 + 1_000);
		const outcomes = await runDueResidentWakes(registry, delivery);

		expect(sent).toEqual([]);
		expect(outcomes[0]).toMatchObject({ delivered: false, reason: "no-prompt" });
	});

	test("skips a handle the agent manager no longer knows", async () => {
		const { registry, delivery, sent, at } = await fixture();
		await registry.register({
			handle: "agent-handle:gone",
			agentId: "Worker",
			sessionId: "s",
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), prompt: "hi" },
		});

		at(T0 + 1_000);
		const outcomes = await runDueResidentWakes(registry, delivery);

		expect(sent).toEqual([]);
		expect(outcomes[0]).toMatchObject({ delivered: false, reason: "unknown-handle" });
	});

	test("skips an agent that has already finished", async () => {
		const { registry, delivery, sent, statuses, at } = await fixture();
		statuses.set("agent-handle:1", "released");
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), prompt: "hi" },
		});

		at(T0 + 1_000);
		const outcomes = await runDueResidentWakes(registry, delivery);

		expect(sent).toEqual([]);
		expect(outcomes[0]).toMatchObject({ delivered: false, reason: "terminal" });
	});

	test("reports a delivery failure without throwing", async () => {
		const { registry, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), prompt: "hi" },
		});
		const failing: WakeDelivery = {
			send: async () => {
				throw new Error("agent busy");
			},
			status: () => "running",
		};

		at(T0 + 1_000);
		const outcomes = await runDueResidentWakes(registry, failing);

		expect(outcomes[0]).toMatchObject({ delivered: false, reason: "delivery-failed", error: "agent busy" });
	});

	test("consumes a one-shot wake even when delivery is skipped", async () => {
		const { registry, delivery, at } = await fixture();
		await registry.register({ ...ENTRY, schedule: { wakeAt: new Date(T0 + 1_000).toISOString() } });

		at(T0 + 1_000);
		await runDueResidentWakes(registry, delivery);
		at(T0 + 120_000);

		// Re-firing a wake because nothing could receive it would spam a dead agent.
		expect(await runDueResidentWakes(registry, delivery)).toEqual([]);
	});

	test("keeps delivering a repeating wake", async () => {
		const { registry, delivery, sent, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), everyMs: 10_000, prompt: "beat" },
		});

		at(T0 + 1_000);
		await runDueResidentWakes(registry, delivery);
		at(T0 + 11_000);
		await runDueResidentWakes(registry, delivery);

		expect(sent).toHaveLength(2);
	});
});

describe("resident wake scheduler", () => {
	/** Manual timer so arming and re-arming are observable without real delays. */
	function manualTimer() {
		let pending: (() => void) | undefined;
		let nextId = 1;
		return {
			setTimer: (fn: () => void) => {
				pending = fn;
				return nextId++ as unknown as NodeJS.Timeout;
			},
			clearTimer: () => {
				pending = undefined;
			},
			fire: () => {
				const fn = pending;
				pending = undefined;
				fn?.();
			},
			get armed() {
				return pending !== undefined;
			},
		};
	}

	test("starts disarmed and arms on request", async () => {
		const { registry, delivery } = await fixture();
		const timer = manualTimer();
		const scheduler = new ResidentWakeScheduler(registry, delivery, timer);

		expect(scheduler.armed).toBe(false);
		scheduler.arm();
		expect(scheduler.armed).toBe(true);
	});

	test("re-arms while a repeating schedule remains", async () => {
		const { registry, delivery, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), everyMs: 10_000, prompt: "beat" },
		});
		const timer = manualTimer();
		const scheduler = new ResidentWakeScheduler(registry, delivery, timer);

		at(T0 + 1_000);
		await scheduler.tick();

		expect(scheduler.armed).toBe(true);
	});

	test("stops polling once the last one-shot wake has fired", async () => {
		const { registry, delivery, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), prompt: "once" },
		});
		const timer = manualTimer();
		const scheduler = new ResidentWakeScheduler(registry, delivery, timer);

		at(T0 + 1_000);
		await scheduler.tick();

		// The loop must not idle forever against an empty schedule set.
		expect(scheduler.armed).toBe(false);
	});

	test("disposal stops the loop and later ticks do nothing", async () => {
		const { registry, delivery, sent, at } = await fixture();
		await registry.register({
			...ENTRY,
			schedule: { wakeAt: new Date(T0 + 1_000).toISOString(), everyMs: 10_000, prompt: "beat" },
		});
		const timer = manualTimer();
		const scheduler = new ResidentWakeScheduler(registry, delivery, timer);
		scheduler.arm();

		scheduler.dispose();
		at(T0 + 1_000);

		expect(scheduler.armed).toBe(false);
		expect(await scheduler.tick()).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("arming after disposal is refused", async () => {
		const { registry, delivery } = await fixture();
		const timer = manualTimer();
		const scheduler = new ResidentWakeScheduler(registry, delivery, timer);

		scheduler.dispose();
		scheduler.arm();

		expect(scheduler.armed).toBe(false);
	});
});
