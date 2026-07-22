import type { Args, Mode } from "../cli/args";

export type NativeLaunchSurface = "print" | Extract<Mode, "rpc" | "rpc-ui" | "acp">;

export type NativeLaunchPolicy =
	| { readonly kind: "native" }
	| { readonly kind: "unavailable"; readonly exitCode: 2; readonly message: string };

/**
 * Print and stdio protocol hosts remain native OMP surfaces. BreadBoard-backed
 * variants need their own framed transport contract; silently accepting a
 * non-off engine selection would make the flag lie about which runtime owns
 * the session.
 */
export function resolveNativeLaunchPolicy(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	surface: NativeLaunchSurface,
): NativeLaunchPolicy {
	if ((parsed.engineMode === undefined || parsed.engineMode === "off") && parsed.engineUrl === undefined) {
		return { kind: "native" };
	}
	return {
		kind: "unavailable",
		exitCode: 2,
		message:
			`BreadBoard launch error [unsupported_native_mode]: ${surface} is a native OMP surface and cannot use ` +
			"a BreadBoard engine selection; omit --engine-mode/--engine-url or use --engine-mode off.",
	};
}
