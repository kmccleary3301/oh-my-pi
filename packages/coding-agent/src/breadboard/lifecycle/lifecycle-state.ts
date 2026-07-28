import type { BoundLifecycleE4Client, LifecycleEngineBinding } from "@breadboard/sdk";
import type { BreadboardEngineMode } from "./run-config";

export const LIFECYCLE_STATES = [
	"off",
	"claiming",
	"starting",
	"connecting",
	"handshaking",
	"acquiring-owner",
	"registering-client",
	"compatible-observed",
	"ready",
	"reconnecting",
	"backing-off",
	"draining",
	"restart-stopping",
	"restart-starting",
	"stopping",
	"detaching-client",
	"detached",
	"stopped",
	"failed",
	"restart-blocked",
	"drain-recovery-failed",
	"update-unavailable",
	"ownership-conflict",
	"owner-lease-expired",
	"registration-conflict",
	"registration-expired",
	"incompatible-engine",
	"auth-failed",
	"tls-failed",
	"identity-changed",
	"request-aborted",
	"external-disconnected",
	"remote-disconnected",
	"recovery-needed",
] as const;

export type LifecycleStateName = (typeof LIFECYCLE_STATES)[number];
export const LIFECYCLE_FAILURE_STATES = [
	"failed",
	"restart-blocked",
	"drain-recovery-failed",
	"update-unavailable",
	"ownership-conflict",
	"owner-lease-expired",
	"registration-conflict",
	"registration-expired",
	"incompatible-engine",
	"auth-failed",
	"tls-failed",
	"identity-changed",
	"request-aborted",
	"external-disconnected",
	"remote-disconnected",
	"recovery-needed",
] as const;
export type LifecycleFailureStateName = (typeof LIFECYCLE_FAILURE_STATES)[number];

export interface LifecycleState {
	readonly name: LifecycleStateName;
	readonly mode: BreadboardEngineMode;
	readonly attempt: number;
	readonly reason?: LifecycleReason;
}

export type LifecycleReason =
	| "engine_mode_off"
	| "mode_forbidden"
	| "artifact_update_not_governed"
	| "engine_artifact_unavailable"
	| "engine_artifact_mismatch"
	| "authority_record_invalid"
	| "authority_store_unavailable"
	| "ownership_conflict"
	| "identity_changed"
	| "owner_lease_expired"
	| "registration_conflict"
	| "registration_expired"
	| "endpoint_unreachable"
	| "incompatible_engine"
	| "auth_failed"
	| "tls_failed"
	| "request_aborted"
	| "restart_budget_exhausted"
	| "drain_denied"
	| "drain_recovery_failed"
	| "process_identity_unavailable"
	| "process_control_failed"
	| "session_slice_not_landed";

export interface LifecycleReadyHandle {
	readonly mode: Exclude<BreadboardEngineMode, "off">;
	readonly binding: LifecycleEngineBinding;
	readonly lifecycleClient: BoundLifecycleE4Client;
	readonly requestFetch: typeof fetch;
	readonly registration: {
		readonly id: string;
		readonly generation: number;
		readonly clientInstanceId: string;
		readonly admissionEpoch: number;
		readonly expiresAtUnix: number;
	};
	readonly ownerGeneration?: number;
}

export interface LifecycleObservedHandle {
	readonly mode: Exclude<BreadboardEngineMode, "off">;
	readonly binding: LifecycleEngineBinding;
}

export type LifecycleResult =
	| { readonly kind: "off"; readonly state: LifecycleState & { readonly name: "off" } }
	| {
			readonly kind: "observed";
			readonly state: LifecycleState & { readonly name: "compatible-observed" };
			readonly handle: LifecycleObservedHandle;
	  }
	| {
			readonly kind: "ready";
			readonly state: LifecycleState & { readonly name: "ready" };
			readonly handle: LifecycleReadyHandle;
	  }
	| { readonly kind: "detached"; readonly state: LifecycleState & { readonly name: "detached" } }
	| { readonly kind: "stopped"; readonly state: LifecycleState & { readonly name: "stopped" } }
	| {
			readonly kind: "failure";
			readonly state: LifecycleState & {
				readonly name: LifecycleFailureStateName;
				readonly reason: LifecycleReason;
			};
	  };

const TERMINAL_STATES: Readonly<Partial<Record<LifecycleStateName, true>>> = {
	off: true,
	detached: true,
	stopped: true,
	failed: true,
	"restart-blocked": true,
	"drain-recovery-failed": true,
	"update-unavailable": true,
	"ownership-conflict": true,
	"owner-lease-expired": true,
	"registration-conflict": true,
	"registration-expired": true,
	"incompatible-engine": true,
	"auth-failed": true,
	"tls-failed": true,
	"identity-changed": true,
	"request-aborted": true,
	"external-disconnected": true,
	"remote-disconnected": true,
	"recovery-needed": true,
};

const LOCAL_OWNED_ONLY: Readonly<Partial<Record<LifecycleStateName, true>>> = {
	claiming: true,
	starting: true,
	"acquiring-owner": true,
	"backing-off": true,
	draining: true,
	"restart-stopping": true,
	"restart-starting": true,
	stopping: true,
	stopped: true,
	"restart-blocked": true,
	"drain-recovery-failed": true,
	"update-unavailable": true,
	"ownership-conflict": true,
	"owner-lease-expired": true,
};

export function lifecycleState(
	mode: BreadboardEngineMode,
	name: LifecycleStateName,
	attempt = 0,
	reason?: LifecycleReason,
): LifecycleState {
	if (mode !== "local-owned" && LOCAL_OWNED_ONLY[name])
		throw new Error(`lifecycle state ${name} is forbidden in ${mode}`);
	if (mode === "off" && name !== "off" && reason !== "mode_forbidden")
		throw new Error(`off mode cannot enter lifecycle state ${name}`);
	if (TERMINAL_STATES[name] && name !== "off" && name !== "detached" && name !== "stopped" && reason === undefined) {
		throw new Error(`terminal lifecycle state ${name} requires a reason`);
	}
	return Object.freeze({ name, mode, attempt, ...(reason === undefined ? {} : { reason }) });
}

function lifecycleFailureState(
	mode: BreadboardEngineMode,
	name: LifecycleFailureStateName,
	reason: LifecycleReason,
	attempt: number,
): LifecycleState & { readonly name: LifecycleFailureStateName; readonly reason: LifecycleReason } {
	lifecycleState(mode, name, attempt, reason);
	return Object.freeze({ name, mode, attempt, reason });
}

export function lifecycleFailure(
	mode: BreadboardEngineMode,
	name: LifecycleFailureStateName,
	reason: LifecycleReason,
	attempt = 0,
): LifecycleResult {
	return {
		kind: "failure",
		state: lifecycleFailureState(mode, name, reason, attempt),
	};
}
