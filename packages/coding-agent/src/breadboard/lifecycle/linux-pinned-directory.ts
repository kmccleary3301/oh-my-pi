import { dlopen, FFIType, type Library, ptr, read } from "bun:ffi";
import { fstatSync, readSync } from "node:fs";
import {
	DARWIN_PINNED_DIRECTORY_LIMITS,
	type PinnedDirectory,
	type PinnedDirectoryListOptions,
	type PinnedFile,
	type PinnedFileType,
	type PinnedStat,
} from "./darwin-pinned-directory";

const O_RDONLY = 0x00000000;
const O_NONBLOCK = 0x00000800;
const O_DIRECTORY = 0x00010000;
const O_NOFOLLOW = 0x00020000;
const O_CLOEXEC = 0x00080000;
const O_PATH = 0x00200000;
const EINTR = 4;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const DIRENT_MIN_BYTES = 20;
const DIRENT_RECLEN_OFFSET = 16;
const DIRENT_NAME_OFFSET = 19;
const DIRECTORY_BUFFER_BYTES = 64 * 1024;

export class LinuxPinnedDirectoryError extends Error {
	readonly operation?: string;
	readonly relativePath?: string;
	readonly errno?: number;

	constructor(
		message: string,
		options: ErrorOptions & {
			readonly operation?: string;
			readonly relativePath?: string;
			readonly errno?: number;
		} = {},
	) {
		super(message, options);
		this.name = "LinuxPinnedDirectoryError";
		this.operation = options.operation;
		this.relativePath = options.relativePath;
		this.errno = options.errno;
	}
}

const SYSTEM_SYMBOLS = {
	open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	readlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	getdents64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	close: { args: [FFIType.i32], returns: FFIType.i32 },
	__errno_location: { args: [], returns: FFIType.ptr },
} as const;

type SystemLibrary = Library<typeof SYSTEM_SYMBOLS>;
let systemLibrary: SystemLibrary | undefined;

function ensureLinuxX64(): void {
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new LinuxPinnedDirectoryError(`Linux x64 pinned directories are unsupported on ${process.platform}/${process.arch}`);
	}
}

function system(): SystemLibrary {
	ensureLinuxX64();
	systemLibrary ??= dlopen("libc.so.6", SYSTEM_SYMBOLS);
	return systemLibrary;
}

function currentErrno(lib: SystemLibrary): number {
	const address = lib.symbols.__errno_location();
	return address === null ? 0 : read.i32(address);
}

function nativeError(
	lib: SystemLibrary,
	operation: string,
	relativePath?: string,
	errnoOverride?: number,
): LinuxPinnedDirectoryError {
	const errno = errnoOverride ?? currentErrno(lib);
	const suffix = relativePath === undefined ? "" : ` for ${JSON.stringify(relativePath)}`;
	return new LinuxPinnedDirectoryError(`${operation}${suffix} failed with errno ${errno}`, {
		operation,
		relativePath,
		errno,
	});
}

function nodeError(operation: string, relativePath: string | undefined, cause: unknown): LinuxPinnedDirectoryError {
	const errno = normalizeNodeErrno(cause);
	const suffix = relativePath === undefined ? "" : ` for ${JSON.stringify(relativePath)}`;
	return new LinuxPinnedDirectoryError(`${operation}${suffix} failed with errno ${errno}`, {
		cause,
		operation,
		relativePath,
		errno,
	});
}

function invalid(message: string, relativePath?: string): LinuxPinnedDirectoryError {
	return new LinuxPinnedDirectoryError(message, { relativePath });
}

export function normalizeNodeErrno(cause: unknown): number {
	if (typeof cause !== "object" || cause === null) return 0;
	if ("code" in cause && cause.code === "EINTR") return EINTR;
	if ("errno" in cause) {
		const errno = cause.errno;
		if (typeof errno === "number" && Number.isSafeInteger(errno)) return Math.abs(errno);
	}
	return 0;
}

