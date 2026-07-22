import { dlopen, FFIType, type Library, ptr, read } from "bun:ffi";

const O_RDONLY = 0x00000000;
const O_NONBLOCK = 0x00000004;
const O_NOFOLLOW = 0x00000100;
const O_DIRECTORY = 0x00100000;
const O_CLOEXEC = 0x01000000;
const EINTR = 4;

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

const DT_UNKNOWN = 0;
const DT_FIFO = 1;
const DT_CHR = 2;
const DT_DIR = 4;
const DT_BLK = 6;
const DT_REG = 8;
const DT_LNK = 10;
const DT_SOCK = 12;
const DT_WHT = 14;

const STAT_BYTES = 144;
const STAT_MODE_OFFSET = 4;
const STAT_INO_OFFSET = 8;
const STAT_SIZE_OFFSET = 96;
const DIRENT_MIN_BYTES = 22;
const DIRENT_RECLEN_OFFSET = 16;
const DIRENT_NAMLEN_OFFSET = 18;
const DIRENT_TYPE_OFFSET = 20;
const DIRENT_NAME_OFFSET = 21;
const DIRECTORY_BUFFER_BYTES = 64 * 1024;

export const DARWIN_PINNED_DIRECTORY_LIMITS = Object.freeze({
	maxRootPathBytes: 1023,
	maxComponentBytes: 255,
	maxRelativePathBytes: 4095,
	maxFileBytes: 64 * 1024 * 1024,
	maxSymlinkBytes: 64 * 1024,
	maxEntries: 100_000,
	maxTotalPathBytes: 16 * 1024 * 1024,
});

export type PinnedFileType = "regular" | "directory" | "other";

export interface PinnedStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: number;
	readonly size: bigint;
	readonly type: PinnedFileType;
}

export interface PinnedFile {
	readonly fd: number;
	stat(): Promise<PinnedStat>;
	read(maxBytes: number): Promise<Buffer>;
	close(): Promise<void>;
}

export interface PinnedDirectoryListOptions {
	readonly maxEntries: number;
	readonly maxPathBytes: number;
	readonly maxTotalPathBytes?: number;
}

export interface PinnedDirectory {
	readonly fd: number;
	readonly identity: Readonly<Pick<PinnedStat, "dev" | "ino">>;
	stat(): Promise<PinnedStat>;
	openFile(relativePath: string, options?: { readonly directory?: boolean }): Promise<PinnedFile>;
	readFile(relativePath: string, maxBytes: number): Promise<Buffer>;
	readlink(relativePath: string, maxBytes: number): Promise<Buffer>;
	listLeaves(options: PinnedDirectoryListOptions): Promise<readonly string[]>;
	close(): Promise<void>;
}

export class DarwinPinnedDirectoryError extends Error {
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
		this.name = "DarwinPinnedDirectoryError";
		this.operation = options.operation;
		this.relativePath = options.relativePath;
		this.errno = options.errno;
	}
}

