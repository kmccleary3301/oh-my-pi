/**
 * Producer-neutral contracts for OMP's recursive control plane.
 *
 * Prime Agent inspired the context-as-data and retained-handle shapes, but all
 * identities, lifecycle state, persistence, permissions, and execution remain
 * owned by OMP.
 */

export const RECURSIVE_CONTROL_VERSION = 1 as const;

export type RecursiveJsonPrimitive = string | number | boolean | null;
export type RecursiveJsonValue = RecursiveJsonPrimitive | RecursiveJsonValue[] | { [key: string]: RecursiveJsonValue };

export type RecursiveContextScope = "conversation" | "agents" | "resources";

export interface RecursiveContextReference {
	version: typeof RECURSIVE_CONTROL_VERSION;
	ref: string;
	scope: RecursiveContextScope;
	fingerprint: string;
	immutable: boolean;
	label: string;
	preview?: string;
	metadata?: Record<string, RecursiveJsonValue>;
}

export interface RecursiveContextListRequest {
	scope?: RecursiveContextScope | RecursiveContextScope[];
	cursor?: number;
	limit?: number;
}

export interface RecursiveContextSearchRequest extends RecursiveContextListRequest {
	query: string;
}

export interface RecursiveContextReadRequest {
	ref: string;
	expectedFingerprint?: string;
	offset?: number;
	limit?: number;
}

export interface RecursiveContextMaterializeRequest {
	refs: string[];
	label?: string;
	maxChars?: number;
}

export interface RecursiveContextPage {
	version: typeof RECURSIVE_CONTROL_VERSION;
	items: RecursiveContextReference[];
	nextCursor?: number;
	truncated: boolean;
}

export interface RecursiveContextSlice {
	version: typeof RECURSIVE_CONTROL_VERSION;
	ref: string;
	fingerprint: string;
	content: string;
	contentType: "text/markdown" | "application/json" | "text/plain";
	offset: number;
	returnedChars: number;
	totalChars: number;
	truncated: boolean;
	nextOffset?: number;
	notes?: string[];
}

export interface RecursiveContextArtifact {
	version: typeof RECURSIVE_CONTROL_VERSION;
	uri: string;
	fingerprint: string;
	chars: number;
	refs: string[];
}

export type RetainedAgentDelivery = "steer-now" | "next-turn" | "when-idle" | "queue";
export type RetainedAgentWaitUntil = "idle" | "parked" | "terminal";

export interface RetainedAgentSpawnRequest {
	prompt: string;
	agent?: string;
	label?: string;
	schema?: unknown;
	schemaMode?: "permissive" | "strict";
}

export interface RetainedAgentSendRequest {
	handle: string;
	message: string;
	delivery?: RetainedAgentDelivery;
}

export interface RetainedAgentObserveRequest {
	handle: string;
	maxChars?: number;
}

export interface RetainedAgentWaitRequest {
	handle: string;
	until?: RetainedAgentWaitUntil;
	timeoutMs?: number;
}

export interface RetainedAgentHandle {
	version: typeof RECURSIVE_CONTROL_VERSION;
	handle: string;
	agentId: string;
	agent: string;
	status: "starting" | "running" | "idle" | "parked" | "aborted" | "released" | "failed";
	createdAt: string;
	updatedAt: string;
	outputRef?: string;
	text?: string;
	data?: unknown;
	model?: string | string[];
	error?: string;
}

export interface RetainedAgentObservation {
	version: typeof RECURSIVE_CONTROL_VERSION;
	handle: RetainedAgentHandle;
	transcript?: RecursiveContextSlice;
}

export interface RecursiveUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	requests: number;
	tools: number;
	durationMs: number;
}

export interface RecursiveUsageNode {
	agentId: string;
	status: string;
	own: RecursiveUsageTotals;
	descendants: RecursiveUsageTotals;
	total: RecursiveUsageTotals;
	children: RecursiveUsageNode[];
}

export interface RecursiveBudgetSnapshot {
	version: typeof RECURSIVE_CONTROL_VERSION;
	startedAt: string;
	elapsedMs: number;
	activeHandles: number;
	totalHandles: number;
	maxHandles: number;
	maxDepth: number;
	maxTotalTokens: number | null;
	maxCostUsd: number | null;
	maxWallTimeMs: number | null;
	usage: RecursiveUsageNode;
	violations: string[];
}

export type RecursiveStateScope = "session" | "project";

export interface RecursiveStateRecord {
	version: typeof RECURSIVE_CONTROL_VERSION;
	scope: RecursiveStateScope;
	key: string;
	value: RecursiveJsonValue;
	fingerprint: string;
	updatedAt: string;
}

export type ImprovementTarget = "memory" | "skill" | "agent-definition" | "rule" | "supplemental-policy";
export type ImprovementScope = "session" | "project" | "user";
export type ImprovementStatus =
	| "proposed"
	| "previewed"
	| "validating"
	| "rejected"
	| "applied-session"
	| "applied-project"
	| "observing"
	| "promoted"
	| "rolled-back";

export interface ImprovementEvidenceRef {
	uri: string;
	label?: string;
	fingerprint?: string;
}

export interface ImprovementValidationPlan {
	baselineRuns?: string[];
	candidateRuns?: string[];
	gates?: string[];
	holdouts?: string[];
}

export interface ImprovementProposalInput {
	target: ImprovementTarget;
	scope: ImprovementScope;
	baseUri: string;
	baseFingerprint: string;
	patch: RecursiveJsonValue;
	rationale: string;
	expectedEffect: string;
	evidence?: ImprovementEvidenceRef[];
	validationPlan?: ImprovementValidationPlan;
}

export interface ImprovementProposal extends ImprovementProposalInput {
	version: typeof RECURSIVE_CONTROL_VERSION;
	id: string;
	revision: number;
	status: ImprovementStatus;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	outcomeIds: string[];
}

export interface ImprovementOutcomeInput {
	proposalId: string;
	baselineRuns: string[];
	candidateRuns: string[];
	metrics: {
		successDelta?: number;
		costDeltaUsd?: number;
		wallTimeDeltaMs?: number;
		tokenDelta?: number;
		interventionDelta?: number;
	};
	regressions?: Array<{ metric: string; delta: number; note?: string }>;
	recommendation: "promote" | "reject" | "collect-more-data";
}

export interface ImprovementOutcome extends ImprovementOutcomeInput {
	version: typeof RECURSIVE_CONTROL_VERSION;
	id: string;
	createdAt: string;
}

export interface QualityGateDefinition {
	id: string;
	label: string;
	required: boolean;
	timeoutMs: number;
	input?: RecursiveJsonValue;
}

export interface QualityGateResult {
	version: typeof RECURSIVE_CONTROL_VERSION;
	gateId: string;
	status: "passed" | "failed" | "error" | "skipped";
	workspaceFingerprint: string;
	startedAt: string;
	completedAt: string;
	evidenceRefs: string[];
	message?: string;
}