function cString(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf8");
}

function validateRootPath(rootPath: string): void {
	if (rootPath.length === 0) throw invalid("root path is empty");
	if (rootPath.includes("\0")) throw invalid("root path contains NUL");
	const length = Buffer.byteLength(rootPath);
	if (length > DARWIN_PINNED_DIRECTORY_LIMITS.maxRootPathBytes) {
		throw invalid(`root path exceeds ${DARWIN_PINNED_DIRECTORY_LIMITS.maxRootPathBytes} bytes`);
	}
}

function validateComponent(component: string, relativePath: string): void {
	if (component.length === 0) throw invalid("relative path contains an empty component", relativePath);
	if (component === "." || component === "..") throw invalid("relative path contains a dot component", relativePath);
	if (component.includes("\0")) throw invalid("relative path contains NUL", relativePath);
	if (component.includes("/")) throw invalid("relative path component contains a slash", relativePath);
	if (Buffer.byteLength(component) > DARWIN_PINNED_DIRECTORY_LIMITS.maxComponentBytes) {
		throw invalid(
			`relative path component exceeds ${DARWIN_PINNED_DIRECTORY_LIMITS.maxComponentBytes} bytes`,
			relativePath,
		);
	}
}

function relativeComponents(relativePath: string): readonly string[] {
	if (relativePath.length === 0) throw invalid("relative path is empty", relativePath);
	if (relativePath.startsWith("/")) throw invalid("relative path is absolute", relativePath);
	if (relativePath.includes("\0")) throw invalid("relative path contains NUL", relativePath);
	if (Buffer.byteLength(relativePath) > DARWIN_PINNED_DIRECTORY_LIMITS.maxRelativePathBytes) {
		throw invalid(`relative path exceeds ${DARWIN_PINNED_DIRECTORY_LIMITS.maxRelativePathBytes} bytes`, relativePath);
	}
	const components = relativePath.split("/");
	for (const component of components) validateComponent(component, relativePath);
	return components;
}

function boundedInteger(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw invalid(`${label} must be an integer from 1 through ${maximum}`);
	}
	return value;
}

function modeType(mode: number): number {
	return mode & S_IFMT;
}

interface LinuxBigIntStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly size: bigint;
}

function parseStat(native: LinuxBigIntStat): PinnedStat {
	const mode = Number(native.mode);
	const kind = modeType(mode);
	return {
		dev: native.dev,
		ino: native.ino,
		mode,
		size: native.size,
		type: kind === S_IFREG ? "regular" : kind === S_IFDIR ? "directory" : "other",
	};
}

function sameIdentity(left: PinnedStat, right: Readonly<Pick<PinnedStat, "dev" | "ino">>): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function fstatFd(fd: number, operation: string, relativePath?: string): PinnedStat {
	for (;;) {
		try {
			return parseStat(fstatSync(fd, { bigint: true }));
		} catch (cause) {
			if (normalizeNodeErrno(cause) === EINTR) continue;
			throw nodeError(operation, relativePath, cause);
		}
	}
}

function closeQuietly(lib: SystemLibrary, fd: number): void {
	lib.symbols.close(fd);
}

function closeChecked(lib: SystemLibrary, fd: number): void {
	const result = Number(lib.symbols.close(fd));
	if (result !== 0) {
		const errno = currentErrno(lib);
		throw nativeError(lib, "close", undefined, errno);
	}
}

function openAt(
	lib: SystemLibrary,
	directoryFd: number,
	component: string,
	flags: number,
	relativePath: string,
): number {
	const name = cString(component);
	for (;;) {
		const fd = Number(lib.symbols.openat(directoryFd, ptr(name), flags, 0));
		if (fd >= 0) return fd;
		const errno = currentErrno(lib);
		if (errno === EINTR) continue;
		throw nativeError(lib, "openat", relativePath, errno);
	}
}

