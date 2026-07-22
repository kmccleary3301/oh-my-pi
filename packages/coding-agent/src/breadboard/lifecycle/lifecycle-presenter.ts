import { createHash } from "node:crypto";
import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui";
import type { LifecycleState } from "./lifecycle-state";
import type { LifecycleDispatchResult } from "./lifecycle-supervisor";
import type { BreadboardRunConfig } from "./run-config";

export interface LifecyclePresentation {
	readonly summary: string;
	readonly remediation?: string;
	readonly exitCode: 0 | 1 | 2;
}

const REMEDIATION_BY_REASON: Readonly<Record<string, string>> = {
	engine_mode_off: "Start a new invocation with --engine-mode local-owned, local-external, or remote.",
	mode_forbidden: "Run this action only with --engine-mode local-owned.",
	artifact_update_not_governed: "Update the engine through its governed installer or package owner.",
	engine_artifact_unavailable: "Configure an explicit, verified local engine artifact.",
	engine_artifact_mismatch: "Reinstall or reselect the verified engine artifact.",
	authority_record_invalid: "Inspect the quarantined local authority record before retrying.",
	authority_store_unavailable: "Repair the user-scoped lifecycle store ownership and permissions.",
	ownership_conflict: "Use local-external explicitly or wait for the current owner lease.",
	identity_changed: "Do not control this process; verify the engine instance and relaunch.",
	owner_lease_expired: "Re-establish exact owner identity in a new lifecycle attempt.",
	registration_conflict: "Create a new invocation and client registration.",
	registration_expired: "Reconnect and register this invocation again.",
	endpoint_unreachable: "Restore the configured engine endpoint and retry explicitly.",
	incompatible_engine: "Install an engine matching the fixed P30 E4 contract.",
	auth_failed: "Repair the configured authentication reference or process secret.",
	tls_failed: "Repair system trust, hostname verification, mTLS identity, or the SPKI binding.",
	request_aborted: "Retry the lifecycle action explicitly.",
	restart_budget_exhausted: "Inspect the engine failure, then retry explicitly in a new attempt.",
	drain_denied: "Close active consumers and resolve admitted work before stopping.",
	drain_recovery_failed: "Leave the engine admission state untouched and obtain operator recovery.",
	process_identity_unavailable: "Do not signal the process; restore OS identity inspection.",
	process_control_failed: "Do not retry a signal until full process and engine identity is verified.",
	session_slice_not_landed: "The lifecycle is ready, but the governed Breadboard session slice is not installed.",
};

export function displayEndpointIdentity(endpoint: string | undefined): string | undefined {
	if (!endpoint) return undefined;
	const url = new URL(endpoint);
	const authority = `${url.protocol}//${url.host}`;
	if (url.pathname === "/" || url.pathname === "") return authority;
	const pathHash = createHash("sha256").update(url.pathname).digest("hex").slice(0, 12);
	return `${authority}/[path-sha256:${pathHash}]`;
}

export function presentLifecycle(result: LifecycleDispatchResult): LifecyclePresentation {
	if (result.kind === "off")
		return { summary: "BreadBoard engine: off", remediation: REMEDIATION_BY_REASON.engine_mode_off, exitCode: 0 };
	if (result.kind === "ready") {
		return {
			summary: `BreadBoard engine: ready (${result.state.mode}; instance ${result.handle.binding.engineInstanceId})`,
			exitCode: 0,
		};
	}
	if (result.kind === "observed") {
		return {
			summary: `BreadBoard engine: compatible, observed only (${result.state.mode}; instance ${result.handle.binding.engineInstanceId})`,
			exitCode: 0,
		};
	}
	if (result.kind === "detached") return { summary: "BreadBoard engine: detached", exitCode: 0 };
	if (result.kind === "stopped") return { summary: "BreadBoard engine: stopped", exitCode: 0 };
	return {
		summary: `BreadBoard engine: ${result.state.name} (${result.state.reason})`,
		remediation: REMEDIATION_BY_REASON[result.state.reason],
		exitCode: result.state.reason === "mode_forbidden" ? 2 : 1,
	};
}

export function secretSafeLifecycleStatus(
	config: BreadboardRunConfig,
	state: LifecycleState,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		mode: config.mode,
		state: state.name,
		...(state.reason === undefined ? {} : { reason: state.reason }),
		endpoint: displayEndpointIdentity(config.endpoint),
		configDigest: config.configDigest,
		sources: config.sources,
		attempt: state.attempt,
	});
}

export function restoreLifecycleTerminal(): void {
	emergencyTerminalRestore();
}

export function writeLifecyclePresentation(
	result: LifecycleDispatchResult,
	write: (text: string) => void = text => process.stdout.write(text),
): LifecyclePresentation {
	const presentation = presentLifecycle(result);
	write(`${presentation.summary}\n`);
	if (presentation.remediation) write(`${presentation.remediation}\n`);
	return presentation;
}
