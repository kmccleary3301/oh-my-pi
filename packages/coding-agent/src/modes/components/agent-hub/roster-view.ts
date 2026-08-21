import { padding, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatAge, formatNumber } from "@oh-my-pi/pi-utils";
import type { AgentActivityIndex, AgentActivityRow } from "../../../activity";
import type { Settings } from "../../../config/settings";
import type { AgentRef, AgentRegistry, AgentStatus } from "../../../registry/agent-registry";
import type { ObservableSession } from "../../session-observer-registry";
import type { AgentMetrics, AggregateMetrics } from "../agent-hub-projection";
import {
	contextGauge,
	formatChildIds,
	formatCost,
	formatMetricDuration,
	formatMetrics,
	formatRoleBadge,
	modelBadge,
	sanitizeDisplayText,
	sanitizeLine,
	statusGlyph,
	statusText,
	treeBranch,
} from "../agent-hub-renderer";
import { shortenPath, truncateToWidth } from "../../../tools/render-utils";
import { theme } from "../../theme/theme";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "../overlay-box";

const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_MIN_WIDTH = 48;

export type HubViewMode = "roster" | "tree";

export interface RosterViewFrame {
	lines: string[];
	hitRows: Array<number | undefined>;
	splitRosterWidth: number | undefined;
}

export interface RosterViewDeps {
	registry: AgentRegistry;
	ircUnreadCount: (id: string) => number;
	settings?: Settings;
	activity: AgentActivityIndex;
	getRows: () => readonly AgentRef[];
	getSelectedRow: () => number;
	getHoveredRow: () => number | null;
	getViewMode: () => HubViewMode;
	getTreeDepthById: () => ReadonlyMap<string, number>;
	getTreeParentById: () => ReadonlyMap<string, string>;
	getTreeLastSiblingById: () => ReadonlyMap<string, boolean>;
	getObserved: (id: string) => ObservableSession | undefined;
	getMetrics: (ref: AgentRef, observed: ObservableSession | undefined) => AgentMetrics | undefined;
	getAggregate: () => AggregateMetrics;
	getStatusCounts: () => Readonly<Record<AgentStatus, number>>;
	getChildrenByParent: () => ReadonlyMap<string, readonly AgentRef[]>;
	getNotice: () => string | undefined;
	isLoadingPersistedSubagents: () => boolean;
	isNarrowDetailsOpen: () => boolean;
	getDetailScrollOffset: () => number;
	setDetailScrollOffset: (offset: number) => void;
}

export class RosterView {
	#registry: AgentRegistry;
	#ircUnreadCount: (id: string) => number;
	#settings: Settings | undefined;
	#activity: AgentActivityIndex;
	#getRows: () => readonly AgentRef[];
	#getSelectedRow: () => number;
	#getHoveredRow: () => number | null;
	#getViewMode: () => HubViewMode;
	#getTreeDepthById: () => ReadonlyMap<string, number>;
	#getTreeParentById: () => ReadonlyMap<string, string>;
	#getTreeLastSiblingById: () => ReadonlyMap<string, boolean>;
	#getObserved: (id: string) => ObservableSession | undefined;
	#getMetrics: (ref: AgentRef, observed: ObservableSession | undefined) => AgentMetrics | undefined;
	#getAggregate: () => AggregateMetrics;
	#getStatusCounts: () => Readonly<Record<AgentStatus, number>>;
	#getChildrenByParent: () => ReadonlyMap<string, readonly AgentRef[]>;
	#getNotice: () => string | undefined;
	#isLoadingPersistedSubagents: () => boolean;
	#isNarrowDetailsOpen: () => boolean;
	#getDetailScrollOffset: () => number;
	#setDetailScrollOffset: (offset: number) => void;