function openDirectoryAt(lib: SystemLibrary, directoryFd: number, component: string, relativePath: string): number {
	const fd = openAt(lib, directoryFd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, relativePath);
	try {
		if (fstatFd(fd, "fstat", relativePath).type !== "directory")
			throw invalid("path component is not a directory", relativePath);
		return fd;
	} catch (error) {
		closeQuietly(lib, fd);
		throw error;
	}
}

function openRelative(
	lib: SystemLibrary,
	rootFd: number,
	relativePath: string,
	directory: boolean,
): { readonly fd: number; readonly stat: PinnedStat } {
	const components = relativeComponents(relativePath);
	let parentFd = rootFd;
	let ownsParent = false;
	try {
		for (let index = 0; index < components.length - 1; index += 1) {
			const nextFd = openDirectoryAt(lib, parentFd, components[index] as string, relativePath);
			if (ownsParent) closeQuietly(lib, parentFd);
			parentFd = nextFd;
			ownsParent = true;
		}
		const flags = directory
			? O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
			: O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC;
		const fd = openAt(lib, parentFd, components.at(-1) as string, flags, relativePath);
		try {
			const stat = fstatFd(fd, "fstat", relativePath);
			const expectedType: PinnedFileType = directory ? "directory" : "regular";
			if (stat.type !== expectedType) throw invalid(`path is not a ${expectedType} file`, relativePath);
			return { fd, stat };
		} catch (error) {
			closeQuietly(lib, fd);
			throw error;
		}
	} finally {
		if (ownsParent) closeQuietly(lib, parentFd);
	}
}

function openParent(
	lib: SystemLibrary,
	rootFd: number,
	relativePath: string,
): { readonly fd: number; readonly name: string; readonly ownsFd: boolean } {
	const components = relativeComponents(relativePath);
	let parentFd = rootFd;
	let ownsParent = false;
	try {
		for (let index = 0; index < components.length - 1; index += 1) {
			const nextFd = openDirectoryAt(lib, parentFd, components[index] as string, relativePath);
			if (ownsParent) closeQuietly(lib, parentFd);
			parentFd = nextFd;
			ownsParent = true;
		}
		return { fd: parentFd, name: components.at(-1) as string, ownsFd: ownsParent };
	} catch (error) {
		if (ownsParent) closeQuietly(lib, parentFd);
		throw error;
	}
}

function readRegularFd(
	fd: number,
	expected: Readonly<Pick<PinnedStat, "dev" | "ino">>,
	maxBytes: number,
	relativePath: string,
): Buffer {
	const limit = boundedInteger(maxBytes, "maxBytes", DARWIN_PINNED_DIRECTORY_LIMITS.maxFileBytes);
	const stat = fstatFd(fd, "fstat", relativePath);
	if (!sameIdentity(stat, expected) || stat.type !== "regular")
		throw invalid("opened file descriptor identity or type changed");
	if (stat.size < 0n || stat.size > BigInt(limit)) throw invalid(`regular file exceeds the ${limit}-byte read limit`);
	let capacity = Math.min(limit + 1, Math.max(1, Number(stat.size) + 1));
	let bytes = Buffer.allocUnsafe(capacity);
	let length = 0;
	for (;;) {
		if (length === capacity) {
			if (capacity === limit + 1) throw invalid(`regular file exceeds the ${limit}-byte read limit`);
			const nextCapacity = Math.min(limit + 1, Math.max(capacity + 1, capacity * 2));
			const next = Buffer.allocUnsafe(nextCapacity);
			bytes.copy(next, 0, 0, length);
			bytes = next;
			capacity = nextCapacity;
		}
		let count: number;
		for (;;) {
			try {
				count = readSync(fd, bytes, length, capacity - length, length);
				break;
			} catch (cause) {
				if (normalizeNodeErrno(cause) === EINTR) continue;
				throw nodeError("read", relativePath, cause);
			}
		}
		if (count === 0) return bytes.subarray(0, length);
		length += count;
		if (length > limit) throw invalid(`regular file exceeds the ${limit}-byte read limit`);
	}
}

