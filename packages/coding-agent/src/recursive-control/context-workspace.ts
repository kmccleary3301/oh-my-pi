import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { InternalResource, ResolveContext } from "../internal-urls";
import { InternalUrlRouter } from "../internal-urls";
import type { AgentRef } from "../registry/agent-registry";
import type { SessionEntry } from "../session/session-entries";
import type { ToolSession } from "../tools";
import { boundedRecursiveText, canonicalRecursiveJson, recursiveFingerprint, sanitizeRecursiveText } from "./canonical";
import type {
	RecursiveContextArtifact,
	RecursiveContextListRequest,
	RecursiveContextMaterializeRequest,
	RecursiveContextPage,
	RecursiveContextReadRequest,
	RecursiveContextReference,
	RecursiveContextScope,
	RecursiveContextSearchRequest,
	RecursiveContextSlice,
	RecursiveJsonValue,
} from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";

const DEFAULT_SCOPES: readonly RecursiveContextScope[] = ["conversation", "agents", "resources"];
const CONVERSATION_REF_PREFIX = "conversation:";

function boundedLabel(value: string, maxChars = 320): string {
	return boundedRecursiveText(value, maxChars).text.replaceAll("\n", " ");
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function selectedScopes(value: RecursiveContextListRequest["scope"]): RecursiveContextScope[] {
	const values = value === undefined ? DEFAULT_SCOPES : Array.isArray(value) ? value : [value];
	return [...new Set(values.filter(scope => DEFAULT_SCOPES.includes(scope)))];
}

function extractText(value: unknown, depth = 0): string[] {
	if (depth > 8 || value === null || value === undefined) return [];
	if (typeof value === "string") return [value];
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(item => extractText(item, depth + 1));
	if (typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const direct = typeof record.text === "string" ? [record.text] : [];
	return [...direct, ...extractText(record.content, depth + 1)];
}

function messageLabel(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	const role = typeof record.role === "string" ? record.role : "message";
	const toolName = typeof record.toolName === "string" ? ` · ${record.toolName}` : "";
	return `${role}${toolName}`;
}

function renderMessage(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	const text = extractText(record.content).join("\n").trim();
	return `## ${messageLabel(message)}\n\n${text || "(no text content)"}`;
}

function renderEntry(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return renderMessage(entry.message);
		case "compaction":
			return `## Compaction\n\n${entry.summary}`;
		case "branch_summary":
			return `## Branch summary\n\n${entry.summary}`;
		case "custom_message":
			return `## ${entry.customType}\n\n${extractText(entry.content).join("\n") || "(no text content)"}`;
		case "session_init":
			return [
				"## Session initialization",
				"",
				`Agent: ${entry.agent ?? "unknown"}`,
				`Model role: ${entry.modelRole ?? "unknown"}`,
				`Resolved model: ${entry.resolvedModel ?? "unknown"}`,
				`Tools: ${entry.tools.join(", ")}`,
			].join("\n");
		case "custom":
			return `## Custom state\n\nType: ${entry.customType}`;
		case "credential_pin":
			return `## Credential pin\n\nProvider: ${entry.provider}`;
		default:
			return `## ${entry.type}\n\n\`\`\`json\n${canonicalRecursiveJson(entry)}\n\`\`\``;
	}
}

function entryLabel(entry: SessionEntry): string {
	if (entry.type === "message") return messageLabel(entry.message);
	if (entry.type === "custom_message") return entry.customType;
	return entry.type.replaceAll("_", " ");
}

function entryReference(entry: SessionEntry, maxPreviewChars: number): RecursiveContextReference {
	const content = sanitizeRecursiveText(renderEntry(entry));
	const preview = boundedRecursiveText(content.replaceAll("\n", " "), maxPreviewChars).text;
	return {
		version: RECURSIVE_CONTROL_VERSION,
		ref: `${CONVERSATION_REF_PREFIX}${entry.id}`,
		scope: "conversation",
		fingerprint: recursiveFingerprint("context-entry", {
			id: entry.id,
			type: entry.type,
			timestamp: entry.timestamp,
			content,
		}),
		immutable: true,
		label: boundedLabel(entryLabel(entry), 160),
		preview,
		metadata: {
			id: entry.id,
			type: entry.type,
			timestamp: entry.timestamp,
		},
	};
}

function numberValue(value: number | undefined): RecursiveJsonValue | undefined {
	return value === undefined || !Number.isFinite(value) ? undefined : value;
}

function agentReference(ref: AgentRef): RecursiveContextReference {
	const metrics = ref.history?.metrics;
	const metadata: Record<string, RecursiveJsonValue> = {
		status: ref.status,
		kind: ref.kind,
		lastActivity: ref.lastActivity,
	};
	if (ref.parentId) metadata.parentId = ref.parentId;
	if (ref.activity) metadata.activity = ref.activity;
	if (ref.history?.agent) metadata.agent = ref.history.agent;
	if (ref.history?.resolvedModel) metadata.resolvedModel = ref.history.resolvedModel;
	const tokens = numberValue(metrics?.tokens);
	const cost = numberValue(metrics?.cost);
	if (tokens !== undefined) metadata.tokens = tokens;
	if (cost !== undefined) metadata.cost = cost;
	return {
		version: RECURSIVE_CONTROL_VERSION,
		ref: `history://${ref.id}`,
		scope: "agents",
		fingerprint: recursiveFingerprint("context-agent", {
			id: ref.id,
			status: ref.status,
			lastActivity: ref.lastActivity,
			history: ref.history,
		}),
		immutable: true,
		label: boundedLabel(`${ref.id} · ${ref.displayName}`, 160),
		preview: boundedLabel([ref.status, ref.kind, ref.activity].filter(Boolean).join(" · ")),
		metadata,
	};
}

function resourceReference(
	scheme: string,
	value: string,
	label?: string,
	description?: string,
): RecursiveContextReference {
	const sanitizedValue = sanitizeRecursiveText(value);
	if (sanitizedValue !== value) throw new Error(`Invalid control characters in ${scheme}:// completion`);
	const uri = `${scheme}://${sanitizedValue}`;
	return {
		version: RECURSIVE_CONTROL_VERSION,
		ref: uri,
		scope: "resources",
		fingerprint: recursiveFingerprint("context-resource-candidate", { uri, label, description }),
		immutable: scheme !== "local",
		label: boundedLabel(label ?? uri, 160),
		...(description ? { preview: boundedLabel(description) } : {}),
		metadata: { scheme },
	};
}

function page(items: RecursiveContextReference[], cursor: number, limit: number): RecursiveContextPage {
	const slice = items.slice(cursor, cursor + limit);
	const nextCursor = cursor + slice.length < items.length ? cursor + slice.length : undefined;
	return {
		version: RECURSIVE_CONTROL_VERSION,
		items: slice,
		...(nextCursor !== undefined ? { nextCursor } : {}),
		truncated: nextCursor !== undefined,
	};
}

export interface ContextWorkspaceOptions {
	maxItems: number;
	maxChars: number;
	maxMaterializeChars: number;
	router?: InternalUrlRouter;
}

/**
 * Read-only query projection over OMP's canonical session and resource state.
 * The workspace never owns a second transcript or copies resources until the
 * caller explicitly materializes a bounded artifact.
 */
export class ContextWorkspace {
	readonly #session: ToolSession;
	readonly #maxItems: number;
	readonly #maxChars: number;
	readonly #maxMaterializeChars: number;
	readonly #router: InternalUrlRouter;

	constructor(session: ToolSession, options: ContextWorkspaceOptions) {
		this.#session = session;
		this.#maxItems = Math.max(1, Math.trunc(options.maxItems));
		this.#maxChars = Math.max(256, Math.trunc(options.maxChars));
		this.#maxMaterializeChars = Math.max(this.#maxChars, Math.trunc(options.maxMaterializeChars));
		this.#router = options.router ?? InternalUrlRouter.instance();
	}

	#resolveContext(signal?: AbortSignal): ResolveContext {
		return {
			cwd: this.#session.cwd,
			settings: this.#session.settings,
			...(signal ? { signal } : {}),
			...(this.#session.localProtocolOptions ? { localProtocolOptions: this.#session.localProtocolOptions } : {}),
			...(this.#session.skills ? { skills: this.#session.skills } : {}),
		};
	}

	#conversationEntries(): SessionEntry[] {
		return this.#session.sessionManager?.getBranch() ?? this.#session.sessionManager?.getEntries() ?? [];
	}

	async #allReferences(scopes: RecursiveContextScope[], signal?: AbortSignal): Promise<RecursiveContextReference[]> {
		const references: RecursiveContextReference[] = [];
		if (scopes.includes("conversation")) {
			const entries = this.#conversationEntries();
			for (let index = entries.length - 1; index >= 0; index--) {
				references.push(entryReference(entries[index]!, Math.min(320, this.#maxChars)));
			}
		}
		if (scopes.includes("agents")) {
			const registry = this.#session.agentRegistry;
			if (registry) {
				for (const ref of registry.list().sort((left, right) => right.lastActivity - left.lastActivity)) {
					if (ref.kind !== "advisor") references.push(agentReference(ref));
				}
			}
		}
		if (scopes.includes("resources")) {
			const context = this.#resolveContext(signal);
			const schemes = this.#router.completionSchemes().sort();
			for (const scheme of schemes) {
				if (signal?.aborted) throw signal.reason;
				try {
					const completions = await this.#router.complete(scheme, "", context);
					for (const completion of (completions ?? []).slice(0, this.#maxItems)) {
						references.push(
							resourceReference(scheme, completion.value, completion.label, completion.description),
						);
					}
				} catch {
					// A single optional completion provider must not make the entire
					// workspace unavailable. Direct reads still surface its real error.
				}
			}
		}
		return references;
	}

	async list(request: RecursiveContextListRequest = {}, signal?: AbortSignal): Promise<RecursiveContextPage> {
		const cursor = clampInteger(request.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = clampInteger(request.limit, this.#maxItems, 1, this.#maxItems);
		return page(await this.#allReferences(selectedScopes(request.scope), signal), cursor, limit);
	}

	async search(request: RecursiveContextSearchRequest, signal?: AbortSignal): Promise<RecursiveContextPage> {
		const query = request.query.trim().toLocaleLowerCase();
		if (!query) throw new Error("context.search requires a non-empty query");
		if (query.length > 4096) throw new Error("context.search query exceeds 4096 characters");
		const cursor = clampInteger(request.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = clampInteger(request.limit, this.#maxItems, 1, this.#maxItems);
		const all = await this.#allReferences(selectedScopes(request.scope), signal);
		const entriesById = new Map(this.#conversationEntries().map(entry => [entry.id, entry]));
		const matches = all.filter(item => {
			const conversationEntry = item.ref.startsWith(CONVERSATION_REF_PREFIX)
				? entriesById.get(item.ref.slice(CONVERSATION_REF_PREFIX.length))
				: undefined;
			const conversationContent = conversationEntry ? renderEntry(conversationEntry) : "";
			const haystack = `${item.ref}\n${item.label}\n${item.preview ?? ""}\n${conversationContent}\n${canonicalRecursiveJson(item.metadata ?? {})}`;
			return haystack.toLocaleLowerCase().includes(query);
		});
		return page(matches, cursor, limit);
	}

	async #resolve(
		ref: string,
		signal?: AbortSignal,
	): Promise<
		InternalResource | { content: string; contentType: RecursiveContextSlice["contentType"]; notes?: string[] }
	> {
		if (ref.startsWith(CONVERSATION_REF_PREFIX)) {
			const id = ref.slice(CONVERSATION_REF_PREFIX.length);
			const entry = this.#conversationEntries().find(candidate => candidate.id === id);
			if (!entry) throw new Error(`Unknown or stale conversation entry: ${id}`);
			return { content: renderEntry(entry), contentType: "text/markdown" };
		}
		if (!this.#router.canResolve(ref)) {
			throw new Error(`Unsupported recursive context reference: ${ref}`);
		}
		return await this.#router.resolve(ref, this.#resolveContext(signal));
	}

	async read(request: RecursiveContextReadRequest, signal?: AbortSignal): Promise<RecursiveContextSlice> {
		const ref = request.ref.trim();
		if (!ref) throw new Error("context.read requires a reference");
		const resolved = await this.#resolve(ref, signal);
		const content = sanitizeRecursiveText(resolved.content);
		const fingerprint = recursiveFingerprint("context-slice", { ref, content, contentType: resolved.contentType });
		if (request.expectedFingerprint && request.expectedFingerprint !== fingerprint) {
			throw new Error(
				`Stale recursive context reference ${ref}: expected ${request.expectedFingerprint}, current ${fingerprint}`,
			);
		}
		const offset = clampInteger(request.offset, 0, 0, content.length);
		const limit = clampInteger(request.limit, this.#maxChars, 1, this.#maxChars);
		const selected = content.slice(offset, offset + limit);
		const nextOffset = offset + selected.length < content.length ? offset + selected.length : undefined;
		return {
			version: RECURSIVE_CONTROL_VERSION,
			ref,
			fingerprint,
			content: selected,
			contentType: resolved.contentType,
			offset,
			returnedChars: selected.length,
			totalChars: content.length,
			truncated: nextOffset !== undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			...(resolved.notes?.length ? { notes: resolved.notes.map(note => boundedLabel(note, 512)) } : {}),
		};
	}

	async materialize(
		request: RecursiveContextMaterializeRequest,
		signal?: AbortSignal,
	): Promise<RecursiveContextArtifact> {
		if (request.refs.length === 0) throw new Error("context.materialize requires at least one reference");
		if (request.refs.length > this.#maxItems) {
			throw new Error(`context.materialize accepts at most ${this.#maxItems} references`);
		}
		const refs = [...new Set(request.refs)];
		const maxChars = clampInteger(request.maxChars, this.#maxMaterializeChars, 1, this.#maxMaterializeChars);
		const chunks: string[] = [];
		for (const ref of refs) {
			if (signal?.aborted) throw signal.reason;
			const resolved = await this.#resolve(ref, signal);
			chunks.push(`# ${ref}\n\n${sanitizeRecursiveText(resolved.content)}`);
		}
		const label = request.label?.trim();
		const body = chunks.join("\n\n---\n\n");
		const combined = boundedRecursiveText(
			label ? `# ${sanitizeRecursiveText(label)}\n\n${body}` : body,
			maxChars,
		).text;
		const allocation = await this.#session.allocateOutputArtifact?.("recursive-context");
		if (!allocation?.id || !allocation.path) {
			throw new Error("This session cannot allocate a recursive context artifact");
		}
		await Bun.write(allocation.path, combined);
		return {
			version: RECURSIVE_CONTROL_VERSION,
			uri: `artifact://${allocation.id}`,
			fingerprint: recursiveFingerprint("context-artifact", { refs, content: combined }),
			chars: combined.length,
			refs,
		};
	}
}
