import * as fs from "node:fs";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { persistedVibeChildIds } from "../vibe/runtime";
import { type AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";

/**
 * Child ids owned by the Vibe roster persisted in this session file. Vibe
 * workers are revived through the Vibe registry's own journal, so the generic
 * persisted-subagent scan must not register them as plain `sub` refs.
 */
const VIBE_LIFECYCLE_MARKER = Buffer.from('"vibe-session-lifecycle"');
const MAX_METADATA_LINES = 64;

interface PersistedAgentMetadata {
	activity?: string;
	createdAt?: number;
	lastActivity?: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestampOf(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function summarizePersistedTask(task: string): string | undefined {
	const withoutPreamble = task.replace(/^Complete the assignment below,\s*thoroughly:\s*/i, "");
	const lines = withoutPreamble.split(/\r?\n/);
	const targetIndex = lines.findIndex(line => line.trim().toLowerCase() === "# target");
	const targetLines: string[] = [];
	if (targetIndex >= 0) {
		for (const line of lines.slice(targetIndex + 1)) {
			if (line.trimStart().startsWith("# ")) break;
			targetLines.push(line);
		}
	}
	const summary = (targetLines.length > 0 ? targetLines : lines).join(" ").replace(/\s+/g, " ").trim();
	return summary ? summary.slice(0, 1_000) : undefined;
}

/**
 * Read only the small session prefix needed by the Hub. A subagent's first
 * `session_init` is written before its conversation, so this never walks a
 * multi-megabyte historical transcript just to populate one roster row.
 */
async function readPersistedAgentMetadata(sessionFile: string): Promise<PersistedAgentMetadata> {
	const stat = fs.promises.stat(sessionFile).catch(() => undefined);
	let createdAt: number | undefined;
	let activity: string | undefined;
	try {
		let linesRead = 0;
		for await (const bytes of readLines(Bun.file(sessionFile).stream())) {
			if (linesRead++ >= MAX_METADATA_LINES) break;
			const line = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			let entry: Record<string, unknown> | undefined;
			try {
				entry = recordOf(JSON.parse(line.toString("utf8")));
			} catch {
				continue;
			}
			if (entry?.type === "session") {
				createdAt ??= timestampOf(entry.timestamp);
				continue;
			}
			if (entry?.type !== "session_init") continue;
			createdAt ??= timestampOf(entry.timestamp);
			if (typeof entry.task === "string") activity = summarizePersistedTask(entry.task);
			break;
		}
	} catch {
		// A readable transcript is still useful even when its optional metadata
		// prefix is malformed.
	}
	const file = await stat;
	return {
		activity,
		createdAt: createdAt ?? file?.birthtimeMs,
		lastActivity: file?.mtimeMs,
	};
}

async function readPersistedVibeChildIds(sessionFile: string): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		for await (const bytes of readLines(Bun.file(sessionFile).stream())) {
			const line = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (line.indexOf(VIBE_LIFECYCLE_MARKER) === -1) continue;
			try {
				const entry: unknown = JSON.parse(line.toString("utf8"));
				for (const id of persistedVibeChildIds([entry])) ids.add(id);
			} catch {
				// Match lenient session loading: one malformed line must not hide
				// valid lifecycle entries later in the transcript.
			}
		}
		return ids;
	} catch {
		return new Set();
	}
}

/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const vibeOwnedIds = await readPersistedVibeChildIds(sessionFile);
	const root = sessionFile.slice(0, -6);
	await registerPersistedSubagentsFromDir(registry, root, undefined, vibeOwnedIds);
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string | undefined,
	vibeOwnedIds: ReadonlySet<string>,
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId ?? MAIN_AGENT_ID;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME ? "" : entry.name.slice("__advisor.".length, -".jsonl".length);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				const metadata = await readPersistedAgentMetadata(sessionFile);
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					activity: metadata.activity,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
					status: "parked",
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (vibeOwnedIds.has(id) && registry.get(id)?.sessionFile !== sessionFile) continue;
		if (!registry.get(id)) {
			const metadata = await readPersistedAgentMetadata(sessionFile);
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				activity: metadata.activity,
				createdAt: metadata.createdAt,
				lastActivity: metadata.lastActivity,
				status: "parked",
			});
		}
		await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, vibeOwnedIds);
	}
}