	constructor(deps: RosterViewDeps) {
		this.#registry = deps.registry;
		this.#ircUnreadCount = deps.ircUnreadCount;
		this.#settings = deps.settings;
		this.#activity = deps.activity;
		this.#getRows = deps.getRows;
		this.#getSelectedRow = deps.getSelectedRow;
		this.#getHoveredRow = deps.getHoveredRow;
		this.#getViewMode = deps.getViewMode;
		this.#getTreeDepthById = deps.getTreeDepthById;
		this.#getTreeParentById = deps.getTreeParentById;
		this.#getTreeLastSiblingById = deps.getTreeLastSiblingById;
		this.#getObserved = deps.getObserved;
		this.#getMetrics = deps.getMetrics;
		this.#getAggregate = deps.getAggregate;
		this.#getStatusCounts = deps.getStatusCounts;
		this.#getChildrenByParent = deps.getChildrenByParent;
		this.#getNotice = deps.getNotice;
		this.#isLoadingPersistedSubagents = deps.isLoadingPersistedSubagents;
		this.#isNarrowDetailsOpen = deps.isNarrowDetailsOpen;
		this.#getDetailScrollOffset = deps.getDetailScrollOffset;
		this.#setDetailScrollOffset = deps.setDetailScrollOffset;
	}

