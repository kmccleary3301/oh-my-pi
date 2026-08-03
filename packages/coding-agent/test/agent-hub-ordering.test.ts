/**
 * Regression: the agent hub row order must be stable while the hub is open.
 *
 * The hub is sorted by lastActivity on first open, but after that keyboard
 * selection must not jump around as agents heartbeat or update activity. New
 * agents that appear while the hub is open are appended at the end.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type AgentHubDeps, AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry, overrides: Partial<AgentHubDeps> = {}) {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
		...overrides,
	});
}

interface RenderedAgentRow {
	id: string;
	selected: boolean;
}

function renderedAgentRows(hub: AgentHubOverlayComponent): RenderedAgentRow[] {
	// Entry first lines are ` <cursor> <status-glyph> <id> …`; task lines are
	// indented deeper and chrome lines never carry the cursor slot.
	const rows: RenderedAgentRow[] = [];
	for (const raw of hub.render(120)) {
		const match = /^ (❯| ) (\S+) (\S+)/u.exec(Bun.stripANSI(raw));
		if (match) rows.push({ id: match[3]!, selected: match[1] === "❯" });
	}
	return rows;
}

function renderedAgentIds(hub: AgentHubOverlayComponent): string[] {
	return renderedAgentRows(hub).map(row => row.id);
}

function selectedAgentId(hub: AgentHubOverlayComponent): string | undefined {
	return renderedAgentRows(hub).find(row => row.selected)?.id;
}

function leftClick(row1Based: number): string {
	return `\x1b[<0;4;${row1Based}M`;
}

function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};4;4M`;
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("freezes the initial lastActivity order while the hub is open", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			geometry = stubStdoutGeometry(120);
			const agents = new AgentRegistry();
			setSystemTime(1000);
			const sessionA = {} as AgentSession;
			agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

			setSystemTime(2000);
			const sessionB = {} as AgentSession;
			agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

			setSystemTime(3000);
			const sessionC = {} as AgentSession;
			agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

			hub = makeHub(agents);
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);

			// Bump A's lastActivity far ahead of the others. The hub is already open,
			// so the captured order must not change.
			setSystemTime(4000);
			agents.setActivity("A", "still running");

			// Registering a new agent schedules a coalesced row refresh; the
			// existing rows must stay put once the scheduled refresh runs.
			setSystemTime(5000);
			const sessionD = {} as AgentSession;
			agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);
			vi.advanceTimersByTime(100);
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A", "D"]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("truncates lines and sanitizes newlines to prevent terminal wrapping", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "Agent runtime + compaction reviewer",
			kind: "sub",
			session: sessionA,
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "RevAgentStream",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				description: "Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
				lastUpdate: Date.now(),
			},
		]);

		const hub = makeHub(agents, { observers });

		const lines = hub.render(80);
		for (const line of lines) {
			const cleanLine = Bun.stripANSI(line);
			expect(cleanLine.includes("\n")).toBe(false);
			expect(cleanLine.includes("\r")).toBe(false);
			const width = visibleWidth(line);
			expect(width).toBeLessThanOrEqual(78);
		}

		hub.dispose();
	});
	it("fits the fullscreen table to short terminals and windows large registries", () => {
		geometry = stubStdoutGeometry(80);
		geometry.setRows(10);
		const agents = new AgentRegistry();
		for (let i = 0; i < 50; i++) {
			agents.register({
				id: `Agent${i}`,
				displayName: `Agent ${i}`,
				kind: "sub",
				session: {} as AgentSession,
			});
		}

		const observers = new SessionObserverRegistry();
		const sessions = vi.spyOn(observers, "getSessions").mockReturnValue([]);
		const hub = makeHub(agents, { observers });

		try {
			const lines = hub.render(80);
			expect(lines.length).toBe(10);
			expect(sessions.mock.calls.length).toBeLessThan(agents.list().length);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("…");
		} finally {
			hub.dispose();
		}
	});
	it("matches fullscreen menu mouse selection, wheel, and activation", async () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000);
		agents.register({ id: "Alpha", displayName: "Alpha", kind: "sub", session: {} as AgentSession });
		setSystemTime(2_000);
		agents.register({ id: "Beta", displayName: "Beta", kind: "sub", session: {} as AgentSession });
		setSystemTime(3_000);
		agents.register({ id: "Gamma", displayName: "Gamma", kind: "sub", session: {} as AgentSession });

		const focused: string[] = [];
		const done = vi.fn();
		const hub = makeHub(agents, {
			onDone: done,
			focusAgent: async id => {
				focused.push(id);
			},
		});

		try {
			expect(selectedAgentId(hub)).toBe("Gamma");
			hub.handleInput(wheel("down"));
			expect(selectedAgentId(hub)).toBe("Beta");

			const frame = hub.render(120);
			const alphaRow = frame.findIndex(line => /^ {3}\S+ Alpha/u.test(Bun.stripANSI(line)));
			expect(alphaRow).toBeGreaterThanOrEqual(0);
			hub.handleInput(leftClick(alphaRow + 1));
			expect(selectedAgentId(hub)).toBe("Alpha");
			expect(focused).toEqual([]);

			const selectedFrame = hub.render(120);
			const selectedAlphaRow = selectedFrame.findIndex(line => /^ ❯ \S+ Alpha/u.test(Bun.stripANSI(line)));
			hub.handleInput(leftClick(selectedAlphaRow + 1));
			await Promise.resolve();
			expect(focused).toEqual(["Alpha"]);
			expect(done).toHaveBeenCalledTimes(1);
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for observer-only rows with no live session", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// A collab guest / observer-only row carries no live AgentSession, so the
		// badge must come from the executor-reported progress instead.
		agents.register({ id: "GuestAgent", displayName: "Guest Agent", kind: "sub", session: null });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "GuestAgent",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					resolvedModel: "openai/gpt-4o",
					resolvedModelIsFallback: true,
				} as never,
			},
		]);

		const hub = makeHub(agents, { observers });

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → openai/gpt-4o");
		} finally {
			hub.dispose();
		}
	});

	it("flags a fallback badge for a live row whose fallback armed no session retry state", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// Live session with a resolved model but no `retryFallbackModel` — the
		// Fireworks Fast → base degrade emits `retry_fallback_applied` without
		// arming `#activeRetryFallback`, so the badge must fall back to the
		// executor-reported progress flag.
		const session = { model: { id: "kimi-k2" }, retryFallbackModel: undefined } as unknown as AgentSession;
		agents.register({ id: "FastAgent", displayName: "Fast Agent", kind: "sub", session });

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "FastAgent",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				lastUpdate: Date.now(),
				progress: {
					resolvedModel: "fireworks/kimi-k2",
					resolvedModelIsFallback: true,
				} as never,
			},
		]);

		const hub = makeHub(agents, { observers });

		try {
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("fallback → fireworks/kimi-k2");
		} finally {
			hub.dispose();
		}
	});
});
