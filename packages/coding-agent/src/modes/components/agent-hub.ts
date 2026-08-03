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
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
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

type HubViewMode = "roster" | "tree";

interface AgentMetrics {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	contextTokens?: number;
	contextWindow?: number;
}

interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
}

interface RosterRender {
	lines: string[];
	hitRows: Array<number | undefined>;
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

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false): string {
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return formatModelBadge(label, level);
}

/**
 * Active model + reasoning level for a hub row: live session state when the
 * agent is attached, else the executor-reported `resolvedModel` selector
 * (`provider/id`, optionally `:<level>`). Active retry fallbacks retain their
 * provider and carry an explicit marker. Undefined when no model is known
 * (e.g. a parked historical agent restored from disk).
 */
function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const progress = observed?.progress;
	// Prefer the live session's own resolved fallback selector; else honor the
	// executor-reported fallback flag. The latter covers observer-only rows (no
	// live session) AND live rows whose fallback armed no session retry state —
	// e.g. the Fireworks Fast → base degrade, which emits `retry_fallback_applied`
	// without populating `#activeRetryFallback`, so `retryFallbackModel` is undefined.
	const fallbackSelector =
		ref.session?.retryFallbackModel ?? (progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", "fallback →")} ${formatResolvedModelBadge(fallbackSelector, true)}`;
	}
	const model = ref.session?.model;
	if (model) {
		const level = model.thinking ? ref.session?.thinkingLevel : undefined;
		return formatModelBadge(model.id, level);
	}
	const resolved = progress?.resolvedModel;
	return resolved ? formatResolvedModelBadge(resolved) : undefined;
}