	render(width: number, termHeight: number): RosterViewFrame {
		const contentRows = Math.max(1, termHeight - 4);
		const rows = this.#getRows();
		const split = this.#splitRosterWidth(width);
		const selected = rows[this.#getSelectedRow()];
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];

		if (split !== undefined) {
			const detailWidth = splitBodyWidth(width, split);
			const roster = this.#renderRosterPanel(split, contentRows);
			const details = this.#renderDetailPanel(selected, detailWidth, contentRows);
			lines.push(topBorderSplit(width, "Agent Hub", split));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) hitRows[lines.length] = hit;
				lines.push(splitRow(roster.lines[i] ?? "", details[i] ?? "", width, split));
			}
			lines.push(dividerSplit(width, split));
			lines.push(row(this.#footer(false, Math.max(1, width - 4)), width));
			lines.push(bottomBorder(width));
			return { lines, hitRows, splitRosterWidth: split };
		}

		const innerWidth = Math.max(1, width - 4);
		if (this.#isNarrowDetailsOpen() && selected) {
			const details = this.#renderDetailPanel(selected, innerWidth, contentRows);
			lines.push(topBorder(width, `Agent Hub · ${selected.id}`));
			for (const detail of details) lines.push(row(detail, width));
		} else {
			const roster = this.#renderRosterPanel(innerWidth, contentRows);
			lines.push(topBorder(width, "Agent Hub"));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) hitRows[lines.length] = hit;
				lines.push(row(roster.lines[i] ?? "", width));
			}
		}
		lines.push(divider(width));
		lines.push(row(this.#footer(this.#isNarrowDetailsOpen(), innerWidth), width));
		lines.push(bottomBorder(width));
		return { lines, hitRows, splitRosterWidth: undefined };
	}

	#splitRosterWidth(width: number): number | undefined {
		if (width < SPLIT_MIN_WIDTH) return undefined;
		const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor(width * 0.58), width - DETAIL_MIN_WIDTH - 7));
		return splitBodyWidth(width, rosterWidth) >= DETAIL_MIN_WIDTH ? rosterWidth : undefined;
	}

	#footer(showingNarrowDetails: boolean, availableWidth: number): string {
		const nextView = this.#getViewMode() === "roster" ? "by parent" : "flat";
		if (showingNarrowDetails) {
			return theme.fg("dim", "1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  Esc:roster");
		}
		if (availableWidth < 96) return theme.fg("dim", `1:agents  2:activity  j/k:select  t:${nextView}  Tab:details  r/x:manage`);
		return theme.fg(
			"dim",
			`1:agents  2:activity  j/k/wheel:select  PgUp/PgDn:details  Enter/click:open  t:${nextView}  r:revive  x:kill  Esc:close`,
		);
	}

	#renderRosterPanel(width: number, rows: number): { lines: string[]; hitRows: Array<number | undefined> } {
		const lines = this.#summaryLines(width);
		const hitRows: Array<number | undefined> = Array.from({ length: lines.length });
		if (rows >= 8) {
			lines.push("");
			hitRows.push(undefined);
		}

		const notice = this.#getNotice();
		const noticeLines = notice ? [theme.fg("error", sanitizeLine(notice, Math.max(10, width)))] : [];
		const agents = this.#getRows();
		const budget = Math.max(0, rows - lines.length - noticeLines.length);
		if (agents.length === 0) {
			if (this.#isLoadingPersistedSubagents()) {
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
			const window = this.#renderRosterWindow(width, budget);
			lines.push(...window.lines);
			hitRows.push(...window.hitRows);
		}
		for (const noticeLine of noticeLines) {
			lines.push(noticeLine);
			hitRows.push(undefined);
		}
		while (lines.length < rows) {
			lines.push("");
			hitRows.push(undefined);
		}
		return { lines: lines.slice(0, rows), hitRows: hitRows.slice(0, rows) };
	}

	#renderRosterWindow(width: number, budget: number): { lines: string[]; hitRows: Array<number | undefined> } {
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];
		const rendered = new Map<number, string[]>();
		const rows = this.#getRows();
		const selectedRow = this.#getSelectedRow();
		const entryAt = (index: number): string[] => {
			const cached = rendered.get(index);
			if (cached) return cached;
			const entry = this.#renderEntry(
				rows[index]!,
				index === selectedRow,
				width,
				this.#getObserved(rows[index]!.id),
				index === this.#getHoveredRow(),
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

		let start = selectedRow;
		let end = selectedRow + 1;
		let used = entryAt(selectedRow).length;
		if (used > budget) {
			appendEntry(selectedRow, entryAt(selectedRow).slice(0, budget));
			return { lines, hitRows };
		}

		for (let grew = true; grew; ) {
			grew = false;
			if (end < rows.length) {
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
		for (
			let markerRows = Number(start > 0) + Number(end < rows.length);
			used + markerRows > budget && start < end;
			markerRows = Number(start > 0) + Number(end < rows.length)
		) {
			if (end - 1 > selectedRow) {
				end--;
				used -= entryAt(end).length;
			} else if (start < selectedRow) {
				used -= entryAt(start).length;
				start++;
			} else {
				break;
			}
		}
		const showTopOverflow = start > 0 && used < budget;
		const showBottomOverflow = end < rows.length && used + Number(showTopOverflow) < budget;
		if (showTopOverflow) {
			lines.push(theme.fg("dim", `… ${start} more`));
			hitRows.push(undefined);
		}
		for (let i = start; i < end; i++) appendEntry(i);
		if (showBottomOverflow) {
			lines.push(theme.fg("dim", `… ${rows.length - end} more`));
			hitRows.push(undefined);
		}
		return { lines, hitRows };
	}

	#summaryLines(width: number): string[] {
		const active = (label: string): string => theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)));
		const inactive = (label: string): string => theme.fg("muted", ` ${label} `);
		const viewMode = this.#getViewMode();
		const projection =
			viewMode === "roster"
				? `${active("Flat")}${theme.fg("dim", "/")}${inactive("By parent")}`
				: `${inactive("Flat")}${theme.fg("dim", "/")}${active("By parent")}`;
		const counts = this.#statusSummary();
		const agents = this.#getRows();
		const header = `${theme.bold("Roster")}${theme.fg("dim", theme.sep.dot)}${projection}${counts ? theme.fg("dim", theme.sep.dot) + counts : ""}`;
		const lines = wrapTextWithAnsi(header, Math.max(1, width));

		const metrics = this.#getAggregate();
		if (metrics.reportedAgents === 0) {
			lines.push(...wrapTextWithAnsi(theme.fg("dim", `Usage —${theme.sep.dot}0/${agents.length} measured`), Math.max(1, width)));
			return lines;
		}
		const activeTime = formatMetricDuration(metrics);
		const usage = [
			theme.fg("statusLineCost", formatCost(metrics.cost)),
			theme.fg("dim", activeTime ? `${activeTime} agent time` : "agent time —"),
			theme.fg("dim", `${formatNumber(metrics.requests)} req`),
			theme.fg("dim", `${formatNumber(metrics.tools)} tools`),
			theme.fg("dim", `${formatNumber(metrics.tokens)} tok`),
			theme.fg("dim", `${metrics.activeDurationAgents}/${metrics.reportedAgents} timed`),
			theme.fg("dim", `${metrics.reportedAgents}/${agents.length} measured`),
		].join(theme.fg("dim", theme.sep.dot));
		lines.push(...wrapTextWithAnsi(usage, Math.max(1, width)));
		return lines;
	}

	#statusSummary(): string {
		const counts = this.#getStatusCounts();
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = counts[status];
			if (count > 0) parts.push(`${statusGlyph(status)} ${statusText(status, `${count} ${status}`)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#renderDetailPanel(ref: AgentRef | undefined, width: number, rows: number): string[] {
		if (!ref) return [theme.fg("dim", "Select an agent to inspect"), ...Array.from({ length: rows - 1 }, () => "")];
		const observed = this.#getObserved(ref.id);
		const progress = observed?.progress;
		const metrics = this.#getMetrics(ref, observed);
		const children = this.#getChildrenByParent().get(ref.id) ?? [];
		const lines: string[] = [];
		const add = (line = ""): void => {
			lines.push(truncateToWidth(line, width));
		};
		const addWrapped = (text: string, maxRows = 2): void => {
			for (const wrapped of wrapTextWithAnsi(sanitizeLine(text), Math.max(1, width)).slice(0, maxRows)) add(wrapped);
		};
		const section = (label: string, contentRows = 0): void => {
			if (lines.length > 0 && lines.length + 1 + contentRows < rows) add();
			add(theme.bold(theme.fg("accent", label)));
		};

		add(`${statusGlyph(ref.status)} ${theme.bold(sanitizeDisplayText(ref.displayName || ref.id))}`);
		if (ref.displayName && ref.displayName !== ref.id) add(theme.fg("dim", sanitizeDisplayText(ref.id)));
		const lifecycle = [
			statusText(ref.status, ref.status),
			metrics ? formatMetricDuration(metrics) : undefined,
			`active ${formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))}`,
		].filter(Boolean);
		add(lifecycle.join(theme.fg("dim", theme.sep.dot)));
		const modelDetails: string[] = [];
		const modelRole = progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) modelDetails.push(formatRoleBadge(modelRole, this.#settings));
		const badge = modelBadge(ref, observed);
		if (badge) modelDetails.push(badge);
		if (modelDetails.length > 0) add(modelDetails.join(theme.sep.dot));

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
			if (progress?.retryState) add(theme.fg("warning", `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`));
		}

		section("Usage", 1);
		if (metrics) {
			addWrapped(formatMetrics(metrics), 3);
			if (metrics.contextTokens !== undefined && metrics.contextWindow) add(contextGauge(metrics.contextTokens, metrics.contextWindow));
		} else {
			add(theme.fg("dim", "usage —"));
		}

		section("Lineage");
		add(`Spawned by ${sanitizeDisplayText(ref.parentId ?? "Main")}${children.length > 0 ? ` · ${children.length} children` : ""}`);
		if (children.length > 0) add(theme.fg("dim", formatChildIds(children, width)));
		add(theme.fg("dim", `Registered ${new Date(ref.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z`));

		section("Changes");
		add(theme.fg("dim", ref.kind === "advisor" || ref.history?.readOnly ? "Read-only · 0 LoC" : "Shared workspace · per-agent LoC not attributable"));
		const artifacts = ref.history;
		if (artifacts?.outputPath) addWrapped(`Output ${shortenPath(artifacts.outputPath)}`);
		if (artifacts?.patchPath) addWrapped(`Patch ${shortenPath(artifacts.patchPath)}`);
		if (artifacts?.branchName) addWrapped(`Worktree branch ${artifacts.branchName}`);

		if (lines.length < rows) add();
		if (lines.length < rows) add(theme.bold(theme.fg("accent", "Recent activity")));
		const activityBudget = Math.max(0, rows - lines.length);
		const activity = this.#activity.recent(ref.id, activityBudget);
		if (activity.length === 0 && activityBudget > 0) add(theme.fg("muted", "No response or tool activity yet"));
		else {
			for (const event of activity) {
				const title = sanitizeLine(event.kind === "tool" ? (event.toolName ?? event.title) : event.title, width);
				const prefix = `${theme.fg("dim", activityClock(event.timestamp))} ${activityGlyph(event)} ${theme.fg("muted", title)} `;
				add(`${prefix}${sanitizeLine(event.summary, Math.max(1, width - visibleWidth(prefix)))}`);
			}
		}

		const maxScroll = Math.max(0, lines.length - rows);
		this.#setDetailScrollOffset(Math.min(this.#getDetailScrollOffset(), maxScroll));
		const visible = lines.slice(this.#getDetailScrollOffset(), this.#getDetailScrollOffset() + rows);
		while (visible.length < rows) visible.push("");
		return visible;
	}

	#renderEntry(ref: AgentRef, selected: boolean, width: number, observed: ObservableSession | undefined, hovered = false): string[] {
		const max = Math.max(1, width);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const viewMode = this.#getViewMode();
		const depth = viewMode === "tree" ? (this.#getTreeDepthById().get(ref.id) ?? 0) : 0;
		const branch =
			viewMode === "tree"
				? treeBranch(ref, max, this.#getTreeDepthById(), this.#getTreeParentById(), this.#getTreeLastSiblingById())
				: "";
		const id = sanitizeDisplayText(ref.id);
		const styledId = selected ? theme.bold(theme.fg("accent", id)) : theme.bold(id);
		const fields: string[] = [`${cursor} ${statusGlyph(ref.status)} ${branch}${styledId}`];
		if (ref.displayName && ref.displayName !== ref.id) fields.push(theme.fg("dim", sanitizeDisplayText(ref.displayName)));
		if (viewMode === "roster" && ref.parentId && ref.parentId !== "Main") fields.push(theme.fg("dim", `↳ ${sanitizeDisplayText(ref.parentId)}`));
		if (ref.kind === "advisor") fields.push(theme.fg("warning", "read-only"));
		const unread = this.#ircUnreadCount(ref.id);
		if (unread > 0) fields.push(theme.fg("warning", `⧉ ${unread}`));
		const left = fields.join("  ");

		const meta: string[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) meta.push(formatRoleBadge(modelRole, this.#settings));
		const badge = modelBadge(ref, observed);
		if (badge) meta.push(badge);
		meta.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		const right = meta.join(theme.sep.dot);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const entry: string[] = [];
		const detailIndent = Math.min(max - 1, 4 + depth * 2);
		if (leftWidth + 2 + rightWidth <= max) entry.push(left + padding(max - leftWidth - rightWidth) + right);
		else {
			entry.push(truncateToWidth(left.replace(/[\r\n]+/g, " "), max));
			entry.push(`${padding(Math.max(0, detailIndent))}${truncateToWidth(right, Math.max(1, max - detailIndent))}`);
		}

		const metrics = this.#getMetrics(ref, observed);
		const usage = metrics ? theme.fg("dim", formatMetrics(metrics)) : theme.fg("dim", "usage —");
		const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
		const detailWidth = Math.max(1, max - detailIndent);
		const details = task ? `${theme.fg("muted", sanitizeLine(task, detailWidth))}${theme.fg("dim", theme.sep.dot)}${usage}` : usage;
		for (const wrapped of wrapTextWithAnsi(details, detailWidth)) entry.push(`${padding(Math.max(0, detailIndent))}${wrapped}`);
		if (!hovered) return entry;
		return entry.map(lineRow => {
			const rowWidth = visibleWidth(lineRow);
			return theme.bg("selectedBg", rowWidth < max ? lineRow + padding(max - rowWidth) : lineRow);
		});
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
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}