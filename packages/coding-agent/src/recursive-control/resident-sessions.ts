/**
 * Durable records for retained agents.
 *
 * `RetainedAgentHandleManager` keeps handles in memory, so every retained agent dies
 * with the process that spawned it and nothing else can find it. This registry
 * persists the identity, ownership lease, and wake schedule of a retained agent
 * alongside the rest of the recursive-control project state.
 *
 * It owns records and leases, not processes. Reviving an agent's execution remains
 * `AgentLifecycleManager`'s job; this module is what tells a later process that the
 * agent exists, whether anyone currently owns it, and when it should be woken.
 */

import * as path from "node:path";
import type { ToolSession } from "../tools";
import type { RetainedAgentHandle } from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";
import { readPrivateJson, recursiveControlProjectDir, withSerializedPath, writePrivateJson } from "./storage";

/**
 * `active` — an owner holds a lease and the agent is expected to be running.
 * `detached` — no owner; the record survives and may be attached.
 * `passivated` — deliberately unloaded to free resources; attachable.
 * `expired` — the owner's lease lapsed without renewal; attachable, and flagged so a
 *   recovering process knows the previous owner did not shut down cleanly.
 */
export type ResidentSessionState = "active" | "detached" | "passivated" | "expired";

export interface ResidentSessionSchedule {
	/** ISO timestamp of the next intended wake. */
	wakeAt: string;
	/** Optional repeat interval; a due record reschedules by this many ms. */
	everyMs?: number;
}

export interface ResidentSessionRecord {
	version: typeof RECURSIVE_CONTROL_VERSION;
	handle: string;
	agentId: string;
	/** OMP session id, so a later process can locate the transcript. */
	sessionId: string;
	label?: string;
	state: ResidentSessionState;
	/** Present only while a lease is held. */
	lease?: { owner: string; expiresAt: string };
	schedule?: ResidentSessionSchedule;
	lastStatus?: RetainedAgentHandle["status"];
	createdAt: string;
	updatedAt: string;
}

export interface ResidentSessionRegisterInput {
	handle: string;
	agentId: string;
	sessionId: string;
	label?: string;
	/** Lease duration for the registering owner. */
	leaseMs?: number;
	schedule?: ResidentSessionSchedule;
}

interface ResidentFile {
	version: typeof RECURSIVE_CONTROL_VERSION;
	sessions: Record<string, ResidentSessionRecord>;
}

const EMPTY_FILE: ResidentFile = { version: RECURSIVE_CONTROL_VERSION, sessions: {} };

export const DEFAULT_LEASE_MS = 300_000;
export const MIN_LEASE_MS = 1_000;

export interface ResidentSessionOptions {
	rootDir?: string;
	ownerId?: string;
	/** Injectable clock; tests and schedule checks need a deterministic now. */
	now?: () => number;
}

/** Durable registry of retained agents that outlive the process that spawned them. */
export class ResidentSessionRegistry {
	readonly #filePath: string;
	readonly #ownerId: string;
	readonly #now: () => number;

	constructor(session: ToolSession, options: ResidentSessionOptions = {}) {
		this.#filePath = path.join(recursiveControlProjectDir(session.cwd, options.rootDir), "resident-sessions.json");
		this.#ownerId = options.ownerId ?? session.getSessionId?.() ?? "Main";
		this.#now = options.now ?? Date.now;
	}

	get ownerId(): string {
		return this.#ownerId;
	}

	async #load(): Promise<ResidentFile> {
		const loaded = await readPrivateJson<ResidentFile>(this.#filePath, EMPTY_FILE);
		if (loaded.version !== RECURSIVE_CONTROL_VERSION || !loaded.sessions || typeof loaded.sessions !== "object") {
			throw new Error("Unsupported or corrupt resident session registry");
		}
		return { version: RECURSIVE_CONTROL_VERSION, sessions: { ...loaded.sessions } };
	}

