import type { ToolSession } from "../tools";

export interface RecursiveControlConfig {
	enabled: boolean;
	contextMaxItems: number;
	contextMaxChars: number;
	contextMaterializeMaxChars: number;
	maxHandles: number;
	wakeIntervalMs: number;
	maxTotalTokens: number | null;
	maxCostUsd: number | null;
	maxWallTimeMs: number | null;
	stateMaxBytes: number;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function optionalPositive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveRecursiveControlConfig(session: ToolSession): RecursiveControlConfig {
	return {
		enabled: session.settings.get("recursive.enabled") === true,
		contextMaxItems: positiveInteger(session.settings.get("recursive.context.maxItems"), 50),
		contextMaxChars: positiveInteger(session.settings.get("recursive.context.maxChars"), 8192),
		contextMaterializeMaxChars: positiveInteger(
			session.settings.get("recursive.context.materializeMaxChars"),
			262_144,
		),
		maxHandles: positiveInteger(session.settings.get("recursive.maxHandles"), 8),
		wakeIntervalMs: positiveInteger(session.settings.get("recursive.wakeIntervalMs"), 30_000),
		maxTotalTokens: optionalPositive(session.settings.get("recursive.maxTotalTokens")),
		maxCostUsd: optionalPositive(session.settings.get("recursive.maxCostUsd")),
		maxWallTimeMs: optionalPositive(session.settings.get("recursive.maxWallTimeMs")),
		stateMaxBytes: positiveInteger(session.settings.get("recursive.state.maxBytes"), 262_144),
	};
}