const SYSTEM_SYMBOLS = {
	open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	fstat: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	pread: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
	readlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	__getdirentries64: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	close: { args: [FFIType.i32], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;

type SystemLibrary = Library<typeof SYSTEM_SYMBOLS>;
let systemLibrary: SystemLibrary | undefined;

function system(): SystemLibrary {
	if (process.platform !== "darwin") {
		throw new DarwinPinnedDirectoryError(`Darwin pinned directories are unsupported on ${process.platform}`);
	}
	systemLibrary ??= dlopen("/usr/lib/libSystem.B.dylib", SYSTEM_SYMBOLS);
	return systemLibrary;
}

function currentErrno(lib: SystemLibrary): number {
	const address = lib.symbols.__error();
	return address === null ? 0 : read.i32(address);
}

function nativeError(lib: SystemLibrary, operation: string, relativePath?: string): DarwinPinnedDirectoryError {
	const errno = currentErrno(lib);
	const suffix = relativePath === undefined ? "" : ` for ${JSON.stringify(relativePath)}`;
	return new DarwinPinnedDirectoryError(`${operation}${suffix} failed with errno ${errno}`, {
		operation,
		relativePath,
		errno,
	});
}

function invalid(message: string, relativePath?: string): DarwinPinnedDirectoryError {
	return new DarwinPinnedDirectoryError(message, { relativePath });
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

function parseStat(bytes: Buffer): PinnedStat {
	const mode = bytes.readUInt16LE(STAT_MODE_OFFSET);
	const kind = mode & S_IFMT;
	return {
		dev: BigInt(bytes.readInt32LE(0)),
		ino: bytes.readBigUInt64LE(STAT_INO_OFFSET),
		mode,
		size: bytes.readBigInt64LE(STAT_SIZE_OFFSET),
		type: kind === S_IFREG ? "regular" : kind === S_IFDIR ? "directory" : "other",
	};
}

function fstatFd(lib: SystemLibrary, fd: number, operation: string, relativePath?: string): PinnedStat {
	const bytes = Buffer.alloc(STAT_BYTES);
	if (Number(lib.symbols.fstat(fd, ptr(bytes))) !== 0) throw nativeError(lib, operation, relativePath);
	return parseStat(bytes);
}

function sameIdentity(left: PinnedStat, right: Readonly<Pick<PinnedStat, "dev" | "ino">>): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(lib: SystemLibrary, fd: number): void {
	lib.symbols.close(fd);
}

function closeChecked(lib: SystemLibrary, fd: number): void {
	if (Number(lib.symbols.close(fd)) !== 0) throw nativeError(lib, "close");
}

function openAt(
	lib: SystemLibrary,
	directoryFd: number,
	component: string,
	flags: number,
	relativePath: string,
): number {
	const name = cString(component);
	const fd = Number(lib.symbols.openat(directoryFd, ptr(name), flags));
	if (fd < 0) throw nativeError(lib, "openat", relativePath);
	return fd;
}

function openDirectoryAt(lib: SystemLibrary, directoryFd: number, component: string, relativePath: string): number {
	const fd = openAt(lib, directoryFd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, relativePath);
	try {
		if (fstatFd(lib, fd, "fstat", relativePath).type !== "directory")
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
			const stat = fstatFd(lib, fd, "fstat", relativePath);
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

function preadRetry(
	lib: SystemLibrary,
	fd: number,
	destination: Buffer,
	offset: number,
	length: number,
	fileOffset: number,
): number {
	for (;;) {
		const result = Number(lib.symbols.pread(fd, ptr(destination, offset), length, fileOffset));
		if (result >= 0) return result;
		if (currentErrno(lib) !== EINTR) throw nativeError(lib, "pread");
	}
}

function readRegularFd(
	lib: SystemLibrary,
	fd: number,
	expected: Readonly<Pick<PinnedStat, "dev" | "ino">>,
	maxBytes: number,
): Buffer {
	const limit = boundedInteger(maxBytes, "maxBytes", DARWIN_PINNED_DIRECTORY_LIMITS.maxFileBytes);
	const stat = fstatFd(lib, fd, "fstat");
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
		const count = preadRetry(lib, fd, bytes, length, capacity - length, length);
		if (count === 0) return bytes.subarray(0, length);
		length += count;
		if (length > limit) throw invalid(`regular file exceeds the ${limit}-byte read limit`);
	}
}

function readlinkAt(
	lib: SystemLibrary,
	directoryFd: number,
	component: string,
	maxBytes: number,
	relativePath: string,
): Buffer {
	const limit = boundedInteger(maxBytes, "maxBytes", DARWIN_PINNED_DIRECTORY_LIMITS.maxSymlinkBytes);
	const output = Buffer.allocUnsafe(limit + 1);
	const name = cString(component);
	let result: number;
	for (;;) {
		result = Number(lib.symbols.readlinkat(directoryFd, ptr(name), ptr(output), output.byteLength));
		if (result >= 0) break;
		if (currentErrno(lib) !== EINTR) throw nativeError(lib, "readlinkat", relativePath);
	}
	if (result > limit) throw invalid(`symlink target exceeds the ${limit}-byte read limit`, relativePath);
	return output.subarray(0, result);
}

interface DirectoryEntry {
	readonly name: string;
	readonly nameBytes: Buffer;
	readonly type: number;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function directoryEntries(lib: SystemLibrary, fd: number): readonly DirectoryEntry[] {
	const buffer = Buffer.allocUnsafe(DIRECTORY_BUFFER_BYTES);
	const base = Buffer.alloc(8);
	const entries: DirectoryEntry[] = [];
	for (;;) {
		let count: number;
		for (;;) {
			count = Number(lib.symbols.__getdirentries64(fd, ptr(buffer), buffer.byteLength, ptr(base)));
			if (count >= 0) break;
			if (currentErrno(lib) !== EINTR) throw nativeError(lib, "getdirentries64");
		}
		if (count === 0) break;
		if (count > buffer.byteLength) throw invalid("getdirentries64 returned an oversized buffer length");
		let cursor = 0;
		while (cursor < count) {
			if (count - cursor < DIRENT_MIN_BYTES) throw invalid("directory entry header is truncated");
			const recordLength = buffer.readUInt16LE(cursor + DIRENT_RECLEN_OFFSET);
			const nameLength = buffer.readUInt16LE(cursor + DIRENT_NAMLEN_OFFSET);
			if (
				recordLength < DIRENT_MIN_BYTES ||
				recordLength > count - cursor ||
				nameLength === 0 ||
				nameLength > DARWIN_PINNED_DIRECTORY_LIMITS.maxComponentBytes ||
				DIRENT_NAME_OFFSET + nameLength >= recordLength ||
				buffer[cursor + DIRENT_NAME_OFFSET + nameLength] !== 0
			) {
				throw invalid("directory entry record is malformed");
			}
			const nameBytes = Buffer.from(
				buffer.subarray(cursor + DIRENT_NAME_OFFSET, cursor + DIRENT_NAME_OFFSET + nameLength),
			);
			if (
				!(nameBytes.length === 1 && nameBytes[0] === 0x2e) &&
				!(nameBytes.length === 2 && nameBytes[0] === 0x2e && nameBytes[1] === 0x2e)
			) {
				let name: string;
				try {
					name = utf8Decoder.decode(nameBytes);
				} catch (cause) {
					throw new DarwinPinnedDirectoryError("directory entry name is not valid UTF-8", { cause });
				}
				validateComponent(name, name);
				entries.push({ name, nameBytes, type: buffer[cursor + DIRENT_TYPE_OFFSET] as number });
			}
			cursor += recordLength;
		}
	}
	entries.sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
	return entries;
}

function verifyRegularEntry(
	lib: SystemLibrary,
	directoryFd: number,
	entry: DirectoryEntry,
	relativePath: string,
): void {
	const fd = openAt(lib, directoryFd, entry.name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, relativePath);
	try {
		if (fstatFd(lib, fd, "fstat", relativePath).type !== "regular")
			throw invalid("directory entry changed type during enumeration", relativePath);
	} finally {
		closeQuietly(lib, fd);
	}
}

function verifySymlinkEntry(
	lib: SystemLibrary,
	directoryFd: number,
	entry: DirectoryEntry,
	relativePath: string,
): void {
	const name = cString(entry.name);
	const byte = Buffer.allocUnsafe(1);
	let result: number;
	for (;;) {
		result = Number(lib.symbols.readlinkat(directoryFd, ptr(name), ptr(byte), 1));
		if (result >= 0) return;
		if (currentErrno(lib) !== EINTR) throw nativeError(lib, "readlinkat", relativePath);
	}
}

function specialTypeName(type: number): string {
	switch (type) {
		case DT_UNKNOWN:
			return "unknown";
		case DT_FIFO:
			return "fifo";
		case DT_CHR:
			return "character-device";
		case DT_BLK:
			return "block-device";
		case DT_SOCK:
			return "socket";
		case DT_WHT:
			return "whiteout";
		default:
			return `type-${type}`;
	}
}

class NativePinnedFile implements PinnedFile {
	readonly fd: number;
	readonly #lib: SystemLibrary;
	readonly #identity: Readonly<Pick<PinnedStat, "dev" | "ino">>;
	readonly #type: "regular" | "directory";
	#closed = false;

	constructor(lib: SystemLibrary, fd: number, stat: PinnedStat, type: "regular" | "directory") {
		this.#lib = lib;
		this.fd = fd;
		this.#identity = { dev: stat.dev, ino: stat.ino };
		this.#type = type;
	}

	async stat(): Promise<PinnedStat> {
		this.#assertOpen();
		const stat = fstatFd(this.#lib, this.fd, "fstat");
		if (!sameIdentity(stat, this.#identity) || stat.type !== this.#type)
			throw invalid("opened file descriptor identity or type changed");
		return stat;
	}

	async read(maxBytes: number): Promise<Buffer> {
		this.#assertOpen();
		if (this.#type !== "regular") throw invalid("cannot read a directory descriptor as a regular file");
		return readRegularFd(this.#lib, this.fd, this.#identity, maxBytes);
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
		return new NativePinnedFile(this.#lib, opened.fd, opened.stat, directory ? "directory" : "regular");
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
			return readlinkAt(this.#lib, parent.fd, parent.name, maxBytes, relativePath);
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
			for (const entry of directoryEntries(this.#lib, directoryFd)) {
				if (visitedEntries === maxEntries)
					throw invalid(`directory enumeration exceeds the ${maxEntries}-entry limit`);
				visitedEntries += 1;
				const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
				const pathBytes = Buffer.byteLength(relativePath);
				if (pathBytes > maxPathBytes || pathBytes > DARWIN_PINNED_DIRECTORY_LIMITS.maxRelativePathBytes) {
					throw invalid(`enumerated path exceeds the ${maxPathBytes}-byte path limit`, relativePath);
				}
				if (entry.type === DT_DIR) {
					const childFd = openDirectoryAt(this.#lib, directoryFd, entry.name, relativePath);
					try {
						visit(childFd, relativePath);
					} finally {
						closeQuietly(this.#lib, childFd);
					}
					continue;
				}
				if (entry.type === DT_REG) verifyRegularEntry(this.#lib, directoryFd, entry, relativePath);
				else if (entry.type === DT_LNK) verifySymlinkEntry(this.#lib, directoryFd, entry, relativePath);
				else throw invalid(`unsupported ${specialTypeName(entry.type)} directory entry`, relativePath);
				if (pathBytes > maxTotalPathBytes - totalPathBytes) {
					throw invalid(`leaf enumeration exceeds the ${maxTotalPathBytes}-byte total output limit`);
				}
				leaves.push(relativePath);
				totalPathBytes += pathBytes;
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
		const stat = fstatFd(this.#lib, this.fd, "fstat");
		if (!sameIdentity(stat, this.identity) || stat.type !== "directory")
			throw invalid("pinned root descriptor identity or type changed");
		return stat;
	}
}

export async function openPinnedDirectory(rootPath: string): Promise<PinnedDirectory> {
	validateRootPath(rootPath);
	const lib = system();
	const path = cString(rootPath);
	const fd = Number(lib.symbols.open(ptr(path), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
	if (fd < 0) throw nativeError(lib, "open", rootPath);
	try {
		const stat = fstatFd(lib, fd, "fstat", rootPath);
		if (stat.type !== "directory") throw invalid("opened root is not a directory", rootPath);
		return new NativePinnedDirectory(lib, fd, stat);
	} catch (error) {
		closeQuietly(lib, fd);
		throw error;
	}
}
