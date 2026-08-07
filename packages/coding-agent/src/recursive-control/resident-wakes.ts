/**
 * Driver for scheduled resident wakes.
 *
 * `ResidentSessionRegistry.claimDue` reports which records are due, but reporting is
 * not waking: without a caller a schedule is only a stored timestamp. This turns a
 * claimed wake into a delivered message on the retained agent.
 *
 * The scheduler is lazily armed — it costs nothing until a schedule exists — and is
 * owned by the recursive-control runtime, so it dies with the feature.
 */

import type { ResidentSessionRecord, ResidentSessionRegistry } from "./resident-sessions";

export const DEFAULT_WAKE_INTERVAL_MS = 30_000;
export const MIN_WAKE_INTERVAL_MS = 1_000;

/** Why a claimed wake did not deliver. Kept per record so a tick is auditable. */
export type WakeSkipReason = "no-prompt" | "unknown-handle" | "terminal" | "delivery-failed";

export interface WakeOutcome {
	handle: string;
	delivered: boolean;
	reason?: WakeSkipReason;
	error?: string;
}

export interface WakeDelivery {
	/** Send the scheduled prompt to the retained agent. */
	send(handle: string, message: string): Promise<void>;
	/** Current status, or `undefined` when the handle is no longer known. */
	status(handle: string): string | undefined;
}

const TERMINAL: Readonly<Record<string, true>> = { failed: true, released: true, cancelled: true, complete: true };

/**
 * Claim every due record and deliver its prompt.
 *
 * A claimed wake is consumed whether or not it delivers: `claimDue` has already
 * rolled the schedule forward, and re-firing a wake because delivery failed would
 * spam an agent that is simply gone.
 */
export async function runDueResidentWakes(
	registry: ResidentSessionRegistry,
	delivery: WakeDelivery,
): Promise<WakeOutcome[]> {
	const due = await registry.claimDue();
	const outcomes: WakeOutcome[] = [];
	for (const record of due) {
		outcomes.push(await deliverWake(record, delivery));
	}
	return outcomes;
}

async function deliverWake(record: ResidentSessionRecord, delivery: WakeDelivery): Promise<WakeOutcome> {
	const prompt = record.schedule?.prompt?.trim();
	if (!prompt) return { handle: record.handle, delivered: false, reason: "no-prompt" };
	const status = delivery.status(record.handle);
	if (status === undefined) return { handle: record.handle, delivered: false, reason: "unknown-handle" };
	if (TERMINAL[status]) return { handle: record.handle, delivered: false, reason: "terminal" };
	try {
		await delivery.send(record.handle, prompt);
		return { handle: record.handle, delivered: true };
	} catch (error) {
		return {
			handle: record.handle,
			delivered: false,
			reason: "delivery-failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface ResidentWakeSchedulerOptions {
	intervalMs?: number;
	/** Injectable for tests; defaults to the global timer. */
	setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (handle: NodeJS.Timeout) => void;
	/** Surfaced so a host can log or display what a tick did. */
	onTick?: (outcomes: WakeOutcome[]) => void;
}

/**
 * Polls for due wakes only while at least one schedule exists.
 *
 * Arming is explicit rather than automatic: a session with the feature enabled but no
 * schedules should not pay for a periodic disk read.
 */
export class ResidentWakeScheduler {
	readonly #registry: ResidentSessionRegistry;
	readonly #delivery: WakeDelivery;
	readonly #intervalMs: number;
	readonly #setTimer: NonNullable<ResidentWakeSchedulerOptions["setTimer"]>;
	readonly #clearTimer: NonNullable<ResidentWakeSchedulerOptions["clearTimer"]>;
	readonly #onTick: ResidentWakeSchedulerOptions["onTick"];
	#timer: NodeJS.Timeout | undefined;
	#ticking = false;
	#disposed = false;

	constructor(registry: ResidentSessionRegistry, delivery: WakeDelivery, options: ResidentWakeSchedulerOptions = {}) {
		this.#registry = registry;
		this.#delivery = delivery;
		this.#intervalMs = Math.max(MIN_WAKE_INTERVAL_MS, Math.trunc(options.intervalMs ?? DEFAULT_WAKE_INTERVAL_MS));
		this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
		this.#onTick = options.onTick;
	}

	get armed(): boolean {
		return this.#timer !== undefined;
	}

	/** Arm the poll loop. Idempotent, and a no-op once disposed. */
	arm(): void {
		if (this.#disposed || this.#timer !== undefined) return;
		this.#timer = this.#setTimer(() => {
			void this.tick();
		}, this.#intervalMs);
	}

	/**
	 * Run one poll. Re-arms only while schedules remain, so the loop stops on its own
	 * once the last one-shot wake has fired.
	 */
	async tick(): Promise<WakeOutcome[]> {
		if (this.#disposed || this.#ticking) return [];
		this.#ticking = true;
		this.#timer = undefined;
		try {
			const outcomes = await runDueResidentWakes(this.#registry, this.#delivery);
			this.#onTick?.(outcomes);
			return outcomes;
		} finally {
			this.#ticking = false;
			// Disposal can land mid-tick; do not resurrect the loop behind it.
			if (!this.#disposed && (await this.#hasSchedules())) this.arm();
		}
	}

	async #hasSchedules(): Promise<boolean> {
		try {
			return (await this.#registry.list()).some(record => record.schedule !== undefined);
		} catch {
			// A registry read failure must not wedge the loop armed forever.
			return false;
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
	}
}