function readlinkAtFd(lib: SystemLibrary, fd: number, maxBytes: number, relativePath: string): Buffer {
	const limit = boundedInteger(maxBytes, "maxBytes", DARWIN_PINNED_DIRECTORY_LIMITS.maxSymlinkBytes);
	const output = Buffer.allocUnsafe(limit + 1);
	const empty = cString("");
	for (;;) {
		const result = Number(lib.symbols.readlinkat(fd, ptr(empty), ptr(output), output.byteLength));
		if (result >= 0) {
			if (result > limit) throw invalid(`symlink target exceeds the ${limit}-byte read limit`, relativePath);
			return output.subarray(0, result);
		}
		const errno = currentErrno(lib);
		if (errno === EINTR) continue;
		throw nativeError(lib, "readlinkat", relativePath, errno);
	}
}
function verifySymlinkFd(lib: SystemLibrary, fd: number, relativePath: string): void {
	const output = Buffer.allocUnsafe(1);
	const empty = cString("");
	for (;;) {
		const result = Number(lib.symbols.readlinkat(fd, ptr(empty), ptr(output), output.byteLength));
		if (result >= 0) return;
		const errno = currentErrno(lib);
		if (errno === EINTR) continue;
		throw nativeError(lib, "readlinkat", relativePath, errno);
	}
}

function specialTypeName(mode: number): string {
	switch (modeType(mode)) {
		case 0o010000:
			return "fifo";
		case 0o020000:
			return "character-device";
		case 0o060000:
			return "block-device";
		case 0o140000:
			return "socket";
		default:
			return "special";
	}
}

interface DirectoryEntry {
	readonly name: string;
	readonly nameBytes: Buffer;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function directoryEntries(lib: SystemLibrary, fd: number, remainingEntries: number): readonly DirectoryEntry[] {
	const buffer = Buffer.allocUnsafe(DIRECTORY_BUFFER_BYTES);
	const entries: DirectoryEntry[] = [];
	for (;;) {
		let count: number;
		for (;;) {
			const result = Number(lib.symbols.getdents64(fd, ptr(buffer), buffer.byteLength));
			if (result >= 0) {
				count = result;
				break;
			}
			const errno = currentErrno(lib);
			if (errno === EINTR) continue;
			throw nativeError(lib, "getdents64", undefined, errno);
		}
		if (count === 0) break;
		if (count > buffer.byteLength) throw invalid("getdents64 returned an oversized buffer length");
		let cursor = 0;
		while (cursor < count) {
			if (count - cursor < DIRENT_MIN_BYTES) throw invalid("directory entry header is truncated");
			const recordLength = buffer.readUInt16LE(cursor + DIRENT_RECLEN_OFFSET);
			if (recordLength < DIRENT_MIN_BYTES || recordLength > count - cursor) {
				throw invalid("directory entry record is malformed");
			}
			const nameStart = cursor + DIRENT_NAME_OFFSET;
			let nameEnd = nameStart;
			const recordEnd = cursor + recordLength;
			while (nameEnd < recordEnd && buffer[nameEnd] !== 0) nameEnd += 1;
			if (nameEnd === nameStart || nameEnd === recordEnd) throw invalid("directory entry record is malformed");
			const nameBytes = Buffer.from(buffer.subarray(nameStart, nameEnd));
			if (!(nameBytes.length === 1 && nameBytes[0] === 0x2e) && !(nameBytes.length === 2 && nameBytes[0] === 0x2e && nameBytes[1] === 0x2e)) {
				if (entries.length >= remainingEntries) throw invalid("directory enumeration exceeds the configured entry limit");
				let name: string;
				try {
					name = utf8Decoder.decode(nameBytes);
				} catch (cause) {
					throw new LinuxPinnedDirectoryError("directory entry name is not valid UTF-8", { cause });
				}
				validateComponent(name, name);
				entries.push({ name, nameBytes });
			}
			cursor += recordLength;
		}
	}
	entries.sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
	return entries;
}

class NativePinnedFile implements PinnedFile {
	readonly fd: number;
	readonly #identity: Readonly<Pick<PinnedStat, "dev" | "ino">>;
	readonly #type: "regular" | "directory";
	readonly #lib: SystemLibrary;
	readonly #relativePath: string;
	#closed = false;

