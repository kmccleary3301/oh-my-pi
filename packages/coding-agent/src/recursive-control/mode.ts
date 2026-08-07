/**
 * Recursive work modes.
 *
 * `hybrid` keeps the ordinary OMP tool slate and adds `omp.*`. `strict` narrows the
 * root slate to an eval-centric set so the model must drive work through the control
 * plane; it is an experiment, not a recommended default.
 */

export type RecursiveMode = "hybrid" | "strict";

export const DEFAULT_RECURSIVE_MODE: RecursiveMode = "hybrid";

/** Minimum root slate for strict mode. `eval` is the control-plane entry point. */
export const DEFAULT_STRICT_ROOT_TOOLS: readonly string[] = ["eval"];

export interface RecursiveModeResolution {
	/** Mode actually in force. */
	mode: RecursiveMode;
	/** Mode the settings asked for. */
	requested: RecursiveMode;
	/** Present only when strict was requested but not granted. */
	downgradeReason?: string;
}

export interface RecursiveModeInput {
	requested: unknown;
	enabled: boolean;
	modelId?: string;
	/** `recursive.strictModels`: model ids benchmarked as capable of an eval-only slate. */
	allowlist: unknown;
	/** `recursive.strictAllowAnyModel`: explicit escape hatch for experiments. */
	allowAnyModel: boolean;
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map(e => e.trim());
}

/**
 * Decide the effective mode.
 *
 * Strict mode silently degrades to hybrid rather than failing the session: an
 * unusable root slate would strand the user with no way to recover. The reason is
 * returned so callers can surface it.
 */
export function resolveRecursiveMode(input: RecursiveModeInput): RecursiveModeResolution {
	const requested: RecursiveMode = input.requested === "strict" ? "strict" : DEFAULT_RECURSIVE_MODE;
	if (requested !== "strict") return { mode: "hybrid", requested };
	if (!input.enabled) {
		return {
			mode: "hybrid",
			requested,
			downgradeReason: "recursive control is disabled; enable recursive.enabled to use strict mode",
		};
	}
	if (input.allowAnyModel) return { mode: "strict", requested };
	const allowlist = normalizeStringList(input.allowlist);
	if (allowlist.length === 0) {
		return {
			mode: "hybrid",
			requested,
			downgradeReason:
				"recursive.strictModels is empty. Strict mode ships without a capability list because no model has been benchmarked on an eval-only slate; add the model id or set recursive.strictAllowAnyModel.",
		};
	}
	const modelId = input.modelId?.trim();
	if (!modelId) {
		return { mode: "hybrid", requested, downgradeReason: "no active model to check against recursive.strictModels" };
	}
	if (!allowlist.includes(modelId)) {
		return {
			mode: "hybrid",
			requested,
			downgradeReason: `${modelId} is not listed in recursive.strictModels; add it or set recursive.strictAllowAnyModel`,
		};
	}
	return { mode: "strict", requested };
}

/**
 * Root tool slate for strict mode. `eval` is always present: without it the model
 * cannot reach `omp.*` and the session would have no way to act.
 */
export function resolveStrictRootTools(value: unknown): string[] {
	const configured = normalizeStringList(value);
	const slate = configured.length > 0 ? configured : [...DEFAULT_STRICT_ROOT_TOOLS];
	return slate.includes("eval") ? slate : ["eval", ...slate];
}

/** Session surface needed to swap the root tool slate. */
export interface RecursiveModeSession {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): Promise<void>;
}

/**
 * Slate captured when a session entered strict mode, so leaving restores exactly
 * what the user had rather than a recomputed default. Keyed weakly by session and
 * dropped with it; the recursive runtime uses the same pattern.
 */
const preStrictSlate = new WeakMap<RecursiveModeSession, string[]>();

/**
 * Apply `mode` to the session's root tool slate.
 *
 * Entering strict records the current slate once; re-entering is idempotent and
 * must not overwrite the original capture. Leaving strict without a capture is a
 * no-op rather than a guess.
 */
export async function applyRecursiveMode(
	session: RecursiveModeSession,
	mode: RecursiveMode,
	strictToolsSetting: unknown,
): Promise<{ changed: boolean; slate: string[] }> {
	if (mode === "strict") {
		const slate = resolveStrictRootTools(strictToolsSetting);
		if (!preStrictSlate.has(session)) preStrictSlate.set(session, session.getActiveToolNames());
		await session.setActiveToolsByName(slate);
		return { changed: true, slate };
	}
	const restored = preStrictSlate.get(session);
	if (!restored) return { changed: false, slate: session.getActiveToolNames() };
	preStrictSlate.delete(session);
	await session.setActiveToolsByName(restored);
	return { changed: true, slate: restored };
}
