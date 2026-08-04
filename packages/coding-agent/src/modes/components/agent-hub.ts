/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentRegistry — status, unread irc count,
 *   current/last task, last activity. Navigate with keys, wheel, hover, and
 *   click; `r` revives a parked agent, `x` aborts + releases one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	Ellipsis,
	matchesKey,
	type OverlayHandle,
	padding,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, formatNumber, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import {
	AgentActivityIndex,
	type AgentActivityKind,
	type AgentActivityRow,
	activityRowsFromProgress,
} from "../../activity";
import type { KeyId } from "../../config/keybindings";
import { getRoleInfo } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	type AgentMetricsSummary,
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";

/** Two-pane mode needs a useful roster and a readable inspector. */
const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_MIN_WIDTH = 48;

export type AgentHubSection = "agents" | "activity";

type HubViewMode = "roster" | "tree";
type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";

type AgentMetrics = AgentMetricsSummary;

interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
}

interface RosterRender {
	lines: string[];
	hitRows: Array<number | undefined>;
}

/** Legacy progress snapshots may omit counters; snapshot absence remains distinct. */
function metricNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(text).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width), Ellipsis.Omit);
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/** Status glyph, colored per theme status conventions. The title-line counts spell out the words. */
function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.status.running);
		case "idle":
			return theme.fg("success", theme.status.enabled);
		case "parked":
			return theme.fg("muted", theme.status.shadowed);
		case "aborted":
			return theme.fg("error", theme.status.aborted);
	}
}

function statusText(status: AgentStatus, text: string): string {
	switch (status) {
		case "running":
			return theme.fg("accent", text);
		case "idle":
			return theme.fg("success", text);
		case "parked":
			return theme.fg("muted", text);
		case "aborted":
			return theme.fg("error", text);
	}
}

function activityGlyph(row: AgentActivityRow): string {
	if (row.status === "error") return theme.fg("error", theme.status.error);
	if (row.status === "aborted") return theme.fg("warning", theme.status.aborted);
	if (row.status === "pending") return theme.fg("accent", theme.status.running);
	switch (row.kind) {
		case "response":
			return theme.fg("success", "◆");
		case "tool":
			return theme.fg("success", theme.status.success);
		case "irc":
			return theme.fg("accent", "→");
		case "lifecycle":
			return theme.fg("muted", "○");
	}
}

function activityClock(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(11, 19);
}

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}
/** Textual model-role tag; color reinforces (but never replaces) the label. */
function formatRoleBadge(role: string, settings: Settings): string {
	const info = getRoleInfo(role, settings);
	return theme.fg(info.color ?? "muted", replaceTabs(info.tag ?? info.name ?? role));
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false, fallbackLevel?: ThinkingLevel): string {
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = resolved.lastIndexOf(":");
	const explicitLevel = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = explicitLevel !== undefined ? resolved.slice(0, colon) : resolved;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return formatModelBadge(label, explicitLevel ?? fallbackLevel);
}

/**
 * Resolved model + reasoning level for a hub row. Exact executor progress is
 * authoritative (and survives completion); direct live sessions are the
 * fallback for agents without an observer snapshot. Active retry fallbacks
 * retain provider identity and carry an explicit marker.
 */
function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const progress = observed?.progress;
	const liveThinkingLevel = ref.session?.thinkingLevel;
	// The executor fallback flag also covers retries that do not populate the
	// live session's retryFallbackModel (for example Fireworks Fast → base).
	const fallbackSelector =
		ref.session?.retryFallbackModel ?? (progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", "fallback →")} ${formatResolvedModelBadge(fallbackSelector, true, liveThinkingLevel)}`;
	}
	const resolvedModel = progress?.resolvedModel ?? ref.history?.resolvedModel;
	if (resolvedModel) {
		return formatResolvedModelBadge(resolvedModel, false, liveThinkingLevel);
	}
	const model = ref.session?.model;
	if (!model) return undefined;
	const level = model.thinking ? liveThinkingLevel : undefined;
	return formatModelBadge(model.id, level);
}

/** Exact observer usage for one roster entry. */
function progressMetrics(observed: ObservableSession | undefined): AgentMetrics | undefined {
	const progress = observed?.progress;
	if (!progress) return undefined;
	const { tokens, requests, toolCount: tools, cost, durationMs } = progress;
	if (
		typeof tokens !== "number" ||
		!Number.isFinite(tokens) ||
		typeof requests !== "number" ||
		!Number.isFinite(requests) ||
		typeof tools !== "number" ||
		!Number.isFinite(tools) ||
		typeof cost !== "number" ||
		!Number.isFinite(cost) ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs)
	) {
		return undefined;
	}
	return {
		tokens,
		requests,
		tools,
		cost,
		durationMs,
		contextTokens:
			typeof progress.contextTokens === "number" && Number.isFinite(progress.contextTokens)
				? progress.contextTokens
				: undefined,
		contextWindow:
			typeof progress.contextWindow === "number" && Number.isFinite(progress.contextWindow)
				? progress.contextWindow
				: undefined,
	};
}

function formatCost(cost: number): string {
	const amount = metricNumber(cost);
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}
function formatMetrics(metrics: AgentMetrics): string {
	return [
		formatCost(metrics.cost),
		formatDuration(metrics.durationMs),
		`${formatNumber(metrics.requests)} req`,
		`${formatNumber(metrics.tools)} tools`,
		`${formatNumber(metrics.tokens)} tok`,
	].join(theme.sep.dot);
}