/** Direct usage for one roster entry. Prefer executor progress; fall back to a live session snapshot. */
function metricsFor(ref: AgentRef, observed: ObservableSession | undefined): AgentMetrics | undefined {
	const progress = observed?.progress;
	if (progress) {
		return {
			tokens: progress.tokens,
			requests: progress.requests,
			tools: progress.toolCount,
			cost: progress.cost,
			durationMs: progress.durationMs,
			contextTokens: progress.contextTokens,
			contextWindow: progress.contextWindow,
		};
	}
	const getSessionStats = ref.session?.getSessionStats;
	if (typeof getSessionStats !== "function") return undefined;
	try {
		const stats = getSessionStats.call(ref.session);
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
		// Render-only test doubles and sessions being torn down may not expose a
		// complete statistics host. Missing metrics are preferable to a broken hub.
		return undefined;
	}
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function contextGauge(tokens: number, window: number): string {
	const ratio = Math.max(0, Math.min(1, tokens / window));
	const filled = Math.round(ratio * 10);
	return `${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(10 - filled))} ${formatNumber(tokens)}/${formatNumber(window)} ${Math.round(ratio * 100)}%`;
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

	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
}

export class AgentHubOverlayComponent extends Container implements SelectListMouseTarget {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
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
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
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
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
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
		const frame = this.#renderTable(width, termHeight).map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;

		// A tiny terminal can leave less room than the fixed chrome needs. Keep
		// the title and footer visible instead of spilling into scrollback.
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}

	handleInput(keyData: string): void {
		if (routeSgrMouseInput(keyData, event => routeSelectListMouse(this, event, event.row))) return;

		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		this.#handleTableInput(keyData);
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
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
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

		const rowOrder = this.#rowOrder;
		let rosterRows: AgentRef[];
		if (!rowOrder) {
			// First refresh (usually the constructor): order by status, then recency.
			rosterRows = refs.sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(rosterRows.map((ref, i) => [ref.id, i]));
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
		if (this.#viewMode === "roster") this.#treeDepthById.clear();
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	/** Parent-before-child projection preserving the roster's stable sibling order. */
	#orderAsTree(refs: AgentRef[]): AgentRef[] {
		const ids = new Set(refs.map(ref => ref.id));
		const children = new Map<string, AgentRef[]>();
		for (const ref of refs) {
			const parent =
				ref.parentId && ref.parentId !== MAIN_AGENT_ID && ids.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
			const siblings = children.get(parent);
			if (siblings) siblings.push(ref);
			else children.set(parent, [ref]);
		}

		const ordered: AgentRef[] = [];
		const visited = new Set<string>();
		this.#treeDepthById.clear();
		const visit = (ref: AgentRef, depth: number): void => {
			if (visited.has(ref.id)) return;
			visited.add(ref.id);
			this.#treeDepthById.set(ref.id, depth);
			ordered.push(ref);
			for (const child of children.get(ref.id) ?? []) visit(child, depth + 1);
		};
		for (const root of children.get(MAIN_AGENT_ID) ?? []) visit(root, 0);
		// Corrupt persisted parent cycles remain visible as roots instead of
		// disappearing from the operational surface.
		for (const ref of refs) visit(ref, 0);
		return ordered;
	}

	#observablesById(): Map<string, ObservableSession> {
		return new Map(this.#observers.getSessions().map(session => [session.id, session]));
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const contentRows = Math.max(1, termHeight - 4);
		const observedById = this.#observablesById();
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
		const nextView = this.#viewMode === "roster" ? "tree" : "roster";
		if (showingNarrowDetails) {
			return theme.fg("dim", `Tab:roster  Enter:open  t:${nextView}  Esc:roster`);
		}
		if (availableWidth < 96) {
			return theme.fg("dim", `j/k:select  Enter:open  t:${nextView}  Tab:details  r/x:manage  Esc:close`);
		}
		return theme.fg("dim", `j/k/wheel:select  Enter/click:open  t:${nextView}  r:revive  x:kill  Esc:close`);
	}

	#renderRosterPanel(width: number, rows: number, observedById: ReadonlyMap<string, ObservableSession>): RosterRender {
		const lines = this.#summaryLines(observedById);
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
		const rendered: Array<string[] | undefined> = [];
		const entryAt = (index: number): string[] => {
			const cached = rendered[index];
			if (cached) return cached;
			const entry = this.#renderEntry(
				this.#rows[index],
				index === this.#selectedRow,
				width,
				observedById.get(this.#rows[index].id),
				index === this.#hoveredRow,
			);
			rendered[index] = entry;
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

	#summaryLines(observedById: ReadonlyMap<string, ObservableSession>): string[] {
		const view = this.#viewMode === "roster" ? "Roster" : "Spawn tree";
		const counts = this.#statusSummary();
		const metrics = this.#aggregateMetrics(observedById);
		const usage: string[] = [];
		if (metrics.cost > 0) usage.push(theme.fg("statusLineCost", formatCost(metrics.cost)));
		if (metrics.tokens > 0) usage.push(`${formatNumber(metrics.tokens)} tok`);
		if (metrics.requests > 0) usage.push(`${formatNumber(metrics.requests)} req`);
		if (metrics.tools > 0) usage.push(`${formatNumber(metrics.tools)} tools`);
		if (metrics.durationMs > 0) usage.push(`${formatDuration(metrics.durationMs)} agent time`);
		return [
			`${theme.bold(view)}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`,
			usage.length > 0
				? theme.fg("dim", usage.join(theme.sep.dot))
				: theme.fg(
						"dim",
						metrics.reportedAgents > 0
							? "usage not priced by active providers"
							: "usage appears with agent progress",
					),
		];
	}

	#statusSummary(): string {
		const counts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of this.#rows) counts[ref.status]++;
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = counts[status];
			if (count > 0) parts.push(`${statusGlyph(status)} ${statusText(status, `${count} ${status}`)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#aggregateMetrics(observedById: ReadonlyMap<string, ObservableSession>): AggregateMetrics {
		const total: AggregateMetrics = {
			tokens: 0,
			requests: 0,
			tools: 0,
			cost: 0,
			durationMs: 0,
			reportedAgents: 0,
		};
		for (const ref of this.#rows) {
			const metrics = metricsFor(ref, observedById.get(ref.id));
			if (!metrics) continue;
			total.reportedAgents++;
			total.tokens += metrics.tokens;
			total.requests += metrics.requests;
			total.tools += metrics.tools;
			total.cost += metrics.cost;
			total.durationMs += metrics.durationMs;
		}
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
		const metrics = metricsFor(ref, observed);
		const children = this.#rows.filter(candidate => candidate.parentId === ref.id);
		const lines: string[] = [];
		const add = (line = ""): void => {
			if (lines.length < rows) lines.push(truncateToWidth(line, width));
		};
		const addWrapped = (text: string, maxRows = 2): void => {
			for (const wrapped of wrapTextWithAnsi(sanitizeLine(text), Math.max(1, width)).slice(0, maxRows)) add(wrapped);
		};
		const section = (label: string): void => {
			if (lines.length > 0) add();
			add(theme.bold(theme.fg("accent", label)));
		};

		add(`${statusGlyph(ref.status)} ${theme.bold(replaceTabs(ref.displayName || ref.id))}`);
		if (ref.displayName && ref.displayName !== ref.id) add(theme.fg("dim", ref.id));
		const lifecycleDetails = [
			metrics?.durationMs ? formatDuration(metrics.durationMs) : undefined,
			`active ${formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))}`,
		].filter(Boolean);
		add(
			`${statusText(ref.status, ref.status)}${theme.fg("dim", `${theme.sep.dot}${lifecycleDetails.join(theme.sep.dot)}`)}`,
		);
		const badge = modelBadge(ref, observed);
		if (badge) add(badge);

		const task = observed?.description ?? progress?.task ?? ref.activity;
		if (task) {
			section("Task");
			addWrapped(task);
		}

		const current = progress?.currentTool
			? `${progress.currentTool}${progress.currentToolArgs ? ` · ${progress.currentToolArgs}` : ""}`
			: (progress?.lastIntent ?? ref.activity);
		if (current) {
			section("Current");
			addWrapped(current);
			if (progress?.retryState) {
				add(theme.fg("warning", `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`));
			}
		}

		section("Usage");
		if (metrics) {
			const spend = [
				metrics.cost > 0 ? formatCost(metrics.cost) : "cost —",
				`${formatNumber(metrics.tokens)} tokens`,
				`${formatNumber(metrics.requests)} requests`,
				`${formatNumber(metrics.tools)} tools`,
			];
			addWrapped(spend.join(theme.sep.dot));
			if (metrics.contextTokens !== undefined && metrics.contextWindow) {
				add(contextGauge(metrics.contextTokens, metrics.contextWindow));
			}
		} else {
			add(theme.fg("dim", "No usage snapshot"));
		}

		section("Lineage");
		add(
			`Spawned by ${replaceTabs(ref.parentId ?? MAIN_AGENT_ID)}${children.length > 0 ? ` · ${children.length} children` : ""}`,
		);
		if (children.length > 0) addWrapped(children.map(child => child.id).join(", "), 1);
		add(theme.fg("dim", `Registered ${new Date(ref.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z`));

		section("Changes");
		add(
			theme.fg(
				"dim",
				ref.kind === "advisor" ? "Read-only transcript" : "Shared workspace · per-agent LoC not attributable",
			),
		);

		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	/**
	 * One agent entry, 1-2 lines:
	 * `❯ ⟳ Name  type  ↳ parent  ⧉ 2 ········ model ◒ level · age` — identity
	 * left, metadata right-aligned (inlined when the terminal is too narrow) —
	 * plus an indented dim task line when the agent's work is known.
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
		const branch = this.#viewMode === "tree" && depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : "";
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
		const badge = modelBadge(ref, observed);
		if (badge) meta.push(badge);
		meta.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		const right = meta.join(theme.sep.dot);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const line =
			leftWidth + 2 + rightWidth <= max
				? left + padding(max - leftWidth - rightWidth) + right
				: truncateToWidth(`${left}  ${right}`.replace(/[\r\n]+/g, " "), max);
		const entry = [line];

		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		if (task) {
			const indentWidth = Math.min(max - 1, 4 + depth * 2);
			entry.push(
				`${padding(Math.max(0, indentWidth))}${theme.fg("muted", sanitizeLine(task, Math.max(10, max - indentWidth)))}`,
			);
		}
		if (!hovered) return entry;
		return entry.map(lineRow => {
			const rowWidth = visibleWidth(lineRow);
			return theme.bg("selectedBg", rowWidth < max ? lineRow + padding(max - rowWidth) : lineRow);
		});
	}

	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		if (this.#rows.length > 0) {
			this.#selectedRow = Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1));
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (index === this.#hoveredRow) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}

	clickItem(index: number): void {
		this.#hoveredRow = index;
		if (index === this.#selectedRow) {
			const selected = this.#rows[index];
			if (selected) this.#activateAgent(selected);
			return;
		}
		this.#selectedRow = index;
		this.#requestRender();
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
			this.#viewMode = this.#viewMode === "roster" ? "tree" : "roster";
			this.#refreshRows();
			this.#requestRender();
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
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			}
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
