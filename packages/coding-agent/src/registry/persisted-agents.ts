import * as fs from "node:fs";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { resolveExplicitModelRole } from "../config/model-resolver";
import { loadBundledAgents } from "../task/agents";
import { persistedVibeChildIds } from "../vibe/runtime";
import {
	type AgentHistorySummary,
	type AgentMetricsSummary,
	type AgentRegistry,
	MAIN_AGENT_ID,
} from "./agent-registry";

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
	history?: AgentHistorySummary;
}

interface PersistedTranscript {
	id: string;
	sessionFile: string;
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

const READ_ONLY_AGENT_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	web_search: true,
	ast_grep: true,
	yield: true,
};

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inferBundledAgent(systemPrompt: string): { agent?: string; modelRole?: string; readOnly?: boolean } {
	const matches = loadBundledAgents().filter(agent => {
		const rolePrompt = agent.systemPrompt.trim();
		return rolePrompt.length > 0 && systemPrompt.includes(rolePrompt);
	});
	// `task` and `sonic` intentionally share a prompt body. Ambiguous historical
	// prompts stay unlabelled rather than inventing provenance.
	if (matches.length !== 1) return {};
	const [agent] = matches;
	return {
		agent: agent.name,
		modelRole: resolveExplicitModelRole(agent.model),
		readOnly: !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_AGENT_TOOLS[tool] === true),
	};
}

function usageTokens(usage: Record<string, unknown>): number {
	const computed = finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheWrite);
	return computed > 0 ? computed : finiteNumber(usage.totalTokens);
}

interface AssistantMetrics {
	tokens: number;
	tools: number;
	cost: number;
	contextTokens?: number;
	resolvedModel?: string;
}

function assistantMetrics(message: Record<string, unknown>): AssistantMetrics {
	const usage = recordOf(message.usage) ?? {};
	const cost = recordOf(usage.cost);
	const content = Array.isArray(message.content) ? message.content : [];
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	return {
		tokens: usageTokens(usage),
		tools: content.filter(part => recordOf(part)?.type === "toolCall").length,
		cost: finiteNumber(cost?.total),
		contextTokens: finiteNumber(usage.totalTokens) || undefined,
		resolvedModel: provider && model ? `${provider}/${model}` : undefined,
	};
}

async function readPersistedAgentHistory(transcript: PersistedTranscript): Promise<AgentHistorySummary> {
	const parents = new Map<string, string | undefined>();
	const assistantById = new Map<string, AssistantMetrics>();
	let leafId: string | undefined;
	let leafTimestamp: number | undefined;
	try {
		for await (const bytes of readLines(Bun.file(transcript.sessionFile).stream())) {
			const line = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const prefix = line.subarray(0, Math.min(line.byteLength, 512)).toString("utf8");
			const id = /"id":"([^"]+)"/.exec(prefix)?.[1];
			if (!id) continue;
			const parentMatch = /"parentId":(?:"([^"]+)"|null)/.exec(prefix);
			parents.set(id, parentMatch?.[1]);
			leafId = id;
			const entryTimestamp = /"timestamp":"([^"]+)"/.exec(prefix)?.[1];
			const parsedTimestamp = timestampOf(entryTimestamp);
			if (parsedTimestamp !== undefined) leafTimestamp = parsedTimestamp;
			if (!prefix.includes('"type":"message"') || !line.includes(Buffer.from('"role":"assistant"'))) continue;
			try {
				const entry = recordOf(JSON.parse(line.toString("utf8")));
				const message = recordOf(entry?.message);
				if (message?.role === "assistant") assistantById.set(id, assistantMetrics(message));
			} catch {
				// One malformed historical entry must not erase valid totals.
			}
		}
	} catch {
		return {};
	}

	const metrics: AgentMetricsSummary = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: Math.max(
			0,
			(leafTimestamp ?? transcript.lastActivity ?? transcript.createdAt ?? 0) -
				(transcript.createdAt ?? leafTimestamp ?? 0),
		),
	};
	let resolvedModel: string | undefined;
	let contextTokens: number | undefined;
	const visited = new Set<string>();
	for (let id = leafId; id && !visited.has(id); id = parents.get(id)) {
		visited.add(id);
		const assistant = assistantById.get(id);
		if (!assistant) continue;
		metrics.requests++;
		metrics.tokens += assistant.tokens;
		metrics.tools += assistant.tools;
		metrics.cost += assistant.cost;
		contextTokens ??= assistant.contextTokens;
		resolvedModel ??= assistant.resolvedModel;
	}
	metrics.contextTokens = contextTokens;
	return { metrics: metrics.requests > 0 ? metrics : undefined, resolvedModel };
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
	let history: AgentHistorySummary = {};
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
			if (entry?.type === "model_change") {
				if (typeof entry.model === "string") history.resolvedModel = entry.model;
				if (typeof entry.role === "string") history.modelRole = entry.role;
				continue;
			}
			if (entry?.type !== "session_init") continue;
			createdAt ??= timestampOf(entry.timestamp);
			if (typeof entry.task === "string") activity = summarizePersistedTask(entry.task);
			const inferred =
				typeof entry.systemPrompt === "string"
					? inferBundledAgent(entry.systemPrompt)
					: ({} satisfies AgentHistorySummary);
			history = {
				...history,
				...inferred,
				agent: typeof entry.agent === "string" ? entry.agent : inferred.agent,
				modelRole:
					typeof entry.modelRole === "string" ? entry.modelRole : (history.modelRole ?? inferred.modelRole),
				resolvedModel: typeof entry.resolvedModel === "string" ? entry.resolvedModel : history.resolvedModel,
				readOnly: typeof entry.readOnly === "boolean" ? entry.readOnly : inferred.readOnly,
			};
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
		history,
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
	const transcripts: PersistedTranscript[] = [];
	await registerPersistedSubagentsFromDir(registry, root, undefined, vibeOwnedIds, transcripts);
	let nextTranscript = 0;
	const workers = Array.from({ length: Math.min(4, transcripts.length) }, async () => {
		for (;;) {
			const index = nextTranscript++;
			const transcript = transcripts[index];
			if (!transcript) return;
			const history = await readPersistedAgentHistory(transcript);
			registry.setHistory(transcript.id, history, transcript.sessionFile);
		}
	});
	await Promise.all(workers);
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string | undefined,
	vibeOwnedIds: ReadonlySet<string>,
	transcripts: PersistedTranscript[],
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
					history: { ...metadata.history, readOnly: true },
					status: "parked",
				});
				transcripts.push({
					id: advisorId,
					sessionFile,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
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
				history: metadata.history,
				status: "parked",
			});
			const ref = registry.get(id);
			transcripts.push({
				id,
				sessionFile,
				createdAt: ref?.createdAt,
				lastActivity: ref?.lastActivity,
			});
		}
		await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, vibeOwnedIds, transcripts);
	}
}
