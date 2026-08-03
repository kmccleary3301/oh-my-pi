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
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (vibeOwnedIds.has(id) && registry.get(id)?.sessionFile !== sessionFile) continue;
		if (!registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, vibeOwnedIds);
	}
}