function contextGauge(tokens: number, window: number): string {
	const ratio = Math.max(0, Math.min(1, tokens / window));
	const filled = Math.round(ratio * 10);
	return `${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(10 - filled))} ${formatNumber(tokens)}/${formatNumber(window)} ${Math.round(ratio * 100)}%`;
}
/** Fit a child-id preview without joining an arbitrarily large child set. */
function formatChildIds(children: readonly AgentRef[], width: number): string {
	const max = Math.max(1, width);
	let shown = 0;
	let text = "";
	while (shown < children.length) {
		const id = sanitizeLine(children[shown].id, max);
		const candidate = text ? `${text}, ${id}` : id;
		const remaining = children.length - shown - 1;
		const suffix = remaining > 0 ? `, … +${remaining}` : "";
		if (visibleWidth(candidate + suffix) > max) {
			const includesCurrent = text.length === 0;
			const omitted = children.length - shown - Number(includesCurrent);
			return truncateToWidth(`${includesCurrent ? id : text}${omitted > 0 ? `, … +${omitted}` : ""}`, max);
		}
		text = candidate;
		shown++;
	}
	return text;
}

/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Production settings used to resolve textual model-role tags. */
	settings?: Settings;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Initial top-level projection; slash commands deep-link into this surface. */
	initialSection?: AgentHubSection;
	/** Injectable unified activity source; production creates one from local or remote transcripts. */
	activity?: AgentActivityIndex;

	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
}

export class AgentHubOverlayComponent extends Container implements SelectListMouseTarget {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#settings: Settings | undefined;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#remote: AgentHubRemote | undefined;
	#disposed = false;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;
	/** Prevent the async persisted-session scan from flashing a false empty state. */
	#loadingPersistedSubagents = false;
	#section: AgentHubSection;
	#activity: AgentActivityIndex;
	#manageActivityLive: boolean;
	#activityRows: AgentActivityRow[] = [];
	#selectedActivityRow = 0;
	#activityFilter: ActivityFilter = "all";
	#activityScope: ActivityScope = "all";
	#activitySearch = "";
	#activitySearchEditing = false;
	#activityFollow = true;
	#activitySyncGeneration = 0;
	#activitySyncStamp = new Map<string, string>();

