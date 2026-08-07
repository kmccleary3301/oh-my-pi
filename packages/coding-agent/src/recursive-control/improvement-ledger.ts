import * as path from "node:path";
import type { ToolSession } from "../tools";
import { normalizeRecursiveJson, recursiveId } from "./canonical";
import type {
	ImprovementOutcome,
	ImprovementOutcomeInput,
	ImprovementPreview,
	ImprovementPromotion,
	ImprovementPromotionInput,
	ImprovementProposal,
	ImprovementProposalInput,
	ImprovementScope,
	ImprovementStatus,
	ImprovementTarget,
	ImprovementValidationPlan,
} from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";
import { readPrivateJson, recursiveControlProjectDir, withSerializedPath, writePrivateJson } from "./storage";

interface ImprovementFile {
	version: typeof RECURSIVE_CONTROL_VERSION;
	proposals: Record<string, ImprovementProposal>;
	outcomes: Record<string, ImprovementOutcome>;
}

const EMPTY_FILE: ImprovementFile = { version: RECURSIVE_CONTROL_VERSION, proposals: {}, outcomes: {} };
const MAX_TEXT_CHARS = 32_768;
const MAX_EVIDENCE_REFS = 128;
const MAX_VALIDATION_ITEMS = 256;

const TARGETS = new Set<ImprovementTarget>(["memory", "skill", "agent-definition", "rule", "supplemental-policy"]);
const SCOPES = new Set<ImprovementScope>(["session", "project", "user"]);
const OUTCOME_STATUSES = new Set<ImprovementStatus>(["validating", "applied-session", "applied-project", "observing"]);

const TRANSITIONS: Readonly<Record<ImprovementStatus, readonly ImprovementStatus[]>> = {
	proposed: ["previewed", "validating", "rejected"],
	previewed: ["validating", "rejected", "applied-session"],
	validating: ["rejected", "applied-session", "applied-project"],
	rejected: [],
	"applied-session": ["observing", "promoted", "rolled-back", "rejected"],
	"applied-project": ["observing", "promoted", "rolled-back", "rejected"],
	observing: ["promoted", "rolled-back", "rejected"],
	promoted: ["rolled-back"],
	"rolled-back": [],
};

function requiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be empty`);
	if (trimmed.length > MAX_TEXT_CHARS) throw new Error(`${label} exceeds ${MAX_TEXT_CHARS} characters`);
	return trimmed;
}

function finite(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
}

function requiredFinite(value: number | undefined, label: string): number {
	const normalized = finite(value, label);
	if (normalized === undefined) throw new Error(`${label} is required`);
	return normalized;
}

function normalizedStringList(value: readonly string[] | undefined, label: string): string[] {
	const result = [...new Set((value ?? []).map((item, index) => requiredText(item, `${label}[${index}]`)))];
	if (result.length > MAX_VALIDATION_ITEMS) {
		throw new Error(`${label} exceeds ${MAX_VALIDATION_ITEMS} items`);
	}
	return result;
}

function normalizedValidationPlan(plan: ImprovementValidationPlan | undefined): ImprovementValidationPlan {
	return {
		baselineRuns: normalizedStringList(plan?.baselineRuns, "validationPlan.baselineRuns"),
		candidateRuns: normalizedStringList(plan?.candidateRuns, "validationPlan.candidateRuns"),
		gates: normalizedStringList(plan?.gates, "validationPlan.gates"),
		holdouts: normalizedStringList(plan?.holdouts, "validationPlan.holdouts"),
	};
}

function hasPromoteOutcome(file: ImprovementFile, proposal: ImprovementProposal): boolean {
	return proposal.outcomeIds.some(id => file.outcomes[id]?.recommendation === "promote");
}

export interface ImprovementLedgerOptions {
	rootDir?: string;
	actorId?: string;
}

/**
 * Auditable proposal and outcome ledger. It intentionally cannot mutate OMP's
 * canonical prompt, memory, skill, rule, or agent-definition stores.
 */
export class ImprovementLedger {
	readonly #filePath: string;
	readonly #actorId: string;

	constructor(session: ToolSession, options: ImprovementLedgerOptions = {}) {
		this.#filePath = path.join(recursiveControlProjectDir(session.cwd, options.rootDir), "improvements.json");
		this.#actorId = options.actorId ?? session.getAgentId?.() ?? "Main";
	}

	async #load(): Promise<ImprovementFile> {
		const loaded = await readPrivateJson<ImprovementFile>(this.#filePath, EMPTY_FILE);
		if (
			loaded.version !== RECURSIVE_CONTROL_VERSION ||
			!loaded.proposals ||
			typeof loaded.proposals !== "object" ||
			!loaded.outcomes ||
			typeof loaded.outcomes !== "object"
		) {
			throw new Error("Unsupported or corrupt recursive improvement ledger");
		}
		return {
			version: RECURSIVE_CONTROL_VERSION,
			proposals: { ...loaded.proposals },
			outcomes: { ...loaded.outcomes },
		};
	}

	async list(status?: ImprovementStatus): Promise<ImprovementProposal[]> {
		const proposals = Object.values((await this.#load()).proposals);
		return proposals
			.filter(proposal => status === undefined || proposal.status === status)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async get(id: string): Promise<ImprovementProposal | null> {
		return (await this.#load()).proposals[id] ?? null;
	}

	async outcomes(proposalId: string): Promise<ImprovementOutcome[]> {
		return Object.values((await this.#load()).outcomes)
			.filter(outcome => outcome.proposalId === proposalId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async propose(input: ImprovementProposalInput): Promise<ImprovementProposal> {
		if (!TARGETS.has(input.target)) throw new Error(`Invalid improvement target: ${String(input.target)}`);
		if (!SCOPES.has(input.scope)) throw new Error(`Invalid improvement scope: ${String(input.scope)}`);
		if ((input.evidence?.length ?? 0) > MAX_EVIDENCE_REFS) {
			throw new Error(`evidence exceeds ${MAX_EVIDENCE_REFS} references`);
		}
		const now = new Date().toISOString();
		const normalized: ImprovementProposalInput = {
			...input,
			baseUri: requiredText(input.baseUri, "baseUri"),
			baseFingerprint: requiredText(input.baseFingerprint, "baseFingerprint"),
			patch: normalizeRecursiveJson(input.patch),
			rationale: requiredText(input.rationale, "rationale"),
			expectedEffect: requiredText(input.expectedEffect, "expectedEffect"),
			evidence: (input.evidence ?? []).map(item => ({
				uri: requiredText(item.uri, "evidence.uri"),
				...(item.label?.trim() ? { label: item.label.trim() } : {}),
				...(item.fingerprint?.trim() ? { fingerprint: item.fingerprint.trim() } : {}),
			})),
			validationPlan: normalizedValidationPlan(input.validationPlan),
		};
		const proposal: ImprovementProposal = {
			version: RECURSIVE_CONTROL_VERSION,
			id: recursiveId("impr", { ...normalized, createdAt: now, actor: this.#actorId, nonce: crypto.randomUUID() }),
			revision: 1,
			status: "proposed",
			createdAt: now,
			updatedAt: now,
			createdBy: this.#actorId,
			outcomeIds: [],
			...normalized,
		};
		return await withSerializedPath(this.#filePath, async () => {
			const file = await this.#load();
			file.proposals[proposal.id] = proposal;
			await writePrivateJson(this.#filePath, file);
			return proposal;
		});
	}

	/**
	 * Non-mutating read of what promoting this proposal would take.
	 *
	 * `currentBaseFingerprint` is supplied by the caller because the ledger cannot
	 * resolve arbitrary `baseUri` schemes; omitting it leaves staleness unknown, which
	 * is reported as a blocker rather than assumed fresh.
	 */
	async preview(id: string, currentBaseFingerprint?: string): Promise<ImprovementPreview> {
		const file = await this.#load();
		const proposal = file.proposals[id];
		if (!proposal) throw new Error(`Unknown improvement proposal: ${id}`);
		const outcomes = proposal.outcomeIds.flatMap(outcomeId => {
			const outcome = file.outcomes[outcomeId];
			return outcome ? [outcome] : [];
		});
		const observed = currentBaseFingerprint?.trim();
		const stale = observed !== undefined && observed !== proposal.baseFingerprint;
		const blockers: string[] = [];
		if (stale) blockers.push(`base ${proposal.baseUri} changed since the proposal was written`);
		if (observed === undefined) blockers.push("base freshness unverified: no current fingerprint supplied");
		if (!hasPromoteOutcome(file, proposal)) blockers.push("no recorded outcome recommends promote");
		if (!proposal.promotion) blockers.push("no independent reviewer or rollback artifact recorded");
		return { proposal, outcomes, stale, blockers };
	}

	async transition(
		id: string,
		status: ImprovementStatus,
		expectedRevision: number,
		promotion?: ImprovementPromotionInput,
	): Promise<ImprovementProposal> {
		return await withSerializedPath(this.#filePath, async () => {
			const file = await this.#load();
			const current = file.proposals[id];
			if (!current) throw new Error(`Unknown improvement proposal: ${id}`);
			if (current.revision !== expectedRevision) {
				throw new Error(
					`Improvement proposal conflict for ${id}: expected revision ${expectedRevision}, current ${current.revision}`,
				);
			}
			if (!TRANSITIONS[current.status].includes(status)) {
				throw new Error(`Invalid improvement transition ${current.status} -> ${status}`);
			}
			const now = new Date().toISOString();
			let recorded: ImprovementPromotion | undefined = current.promotion;
			if (status === "applied-project" || status === "promoted") {
				if (!hasPromoteOutcome(file, current)) {
					throw new Error(`Improvement transition to ${status} requires a recorded promote outcome`);
				}
				// Measured promotion is scoped: a session-scoped proposal has not been
				// evaluated against the project and must not silently widen.
				if (status === "applied-project" && current.scope === "session") {
					throw new Error("Improvement transition to applied-project requires project or user scope");
				}
				const supplied = promotion ?? current.promotion;
				if (!supplied) {
					throw new Error(`Improvement transition to ${status} requires a reviewer and a rollback artifact`);
				}
				const reviewer = requiredText(supplied.reviewer, "promotion.reviewer");
				// Self-promotion turns the ledger into a rubber stamp.
				if (reviewer === current.createdBy) {
					throw new Error(
						`Improvement promotion reviewer must differ from the proposal author ${current.createdBy}`,
					);
				}
				recorded = {
					reviewer,
					rollback: {
						uri: requiredText(supplied.rollback?.uri, "promotion.rollback.uri"),
						fingerprint: requiredText(supplied.rollback?.fingerprint, "promotion.rollback.fingerprint"),
					},
					...(supplied.note?.trim() ? { note: supplied.note.trim() } : {}),
					at: current.promotion?.at ?? now,
				};
			}
			const updated: ImprovementProposal = {
				...current,
				status,
				revision: current.revision + 1,
				updatedAt: now,
				...(recorded ? { promotion: recorded } : {}),
			};
			file.proposals[id] = updated;
			await writePrivateJson(this.#filePath, file);
			return updated;
		});
	}

	async recordOutcome(input: ImprovementOutcomeInput, expectedRevision: number): Promise<ImprovementOutcome> {
		return await withSerializedPath(this.#filePath, async () => {
			const file = await this.#load();
			const proposal = file.proposals[input.proposalId];
			if (!proposal) throw new Error(`Unknown improvement proposal: ${input.proposalId}`);
			if (proposal.revision !== expectedRevision) {
				throw new Error(
					`Improvement proposal conflict for ${proposal.id}: expected revision ${expectedRevision}, current ${proposal.revision}`,
				);
			}
			if (!OUTCOME_STATUSES.has(proposal.status)) {
				throw new Error(`Improvement outcomes cannot be recorded while proposal status is ${proposal.status}`);
			}
			const baselineRuns = normalizedStringList(input.baselineRuns, "baselineRuns");
			const candidateRuns = normalizedStringList(input.candidateRuns, "candidateRuns");
			if (baselineRuns.length === 0 || candidateRuns.length === 0) {
				throw new Error("Improvement outcomes require at least one baseline and candidate run");
			}
			if (
				input.recommendation !== "promote" &&
				input.recommendation !== "reject" &&
				input.recommendation !== "collect-more-data"
			) {
				throw new Error(`Invalid improvement outcome recommendation: ${String(input.recommendation)}`);
			}
			const regressions = (input.regressions ?? []).map((regression, index) => ({
				metric: requiredText(regression.metric, `regressions[${index}].metric`),
				delta: requiredFinite(regression.delta, `regressions[${index}].delta`),
				...(regression.note?.trim() ? { note: requiredText(regression.note, `regressions[${index}].note`) } : {}),
			}));
			if (regressions.length > MAX_VALIDATION_ITEMS) {
				throw new Error(`regressions exceeds ${MAX_VALIDATION_ITEMS} items`);
			}
			const successDelta = finite(input.metrics.successDelta, "metrics.successDelta");
			const costDeltaUsd = finite(input.metrics.costDeltaUsd, "metrics.costDeltaUsd");
			const wallTimeDeltaMs = finite(input.metrics.wallTimeDeltaMs, "metrics.wallTimeDeltaMs");
			const tokenDelta = finite(input.metrics.tokenDelta, "metrics.tokenDelta");
			const interventionDelta = finite(input.metrics.interventionDelta, "metrics.interventionDelta");
			const createdAt = new Date().toISOString();
			const outcome: ImprovementOutcome = {
				proposalId: proposal.id,
				baselineRuns,
				candidateRuns,
				metrics: {
					...(successDelta !== undefined ? { successDelta } : {}),
					...(costDeltaUsd !== undefined ? { costDeltaUsd } : {}),
					...(wallTimeDeltaMs !== undefined ? { wallTimeDeltaMs } : {}),
					...(tokenDelta !== undefined ? { tokenDelta } : {}),
					...(interventionDelta !== undefined ? { interventionDelta } : {}),
				},
				recommendation: input.recommendation,
				version: RECURSIVE_CONTROL_VERSION,
				id: recursiveId("impro", { ...input, createdAt, nonce: crypto.randomUUID() }),
				createdAt,
				regressions,
			};
			file.outcomes[outcome.id] = outcome;
			file.proposals[proposal.id] = {
				...proposal,
				outcomeIds: [...proposal.outcomeIds, outcome.id],
				revision: proposal.revision + 1,
				updatedAt: createdAt,
			};
			await writePrivateJson(this.#filePath, file);
			return outcome;
		});
	}
}
