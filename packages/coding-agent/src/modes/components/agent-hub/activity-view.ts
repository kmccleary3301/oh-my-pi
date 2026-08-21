import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	AgentActivityIndex,
	type AgentActivityKind,
	type AgentActivityRow,
} from "../../../activity";
import type { AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { ObservableSession } from "../../session-observer-registry";
import type { Settings } from "../../../config/settings";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { matchesSelectDown, matchesSelectUp } from "../../utils/keybinding-matchers";
import { theme } from "../../theme/theme";
import { formatRoleBadge, sanitizeLine } from "../agent-hub-renderer";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";

type ActivityFilter = "all" | "errors" | "responses" | "tools";
type ActivityScope = "all" | "agent" | "subtree";

export interface ActivityViewDeps {
	activity: AgentActivityIndex;
	registry: AgentRegistry;
	settings?: Settings;
	getRows: () => readonly AgentRef[];
	getSelectedAgentIndex: () => number;
	getSelectedActivityRow: () => number;
	setSelectedActivityRow: (index: number) => void;
	getChildrenByParent: () => ReadonlyMap<string, readonly AgentRef[]>;
	getObserved: (id: string) => ObservableSession | undefined;
	sectionTabs: () => string;
	onSwitchToAgents: () => void;
	onDone: () => void;
	openChat: (id: string, entryId?: string) => void;
	requestRender: () => void;
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

export class ActivityView {
	#activity: AgentActivityIndex;
	#registry: AgentRegistry;
	#settings: Settings | undefined;
	#getRows: () => readonly AgentRef[];
	#getSelectedAgentIndex: () => number;
	#getSelectedActivityRow: () => number;
	#setSelectedActivityRow: (index: number) => void;
	#getChildrenByParent: () => ReadonlyMap<string, readonly AgentRef[]>;
	#getObserved: (id: string) => ObservableSession | undefined;
	#sectionTabs: () => string;
	#onSwitchToAgents: () => void;
	#onDone: () => void;
	#openChat: (id: string, entryId?: string) => void;
	#requestRender: () => void;
	#rows: AgentActivityRow[] = [];
	#filter: ActivityFilter = "all";
	#scope: ActivityScope = "all";
	#search = "";
	#searchEditing = false;
	#follow = true;
	#hitRows: Array<number | undefined> = [];

	constructor(deps: ActivityViewDeps) {
		this.#activity = deps.activity;
		this.#registry = deps.registry;
		this.#settings = deps.settings;
		this.#getRows = deps.getRows;
		this.#getSelectedAgentIndex = deps.getSelectedAgentIndex;
		this.#getSelectedActivityRow = deps.getSelectedActivityRow;
		this.#setSelectedActivityRow = deps.setSelectedActivityRow;
		this.#getChildrenByParent = deps.getChildrenByParent;
		this.#getObserved = deps.getObserved;
		this.#sectionTabs = deps.sectionTabs;
		this.#onSwitchToAgents = deps.onSwitchToAgents;
		this.#onDone = deps.onDone;
		this.#openChat = deps.openChat;
		this.#requestRender = deps.requestRender;
	}

	get isSearchEditing(): boolean {
		return this.#searchEditing;
	}

	refreshRows(): void {
		const kinds: ReadonlySet<AgentActivityKind> | undefined =
			this.#filter === "responses" ? new Set(["response"]) : this.#filter === "tools" ? new Set(["tool"]) : undefined;
		let rows = this.#activity.query({
			agentIds: this.#activityAgentIds(),
			kinds,
			search: this.#search,
			limit: 2_000,
		});
		if (this.#filter === "errors") rows = rows.filter(row => row.status === "error");
		this.#rows = rows;
		const selected = this.#getSelectedActivityRow();
		if (rows.length === 0) this.#setSelectedActivityRow(0);
		else if (this.#follow) this.#setSelectedActivityRow(rows.length - 1);
		else this.#setSelectedActivityRow(Math.min(selected, rows.length - 1));
	}

	render(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const innerWidth = Math.max(1, width - 4);
		const contentRows = Math.max(1, termHeight - 4);
		const body: string[] = [this.#sectionTabs()];
		const rows = this.#getRows();
		const selectedAgent = rows[this.#getSelectedAgentIndex()]?.id;
		const scope =
			this.#scope === "all"
				? "all agents"
				: this.#scope === "agent"
					? (selectedAgent ?? "selected agent")
					: `${selectedAgent ?? "selected"} subtree`;
		const search = this.#searchEditing
			? theme.fg("accent", `search: ${this.#search}▌`)
			: this.#search
				? `search: ${this.#search}`
				: "search: —";
		body.push(
			theme.fg("dim", `${scope}${theme.sep.dot}${this.#filter}${theme.sep.dot}${this.#follow ? "following" : "paused"}${theme.sep.dot}${search}`),
		);
		if (contentRows >= 8) body.push("");

		const budget = Math.max(0, contentRows - body.length);
		if (this.#rows.length === 0 && budget > 0) {
			body.push(theme.fg("muted", this.#search ? "No matching activity" : "No agent activity recorded yet"));
		} else if (budget > 0) {
			const selected = Math.min(this.#getSelectedActivityRow(), this.#rows.length - 1);
			const start = this.#follow
				? Math.max(0, this.#rows.length - budget)
				: Math.max(0, Math.min(selected - Math.floor(budget / 2), this.#rows.length - budget));
			const end = Math.min(this.#rows.length, start + budget);
			if (start > 0) body.push(theme.fg("dim", `… ${start} earlier`));
			for (let index = start + Number(start > 0); index < end; index++) {
				this.#hitRows[1 + body.length] = index;
				body.push(this.#formatRow(this.#rows[index]!, index === selected, innerWidth));
			}
		}
		while (body.length < contentRows) body.push("");

		const lines = [topBorder(width, "Agent Hub")];
		for (const line of body.slice(0, contentRows)) lines.push(row(line, width));
		lines.push(divider(width));
		lines.push(
			row(
				theme.fg("dim", "1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close"),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(keyData: string): void {
		if (this.#searchEditing) {
			this.#handleSearchInput(keyData);
			return;
		}
		if (matchesKey(keyData, "escape")) {
			if (this.#search) {
				this.#search = "";
				this.refreshRows();
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#onSwitchToAgents();
			return;
		}
		if (keyData === "/") {
			this.#searchEditing = true;
			this.#requestRender();
			return;
		}
		if (keyData === " ") {
			this.#follow = !this.#follow;
			if (this.#follow && this.#rows.length > 0) this.#setSelectedActivityRow(this.#rows.length - 1);
			this.#requestRender();
			return;
		}
		if (keyData === "f") {
			const filters: ActivityFilter[] = ["all", "errors", "responses", "tools"];
			this.#filter = filters[(filters.indexOf(this.#filter) + 1) % filters.length]!;
			this.refreshRows();
			this.#requestRender();
			return;
		}
		if (keyData === "s") {
			const scopes: ActivityScope[] = ["all", "agent", "subtree"];
			this.#scope = scopes[(scopes.indexOf(this.#scope) + 1) % scopes.length]!;
			this.refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#follow = false;
				this.#setSelectedActivityRow(Math.min(this.#getSelectedActivityRow() + 1, this.#rows.length - 1));
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#follow = false;
				this.#setSelectedActivityRow(Math.max(this.#getSelectedActivityRow() - 1, 0));
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const activity = this.#rows[this.#getSelectedActivityRow()];
			if (activity) this.#openChat(activity.agentId, activity.entryId);
		}
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#rows.length > 0) {
			this.#follow = false;
			this.#setSelectedActivityRow(Math.max(0, Math.min(this.#getSelectedActivityRow() + delta, this.#rows.length - 1)));
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	clickItem(index: number): void {
		if (index === this.#getSelectedActivityRow()) {
			const activity = this.#rows[index];
			if (activity) this.#openChat(activity.agentId, activity.entryId);
			return;
		}
		this.#follow = false;
		this.#setSelectedActivityRow(index);
		this.#requestRender();
	}

	#handleSearchInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#searchEditing = false;
		} else if (matchesKey(keyData, "backspace")) {
			this.#search = this.#search.slice(0, -1);
		} else if (keyData.length === 1 && keyData >= " " && keyData !== "\u007f") {
			this.#search += keyData;
		} else {
			return;
		}
		this.refreshRows();
		this.#requestRender();
	}

	#activityAgentIds(): ReadonlySet<string> | undefined {
		if (this.#scope === "all") return undefined;
		const selected = this.#getRows()[this.#getSelectedAgentIndex()]?.id;
		if (!selected) return new Set();
		const ids = new Set([selected]);
		if (this.#scope === "agent") return ids;
		const queue = [selected];
		for (let index = 0; index < queue.length; index++) {
			for (const child of this.#getChildrenByParent().get(queue[index]!) ?? []) {
				if (ids.has(child.id)) continue;
				ids.add(child.id);
				queue.push(child.id);
			}
		}
		return ids;
	}

	#formatRow(activity: AgentActivityRow, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const ref = this.#registry.get(activity.agentId);
		const observed = this.#getObserved(activity.agentId);
		const role = observed?.progress?.modelRole ?? ref?.history?.modelRole;
		const roleBadge = role && this.#settings ? `${formatRoleBadge(role, this.#settings)} ` : "";
		const agent = sanitizeLine(activity.agentId, Math.max(8, Math.min(18, Math.floor(width * 0.18))));
		const title = sanitizeLine(activity.kind === "tool" ? (activity.toolName ?? activity.title) : activity.title, width);
		const prefix =
			`${cursor} ${theme.fg("dim", activityClock(activity.timestamp))} ${activityGlyph(activity)} ` +
			`${roleBadge}${theme.bold(agent)} ${theme.fg(activity.kind === "response" ? "success" : "muted", title)}`;
		const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(theme.sep.dot));
		return `${prefix}${theme.fg("dim", theme.sep.dot)}${sanitizeLine(activity.summary, available)}`;
	}
}