	constructor(lib: SystemLibrary, fd: number, stat: PinnedStat, type: "regular" | "directory", relativePath: string) {
		this.#lib = lib;
		this.fd = fd;
		this.#identity = { dev: stat.dev, ino: stat.ino };
		this.#type = type;
		this.#relativePath = relativePath;
	}

	async stat(): Promise<PinnedStat> {
		this.#assertOpen();
		const stat = fstatFd(this.fd, "fstat", this.#relativePath);
		if (!sameIdentity(stat, this.#identity) || stat.type !== this.#type)
			throw invalid("opened file descriptor identity or type changed");
		return stat;
	}

	async read(maxBytes: number): Promise<Buffer> {
		this.#assertOpen();
		if (this.#type !== "regular") throw invalid("cannot read a directory descriptor as a regular file");
		return readRegularFd(this.fd, this.#identity, maxBytes, this.#relativePath);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		closeChecked(this.#lib, this.fd);
	}

	#assertOpen(): void {
		if (this.#closed) throw invalid("file descriptor is closed");
	}
}

class NativePinnedDirectory implements PinnedDirectory {
	readonly fd: number;
	readonly identity: Readonly<Pick<PinnedStat, "dev" | "ino">>;
	readonly #lib: SystemLibrary;
	#closed = false;

	constructor(lib: SystemLibrary, fd: number, stat: PinnedStat) {
		this.#lib = lib;
		this.fd = fd;
		this.identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
	}

	async stat(): Promise<PinnedStat> {
		return this.#assertRoot();
	}

	async openFile(relativePath: string, options: { readonly directory?: boolean } = {}): Promise<PinnedFile> {
		this.#assertRoot();
		const directory = options.directory === true;
		const opened = openRelative(this.#lib, this.fd, relativePath, directory);
		return new NativePinnedFile(
			this.#lib,
			opened.fd,
			opened.stat,
			directory ? "directory" : "regular",
			relativePath,
		);
	}

	async readFile(relativePath: string, maxBytes: number): Promise<Buffer> {
		const file = await this.openFile(relativePath);
		try {
			return await file.read(maxBytes);
		} finally {
			await file.close();
		}
	}

	async readlink(relativePath: string, maxBytes: number): Promise<Buffer> {
		this.#assertRoot();
		const parent = openParent(this.#lib, this.fd, relativePath);
		try {
			const linkFd = openAt(this.#lib, parent.fd, parent.name, O_PATH | O_NOFOLLOW | O_CLOEXEC, relativePath);
			try {
				const stat = fstatFd(linkFd, "fstat", relativePath);
				if (modeType(stat.mode) !== S_IFLNK) throw invalid("path is not a symbolic link", relativePath);
				return readlinkAtFd(this.#lib, linkFd, maxBytes, relativePath);
			} finally {
				closeQuietly(this.#lib, linkFd);
			}
		} finally {
			if (parent.ownsFd) closeQuietly(this.#lib, parent.fd);
		}
	}

	async listLeaves(options: PinnedDirectoryListOptions): Promise<readonly string[]> {
		this.#assertRoot();
		const maxEntries = boundedInteger(options.maxEntries, "maxEntries", DARWIN_PINNED_DIRECTORY_LIMITS.maxEntries);
		const maxPathBytes = boundedInteger(
			options.maxPathBytes,
			"maxPathBytes",
			DARWIN_PINNED_DIRECTORY_LIMITS.maxRelativePathBytes,
		);
		const maxTotalPathBytes = boundedInteger(
			options.maxTotalPathBytes ?? DARWIN_PINNED_DIRECTORY_LIMITS.maxTotalPathBytes,
			"maxTotalPathBytes",
			DARWIN_PINNED_DIRECTORY_LIMITS.maxTotalPathBytes,
		);
		const leaves: string[] = [];
		let totalPathBytes = 0;
		let visitedEntries = 0;
		const visit = (directoryFd: number, prefix: string): void => {
			for (const entry of directoryEntries(this.#lib, directoryFd, maxEntries - visitedEntries)) {
				if (visitedEntries === maxEntries) throw invalid(`directory enumeration exceeds the ${maxEntries}-entry limit`);
				visitedEntries += 1;
				const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
				const pathBytes = Buffer.byteLength(relativePath);
				if (pathBytes > maxPathBytes || pathBytes > DARWIN_PINNED_DIRECTORY_LIMITS.maxRelativePathBytes) {
					throw invalid(`enumerated path exceeds the ${maxPathBytes}-byte path limit`, relativePath);
				}
				const entryFd = openAt(this.#lib, directoryFd, entry.name, O_PATH | O_NOFOLLOW | O_CLOEXEC, relativePath);
				try {
					const stat = fstatFd(entryFd, "fstat", relativePath);
					if (stat.type === "regular") {
						if (pathBytes > maxTotalPathBytes - totalPathBytes)
							throw invalid(`leaf enumeration exceeds the ${maxTotalPathBytes}-byte total output limit`);
						leaves.push(relativePath);
						totalPathBytes += pathBytes;
						continue;
					}
					if (modeType(stat.mode) === S_IFLNK) {
						verifySymlinkFd(this.#lib, entryFd, relativePath);
						if (pathBytes > maxTotalPathBytes - totalPathBytes)
							throw invalid(`leaf enumeration exceeds the ${maxTotalPathBytes}-byte total output limit`);
						leaves.push(relativePath);
						totalPathBytes += pathBytes;
						continue;
					}
					if (stat.type === "directory") {
						const childFd = openDirectoryAt(this.#lib, entryFd, ".", relativePath);
						try {
							visit(childFd, relativePath);
						} finally {
							closeQuietly(this.#lib, childFd);
						}
						continue;
					}
					throw invalid(`unsupported ${specialTypeName(stat.mode)} directory entry`, relativePath);
				} finally {
					closeQuietly(this.#lib, entryFd);
				}
			}
		};
		const enumerationFd = openDirectoryAt(this.#lib, this.fd, ".", ".");
		try {
			visit(enumerationFd, "");
		} finally {
			closeQuietly(this.#lib, enumerationFd);
		}
		leaves.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
		return Object.freeze(leaves);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		closeChecked(this.#lib, this.fd);
	}

	#assertRoot(): PinnedStat {
		if (this.#closed) throw invalid("pinned directory is closed");
		const stat = fstatFd(this.fd, "fstat");
		if (!sameIdentity(stat, this.identity) || stat.type !== "directory")
			throw invalid("pinned root descriptor identity or type changed");
		return stat;
	}
}

export async function openLinuxPinnedDirectory(rootPath: string): Promise<PinnedDirectory> {
	validateRootPath(rootPath);
	const lib = system();
	const path = cString(rootPath);
	let fd: number;
	for (;;) {
		fd = Number(lib.symbols.open(ptr(path), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0));
		if (fd >= 0) break;
		const errno = currentErrno(lib);
		if (errno === EINTR) continue;
		throw nativeError(lib, "open", rootPath, errno);
	}
	try {
		const stat = fstatFd(fd, "fstat", rootPath);
		if (stat.type !== "directory") throw invalid("opened root is not a directory", rootPath);
		return new NativePinnedDirectory(lib, fd, stat);
	} catch (error) {
		closeQuietly(lib, fd);
		throw error;
	}
}
