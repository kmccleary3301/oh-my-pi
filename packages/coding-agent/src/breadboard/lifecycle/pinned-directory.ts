import {
	DARWIN_PINNED_DIRECTORY_LIMITS,
	DarwinPinnedDirectoryError,
	openPinnedDirectory as openDarwinPinnedDirectory,
	type PinnedDirectory,
	type PinnedDirectoryListOptions,
	type PinnedFile,
	type PinnedFileType,
	type PinnedStat,
} from "./darwin-pinned-directory";
import { LinuxPinnedDirectoryError, openLinuxPinnedDirectory } from "./linux-pinned-directory";

export const PINNED_DIRECTORY_LIMITS = DARWIN_PINNED_DIRECTORY_LIMITS;

export type { PinnedDirectory, PinnedDirectoryListOptions, PinnedFile, PinnedFileType, PinnedStat };
export { DarwinPinnedDirectoryError, LinuxPinnedDirectoryError };

export class PinnedDirectoryUnsupportedPlatformError extends Error {
	constructor() {
		super(`Pinned directories are unsupported on ${process.platform}/${process.arch}`);
		this.name = "PinnedDirectoryUnsupportedPlatformError";
	}
}

export async function openPinnedDirectory(rootPath: string): Promise<PinnedDirectory> {
	if (process.platform === "darwin") return await openDarwinPinnedDirectory(rootPath);
	if (process.platform === "linux" && process.arch === "x64") return await openLinuxPinnedDirectory(rootPath);
	throw new PinnedDirectoryUnsupportedPlatformError();
}
