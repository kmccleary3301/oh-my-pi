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
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	matchesKey,
	type OverlayHandle,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { AgentActivityIndex, activityRowsFromProgress } from "../../activity";
import type { KeyId } from "../../config/keybindings";
import type { Settings } from "../../config/settings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	type AgentMetrics,
	type AggregateMetrics,
	aggregateMetrics,
	progressMetrics,
	projectAgentTree,
	STATUS_ORDER,
} from "./agent-hub-projection";
import { clampHubLine } from "./agent-hub-renderer";
import { ActivityView } from "./agent-hub/activity-view";
import { RosterView, type HubViewMode } from "./agent-hub/roster-view";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
export type AgentHubSection = "agents" | "activity";
/** Refresh cadence for the relative-time column. */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;
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
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
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
	#activityView: ActivityView;
	#rosterView: RosterView;
	#selectedActivityRow = 0;
	#activitySyncGeneration = 0;
	#activitySyncStamp = new Map<string, string>();
	// Table state
	#rows: AgentRef[] = [];
	#statusCounts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
	#selectedRow = 0;
	#hoveredRow: number | null = null;
	/** Per-render screen-line to agent-row map, shared by click and hover routing. */
	#hitRows: Array<number | undefined> = [];
	#notice: string | undefined;
	/** Captured row order from the first refresh; keeps the hub stable while open. */
	#rowOrder: Map<string, number> | undefined;
	#nextRowOrder = 0;
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
		durationKind: "active",
		reportedAgents: 0,
		activeDurationAgents: 0,
	};
	#childrenByParent = new Map<string, AgentRef[]>();
	/** Transcript-derived fallback stats are sampled only on the bounded age cadence. */
	#sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	/** Avoid a cadence-time row scan for the common persisted-only roster. */
	#hasFallbackLiveSessions = false;
	/** On narrow terminals Tab replaces the roster with the selected-agent inspector. */
	#narrowDetailsOpen = false;
	#lastRenderWasSplit = false;
	#lastSplitRosterWidth: number | undefined;
	/** Scroll offset for the selected-agent inspector when its content overflows. */
	#detailScrollOffset = 0;
	#detailAgentId: string | undefined;
	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#isBuiltInTool: ((name: string) => boolean) | undefined;
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
		this.#isBuiltInTool = deps.isBuiltInTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;
		this.#activityView = new ActivityView({
			activity: this.#activity,
			registry: this.#registry,
			settings: this.#settings,
			getRows: () => this.#rows,
			getSelectedAgentIndex: () => this.#selectedRow,
			getSelectedActivityRow: () => this.#selectedActivityRow,
			setSelectedActivityRow: index => {
				this.#selectedActivityRow = index;
			},
			getChildrenByParent: () => this.#childrenByParent,
			getObserved: id => this.#observedById.get(id),
			sectionTabs: () => this.#sectionTabs(),
			onSwitchToAgents: () => this.#switchSection("agents"),
			onDone: this.#onDone,
			openChat: (id, entryId) => this.openChat(id, entryId),
			requestRender: this.#requestRender,
		});
		this.#rosterView = new RosterView({
			registry: this.#registry,
			ircUnreadCount: id => this.#irc.unreadCount(id),
			settings: this.#settings,
			activity: this.#activity,
			getRows: () => this.#rows,
			getSelectedRow: () => this.#selectedRow,
			getHoveredRow: () => this.#hoveredRow,
			getViewMode: () => this.#viewMode,
			getTreeDepthById: () => this.#treeDepthById,
			getTreeParentById: () => this.#treeParentById,
			getTreeLastSiblingById: () => this.#treeLastSiblingById,
			getObserved: id => this.#observableFor(id),
			getMetrics: (ref, observed) => this.#metricsFor(ref, observed),
			getAggregate: () => this.#aggregate,
			getStatusCounts: () => this.#statusCounts,
			getChildrenByParent: () => this.#childrenByParent,
			getNotice: () => this.#notice,
			isLoadingPersistedSubagents: () => this.#loadingPersistedSubagents,
			isNarrowDetailsOpen: () => this.#narrowDetailsOpen,
			getDetailScrollOffset: () => this.#detailScrollOffset,
			setDetailScrollOffset: offset => {
				this.#detailScrollOffset = offset;
			},
		});
		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		if (!this.#manageActivityLive) {
			this.#unsubscribers.push(
				this.#activity.onChange(() => {
					this.#activityView.refreshRows();
					this.#requestRender();
				}),
			);
		}
		this.#ageTimer = setInterval(() => {
			if (this.#hasFallbackLiveSessions) {
				this.#refreshAggregate(true);
			}
			this.#requestRender();
		}, AGE_TICK_MS);
		this.#ageTimer.unref?.();
		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile, {
					shouldContinue: () => !this.#disposed,
				})
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
	override dispose(): void {
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
		let frame: string[];
		if (this.#section === "activity") {
			frame = this.#activityView.render(width, termHeight);
		} else {
			const rosterFrame = this.#rosterView.render(width, termHeight);
			this.#hitRows = rosterFrame.hitRows;
			this.#lastSplitRosterWidth = rosterFrame.splitRosterWidth;
			this.#lastRenderWasSplit = rosterFrame.splitRosterWidth !== undefined;
			frame = rosterFrame.lines;
		}
		frame = frame.map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;
		// A tiny terminal can leave less room than the fixed chrome needs. Keep
		// the title and footer visible instead of spilling into scrollback.
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}
	handleInput(keyData: string): void {
		if (
			routeSgrMouseInput(keyData, event => {
				const split = this.#lastSplitRosterWidth;
				if (split !== undefined && event.wheel === null && event.col > split + 2) return false;
				return routeSelectListMouse(this, event, event.row);
			})
		) {
			return;
		}
		if (this.#section === "activity" && this.#activityView.isSearchEditing) {
			this.#activityView.handleInput(keyData);
			return;
		}
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (keyData === "1") {
			this.#switchSection("agents");
			return;
		}
		if (keyData === "2") {
			this.#switchSection("activity");
			return;
		}
		if (this.#section === "activity") this.#activityView.handleInput(keyData);
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
		if (this.#disposed || !this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		let viewer: AgentTranscriptViewer;
		viewer = new AgentTranscriptViewer({
			agentId: id,
			initialEntryId: entryId,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			isBuiltInTool: this.#isBuiltInTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(viewer),
			onHubClose: () => {
				if (this.#disposed) return;
				this.#closeTranscriptOverlay(viewer);
				if (!this.#disposed) this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}
	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(expectedViewer?: AgentTranscriptViewer): void {
		if (expectedViewer && this.#transcriptViewer !== expectedViewer) return;
		const overlay = this.#transcriptOverlay;
		const viewer = this.#transcriptViewer;
		if (!overlay && !viewer) return;
		overlay?.hide();
		this.#transcriptOverlay = undefined;
		viewer?.dispose();
		this.#transcriptViewer = undefined;
		if (!this.#disposed) {
			if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
			this.#requestRender();
		}
	}
	// Live data plumbing
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
			rosterRows = refs.sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					b.lastActivity - a.lastActivity ||
					a.id.localeCompare(b.id),
			);
			this.#rowOrder = new Map();
			for (const ref of rosterRows) this.#rowOrder.set(ref.id, this.#nextRowOrder++);
		} else {
			rosterRows = refs.sort(
				(a, b) => (rowOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rowOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
			);
			for (const ref of rosterRows) {
				if (!rowOrder.has(ref.id)) rowOrder.set(ref.id, this.#nextRowOrder++);
			}
		}
		if (this.#viewMode === "tree") {
			const tree = projectAgentTree(rosterRows);
			this.#rows = tree.rows;
			this.#treeDepthById = tree.depthById;
			this.#treeParentById = tree.parentById;
			this.#treeLastSiblingById = tree.lastSiblingById;
		} else {
			this.#rows = rosterRows;
			this.#treeDepthById.clear();
			this.#treeParentById.clear();
			this.#treeLastSiblingById.clear();
		}
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		const detailAgentId = this.#rows[this.#selectedRow]?.id;
		if (detailAgentId !== this.#detailAgentId) {
			this.#detailAgentId = detailAgentId;
			this.#detailScrollOffset = 0;
		}
		this.#childrenByParent.clear();
		for (const ref of rosterRows) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const children = this.#childrenByParent.get(parent);
			if (children) children.push(ref);
			else this.#childrenByParent.set(parent, [ref]);
		}
		this.#statusCounts = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of rosterRows) this.#statusCounts[ref.status]++;
		this.#refreshAggregate();
		this.#refreshActivityData(rosterRows);
		this.#activityView.refreshRows();
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
		void Promise.all(pending)
			.then(() => {
				if (this.#disposed || generation !== this.#activitySyncGeneration) return;
				this.#activityView.refreshRows();
				this.#requestRender();
			})
			.catch(() => {
				// Individual sync paths already guard I/O failures; keep the hub render loop alive.
			});
	}
	#metricsFor(ref: AgentRef, observed: ObservableSession | undefined): AgentMetrics | undefined {
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
	#refreshAggregate(refreshFallback = false): void {
		const result = aggregateMetrics({
			rows: this.#rows,
			observedById: this.#observedById,
			metricsFor: (ref, observed) => this.#metricsFor(ref, observed),
			fallbackStatsSession: (ref, observed) => this.#fallbackStatsSession(ref, observed),
			sessionMetrics: this.#sessionMetrics,
			refreshFallback,
		});
		this.#aggregate = result.metrics;
		this.#hasFallbackLiveSessions = result.hasFallbackLiveSessions;
	}
	#observableFor(id: string): ObservableSession | undefined {
		return this.#observedById.get(id) ?? this.#observers.getSession(id);
	}
	// Table view
	#sectionTabs(): string {
		const tab = (section: AgentHubSection, label: string): string =>
			this.#section === section
				? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)))
				: theme.fg("muted", ` ${label} `);
		return `${tab("agents", "1 Agents")}${theme.fg("dim", theme.sep.dot)}${tab("activity", "2 Activity")}`;
	}
	#scrollDetails(direction: -1 | 1): void {
		this.#detailScrollOffset = Math.max(0, this.#detailScrollOffset + direction * 5);
		this.#requestRender();
	}
	#selectRow(index: number): void {
		if (index !== this.#selectedRow) {
			this.#detailScrollOffset = 0;
			this.#detailAgentId = this.#rows[index]?.id;
		}
		this.#selectedRow = index;
	}
	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		if (this.#section === "activity") {
			this.#activityView.handleWheel(delta);
			return;
		}
		if (this.#rows.length > 0) this.#selectRow(Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1)));
		this.#requestRender();
	}
	hitTest(line: number): number | undefined {
		return this.#section === "activity" ? this.#activityView.hitTest(line) : this.#hitRows[line];
	}
	setHoverIndex(index: number | null): void {
		if (this.#section === "activity") return;
		if (index === this.#hoveredRow) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}
	clickItem(index: number): void {
		if (this.#section === "activity") {
			this.#activityView.clickItem(index);
			return;
		}
		const selected = this.#rows[index];
		if (!selected) return;
		this.#hoveredRow = index;
		this.#selectRow(index);
		this.#activityView.refreshRows();
		this.#requestRender();
		this.#activateAgent(selected);
	}
	#switchSection(section: AgentHubSection): void {
		if (this.#section === section) return;
		this.#section = section;
		this.#hoveredRow = null;
		this.#narrowDetailsOpen = false;
		if (section === "activity") this.#activityView.refreshRows();
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
		if (this.#lastRenderWasSplit || this.#narrowDetailsOpen) {
			if (matchesKey(keyData, "pageUp")) {
				this.#scrollDetails(-1);
				return;
			}
			if (matchesKey(keyData, "pageDown")) {
				this.#scrollDetails(1);
				return;
			}
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
				this.#selectRow(Math.min(this.#selectedRow + 1, this.#rows.length - 1));
			}
			this.#activityView.refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectRow(Math.max(this.#selectedRow - 1, 0));
			}
			this.#activityView.refreshRows();
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
