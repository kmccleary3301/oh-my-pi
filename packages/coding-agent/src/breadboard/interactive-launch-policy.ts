import type { Args } from "../cli/args";

const ALLOWED_ARGS = new Set([
	"allowHome",
	"cwd",
	"engineMode",
	"engineUrl",
	"fileArgs",
	"help",
	"messages",
	"noTitle",
	"profile",
	"resume",
	"version",
]);

function hasLaunchValue(value: unknown): boolean {
	if (value === undefined || value === false) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (value instanceof Map || value instanceof Set) return value.size > 0;
	return true;
}

export function validateBreadboardInteractiveLaunch(parsed: Args, pipedInput: string | undefined): string | null {
	if (pipedInput !== undefined) return "Piped input is outside the governed BreadBoard interactive slice.";
	if (parsed.messages.length > 0)
		return "Initial-message launch is outside the governed BreadBoard interactive slice.";
	if (parsed.fileArgs.length > 0)
		return "File and attachment launch arguments are outside the governed BreadBoard interactive slice.";
	if (parsed.resume === true) return "Bare resume is unavailable; provide one full canonical BreadBoard session ID.";
	if (typeof parsed.resume === "string" && parsed.resume.trim().length === 0) {
		return "Resume requires one full canonical BreadBoard session ID.";
	}
	for (const [name, value] of Object.entries(parsed)) {
		if (!ALLOWED_ARGS.has(name) && hasLaunchValue(value)) {
			return `The '${name}' launch option is outside the governed BreadBoard interactive slice.`;
		}
	}
	return null;
}