	// Table state
	#rows: AgentRef[] = [];
	#selectedRow = 0;
	#hoveredRow: number | null = null;
	/** Per-render screen-line to agent-row map, shared by click and hover routing. */
	#hitRows: Array<number | undefined> = [];
	#notice: string | undefined;
	/** Captured row order from the first refresh; keeps the hub stable while open. */
	#rowOrder: Map<string, number> | undefined;
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;
	/** Operational ordering by default; tree mode groups descendants under their spawner. */
	#viewMode: HubViewMode = "roster";
	#treeDepthById = new Map<string, number>();
	#treeParentById = new Map<string, string>();
	#treeLastSiblingById = new Map<string, boolean>();
	/** Current observer index and summary data, rebuilt on source changes rather than every paint. */
	#observedById = new Map<string, ObservableSession>();
	#aggregate: AggregateMetrics = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: 0,
		reportedAgents: 0,
	};
	#statusCounts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
	#childrenByParent = new Map<string, AgentRef[]>();
	/** Transcript-derived fallback stats are sampled only on the bounded age cadence. */
	#sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	/** Avoid a cadence-time row scan for the common persisted-only roster. */
	#hasFallbackLiveSessions = false;
	/** On narrow terminals Tab replaces the roster with the selected-agent inspector. */
	#narrowDetailsOpen = false;
	#lastRenderWasSplit = false;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#settings = deps.settings;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#section = deps.initialSection ?? "agents";
		this.#activity = deps.activity ?? new AgentActivityIndex({ remote: deps.remote });
		this.#manageActivityLive = !deps.activity;
		this.#loadingPersistedSubagents = !this.#remote && Boolean(deps.sessionFile?.endsWith(".jsonl"));
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		if (!this.#manageActivityLive) {
			this.#unsubscribers.push(
				this.#activity.onChange(() => {
					this.#refreshActivityRows();
					this.#requestRender();
				}),
			);
		}
		this.#ageTimer = setInterval(() => {
			if (this.#hasFallbackLiveSessions) {
				this.#aggregate = this.#aggregateMetrics(this.#observedById, true);
			}
			this.#requestRender();
		}, AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile)
					.then(() => {
						if (!this.#disposed) this.#refreshRows();
					})
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.finally(() => {
						this.#loadingPersistedSubagents = false;
						if (!this.#disposed) this.#requestRender();
					});
		this.#refreshRows();
	}

	/**
	 * Whether the current table view has no agents to show (every registered agent
	 * except Main). Persisted historical rows may arrive later; callers that need
	 * those included must wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		const termHeight = this.#ui.terminal?.rows || process.stdout.rows || 40;
		const frame = (
			this.#section === "activity"
				? this.#renderActivityTable(width, termHeight)
				: this.#renderTable(width, termHeight)
		).map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;

		// A tiny terminal can leave less room than the fixed chrome needs. Keep
		// the title and footer visible instead of spilling into scrollback.
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}

	handleInput(keyData: string): void {
		if (routeSgrMouseInput(keyData, event => routeSelectListMouse(this, event, event.row))) return;

		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (this.#section === "activity" && this.#activitySearchEditing) {
			this.#handleActivitySearchInput(keyData);
			return;
		}
		if (keyData === "1") {
			this.#switchSection("agents");
			return;
		}
		if (keyData === "2") {
			this.#switchSection("activity");
			return;
		}
		if (this.#section === "activity") this.#handleActivityInput(keyData);
		else this.#handleTableInput(keyData);
	}

	/**
	 * Seed the table's left-left close detector with the current time so a single
	 * subsequent `←` (within {@link LEFT_TAP_WINDOW_MS}) dismisses the hub.
	 *
	 * The editor's own double-tap detector consumes the `←←` that opens the hub,
	 * leaving this detector at its fresh `0` — without this handoff the user would
	 * have to press `←←` a second time to escape. Called by the opener when the hub
	 * was raised by that gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string, entryId?: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			initialEntryId: entryId,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#onDataChange();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);
		this.#observedById = new Map();
		for (const session of this.#observers.getSessions()) this.#observedById.set(session.id, session);

		const rowOrder = this.#rowOrder;
		let rosterRows: AgentRef[];
		if (!rowOrder) {
			// First refresh (usually the constructor): order by status, then recency.
			rosterRows = refs.sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map();
			for (let i = 0; i < rosterRows.length; i++) this.#rowOrder.set(rosterRows[i].id, i);
		} else {
			// After the hub is open, freeze relative order within each lifecycle
			// group. New agents append instead of moving the user's selection.
			rosterRows = refs.sort((a, b) => {
				const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
				if (statusDiff !== 0) return statusDiff;
				return (rowOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rowOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
			});
			for (const ref of rosterRows) {
				if (!rowOrder.has(ref.id)) rowOrder.set(ref.id, rowOrder.size);
			}
		}

		this.#rows = this.#viewMode === "tree" ? this.#orderAsTree(rosterRows) : rosterRows;
		if (this.#viewMode === "roster") {
			this.#treeDepthById.clear();
			this.#treeParentById.clear();
			this.#treeLastSiblingById.clear();
		}
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));

		this.#childrenByParent.clear();
		for (const ref of rosterRows) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const children = this.#childrenByParent.get(parent);
			if (children) children.push(ref);
			else this.#childrenByParent.set(parent, [ref]);
		}
		this.#statusCounts = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of rosterRows) this.#statusCounts[ref.status]++;
		this.#aggregate = this.#aggregateMetrics(this.#observedById);
		this.#refreshActivityData(rosterRows);
		this.#refreshActivityRows();
	}

	#refreshActivityData(refs: readonly AgentRef[]): void {
		if (this.#manageActivityLive) {
			const liveIds = new Set<string>();
			for (const ref of refs) {
				const observed = this.#observedById.get(ref.id);
				if (observed?.progress) {
					liveIds.add(ref.id);
					this.#activity.setLive(ref.id, activityRowsFromProgress(observed.progress, observed.lastUpdate));
				}
			}
			for (const ref of refs) {
				if (!liveIds.has(ref.id)) this.#activity.setLive(ref.id, []);
			}
		}

		const generation = ++this.#activitySyncGeneration;
		const pending: Promise<void>[] = [];
		for (const ref of refs) {
			if (!this.#remote && !ref.sessionFile) continue;
			const stamp = `${ref.sessionFile ?? ""}:${ref.lastActivity}`;
			if (this.#activitySyncStamp.get(ref.id) === stamp) continue;
			this.#activitySyncStamp.set(ref.id, stamp);
			pending.push(this.#activity.sync(ref.id, ref.sessionFile));
		}
		if (pending.length === 0) return;
		void Promise.all(pending).then(() => {
			if (this.#disposed || generation !== this.#activitySyncGeneration) return;
			this.#refreshActivityRows();
			this.#requestRender();
		});
	}

	#activityAgentIds(): ReadonlySet<string> | undefined {
		if (this.#activityScope === "all") return undefined;
		const selected = this.#rows[this.#selectedRow]?.id;
		if (!selected) return new Set();
		const ids = new Set([selected]);
		if (this.#activityScope === "agent") return ids;
		const queue = [selected];
		for (let index = 0; index < queue.length; index++) {
			for (const child of this.#childrenByParent.get(queue[index]!) ?? []) {
				if (ids.has(child.id)) continue;
				ids.add(child.id);
				queue.push(child.id);
			}
		}
		return ids;
	}

	#refreshActivityRows(): void {
		const kinds: ReadonlySet<AgentActivityKind> | undefined =
			this.#activityFilter === "responses"
				? new Set(["response"])
				: this.#activityFilter === "tools"
					? new Set(["tool"])
					: undefined;
		let rows = this.#activity.query({
			agentIds: this.#activityAgentIds(),
			kinds,
			search: this.#activitySearch,
			limit: 2_000,
		});
		if (this.#activityFilter === "errors") rows = rows.filter(row => row.status === "error");
		this.#activityRows = rows;
		if (rows.length === 0) this.#selectedActivityRow = 0;
		else if (this.#activityFollow) this.#selectedActivityRow = rows.length - 1;
		else this.#selectedActivityRow = Math.min(this.#selectedActivityRow, rows.length - 1);
	}

	#metricsFor(ref: AgentRef, observed: ObservableSession | undefined): AgentMetrics | undefined {
		// An observer snapshot is authoritative. Legacy/incomplete snapshots remain
		// unknown rather than being silently replaced by unrelated transcript stats.
		if (observed?.progress) return progressMetrics(observed);
		if (ref.history?.metrics) return ref.history.metrics;
		const session = this.#fallbackStatsSession(ref, observed);
		return session ? this.#sessionMetrics.get(session)?.metrics : undefined;
	}

	#fallbackStatsSession(
		ref: AgentRef,
		observed: ObservableSession | undefined,
	): NonNullable<AgentRef["session"]> | undefined {
		if (observed?.progress) return undefined;
		const session = ref.session;
		return session && typeof session.getSessionStats === "function" ? session : undefined;
	}

	#readSessionMetrics(session: NonNullable<AgentRef["session"]>): AgentMetrics | undefined {
		try {
			const stats = session.getSessionStats();
			return {
				// Match AgentProgress lifetime billing volume: cache reads are
				// deliberately excluded because every turn rereads cached context.
				tokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
				requests: stats.assistantMessages,
				tools: stats.toolCalls,
				cost: stats.cost,
				durationMs: 0,
				contextTokens: stats.contextUsage?.tokens,
				contextWindow: stats.contextUsage?.contextWindow,
			};
		} catch {
			// Render-only doubles and sessions being torn down may not expose a
			// complete statistics host. Missing metrics are preferable to a broken hub.
			return undefined;
		}
	}

	/** Parent-before-child projection preserving the roster's stable sibling order. */
	#orderAsTree(refs: AgentRef[]): AgentRef[] {
		this.#treeParentById.clear();
		this.#treeLastSiblingById.clear();
		const ids = new Set<string>();
		const operationalIndex = new Map<string, number>();
		for (let i = 0; i < refs.length; i++) {
			ids.add(refs[i].id);
			operationalIndex.set(refs[i].id, i);
		}

		const children = new Map<string, AgentRef[]>();
		for (const ref of refs) {
			const parent =
				ref.parentId && ref.parentId !== MAIN_AGENT_ID && ids.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
			this.#treeParentById.set(ref.id, parent);
			const siblings = children.get(parent);
			if (siblings) siblings.push(ref);
			else children.set(parent, [ref]);
		}

		// A tree group occupies the position of its earliest operational row.
		// Otherwise a recent child could leave its older parent group below an
		// unrelated peer (`child, peer, parent` → `peer, parent, child`).
		// Compute subtree minima iteratively so even pathological lineage depth
		// remains stack-safe.
		const subtreeOrder = new Map<string, number>();
		const visiting = new Set<string>();
		const ranked = new Set<string>();
		for (const start of refs) {
			if (ranked.has(start.id)) continue;
			const stack: Array<{ ref: AgentRef; expanded: boolean }> = [{ ref: start, expanded: false }];
			while (stack.length > 0) {
				const current = stack.pop();
				if (!current) continue;
				if (current.expanded) {
					let order = operationalIndex.get(current.ref.id) ?? Number.MAX_SAFE_INTEGER;
					for (const child of children.get(current.ref.id) ?? []) {
						order = Math.min(order, subtreeOrder.get(child.id) ?? Number.MAX_SAFE_INTEGER);
					}
					subtreeOrder.set(current.ref.id, order);
					visiting.delete(current.ref.id);
					ranked.add(current.ref.id);
					continue;
				}
				if (ranked.has(current.ref.id) || visiting.has(current.ref.id)) continue;
				visiting.add(current.ref.id);
				stack.push({ ref: current.ref, expanded: true });
				const descendants = children.get(current.ref.id);
				if (!descendants) continue;
				for (let i = descendants.length - 1; i >= 0; i--) {
					const child = descendants[i];
					if (!ranked.has(child.id) && !visiting.has(child.id)) {
						stack.push({ ref: child, expanded: false });
					}
				}
			}
		}
		for (const siblings of children.values()) {
			siblings.sort(
				(a, b) =>
					(subtreeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(subtreeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
					(operationalIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(operationalIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
			);
		}
		for (const siblings of children.values()) {
			for (let i = 0; i < siblings.length; i++) {
				this.#treeLastSiblingById.set(siblings[i].id, i === siblings.length - 1);
			}
		}

		const ordered: AgentRef[] = [];
		const visited = new Set<string>();
		this.#treeDepthById.clear();
		const visit = (root: AgentRef, rootDepth: number): void => {
			const stack: Array<{ ref: AgentRef; depth: number }> = [{ ref: root, depth: rootDepth }];
			while (stack.length > 0) {
				const current = stack.pop();
				if (!current || visited.has(current.ref.id)) continue;
				visited.add(current.ref.id);
				this.#treeDepthById.set(current.ref.id, current.depth);
				ordered.push(current.ref);
				const descendants = children.get(current.ref.id);
				if (!descendants) continue;
				for (let i = descendants.length - 1; i >= 0; i--) {
					stack.push({ ref: descendants[i], depth: current.depth + 1 });
				}
			}
		};
		for (const root of children.get(MAIN_AGENT_ID) ?? []) visit(root, 0);
		// Corrupt persisted parent cycles remain visible as roots instead of
		// disappearing from the operational surface.
		for (const ref of refs) visit(ref, 0);
		return ordered;
	}

	/** Bash `tree`-style ancestry prefix, clipped from the left on pathological depth. */
	#treeBranch(ref: AgentRef, maxWidth: number): string {
		if ((this.#treeDepthById.get(ref.id) ?? 0) === 0) return "";
		const segments: string[] = [this.#treeLastSiblingById.get(ref.id) ? "└── " : "├── "];
		let parent = this.#treeParentById.get(ref.id);
		while (parent && this.#treeParentById.get(parent) !== MAIN_AGENT_ID) {
			segments.push(this.#treeLastSiblingById.get(parent) ? "    " : "│   ");
			parent = this.#treeParentById.get(parent);
		}
		const maxSegments = Math.max(1, Math.floor(Math.max(4, maxWidth - 2) / 4));
		const omitted = Math.max(0, segments.length - maxSegments);
		const prefix = segments.slice(0, maxSegments).reverse().join("");
		return theme.fg("dim", `${omitted > 0 ? "… " : ""}${prefix}`);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#sectionTabs(): string {
		const tab = (section: AgentHubSection, label: string): string =>
			this.#section === section
				? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)))
				: theme.fg("muted", ` ${label} `);
		return `${tab("agents", "1 Agents")}${theme.fg("dim", theme.sep.dot)}${tab("activity", "2 Activity")}`;
	}

	#renderActivityTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const innerWidth = Math.max(1, width - 4);
		const contentRows = Math.max(1, termHeight - 4);
		const body: string[] = [this.#sectionTabs()];
		const selectedAgent = this.#rows[this.#selectedRow]?.id;
		const scope =
			this.#activityScope === "all"
				? "all agents"
				: this.#activityScope === "agent"
					? (selectedAgent ?? "selected agent")
					: `${selectedAgent ?? "selected"} subtree`;
		const search = this.#activitySearchEditing
			? theme.fg("accent", `search: ${this.#activitySearch}▌`)
			: this.#activitySearch
				? `search: ${this.#activitySearch}`
				: "search: —";
		body.push(
			theme.fg(
				"dim",
				`${scope}${theme.sep.dot}${this.#activityFilter}${theme.sep.dot}${this.#activityFollow ? "following" : "paused"}${theme.sep.dot}${search}`,
			),
		);
		if (contentRows >= 8) body.push("");

		const budget = Math.max(0, contentRows - body.length);
		if (this.#activityRows.length === 0 && budget > 0) {
			body.push(theme.fg("muted", this.#activitySearch ? "No matching activity" : "No agent activity recorded yet"));
		} else if (budget > 0) {
			const selected = Math.min(this.#selectedActivityRow, this.#activityRows.length - 1);
			const start = this.#activityFollow
				? Math.max(0, this.#activityRows.length - budget)
				: Math.max(0, Math.min(selected - Math.floor(budget / 2), this.#activityRows.length - budget));
			const end = Math.min(this.#activityRows.length, start + budget);
			if (start > 0) {
				body.push(theme.fg("dim", `… ${start} earlier`));
			}
			for (let index = start + Number(start > 0); index < end; index++) {
				this.#hitRows[1 + body.length] = index;
				body.push(this.#formatActivityRow(this.#activityRows[index]!, index === selected, innerWidth));
			}
		}
		while (body.length < contentRows) body.push("");

		const lines = [topBorder(width, "Agent Hub")];
		for (const line of body.slice(0, contentRows)) lines.push(row(line, width));
		lines.push(divider(width));
		lines.push(
			row(
				theme.fg(
					"dim",
					"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close",
				),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}

	#formatActivityRow(activity: AgentActivityRow, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const ref = this.#registry.get(activity.agentId);
		const observed = this.#observedById.get(activity.agentId);
		const role = observed?.progress?.modelRole ?? ref?.history?.modelRole;
		const roleBadge = role && this.#settings ? `${formatRoleBadge(role, this.#settings)} ` : "";
		const agent = truncateToWidth(replaceTabs(activity.agentId), Math.max(8, Math.min(18, Math.floor(width * 0.18))));
		const title = activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title;
		const prefix =
			`${cursor} ${theme.fg("dim", activityClock(activity.timestamp))} ${activityGlyph(activity)} ` +
			`${roleBadge}${theme.bold(agent)} ${theme.fg(activity.kind === "response" ? "success" : "muted", title)}`;
		const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(theme.sep.dot));
		return `${prefix}${theme.fg("dim", theme.sep.dot)}${truncateToWidth(activity.summary, available)}`;
	}

	#renderTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const contentRows = Math.max(1, termHeight - 4);
		const observedById = this.#observedById;
		const split = this.#splitRosterWidth(width);
		this.#lastRenderWasSplit = split !== undefined;
		const selected = this.#rows[this.#selectedRow];
		const lines: string[] = [];

		if (split !== undefined) {
			const detailWidth = splitBodyWidth(width, split);
			const roster = this.#renderRosterPanel(split, contentRows, observedById);
			const details = this.#renderDetailPanel(selected, detailWidth, contentRows, observedById);
			lines.push(topBorderSplit(width, "Agent Hub", split));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(splitRow(roster.lines[i] ?? "", details[i] ?? "", width, split));
			}
			lines.push(dividerSplit(width, split));
			lines.push(row(this.#footer(false, Math.max(1, width - 4)), width));
			lines.push(bottomBorder(width));
			return lines;
		}

		const innerWidth = Math.max(1, width - 4);
		if (this.#narrowDetailsOpen && selected) {
			const details = this.#renderDetailPanel(selected, innerWidth, contentRows, observedById);
			lines.push(topBorder(width, `Agent Hub · ${selected.id}`));
			for (const detail of details) lines.push(row(detail, width));
		} else {
			const roster = this.#renderRosterPanel(innerWidth, contentRows, observedById);
			lines.push(topBorder(width, "Agent Hub"));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(row(roster.lines[i] ?? "", width));
			}
		}
		lines.push(divider(width));
		lines.push(row(this.#footer(this.#narrowDetailsOpen, innerWidth), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#splitRosterWidth(width: number): number | undefined {
		if (width < SPLIT_MIN_WIDTH) return undefined;
		const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor(width * 0.58), width - DETAIL_MIN_WIDTH - 7));
		return splitBodyWidth(width, rosterWidth) >= DETAIL_MIN_WIDTH ? rosterWidth : undefined;
	}

	#footer(showingNarrowDetails: boolean, availableWidth: number): string {
		const nextView = this.#viewMode === "roster" ? "by parent" : "flat";
		if (showingNarrowDetails) {
			return theme.fg("dim", `1:agents  2:activity  Tab:roster  Enter:open  Esc:roster`);
		}
		if (availableWidth < 96) {
			return theme.fg("dim", `1:agents  2:activity  j/k:select  t:${nextView}  Tab:details  r/x:manage`);
		}
		return theme.fg(
			"dim",
			`1:agents  2:activity  j/k/wheel:select  Enter:open  t:${nextView}  r/x:manage  Esc:close`,
		);
	}

	#renderRosterPanel(width: number, rows: number, observedById: ReadonlyMap<string, ObservableSession>): RosterRender {
		const lines = this.#summaryLines(width);
		const hitRows: Array<number | undefined> = Array.from({ length: lines.length });
		if (rows >= 8) {
			lines.push("");
			hitRows.push(undefined);
		}

		const noticeLines = this.#notice ? [theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width)))] : [];
		const budget = Math.max(0, rows - lines.length - noticeLines.length);
		if (this.#rows.length === 0) {
			if (this.#loadingPersistedSubagents) {
				if (budget > 0) {
					lines.push(`${statusGlyph("running")} ${theme.fg("accent", "Loading saved agents…")}`);
					hitRows.push(undefined);
				}
			} else {
				const emptyState = [
					`${theme.fg("muted", theme.status.shadowed)} ${theme.bold("No agents in this session")}`,
					theme.fg("dim", "Finished, parked, and killed subagents remain with the session that created them."),
					theme.fg("dim", "Resume that session with omp-dev --continue, or spawn a task here."),
				];
				for (const line of emptyState.slice(0, budget)) {
					lines.push(line);
					hitRows.push(undefined);
				}
			}
		} else if (budget > 0) {
			const window = this.#renderRosterWindow(width, budget, observedById);
			lines.push(...window.lines);
			hitRows.push(...window.hitRows);
		}
		for (const notice of noticeLines) {
			lines.push(notice);
			hitRows.push(undefined);
		}
		while (lines.length < rows) {
			lines.push("");
			hitRows.push(undefined);
		}
		return { lines: lines.slice(0, rows), hitRows: hitRows.slice(0, rows) };
	}

	#renderRosterWindow(
		width: number,
		budget: number,
		observedById: ReadonlyMap<string, ObservableSession>,
	): RosterRender {
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];
		const rendered = new Map<number, string[]>();
		const entryAt = (index: number): string[] => {
			const cached = rendered.get(index);
			if (cached) return cached;
			const entry = this.#renderEntry(
				this.#rows[index],
				index === this.#selectedRow,
				width,
				observedById.get(this.#rows[index].id),
				index === this.#hoveredRow,
			);
			rendered.set(index, entry);
			return entry;
		};
		const appendEntry = (index: number, entry = entryAt(index)): void => {
			for (const line of entry) {
				lines.push(line);
				hitRows.push(index);
			}
		};

		let start = this.#selectedRow;
		let end = this.#selectedRow + 1;
		let used = entryAt(this.#selectedRow).length;
		if (used > budget) {
			appendEntry(this.#selectedRow, entryAt(this.#selectedRow).slice(0, budget));
			return { lines, hitRows };
		}

		// Grow a window around the selection. Only visible entries are rendered,
		// so the 5,000-agent Hub retains bounded paint cost.
		for (let grew = true; grew; ) {
			grew = false;
			if (end < this.#rows.length) {
				const next = entryAt(end);
				if (used + next.length <= budget) {
					used += next.length;
					end++;
					grew = true;
				}
			}
			if (start > 0) {
				const previous = entryAt(start - 1);
				if (used + previous.length <= budget) {
					start--;
					used += previous.length;
					grew = true;
				}
			}
		}
		// Overflow labels consume real rows. Trim the farthest visible neighbors
		// before painting them so the selected entry and both labels fit.
		for (
			let markerRows = Number(start > 0) + Number(end < this.#rows.length);
			used + markerRows > budget && start < end;
			markerRows = Number(start > 0) + Number(end < this.#rows.length)
		) {
			if (end - 1 > this.#selectedRow) {
				end--;
				used -= entryAt(end).length;
			} else if (start < this.#selectedRow) {
				used -= entryAt(start).length;
				start++;
			} else {
				break;
			}
		}
		const showTopOverflow = start > 0 && used < budget;
		const showBottomOverflow = end < this.#rows.length && used + Number(showTopOverflow) < budget;
		if (showTopOverflow) {
			lines.push(theme.fg("dim", `… ${start} more`));
			hitRows.push(undefined);
		}
		for (let i = start; i < end; i++) appendEntry(i);
		if (showBottomOverflow) {
			lines.push(theme.fg("dim", `… ${this.#rows.length - end} more`));
			hitRows.push(undefined);
		}
		return { lines, hitRows };
	}

	#summaryLines(width: number): string[] {
		const active = (label: string): string => theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)));
		const inactive = (label: string): string => theme.fg("muted", ` ${label} `);
		const projection =
			this.#viewMode === "roster"
				? `${active("Flat")}${theme.fg("dim", "/")}${inactive("By parent")}`
				: `${inactive("Flat")}${theme.fg("dim", "/")}${active("By parent")}`;
		const counts = this.#statusSummary();
		const header = `${theme.bold("Roster")}${theme.fg("dim", theme.sep.dot)}${projection}${counts ? theme.fg("dim", theme.sep.dot) + counts : ""}`;
		const lines = [this.#sectionTabs(), ...wrapTextWithAnsi(header, Math.max(1, width))];

		const metrics = this.#aggregate;
		if (metrics.reportedAgents === 0) {
			lines.push(
				...wrapTextWithAnsi(
					theme.fg("dim", `Usage —${theme.sep.dot}0/${this.#rows.length} measured`),
					Math.max(1, width),
				),
			);
			return lines;
		}
		const usage = [
			theme.fg("statusLineCost", formatCost(metrics.cost)),
			theme.fg("dim", `${formatDuration(metrics.durationMs)} agent time`),
			theme.fg("dim", `${formatNumber(metrics.requests)} req`),
			theme.fg("dim", `${formatNumber(metrics.tools)} tools`),
			theme.fg("dim", `${formatNumber(metrics.tokens)} tok`),
			theme.fg("dim", `${metrics.reportedAgents}/${this.#rows.length} measured`),
		].join(theme.fg("dim", theme.sep.dot));
		lines.push(...wrapTextWithAnsi(usage, Math.max(1, width)));
		return lines;
	}

	#statusSummary(): string {
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = this.#statusCounts[status];
			if (count > 0) parts.push(`${statusGlyph(status)} ${statusText(status, `${count} ${status}`)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#aggregateMetrics(observedById: ReadonlyMap<string, ObservableSession>, refreshFallback = false): AggregateMetrics {
		const total: AggregateMetrics = {
			tokens: 0,
			requests: 0,
			tools: 0,
			cost: 0,
			durationMs: 0,
			reportedAgents: 0,
		};
		let hasFallbackLiveSessions = false;
		for (const ref of this.#rows) {
			const observed = observedById.get(ref.id);
			const fallbackSession = this.#fallbackStatsSession(ref, observed);
			if (fallbackSession) {
				hasFallbackLiveSessions = true;
				if (refreshFallback || !this.#sessionMetrics.has(fallbackSession)) {
					this.#sessionMetrics.set(fallbackSession, { metrics: this.#readSessionMetrics(fallbackSession) });
				}
			}
			const metrics = this.#metricsFor(ref, observed);
			if (!metrics) continue;
			total.reportedAgents++;
			total.tokens += metrics.tokens;
			total.requests += metrics.requests;
			total.tools += metrics.tools;
			total.cost += metrics.cost;
			total.durationMs += metrics.durationMs;
		}
		this.#hasFallbackLiveSessions = hasFallbackLiveSessions;
		return total;
	}

	#renderDetailPanel(
		ref: AgentRef | undefined,
		width: number,
		rows: number,
		observedById: ReadonlyMap<string, ObservableSession>,
	): string[] {
		if (!ref) return [theme.fg("dim", "Select an agent to inspect"), ...Array.from({ length: rows - 1 }, () => "")];
		const observed = observedById.get(ref.id);
		const progress = observed?.progress;
		const metrics = this.#metricsFor(ref, observed);
		const children = this.#childrenByParent.get(ref.id) ?? [];
		const lines: string[] = [];
		const add = (line = ""): void => {
			if (lines.length < rows) lines.push(truncateToWidth(line, width));
		};
		const label = (name: string, value: string): string =>
			`${theme.bold(theme.fg("accent", name))} ${truncateToWidth(sanitizeLine(value), Math.max(1, width - name.length - 1))}`;

		add(`${statusGlyph(ref.status)} ${theme.bold(replaceTabs(ref.displayName || ref.id))}`);
		const lifecycle = [
			statusText(ref.status, ref.status),
			metrics?.durationMs ? formatDuration(metrics.durationMs) : undefined,
			`active ${formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))}`,
		].filter(Boolean);
		add(lifecycle.join(theme.fg("dim", theme.sep.dot)));
		add(`Registered ${formatAge(Math.max(1, Math.round((Date.now() - ref.createdAt) / 1000)))}`);
		const modelDetails: string[] = [];
		const modelRole = progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) modelDetails.push(formatRoleBadge(modelRole, this.#settings));
		const badge = modelBadge(ref, observed);
		if (badge) modelDetails.push(badge);
		if (modelDetails.length > 0) add(modelDetails.join(theme.sep.dot));

		const task = observed?.description ?? progress?.task ?? ref.activity;
		if (task) add(label("Task", task));
		const current = progress?.currentTool
			? `${progress.currentTool}${progress.currentToolArgs ? ` · ${progress.currentToolArgs}` : ""}`
			: progress?.lastIntent;
		if (current) add(label("Current", current));
		add(label("Usage", metrics ? formatMetrics(metrics) : "—"));
		if (metrics?.contextTokens !== undefined && metrics.contextWindow && rows >= 18) {
			add(contextGauge(metrics.contextTokens, metrics.contextWindow));
		}
		add(
			label(
				"Lineage",
				`${replaceTabs(ref.parentId ?? MAIN_AGENT_ID)}${children.length > 0 ? ` · ${children.length} children · ${formatChildIds(children, width)}` : ""}`,
			),
		);
		add(
			theme.fg(
				"dim",
				ref.kind === "advisor" || ref.history?.readOnly
					? "Read-only · 0 LoC"
					: "Shared workspace · per-agent LoC not attributable",
			),
		);

		if (lines.length < rows) add();
		if (lines.length < rows) add(theme.bold(theme.fg("accent", "Recent activity")));
		const activityBudget = Math.max(0, rows - lines.length);
		const activity = this.#activity.recent(ref.id, activityBudget);
		if (activity.length === 0 && activityBudget > 0) add(theme.fg("muted", "No response or tool activity yet"));
		else {
			for (const event of activity) {
				const title = event.kind === "tool" ? (event.toolName ?? event.title) : event.title;
				const prefix = `${theme.fg("dim", activityClock(event.timestamp))} ${activityGlyph(event)} ${theme.fg("muted", title)} `;
				add(`${prefix}${truncateToWidth(event.summary, Math.max(1, width - visibleWidth(prefix)))}`);
			}
		}

		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	/**
	 * One agent entry keeps identity/model metadata on one line when it fits,
	 * then packs task and all five usage metrics together below. Narrow rows wrap
	 * only those dense secondary fields.
	 */
	#renderEntry(
		ref: AgentRef,
		selected: boolean,
		width: number,
		observed: ObservableSession | undefined,
		hovered = false,
	): string[] {
		const max = Math.max(1, width);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const depth = this.#viewMode === "tree" ? (this.#treeDepthById.get(ref.id) ?? 0) : 0;
		const branch = this.#viewMode === "tree" ? this.#treeBranch(ref, max) : "";
		const id = replaceTabs(ref.id);
		const styledId = selected ? theme.bold(theme.fg("accent", id)) : theme.bold(id);
		const fields: string[] = [`${cursor} ${statusGlyph(ref.status)} ${branch}${styledId}`];
		if (ref.displayName && ref.displayName !== ref.id) {
			fields.push(theme.fg("dim", replaceTabs(ref.displayName)));
		}
		if (this.#viewMode === "roster" && ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
			fields.push(theme.fg("dim", `↳ ${replaceTabs(ref.parentId)}`));
		}
		if (ref.kind === "advisor") {
			fields.push(theme.fg("warning", "read-only"));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			fields.push(theme.fg("warning", `⧉ ${unread}`));
		}
		const left = fields.join("  ");

		const meta: string[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) {
			meta.push(formatRoleBadge(modelRole, this.#settings));
		}
		const badge = modelBadge(ref, observed);
		if (badge) meta.push(badge);
		meta.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		const right = meta.join(theme.sep.dot);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const entry: string[] = [];
		const detailIndent = Math.min(max - 1, 4 + depth * 2);
		if (leftWidth + 2 + rightWidth <= max) {
			entry.push(left + padding(max - leftWidth - rightWidth) + right);
		} else {
			entry.push(truncateToWidth(left.replace(/[\r\n]+/g, " "), max));
			entry.push(`${padding(Math.max(0, detailIndent))}${truncateToWidth(right, Math.max(1, max - detailIndent))}`);
		}

		const metrics = this.#metricsFor(ref, observed);
		const usage = metrics ? theme.fg("dim", formatMetrics(metrics)) : theme.fg("dim", "usage —");
		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		const detailWidth = Math.max(1, max - detailIndent);
		const details = task
			? `${theme.fg("muted", sanitizeLine(task, detailWidth))}${theme.fg("dim", theme.sep.dot)}${usage}`
			: usage;
		for (const wrapped of wrapTextWithAnsi(details, detailWidth)) {
			entry.push(`${padding(Math.max(0, detailIndent))}${wrapped}`);
		}
		if (!hovered) return entry;
		return entry.map(lineRow => {
			const rowWidth = visibleWidth(lineRow);
			return theme.bg("selectedBg", rowWidth < max ? lineRow + padding(max - rowWidth) : lineRow);
		});
	}

	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		if (this.#section === "activity") {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.max(
					0,
					Math.min(this.#selectedActivityRow + delta, this.#activityRows.length - 1),
				);
			}
		} else if (this.#rows.length > 0) {
			this.#selectedRow = Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1));
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (this.#section === "activity") return;
		if (index === this.#hoveredRow) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}

	clickItem(index: number): void {
		if (this.#section === "activity") {
			if (index === this.#selectedActivityRow) {
				const activity = this.#activityRows[index];
				if (activity) this.openChat(activity.agentId, activity.entryId);
				return;
			}
			this.#activityFollow = false;
			this.#selectedActivityRow = index;
			this.#requestRender();
			return;
		}
		this.#hoveredRow = index;
		if (index === this.#selectedRow) {
			const selected = this.#rows[index];
			if (selected) this.#activateAgent(selected);
			return;
		}
		this.#selectedRow = index;
		this.#refreshActivityRows();
		this.#requestRender();
	}

	#switchSection(section: AgentHubSection): void {
		if (this.#section === section) return;
		this.#section = section;
		this.#hoveredRow = null;
		this.#narrowDetailsOpen = false;
		if (section === "activity") this.#refreshActivityRows();
		this.#requestRender();
	}

	#handleActivitySearchInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#activitySearchEditing = false;
		} else if (matchesKey(keyData, "backspace")) {
			this.#activitySearch = this.#activitySearch.slice(0, -1);
		} else if (keyData.length === 1 && keyData >= " " && keyData !== "\u007f") {
			this.#activitySearch += keyData;
		} else {
			return;
		}
		this.#refreshActivityRows();
		this.#requestRender();
	}

	#handleActivityInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#activitySearch) {
				this.#activitySearch = "";
				this.#refreshActivityRows();
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#switchSection("agents");
			return;
		}
		if (keyData === "/") {
			this.#activitySearchEditing = true;
			this.#requestRender();
			return;
		}
		if (keyData === " ") {
			this.#activityFollow = !this.#activityFollow;
			if (this.#activityFollow && this.#activityRows.length > 0) {
				this.#selectedActivityRow = this.#activityRows.length - 1;
			}
			this.#requestRender();
			return;
		}
		if (keyData === "f") {
			const filters: ActivityFilter[] = ["all", "errors", "responses", "tools"];
			this.#activityFilter = filters[(filters.indexOf(this.#activityFilter) + 1) % filters.length]!;
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (keyData === "s") {
			const scopes: ActivityScope[] = ["all", "agent", "subtree"];
			this.#activityScope = scopes[(scopes.indexOf(this.#activityScope) + 1) % scopes.length]!;
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.min(this.#selectedActivityRow + 1, this.#activityRows.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#activityRows.length > 0) {
				this.#activityFollow = false;
				this.#selectedActivityRow = Math.max(this.#selectedActivityRow - 1, 0);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const activity = this.#activityRows[this.#selectedActivityRow];
			if (activity) this.openChat(activity.agentId, activity.entryId);
		}
	}

	#handleTableInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#narrowDetailsOpen && !this.#lastRenderWasSplit) {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if ((matchesKey(keyData, "tab") || keyData === "\t") && !this.#lastRenderWasSplit) {
			if (this.#rows.length > 0) this.#narrowDetailsOpen = !this.#narrowDetailsOpen;
			this.#requestRender();
			return;
		}
		if (keyData === "t") {
			this.#hoveredRow = null;
			this.#viewMode = this.#viewMode === "roster" ? "tree" : "roster";
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "right")) {
			this.#switchSection("activity");
			return;
		}
		if (matchesKey(keyData, "left")) {
			if (this.#narrowDetailsOpen && !this.#lastRenderWasSplit) {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
				return;
			}
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		this.#hoveredRow = null;
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			}
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			}
			this.#refreshActivityRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const selected = this.#rows[this.#selectedRow];
			if (selected) this.#activateAgent(selected);
			return;
		}
		if (keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (keyData === "x") {
			this.#killSelected();
			return;
		}
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: AgentRef): void {
		this.#notice = undefined;
		const focusAgent = this.#focusAgent;
		// Advisor refs are read-only transcripts with no live/ revivable session;
		// open the in-hub chat view (file-backed) instead of trying to focus one.
		if (ref.kind === "advisor" || this.#remote || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await focusAgent(ref.id); // ensureLive inside revives parked agents; no parking, no session files
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#reviveSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — nothing to revive.`;
			this.#requestRender();
			return;
		}
		if (ref.status !== "parked") {
			this.#notice = `Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
		// Fire-and-forget; failures surface as an inline notice
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — cannot be killed.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
