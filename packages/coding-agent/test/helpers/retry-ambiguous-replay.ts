import { LifecycleE4ClientError } from "@breadboard/sdk";

function isAmbiguousReplayFailure(error: unknown): boolean {
	if (!(error instanceof LifecycleE4ClientError)) return false;
	return (
		error.failure.kind === "timeout" ||
		error.failure.kind === "caller-abort" ||
		(error.failure.kind === "http" && error.failure.status === 0)
	);
}

export async function retryAmbiguousReplay<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!isAmbiguousReplayFailure(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}
