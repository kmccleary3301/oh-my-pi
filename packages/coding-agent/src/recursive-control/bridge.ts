import type { ToolSession } from "../tools";
import { normalizeRecursiveJson } from "./canonical";
import type {
	ImprovementOutcomeInput,
	ImprovementPromotionInput,
	ImprovementProposalInput,
	ImprovementStatus,
	RecursiveContextListRequest,
	RecursiveContextMaterializeRequest,
	RecursiveContextReadRequest,
	RecursiveContextSearchRequest,
	RecursiveJsonValue,
	RecursiveStateScope,
	RetainedAgentDelivery,
	RetainedAgentObserveRequest,
	RetainedAgentSendRequest,
	RetainedAgentSpawnRequest,
	RetainedAgentWaitRequest,
	RetainedAgentWaitUntil,
} from "./contracts";
import { RECURSIVE_CONTROL_VERSION } from "./contracts";
import type { ResidentSessionRegisterInput, ResidentSessionSchedule } from "./resident-sessions";
import { getRecursiveControlRuntime } from "./runtime";
import type { ShadowEvaluationInput, ShadowSample } from "./shadow-evaluation";
import { evaluateShadowRuns } from "./shadow-evaluation";

export const EVAL_RECURSIVE_BRIDGE_NAME = "__recursive__";

export interface RecursiveBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	invokeTool(name: string, args: unknown): Promise<unknown>;
}