	/**
	 * Reconcile a record against the clock before anyone reads it. A lease that
	 * lapsed leaves the record `expired` rather than silently `active`, so a
	 * recovering process can tell an unclean shutdown from a clean detach.
	 */
	#reconcile(record: ResidentSessionRecord, nowMs: number): ResidentSessionRecord {
		if (record.state !== "active" || !record.lease) return record;
		if (Date.parse(record.lease.expiresAt) > nowMs) return record;
		const { lease: _lapsed, ...rest } = record;
		return { ...rest, state: "expired", updatedAt: new Date(nowMs).toISOString() };
	}

	async list(): Promise<ResidentSessionRecord[]> {
		const nowMs = this.#now();
		return Object.values((await this.#load()).sessions)
			.map(record => this.#reconcile(record, nowMs))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async get(handle: string): Promise<ResidentSessionRecord | null> {
		const record = (await this.#load()).sessions[handle];
		return record ? this.#reconcile(record, this.#now()) : null;
	}

	async register(input: ResidentSessionRegisterInput): Promise<ResidentSessionRecord> {
		const handle = input.handle.trim();
		if (!handle) throw new Error("resident session handle must not be empty");
		const agentId = input.agentId.trim();
		if (!agentId) throw new Error("resident session agentId must not be empty");
		return await this.#mutate(file => {
			if (file.sessions[handle]) throw new Error(`resident session already registered: ${handle}`);
			const nowMs = this.#now();
			const iso = new Date(nowMs).toISOString();
			const label = input.label?.trim();
			const record: ResidentSessionRecord = {
				version: RECURSIVE_CONTROL_VERSION,
				handle,
				agentId,
				sessionId: input.sessionId.trim(),
				...(label ? { label } : {}),
				state: "active",
				lease: { owner: this.#ownerId, expiresAt: this.#expiry(nowMs, input.leaseMs) },
				...(input.schedule ? { schedule: input.schedule } : {}),
				createdAt: iso,
				updatedAt: iso,
			};
			file.sessions[handle] = record;
			return record;
		});
	}

	/**
	 * Take ownership of a record this process does not hold.
	 *
	 * Refused while another owner's lease is still live: two processes driving the
	 * same agent would interleave turns on one transcript.
	 */
	async attach(handle: string, leaseMs?: number): Promise<ResidentSessionRecord> {
		return await this.#mutate(file => {
			const nowMs = this.#now();
			const current = this.#reconcile(this.#require(file, handle), nowMs);
			if (current.lease && current.lease.owner !== this.#ownerId) {
				throw new Error(
					`resident session ${handle} is leased by ${current.lease.owner} until ${current.lease.expiresAt}`,
				);
			}
			const updated: ResidentSessionRecord = {
				...current,
				state: "active",
				lease: { owner: this.#ownerId, expiresAt: this.#expiry(nowMs, leaseMs) },
				updatedAt: new Date(nowMs).toISOString(),
			};
			file.sessions[handle] = updated;
			return updated;
		});
	}

	/** Extend this process's lease. Only the holder may renew. */
	async renew(handle: string, leaseMs?: number): Promise<ResidentSessionRecord> {
		return await this.#mutate(file => {
			const nowMs = this.#now();
			const current = this.#reconcile(this.#require(file, handle), nowMs);
			this.#requireOwnership(current, "renew");
			const updated: ResidentSessionRecord = {
				...current,
				state: "active",
				lease: { owner: this.#ownerId, expiresAt: this.#expiry(nowMs, leaseMs) },
				updatedAt: new Date(nowMs).toISOString(),
			};
			file.sessions[handle] = updated;
			return updated;
		});
	}

	/**
	 * Give up the lease without ending the agent. `passivate` records the same
	 * ownership change but marks the agent as deliberately unloaded.
	 */
	async detach(handle: string, options: { passivate?: boolean } = {}): Promise<ResidentSessionRecord> {
		return await this.#mutate(file => {
			const nowMs = this.#now();
			const current = this.#reconcile(this.#require(file, handle), nowMs);
			this.#requireOwnership(current, options.passivate ? "passivate" : "detach");
			const { lease: _released, ...rest } = current;
			const updated: ResidentSessionRecord = {
				...rest,
				state: options.passivate ? "passivated" : "detached",
				updatedAt: new Date(nowMs).toISOString(),
			};
			file.sessions[handle] = updated;
			return updated;
		});
	}

	/** Record the agent's last seen status so a detached record stays informative. */
	async noteStatus(handle: string, status: RetainedAgentHandle["status"]): Promise<ResidentSessionRecord> {
		return await this.#mutate(file => {
			const current = this.#reconcile(this.#require(file, handle), this.#now());
			const updated: ResidentSessionRecord = {
				...current,
				lastStatus: status,
				updatedAt: new Date(this.#now()).toISOString(),
			};
			file.sessions[handle] = updated;
			return updated;
		});
	}

	/** Set or clear the wake schedule. Only the lease holder may reschedule. */
	async schedule(handle: string, schedule: ResidentSessionSchedule | null): Promise<ResidentSessionRecord> {
		if (schedule && Number.isNaN(Date.parse(schedule.wakeAt))) {
			throw new Error(`invalid schedule.wakeAt: ${schedule.wakeAt}`);
		}
		if (schedule?.everyMs !== undefined && !(schedule.everyMs >= MIN_LEASE_MS)) {
			throw new Error(`schedule.everyMs must be at least ${MIN_LEASE_MS}ms`);
		}
		return await this.#mutate(file => {
			const current = this.#reconcile(this.#require(file, handle), this.#now());
			this.#requireOwnership(current, "schedule");
			const { schedule: _previous, ...rest } = current;
			const updated: ResidentSessionRecord = {
				...rest,
				...(schedule ? { schedule } : {}),
				updatedAt: new Date(this.#now()).toISOString(),
			};
			file.sessions[handle] = updated;
			return updated;
		});
	}

	/**
	 * Records whose wake time has arrived. Repeating schedules roll forward as they
	 * are reported so one due check cannot fire the same wake twice.
	 */
	async claimDue(): Promise<ResidentSessionRecord[]> {
		return await this.#mutate(file => {
			const nowMs = this.#now();
			const due: ResidentSessionRecord[] = [];
			for (const [handle, stored] of Object.entries(file.sessions)) {
				const record = this.#reconcile(stored, nowMs);
				if (!record.schedule || Date.parse(record.schedule.wakeAt) > nowMs) {
					file.sessions[handle] = record;
					continue;
				}
				const everyMs = record.schedule.everyMs;
				const { schedule: _fired, ...rest } = record;
				const updated: ResidentSessionRecord = {
					...rest,
					...(everyMs !== undefined
						? { schedule: { wakeAt: new Date(nowMs + everyMs).toISOString(), everyMs } }
						: {}),
					updatedAt: new Date(nowMs).toISOString(),
				};
				file.sessions[handle] = updated;
				due.push(record);
			}
			return due;
		});
	}

	/** Drop the record entirely. Used once an agent is genuinely gone. */
	async forget(handle: string): Promise<void> {
		await this.#mutate(file => {
			delete file.sessions[handle];
			return null;
		});
	}

	#expiry(nowMs: number, leaseMs: number | undefined): string {
		const span = Math.max(MIN_LEASE_MS, Math.trunc(leaseMs ?? DEFAULT_LEASE_MS));
		return new Date(nowMs + span).toISOString();
	}

	#require(file: ResidentFile, handle: string): ResidentSessionRecord {
		const record = file.sessions[handle];
		if (!record) throw new Error(`Unknown resident session: ${handle}`);
		return record;
	}

	#requireOwnership(record: ResidentSessionRecord, action: string): void {
		if (record.lease?.owner === this.#ownerId) return;
		const held = record.lease ? `held by ${record.lease.owner}` : "not leased";
		throw new Error(`cannot ${action} resident session ${record.handle}: lease is ${held}`);
	}

	async #mutate<T>(operation: (file: ResidentFile) => T): Promise<T> {
		return await withSerializedPath(this.#filePath, async () => {
			const file = await this.#load();
			const result = operation(file);
			await writePrivateJson(this.#filePath, file);
			return result;
		});
	}
}