interface RecursiveBridgeRequest {
	method: string;
	params: Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function parseRequest(value: unknown): RecursiveBridgeRequest {
	const record = asRecord(value, "recursive bridge request");
	const method = requiredString(record.method, "method");
	const params = record.params === undefined ? {} : asRecord(record.params, "params");
	return { method, params };
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
	const normalized = optionalNumber(value, label);
	if (normalized === undefined || !Number.isInteger(normalized) || normalized < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return normalized;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
	return value === undefined ? undefined : stringArray(value, label);
}

function improvementEvidence(value: unknown): ImprovementProposalInput["evidence"] {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("evidence must be an array");
	return value.map((item, index) => {
		if (typeof item === "string") return { uri: requiredString(item, `evidence[${index}]`) };
		const record = asRecord(item, `evidence[${index}]`);
		const label = optionalString(record.label, `evidence[${index}].label`)?.trim();
		const fingerprint = optionalString(record.fingerprint, `evidence[${index}].fingerprint`)?.trim();
		return {
			uri: requiredString(record.uri, `evidence[${index}].uri`),
			...(label ? { label } : {}),
			...(fingerprint ? { fingerprint } : {}),
		};
	});
}

function improvementValidationPlan(value: unknown): ImprovementProposalInput["validationPlan"] {
	if (value === undefined) return undefined;
	const record = asRecord(value, "validationPlan");
	const baselineRuns = optionalStringArray(record.baselineRuns, "validationPlan.baselineRuns");
	const candidateRuns = optionalStringArray(record.candidateRuns, "validationPlan.candidateRuns");
	const gates = optionalStringArray(record.gates, "validationPlan.gates");
	const holdouts = optionalStringArray(record.holdouts, "validationPlan.holdouts");
	return {
		...(baselineRuns ? { baselineRuns } : {}),
		...(candidateRuns ? { candidateRuns } : {}),
		...(gates ? { gates } : {}),
		...(holdouts ? { holdouts } : {}),
	};
}

function optionalScope(value: unknown): RecursiveStateScope | undefined {
	if (value === undefined) return undefined;
	if (value !== "session" && value !== "project") throw new Error("scope must be session or project");
	return value;
}

function requiredScope(value: unknown): RecursiveStateScope {
	return optionalScope(value) ?? "session";
}

function contextScope(value: unknown): RecursiveContextListRequest["scope"] {
	if (value === undefined) return undefined;
	const validate = (item: unknown): "conversation" | "agents" | "resources" => {
		if (item !== "conversation" && item !== "agents" && item !== "resources") {
			throw new Error("context scope must be conversation, agents, or resources");
		}
		return item;
	};
	return Array.isArray(value) ? value.map(validate) : validate(value);
}

function delivery(value: unknown): RetainedAgentDelivery | undefined {
	if (value === undefined) return undefined;
	if (value !== "steer-now" && value !== "next-turn" && value !== "when-idle" && value !== "queue") {
		throw new Error("delivery must be steer-now, next-turn, when-idle, or queue");
	}
	return value;
}

function waitUntil(value: unknown): RetainedAgentWaitUntil | undefined {
	if (value === undefined) return undefined;
	if (value !== "idle" && value !== "parked" && value !== "terminal") {
		throw new Error("until must be idle, parked, or terminal");
	}
	return value;
}

function improvementStatus(value: unknown): ImprovementStatus | undefined {
	if (value === undefined) return undefined;
	const statuses: readonly ImprovementStatus[] = [
		"proposed",
		"previewed",
		"validating",
		"rejected",
		"applied-session",
		"applied-project",
		"observing",
		"promoted",
		"rolled-back",
	];
	if (!statuses.includes(value as ImprovementStatus)) throw new Error("invalid improvement status");
	return value as ImprovementStatus;
}

function contextList(params: Record<string, unknown>): RecursiveContextListRequest {
	const scope = contextScope(params.scope);
	const cursor = optionalNumber(params.cursor, "cursor");
	const limit = optionalNumber(params.limit, "limit");
	return {
		...(scope !== undefined ? { scope } : {}),
		...(cursor !== undefined ? { cursor } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
}

function contextSearch(params: Record<string, unknown>): RecursiveContextSearchRequest {
	return { ...contextList(params), query: requiredString(params.query, "query") };
}

function contextRead(params: Record<string, unknown>): RecursiveContextReadRequest {
	const expectedFingerprint = optionalString(params.expectedFingerprint, "expectedFingerprint");
	const offset = optionalNumber(params.offset, "offset");
	const limit = optionalNumber(params.limit, "limit");
	return {
		ref: requiredString(params.ref, "ref"),
		...(expectedFingerprint !== undefined ? { expectedFingerprint } : {}),
		...(offset !== undefined ? { offset } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
}

function contextMaterialize(params: Record<string, unknown>): RecursiveContextMaterializeRequest {
	const label = optionalString(params.label, "label");
	const maxChars = optionalNumber(params.maxChars, "maxChars");
	return {
		refs: stringArray(params.refs, "refs"),
		...(label !== undefined ? { label } : {}),
		...(maxChars !== undefined ? { maxChars } : {}),
	};
}

function spawnRequest(params: Record<string, unknown>): RetainedAgentSpawnRequest {
	const schemaModeValue = optionalString(params.schemaMode, "schemaMode");
	const agent = optionalString(params.agent, "agent");
	const label = optionalString(params.label, "label");
	let schemaMode: "permissive" | "strict" | undefined;
	if (schemaModeValue === "permissive" || schemaModeValue === "strict") schemaMode = schemaModeValue;
	else if (schemaModeValue !== undefined) throw new Error("schemaMode must be permissive or strict");
	return {
		prompt: requiredString(params.prompt, "prompt"),
		...(agent !== undefined ? { agent } : {}),
		...(label !== undefined ? { label } : {}),
		...(Object.hasOwn(params, "schema") ? { schema: params.schema } : {}),
		...(schemaMode ? { schemaMode } : {}),
	};
}

function improvementProposal(params: Record<string, unknown>): ImprovementProposalInput {
	const target = requiredString(params.target, "target");
	if (
		target !== "memory" &&
		target !== "skill" &&
		target !== "agent-definition" &&
		target !== "rule" &&
		target !== "supplemental-policy"
	) {
		throw new Error("invalid improvement target");
	}
	const scope = requiredString(params.scope, "scope");
	if (scope !== "session" && scope !== "project" && scope !== "user") throw new Error("invalid improvement scope");
	const evidence = improvementEvidence(params.evidence);
	const validationPlan = improvementValidationPlan(params.validationPlan);
	return {
		target,
		scope,
		baseUri: requiredString(params.baseUri, "baseUri"),
		baseFingerprint: requiredString(params.baseFingerprint, "baseFingerprint"),
		patch: normalizeRecursiveJson(params.patch),
		rationale: requiredString(params.rationale, "rationale"),
		expectedEffect: requiredString(params.expectedEffect, "expectedEffect"),
		...(evidence ? { evidence } : {}),
		...(validationPlan ? { validationPlan } : {}),
	};
}

function improvementOutcome(params: Record<string, unknown>): ImprovementOutcomeInput {
	const metrics = asRecord(params.metrics, "metrics");
	const recommendation = requiredString(params.recommendation, "recommendation");
	if (recommendation !== "promote" && recommendation !== "reject" && recommendation !== "collect-more-data") {
		throw new Error("invalid improvement recommendation");
	}
	const regressions =
		params.regressions === undefined
			? undefined
			: (() => {
					if (!Array.isArray(params.regressions)) throw new Error("regressions must be an array");
					return params.regressions.map((item, index) => {
						const record = asRecord(item, `regressions[${index}]`);
						const delta = optionalNumber(record.delta, `regressions[${index}].delta`);
						const note = optionalString(record.note, `regressions[${index}].note`)?.trim();
						return {
							metric: requiredString(record.metric, `regressions[${index}].metric`),
							delta:
								delta ??
								(() => {
									throw new Error(`regressions[${index}].delta is required`);
								})(),
							...(note ? { note } : {}),
						};
					});
				})();
	const successDelta = optionalNumber(metrics.successDelta, "metrics.successDelta");
	const costDeltaUsd = optionalNumber(metrics.costDeltaUsd, "metrics.costDeltaUsd");
	const wallTimeDeltaMs = optionalNumber(metrics.wallTimeDeltaMs, "metrics.wallTimeDeltaMs");
	const tokenDelta = optionalNumber(metrics.tokenDelta, "metrics.tokenDelta");
	const interventionDelta = optionalNumber(metrics.interventionDelta, "metrics.interventionDelta");
	return {
		proposalId: requiredString(params.proposalId, "proposalId"),
		baselineRuns: stringArray(params.baselineRuns ?? [], "baselineRuns"),
		candidateRuns: stringArray(params.candidateRuns ?? [], "candidateRuns"),
		metrics: {
			...(successDelta !== undefined ? { successDelta } : {}),
			...(costDeltaUsd !== undefined ? { costDeltaUsd } : {}),
			...(wallTimeDeltaMs !== undefined ? { wallTimeDeltaMs } : {}),
			...(tokenDelta !== undefined ? { tokenDelta } : {}),
			...(interventionDelta !== undefined ? { interventionDelta } : {}),
		},
		...(regressions ? { regressions } : {}),
		recommendation,
	};
}

function shadowSamples(value: unknown, label: string): ShadowSample[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => {
		const record = asRecord(item, `${label}[${index}]`);
		if (typeof record.success !== "boolean") throw new Error(`${label}[${index}].success must be a boolean`);
		const costUsd = optionalNumber(record.costUsd, `${label}[${index}].costUsd`);
		const wallTimeMs = optionalNumber(record.wallTimeMs, `${label}[${index}].wallTimeMs`);
		const tokens = optionalNumber(record.tokens, `${label}[${index}].tokens`);
		const interventions = optionalNumber(record.interventions, `${label}[${index}].interventions`);
		return {
			runId: requiredString(record.runId, `${label}[${index}].runId`),
			success: record.success,
			...(costUsd !== undefined ? { costUsd } : {}),
			...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
			...(tokens !== undefined ? { tokens } : {}),
			...(interventions !== undefined ? { interventions } : {}),
		};
	});
}

function improvementShadowInput(params: Record<string, unknown>): ShadowEvaluationInput {
	const holdoutRunIds = optionalStringArray(params.holdoutRunIds, "holdoutRunIds");
	const minRunsPerArm = optionalNumber(params.minRunsPerArm, "minRunsPerArm");
	const regressionTolerance = optionalNumber(params.regressionTolerance, "regressionTolerance");
	return {
		baseline: shadowSamples(params.baseline ?? [], "baseline"),
		candidate: shadowSamples(params.candidate ?? [], "candidate"),
		...(holdoutRunIds ? { holdoutRunIds } : {}),
		...(minRunsPerArm !== undefined ? { minRunsPerArm } : {}),
		...(regressionTolerance !== undefined ? { regressionTolerance } : {}),
	};
}

function improvementPromotion(value: unknown): ImprovementPromotionInput | undefined {
	if (value === undefined || value === null) return undefined;
	const record = asRecord(value, "promotion");
	const rollback = asRecord(record.rollback, "promotion.rollback");
	const note = optionalString(record.note, "promotion.note")?.trim();
	return {
		reviewer: requiredString(record.reviewer, "promotion.reviewer"),
		rollback: {
			uri: requiredString(rollback.uri, "promotion.rollback.uri"),
			fingerprint: requiredString(rollback.fingerprint, "promotion.rollback.fingerprint"),
		},
		...(note ? { note } : {}),
	};
}

function residentSchedule(value: unknown): ResidentSessionSchedule | null {
	if (value === undefined || value === null) return null;
	const record = asRecord(value, "schedule");
	const everyMs = optionalNumber(record.everyMs, "schedule.everyMs");
	const prompt = optionalString(record.prompt, "schedule.prompt")?.trim();
	return {
		wakeAt: requiredString(record.wakeAt, "schedule.wakeAt"),
		...(everyMs !== undefined ? { everyMs } : {}),
		...(prompt ? { prompt } : {}),
	};
}

function residentRegister(params: Record<string, unknown>): ResidentSessionRegisterInput {
	const label = optionalString(params.label, "label")?.trim();
	const leaseMs = optionalNumber(params.leaseMs, "leaseMs");
	const schedule = residentSchedule(params.schedule);
	return {
		handle: requiredString(params.handle, "handle"),
		agentId: requiredString(params.agentId, "agentId"),
		sessionId: requiredString(params.sessionId, "sessionId"),
		...(label ? { label } : {}),
		...(leaseMs !== undefined ? { leaseMs } : {}),
		...(schedule ? { schedule } : {}),
	};
}

/** Dispatch one JSON-safe recursive-control request from an eval runtime. */
export async function runRecursiveBridge(value: unknown, options: RecursiveBridgeOptions): Promise<RecursiveJsonValue> {
	const { method, params } = parseRequest(value);
	const runtime = getRecursiveControlRuntime(options.session);
	runtime.assertActive();
	let result: unknown;
	switch (method) {
		case "capabilities":
			result = {
				version: RECURSIVE_CONTROL_VERSION,
				methods: [
					"context.list",
					"context.search",
					"context.read",
					"context.materialize",
					"tools.call",
					"agents.spawn",
					"agents.list",
					"agents.status",
					"agents.send",
					"agents.observe",
					"agents.wait",
					"agents.cancel",
					"agents.release",
					"state.get",
					"state.list",
					"state.put",
					"state.delete",
					"state.export",
					"budget.status",
					"improvements.propose",
					"improvements.list",
					"improvements.get",
					"improvements.outcomes",
					"improvements.preview",
					"improvements.evaluateShadow",
					"improvements.transition",
					"improvements.recordOutcome",
					"resident.list",
					"resident.get",
					"resident.register",
					"resident.attach",
					"resident.renew",
					"resident.detach",
					"resident.schedule",
					"resident.claimDue",
					"resident.tick",
					"resident.forget",
				],
			};
			break;
		case "context.list":
			result = await runtime.context.list(contextList(params), options.signal);
			break;
		case "context.search":
			result = await runtime.context.search(contextSearch(params), options.signal);
			break;
		case "context.read":
			result = await runtime.context.read(contextRead(params), options.signal);
			break;
		case "context.materialize":
			result = await runtime.context.materialize(contextMaterialize(params), options.signal);
			break;
		case "tools.call": {
			const name = requiredString(params.name, "name");
			if (name.startsWith("__") || name === "eval") {
				throw new Error(`recursive tools.call cannot invoke ${name}`);
			}
			result = await options.invokeTool(name, params.args ?? {});
			break;
		}
		case "agents.spawn":
			result = await runtime.agents.spawn(spawnRequest(params), options.signal);
			break;
		case "agents.list":
			result = runtime.agents.listHandles();
			break;
		case "agents.status":
			result = runtime.agents.status(requiredString(params.handle, "handle"));
			break;
		case "agents.send": {
			const requestedDelivery = delivery(params.delivery);
			const request: RetainedAgentSendRequest = {
				handle: requiredString(params.handle, "handle"),
				message: requiredString(params.message, "message"),
				...(requestedDelivery ? { delivery: requestedDelivery } : {}),
			};
			result = await runtime.agents.send(request, options.signal);
			break;
		}
		case "agents.observe": {
			const maxChars = optionalNumber(params.maxChars, "maxChars");
			const request: RetainedAgentObserveRequest = {
				handle: requiredString(params.handle, "handle"),
				...(maxChars !== undefined ? { maxChars } : {}),
			};
			result = await runtime.agents.observe(request, options.signal);
			break;
		}
		case "agents.wait": {
			const until = waitUntil(params.until);
			const timeoutMs = optionalNumber(params.timeoutMs, "timeoutMs");
			const request: RetainedAgentWaitRequest = {
				handle: requiredString(params.handle, "handle"),
				...(until ? { until } : {}),
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			};
			result = await runtime.agents.wait(request, options.signal);
			break;
		}
		case "agents.cancel":
			result = await runtime.agents.cancel(requiredString(params.handle, "handle"));
			break;
		case "agents.release":
			result = await runtime.agents.release(requiredString(params.handle, "handle"));
			break;
		case "state.get":
			result = await runtime.state.get(requiredScope(params.scope), requiredString(params.key, "key"));
			break;
		case "state.list":
			result = await runtime.state.list(requiredScope(params.scope));
			break;
		case "state.put": {
			const expectedFingerprint = optionalString(params.expectedFingerprint, "expectedFingerprint");
			result = await runtime.state.put(
				requiredScope(params.scope),
				requiredString(params.key, "key"),
				params.value,
				{
					...(expectedFingerprint !== undefined ? { expectedFingerprint } : {}),
				},
			);
			break;
		}
		case "state.delete": {
			const expectedFingerprint = optionalString(params.expectedFingerprint, "expectedFingerprint");
			result = await runtime.state.delete(requiredScope(params.scope), requiredString(params.key, "key"), {
				...(expectedFingerprint !== undefined ? { expectedFingerprint } : {}),
			});
			break;
		}
		case "state.export":
			result = await runtime.state.export(requiredScope(params.scope));
			break;
		case "budget.status":
			result = runtime.budget.snapshot();
			break;
		case "improvements.propose":
			result = await runtime.improvements.propose(improvementProposal(params));
			break;
		case "improvements.list":
			result = await runtime.improvements.list(improvementStatus(params.status));
			break;
		case "improvements.get":
			result = await runtime.improvements.get(requiredString(params.id, "id"));
			break;
		case "improvements.outcomes":
			result = await runtime.improvements.outcomes(requiredString(params.proposalId, "proposalId"));
			break;
		case "improvements.preview":
			result = await runtime.improvements.preview(
				requiredString(params.id, "id"),
				optionalString(params.currentBaseFingerprint, "currentBaseFingerprint"),
			);
			break;
		case "improvements.evaluateShadow":
			result = evaluateShadowRuns(improvementShadowInput(params));
			break;
		case "improvements.transition":
			result = await runtime.improvements.transition(
				requiredString(params.id, "id"),
				improvementStatus(params.status) ??
					(() => {
						throw new Error("status is required");
					})(),
				requiredPositiveInteger(params.expectedRevision, "expectedRevision"),
				improvementPromotion(params.promotion),
			);
			break;
		case "improvements.recordOutcome":
			result = await runtime.improvements.recordOutcome(
				improvementOutcome(params),
				requiredPositiveInteger(params.expectedRevision, "expectedRevision"),
			);
			break;
		case "resident.list":
			result = await runtime.resident.list();
			break;
		case "resident.get":
			result = await runtime.resident.get(requiredString(params.handle, "handle"));
			break;
		case "resident.register": {
			const registered = await runtime.resident.register(residentRegister(params));
			if (registered.schedule) runtime.wakes.arm();
			result = registered;
			break;
		}
		case "resident.attach":
			result = await runtime.resident.attach(
				requiredString(params.handle, "handle"),
				optionalNumber(params.leaseMs, "leaseMs"),
			);
			break;
		case "resident.renew":
			result = await runtime.resident.renew(
				requiredString(params.handle, "handle"),
				optionalNumber(params.leaseMs, "leaseMs"),
			);
			break;
		case "resident.detach":
			result = await runtime.resident.detach(requiredString(params.handle, "handle"), {
				passivate: params.passivate === true,
			});
			break;
		case "resident.schedule": {
			const scheduled = await runtime.resident.schedule(
				requiredString(params.handle, "handle"),
				residentSchedule(params.schedule),
			);
			// Arming here keeps the poll loop off until a schedule actually exists.
			if (scheduled.schedule) runtime.wakes.arm();
			result = scheduled;
			break;
		}
		case "resident.tick":
			result = await runtime.wakes.tick();
			break;
		case "resident.claimDue":
			result = await runtime.resident.claimDue();
			break;
		case "resident.forget":
			await runtime.resident.forget(requiredString(params.handle, "handle"));
			result = { ok: true };
			break;
		default:
			throw new Error(`Unknown recursive bridge method: ${method}`);
	}
	return normalizeRecursiveJson(result);
}
