import { dlopen, FFIType, type Library, ptr, read } from "bun:ffi";
import { createHash, timingSafeEqual } from "node:crypto";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 2;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ALTERNATE_CODEDIRECTORIES = 0x1000;
const CSSLOT_ALTERNATE_CODEDIRECTORY_LIMIT = 0x1005;
const POSIX_SPAWN_START_SUSPENDED = 0x0080;
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x4000;
const CS_OPS_CDHASH_WITH_INFO = 18;
const SIGKILL = 9;
const SIGCONT = 19;
const WNOHANG = 1;
const EINTR = 4;
const ESRCH = 3;
const ECHILD = 10;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDTBSDINFO_SIZE = 136;
const BOOTSTRAP_FD = 3;
const MAX_BOOTSTRAP_BYTES = 32;
const MAX_ARGUMENTS = 64;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_C_STRING_BYTES = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 5_000;

type SupportedHashType = 1 | 2 | 3 | 4;
type DarwinSignal = "SIGKILL";

export interface DarwinCodeIdentity {
	readonly cdHash: Buffer;
	readonly hashType: SupportedHashType;
}

export interface DarwinSuspendedChild {
	readonly pid: number;
	readonly bootstrapFd: number;
	readonly exited: Promise<number | null>;
	hasExited(): boolean;
	unref(): void;
	waitForExit(timeoutMs: number): Promise<boolean>;
}

/** Injectable syscall boundary. Production callers normally omit this. */
export interface DarwinVerifiedSpawnNative {
	spawnSuspended(path: string, argv: readonly string[], env: Readonly<Record<string, string>>): DarwinSuspendedChild;
	processStartToken(pid: number): string | null;
	loadedCodeIdentity(pid: number): DarwinCodeIdentity | null;
	writeAll(fd: number, bytes: Uint8Array): void;
	close(fd: number): void;
	signal(pid: number, signal: "SIGKILL" | "SIGCONT"): boolean;
}

export interface DarwinVerifiedSpawnOptions {
	readonly executablePath: string;
	/** Descriptor-verified bytes of executablePath. */
	readonly executableBytes: Uint8Array;
	/** Arguments excluding argv[0]. executablePath is always supplied as argv[0]. */
	readonly argv: readonly string[];
	/** Complete child environment. The parent environment is never inherited. */
	readonly env: Readonly<Record<string, string>>;
	/** At most 32 bytes. This buffer is zeroed on every return path. */
	readonly bootstrap: Uint8Array;
	readonly bindIdentity: (pid: number, startToken: string) => Promise<void>;
	readonly native?: DarwinVerifiedSpawnNative;
}

export type DarwinSignalOutcome = "sent" | "process-exited" | "identity-changed" | "identity-unavailable";

export interface DarwinVerifiedProcess {
	readonly pid: number;
	readonly startToken: string;
	readonly exited: Promise<number | null>;
	unref(): void;
	waitForExit(timeoutMs: number): Promise<boolean>;
	signalIfSame(signal: DarwinSignal): Promise<DarwinSignalOutcome>;
}

export class DarwinVerifiedSpawnError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DarwinVerifiedSpawnError";
	}
}

interface Slice {
	readonly offset: number;
	readonly size: number;
}

interface CodeDirectoryCandidate {
	readonly bytes: Buffer;
	readonly hashType: SupportedHashType;
	readonly rank: number;
}

function checkedRange(total: number, offset: number, length: number, label: string): void {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset > total ||
		length > total - offset
	) {
		throw new DarwinVerifiedSpawnError(`malformed Mach-O: ${label} is out of bounds`);
	}
}

function safeBigUint64(value: bigint, label: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new DarwinVerifiedSpawnError(`malformed Mach-O: ${label} is too large`);
	return Number(value);
}

function arm64Slice(bytes: Buffer): Slice {
	if (bytes.byteLength < 4) throw new DarwinVerifiedSpawnError("malformed Mach-O: missing magic");
	if (bytes.readUInt32LE(0) === MH_MAGIC_64) return { offset: 0, size: bytes.byteLength };
	const magic = bytes.readUInt32BE(0);
	if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64)
		throw new DarwinVerifiedSpawnError("unsupported Mach-O container or byte order");
	if (bytes.byteLength < 8) throw new DarwinVerifiedSpawnError("malformed fat Mach-O header");
	const count = bytes.readUInt32BE(4);
	const archSize = magic === FAT_MAGIC_64 ? 32 : 20;
	if (count === 0 || count > Math.floor((bytes.byteLength - 8) / archSize))
		throw new DarwinVerifiedSpawnError("malformed fat Mach-O architecture table");
	const tableEnd = 8 + count * archSize;
	const regions: Array<Slice & { readonly cpuType: number }> = [];
	for (let index = 0; index < count; index += 1) {
		const base = 8 + index * archSize;
		const cpuType = bytes.readUInt32BE(base);
		const offset =
			magic === FAT_MAGIC_64
				? safeBigUint64(bytes.readBigUInt64BE(base + 8), "fat slice offset")
				: bytes.readUInt32BE(base + 8);
		const size =
			magic === FAT_MAGIC_64
				? safeBigUint64(bytes.readBigUInt64BE(base + 16), "fat slice size")
				: bytes.readUInt32BE(base + 12);
		const align = bytes.readUInt32BE(base + (magic === FAT_MAGIC_64 ? 24 : 16));
		if (magic === FAT_MAGIC_64 && bytes.readUInt32BE(base + 28) !== 0)
			throw new DarwinVerifiedSpawnError("malformed fat64 reserved field");
		if (size === 0 || align > 31) throw new DarwinVerifiedSpawnError("malformed fat Mach-O slice metadata");
		checkedRange(bytes.byteLength, offset, size, "fat slice");
		if (offset < tableEnd || offset % 2 ** align !== 0)
			throw new DarwinVerifiedSpawnError("malformed fat Mach-O slice alignment");
		regions.push({ cpuType, offset, size });
	}
	const ordered = [...regions].sort((left, right) => left.offset - right.offset);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1] as Slice;
		const current = ordered[index] as Slice;
		if (current.offset < previous.offset + previous.size)
			throw new DarwinVerifiedSpawnError("ambiguous overlapping fat Mach-O slices");
	}
	const matches = regions.filter(region => region.cpuType === CPU_TYPE_ARM64);
	if (matches.length !== 1)
		throw new DarwinVerifiedSpawnError(
			matches.length === 0 ? "unsupported Mach-O: no arm64 slice" : "ambiguous Mach-O: multiple arm64 slices",
		);
	return matches[0] as Slice;
}

function hashMetadata(hashType: number): {
	readonly type: SupportedHashType;
	readonly size: number;
	readonly algorithm: "sha1" | "sha256" | "sha384";
	readonly rank: number;
} {
	switch (hashType) {
		case 1:
			return { type: 1, size: 20, algorithm: "sha1", rank: 1 };
		case 3:
			return { type: 3, size: 20, algorithm: "sha256", rank: 2 };
		case 2:
			return { type: 2, size: 32, algorithm: "sha256", rank: 3 };
		case 4:
			return { type: 4, size: 48, algorithm: "sha384", rank: 4 };
		default:
			throw new DarwinVerifiedSpawnError(`unsupported CodeDirectory hash type ${hashType}`);
	}
}

function minimumCodeDirectoryHeader(version: number): number {
	if (version < 0x20001 || version > 0x20600)
		throw new DarwinVerifiedSpawnError(`unsupported CodeDirectory version 0x${version.toString(16)}`);
	if (version >= 0x20600) return 108;
	if (version >= 0x20500) return 96;
	if (version >= 0x20400) return 88;
	if (version >= 0x20300) return 64;
	if (version >= 0x20200) return 52;
	if (version >= 0x20100) return 48;
	return 44;
}

function validateScatter(bytes: Buffer, offset: number): void {
	if (offset === 0) return;
	if (offset < 44 || offset >= bytes.byteLength)
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory scatter offset");
	let cursor = offset;
	let pages = 0;
	while (true) {
		checkedRange(bytes.byteLength, cursor, 24, "CodeDirectory scatter entry");
		const count = bytes.readUInt32BE(cursor);
		if (count === 0) return;
		if (pages + count > 0xffffffff) throw new DarwinVerifiedSpawnError("malformed CodeDirectory scatter page count");
		pages += count;
		cursor += 24;
	}
}

function codeDirectoryCandidate(bytes: Buffer, codeLimitMaximum: number): CodeDirectoryCandidate {
	if (bytes.byteLength < 44 || bytes.readUInt32BE(0) !== CSMAGIC_CODEDIRECTORY)
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory blob");
	const declaredLength = bytes.readUInt32BE(4);
	if (declaredLength !== bytes.byteLength) throw new DarwinVerifiedSpawnError("malformed CodeDirectory length");
	const version = bytes.readUInt32BE(8);
	const headerLength = minimumCodeDirectoryHeader(version);
	if (bytes.byteLength < headerLength) throw new DarwinVerifiedSpawnError("malformed versioned CodeDirectory header");
	if (bytes.readUInt32BE(40) !== 0) throw new DarwinVerifiedSpawnError("malformed CodeDirectory spare field");
	if (version >= 0x20300 && bytes.readUInt32BE(52) !== 0)
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory spare3 field");
	const metadata = hashMetadata(bytes[37] as number);
	if (bytes[36] !== metadata.size) throw new DarwinVerifiedSpawnError("malformed CodeDirectory hash size");
	const pageSize = bytes[39] as number;
	if (pageSize !== 12 && pageSize !== 14)
		throw new DarwinVerifiedSpawnError(`unsupported CodeDirectory page size ${pageSize}`);
	const hashOffset = bytes.readUInt32BE(16);
	const identOffset = bytes.readUInt32BE(20);
	const specialSlots = bytes.readUInt32BE(24);
	const codeSlots = bytes.readUInt32BE(28);
	const codeLimit32 = bytes.readUInt32BE(32);
	let codeLimit = codeLimit32;
	if (version >= 0x20300 && codeLimit32 === 0xffffffff)
		codeLimit = safeBigUint64(bytes.readBigUInt64BE(56), "CodeDirectory code limit");
	if (codeLimit > codeLimitMaximum) throw new DarwinVerifiedSpawnError("malformed CodeDirectory code limit");
	const scatterOffset = version >= 0x20100 ? bytes.readUInt32BE(44) : 0;
	validateScatter(bytes, scatterOffset);
	if (scatterOffset === 0 && codeSlots !== Math.ceil(codeLimit / 2 ** pageSize))
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory code slot count");
	if (hashOffset > bytes.byteLength || specialSlots > Math.floor(hashOffset / metadata.size))
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory special hash slots");
	if (codeSlots > Math.floor((bytes.byteLength - hashOffset) / metadata.size))
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory code hash slots");
	if (identOffset < headerLength || identOffset >= bytes.byteLength || bytes.indexOf(0, identOffset) < 0)
		throw new DarwinVerifiedSpawnError("malformed CodeDirectory identifier");
	if (version >= 0x20200) {
		const teamOffset = bytes.readUInt32BE(48);
		if (
			teamOffset !== 0 &&
			(teamOffset < headerLength || teamOffset >= bytes.byteLength || bytes.indexOf(0, teamOffset) < 0)
		)
			throw new DarwinVerifiedSpawnError("malformed CodeDirectory team identifier");
	}
	if (version >= 0x20600 && bytes[96] !== 0) {
		const linkageOffset = bytes.readUInt32BE(100);
		const linkageSize = bytes.readUInt32BE(104);
		checkedRange(bytes.byteLength, linkageOffset, linkageSize, "CodeDirectory linkage");
	}
	return { bytes, hashType: metadata.type, rank: metadata.rank };
}

function selectCodeDirectory(signature: Buffer, codeLimitMaximum: number): CodeDirectoryCandidate {
	if (signature.byteLength < 8) throw new DarwinVerifiedSpawnError("malformed code signature blob");
	const magic = signature.readUInt32BE(0);
	const declaredLength = signature.readUInt32BE(4);
	if (declaredLength < 8 || declaredLength > signature.byteLength)
		throw new DarwinVerifiedSpawnError("malformed code signature length");
	if (magic === CSMAGIC_CODEDIRECTORY)
		return codeDirectoryCandidate(signature.subarray(0, declaredLength), codeLimitMaximum);
	if (magic !== CSMAGIC_EMBEDDED_SIGNATURE || declaredLength < 12)
		throw new DarwinVerifiedSpawnError("unsupported code signature container");
	const superBlob = signature.subarray(0, declaredLength);
	const count = superBlob.readUInt32BE(8);
	if (count > Math.floor((declaredLength - 12) / 8)) throw new DarwinVerifiedSpawnError("malformed SuperBlob index");
	const tableEnd = 12 + count * 8;
	const regions: Slice[] = [];
	const candidates: CodeDirectoryCandidate[] = [];
	for (let index = 0; index < count; index += 1) {
		const base = 12 + index * 8;
		const slot = superBlob.readUInt32BE(base);
		const offset = superBlob.readUInt32BE(base + 4);
		if (offset < tableEnd) throw new DarwinVerifiedSpawnError("malformed SuperBlob child offset");
		checkedRange(declaredLength, offset, 8, "SuperBlob child header");
		const childLength = superBlob.readUInt32BE(offset + 4);
		if (childLength < 8) throw new DarwinVerifiedSpawnError("malformed SuperBlob child length");
		checkedRange(declaredLength, offset, childLength, "SuperBlob child");
		regions.push({ offset, size: childLength });
		if (
			slot === CSSLOT_CODEDIRECTORY ||
			(slot >= CSSLOT_ALTERNATE_CODEDIRECTORIES && slot < CSSLOT_ALTERNATE_CODEDIRECTORY_LIMIT)
		) {
			candidates.push(codeDirectoryCandidate(superBlob.subarray(offset, offset + childLength), codeLimitMaximum));
		}
	}
	const ordered = [...regions].sort((left, right) => left.offset - right.offset);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1] as Slice;
		const current = ordered[index] as Slice;
		if (current.offset < previous.offset + previous.size)
			throw new DarwinVerifiedSpawnError("ambiguous overlapping SuperBlob children");
	}
	if (candidates.length === 0)
		throw new DarwinVerifiedSpawnError("code signature has no supported CodeDirectory slot");
	let best = candidates[0] as CodeDirectoryCandidate;
	const ranks = new Set<number>();
	for (const candidate of candidates) {
		if (ranks.has(candidate.rank)) throw new DarwinVerifiedSpawnError("ambiguous duplicate CodeDirectory hash rank");
		ranks.add(candidate.rank);
		if (candidate.rank > best.rank) best = candidate;
	}
	return best;
}

/** Parse the kernel-selected arm64 CodeDirectory identity from verified Mach-O bytes. */
export function parseDarwinArm64CodeIdentity(input: Uint8Array): DarwinCodeIdentity {
	const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const slice = arm64Slice(bytes);
	checkedRange(bytes.byteLength, slice.offset, slice.size, "arm64 slice");
	const macho = bytes.subarray(slice.offset, slice.offset + slice.size);
	if (macho.byteLength < 32 || macho.readUInt32LE(0) !== MH_MAGIC_64)
		throw new DarwinVerifiedSpawnError("unsupported arm64 Mach-O header");
	if (macho.readUInt32LE(4) !== CPU_TYPE_ARM64) throw new DarwinVerifiedSpawnError("Mach-O slice is not arm64");
	if (macho.readUInt32LE(12) !== MH_EXECUTE) throw new DarwinVerifiedSpawnError("unsupported Mach-O file type");
	const commandCount = macho.readUInt32LE(16);
	const commandBytes = macho.readUInt32LE(20);
	checkedRange(macho.byteLength, 32, commandBytes, "load command table");
	if (commandCount === 0 || commandCount > Math.floor(commandBytes / 8))
		throw new DarwinVerifiedSpawnError("malformed Mach-O load command count");
	let cursor = 32;
	let signature: Slice | undefined;
	for (let index = 0; index < commandCount; index += 1) {
		checkedRange(32 + commandBytes, cursor, 8, "load command header");
		const command = macho.readUInt32LE(cursor);
		const size = macho.readUInt32LE(cursor + 4);
		if (size < 8 || size % 8 !== 0) throw new DarwinVerifiedSpawnError("malformed Mach-O load command size");
		checkedRange(32 + commandBytes, cursor, size, "load command");
		if (command === LC_CODE_SIGNATURE) {
			if (signature !== undefined || size !== 16)
				throw new DarwinVerifiedSpawnError("ambiguous or malformed LC_CODE_SIGNATURE");
			const offset = macho.readUInt32LE(cursor + 8);
			const length = macho.readUInt32LE(cursor + 12);
			if (length === 0 || offset < 32 + commandBytes)
				throw new DarwinVerifiedSpawnError("malformed LC_CODE_SIGNATURE range");
			checkedRange(macho.byteLength, offset, length, "LC_CODE_SIGNATURE data");
			signature = { offset, size: length };
		}
		cursor += size;
	}
	if (cursor !== 32 + commandBytes) throw new DarwinVerifiedSpawnError("malformed Mach-O load command table size");
	if (signature === undefined) throw new DarwinVerifiedSpawnError("Mach-O has no LC_CODE_SIGNATURE");
	const candidate = selectCodeDirectory(
		macho.subarray(signature.offset, signature.offset + signature.size),
		signature.offset,
	);
	const metadata = hashMetadata(candidate.hashType);
	const digest = createHash(metadata.algorithm).update(candidate.bytes).digest();
	return { hashType: candidate.hashType, cdHash: Buffer.from(digest.subarray(0, 20)) };
}

function cString(value: string, label: string): Buffer {
	if (value.includes("\0")) throw new DarwinVerifiedSpawnError(`${label} contains NUL`);
	return Buffer.from(`${value}\0`, "utf8");
}

class CStringVector {
	readonly strings: Buffer[];
	readonly pointers: BigUint64Array;

	constructor(values: readonly string[], label: string) {
		this.strings = values.map((value, index) => cString(value, `${label}[${index}]`));
		const total = this.strings.reduce((sum, value) => sum + value.byteLength, 0);
		if (total > MAX_C_STRING_BYTES) throw new DarwinVerifiedSpawnError(`${label} exceeds native byte limit`);
		this.pointers = new BigUint64Array(this.strings.length + 1);
		for (let index = 0; index < this.strings.length; index += 1)
			this.pointers[index] = BigInt(ptr(this.strings[index] as Buffer));
	}
}

const SYSTEM_SYMBOLS = {
	posix_spawn: {
		args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
		returns: FFIType.i32,
	},
	posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
	posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
	posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
	posix_spawn_file_actions_init: { args: [FFIType.ptr], returns: FFIType.i32 },
	posix_spawn_file_actions_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
	posix_spawn_file_actions_adddup2: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	posix_spawn_file_actions_addclose: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
	close: { args: [FFIType.i32], returns: FFIType.i32 },
	write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	csops: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;
const PROC_SYMBOLS = {
	proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

interface NativeLibraries {
	readonly system: Library<typeof SYSTEM_SYMBOLS>;
	readonly proc: Library<typeof PROC_SYMBOLS>;
}

let libraries: NativeLibraries | undefined;

function nativeLibraries(): NativeLibraries {
	if (process.platform !== "darwin")
		throw new DarwinVerifiedSpawnError(`Darwin verified spawn is unsupported on ${process.platform}`);
	libraries ??= {
		system: dlopen("/usr/lib/libSystem.B.dylib", SYSTEM_SYMBOLS),
		proc: dlopen("/usr/lib/libproc.dylib", PROC_SYMBOLS),
	};
	return libraries;
}

function errno(system: NativeLibraries["system"]): number {
	const address = system.symbols.__error();
	return address === null ? 0 : read.i32(address);
}

function checkDirectError(operation: string, result: number): void {
	if (result !== 0) throw new DarwinVerifiedSpawnError(`${operation} failed with errno ${result}`);
}

class NativeChild implements DarwinSuspendedChild {
	readonly exited: Promise<number | null>;
	readonly #resolve: (status: number | null) => void;
	#settled = false;
	#unreferenced = false;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		readonly pid: number,
		readonly bootstrapFd: number,
		private readonly system: NativeLibraries["system"],
	) {
		const deferred = Promise.withResolvers<number | null>();
		this.exited = deferred.promise;
		this.#resolve = deferred.resolve;
		this.#poll();
	}

	hasExited(): boolean {
		return this.#settled;
	}

	unref(): void {
		this.#unreferenced = true;
		this.#timer?.unref();
	}
	async waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.#settled) return true;
		if (timeoutMs <= 0) return false;
		return await Promise.race([
			this.exited.then(() => true),
			new Promise<false>(resolve => {
				const timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref();
			}),
		]);
	}

	#poll(): void {
		const status = new Int32Array(1);
		const result = Number(this.system.symbols.waitpid(this.pid, ptr(status), WNOHANG));
		if (result === this.pid) {
			this.#settled = true;
			const raw = status[0] as number;
			this.#resolve((raw & 0x7f) === 0 ? (raw >>> 8) & 0xff : null);
			return;
		}
		if (result < 0) {
			const code = errno(this.system);
			if (code === ECHILD) {
				this.#settled = true;
				this.#resolve(null);
				return;
			}
		}
		this.#timer = setTimeout(() => this.#poll(), 10);
		if (this.#unreferenced) this.#timer.unref();
	}
}

class BunDarwinVerifiedSpawnNative implements DarwinVerifiedSpawnNative {
	readonly #libraries = nativeLibraries();

	spawnSuspended(path: string, argv: readonly string[], env: Readonly<Record<string, string>>): DarwinSuspendedChild {
		if (argv.length > MAX_ARGUMENTS) throw new DarwinVerifiedSpawnError("argument count exceeds native limit");
		const entries = Object.entries(env);
		if (entries.length > MAX_ENVIRONMENT_ENTRIES)
			throw new DarwinVerifiedSpawnError("environment count exceeds native limit");
		for (const [key] of entries)
			if (key.length === 0 || key.includes("=") || key.includes("\0"))
				throw new DarwinVerifiedSpawnError("environment contains an invalid key");
		const pathBytes = cString(path, "executable path");
		const argvVector = new CStringVector([path, ...argv], "argv");
		const envVector = new CStringVector(
			entries.map(([key, value]) => `${key}=${value}`),
			"env",
		);
		const pipeFds = new Int32Array(2);
		const attributes = new BigUint64Array(1);
		const actions = new BigUint64Array(1);
		let attributesInitialized = false;
		let actionsInitialized = false;
		let pipeOpen = false;
		let spawned = false;
		try {
			if (Number(this.#libraries.system.symbols.pipe(ptr(pipeFds))) !== 0)
				throw new DarwinVerifiedSpawnError(`pipe failed with errno ${errno(this.#libraries.system)}`);
			pipeOpen = true;
			checkDirectError(
				"posix_spawnattr_init",
				Number(this.#libraries.system.symbols.posix_spawnattr_init(ptr(attributes))),
			);
			attributesInitialized = true;
			checkDirectError(
				"posix_spawnattr_setflags",
				Number(
					this.#libraries.system.symbols.posix_spawnattr_setflags(
						ptr(attributes),
						POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT,
					),
				),
			);
			checkDirectError(
				"posix_spawn_file_actions_init",
				Number(this.#libraries.system.symbols.posix_spawn_file_actions_init(ptr(actions))),
			);
			actionsInitialized = true;
			checkDirectError(
				"posix_spawn_file_actions_adddup2",
				Number(
					this.#libraries.system.symbols.posix_spawn_file_actions_adddup2(
						ptr(actions),
						pipeFds[0] as number,
						BOOTSTRAP_FD,
					),
				),
			);
			if (pipeFds[0] !== BOOTSTRAP_FD)
				checkDirectError(
					"posix_spawn_file_actions_addclose(read)",
					Number(
						this.#libraries.system.symbols.posix_spawn_file_actions_addclose(ptr(actions), pipeFds[0] as number),
					),
				);
			checkDirectError(
				"posix_spawn_file_actions_addclose(write)",
				Number(
					this.#libraries.system.symbols.posix_spawn_file_actions_addclose(ptr(actions), pipeFds[1] as number),
				),
			);
			const pid = new Int32Array(1);
			checkDirectError(
				"posix_spawn",
				Number(
					this.#libraries.system.symbols.posix_spawn(
						ptr(pid),
						ptr(pathBytes),
						ptr(actions),
						ptr(attributes),
						ptr(argvVector.pointers),
						ptr(envVector.pointers),
					),
				),
			);
			spawned = true;
			if (Number(this.#libraries.system.symbols.close(pipeFds[0] as number)) !== 0)
				throw new DarwinVerifiedSpawnError(`close(read pipe) failed with errno ${errno(this.#libraries.system)}`);
			pipeFds[0] = -1;
			return new NativeChild(pid[0] as number, pipeFds[1] as number, this.#libraries.system);
		} finally {
			if (actionsInitialized) this.#libraries.system.symbols.posix_spawn_file_actions_destroy(ptr(actions));
			if (attributesInitialized) this.#libraries.system.symbols.posix_spawnattr_destroy(ptr(attributes));
			if (pipeOpen && pipeFds[0] >= 0) this.#libraries.system.symbols.close(pipeFds[0] as number);
			if (pipeOpen && !spawned && pipeFds[1] >= 0) this.#libraries.system.symbols.close(pipeFds[1] as number);
		}
	}

	processStartToken(pid: number): string | null {
		const info = new Uint8Array(PROC_PIDTBSDINFO_SIZE);
		const size = Number(
			this.#libraries.proc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), info.byteLength),
		);
		const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
		if (size !== info.byteLength || view.getUint32(12, true) !== pid) return null;
		const seconds = view.getBigUint64(120, true);
		const microseconds = view.getBigUint64(128, true);
		if (seconds === 0n || microseconds >= 1_000_000n) return null;
		return `darwin:${seconds}:${microseconds}`;
	}

	loadedCodeIdentity(pid: number): DarwinCodeIdentity | null {
		const result = Buffer.alloc(21);
		if (
			Number(this.#libraries.system.symbols.csops(pid, CS_OPS_CDHASH_WITH_INFO, ptr(result), result.byteLength)) !==
			0
		)
			return null;
		const metadata = hashMetadata(result[20] as number);
		return { hashType: metadata.type, cdHash: Buffer.from(result.subarray(0, 20)) };
	}

	writeAll(fd: number, bytes: Uint8Array): void {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const written = Number(
				this.#libraries.system.symbols.write(fd, ptr(bytes, offset), bytes.byteLength - offset),
			);
			if (written > 0) {
				offset += written;
				continue;
			}
			const code = errno(this.#libraries.system);
			if (written < 0 && code === EINTR) continue;
			throw new DarwinVerifiedSpawnError(`write bootstrap failed with errno ${code}`);
		}
	}

	close(fd: number): void {
		if (Number(this.#libraries.system.symbols.close(fd)) !== 0)
			throw new DarwinVerifiedSpawnError(`close bootstrap pipe failed with errno ${errno(this.#libraries.system)}`);
	}

	signal(pid: number, signal: "SIGKILL" | "SIGCONT"): boolean {
		if (Number(this.#libraries.system.symbols.kill(pid, signal === "SIGKILL" ? SIGKILL : SIGCONT)) === 0) return true;
		const code = errno(this.#libraries.system);
		if (code === ESRCH) return false;
		throw new DarwinVerifiedSpawnError(`${signal} failed with errno ${code}`);
	}
}
let defaultNative: BunDarwinVerifiedSpawnNative | undefined;
function defaultDarwinVerifiedSpawnNative(): BunDarwinVerifiedSpawnNative {
	defaultNative ??= new BunDarwinVerifiedSpawnNative();
	return defaultNative;
}

export function darwinProcessStartToken(pid: number): string | null {
	return defaultDarwinVerifiedSpawnNative().processStartToken(pid);
}

function identitiesEqual(expected: DarwinCodeIdentity, actual: DarwinCodeIdentity): boolean {
	return (
		expected.hashType === actual.hashType &&
		expected.cdHash.byteLength === 20 &&
		actual.cdHash.byteLength === 20 &&
		timingSafeEqual(expected.cdHash, actual.cdHash)
	);
}

async function cleanupFailedSpawn(
	native: DarwinVerifiedSpawnNative,
	child: DarwinSuspendedChild,
	pipeOpen: boolean,
): Promise<void> {
	if (pipeOpen) {
		try {
			native.close(child.bootstrapFd);
		} catch {
			// Preserve the attestation failure; the descriptor is still closed by process exit.
		}
	}
	if (!child.hasExited()) {
		try {
			native.signal(child.pid, "SIGKILL");
		} catch {
			// The direct stopped child is still reaped below.
		}
	}
	if (!(await child.waitForExit(CLEANUP_TIMEOUT_MS))) {
		throw new DarwinVerifiedSpawnError("failed to reap stopped child after verified spawn failure");
	}
}

/**
 * Spawn an arm64 Mach-O stopped before user code, attest the kernel-loaded
 * CodeDirectory, bind its stable process token, deliver fd3 bootstrap bytes,
 * and send SIGCONT as the final operation.
 */
export async function spawnDarwinVerified(options: DarwinVerifiedSpawnOptions): Promise<DarwinVerifiedProcess> {
	if (options.bootstrap.byteLength === 0 || options.bootstrap.byteLength > MAX_BOOTSTRAP_BYTES) {
		options.bootstrap.fill(0);
		throw new DarwinVerifiedSpawnError(`bootstrap must contain 1..${MAX_BOOTSTRAP_BYTES} bytes`);
	}
	const native = options.native ?? defaultDarwinVerifiedSpawnNative();
	let child: DarwinSuspendedChild | undefined;
	let startToken: string | undefined;
	let pipeOpen = false;
	let resumed = false;
	try {
		const expectedIdentity = parseDarwinArm64CodeIdentity(options.executableBytes);
		child = native.spawnSuspended(options.executablePath, options.argv, options.env);
		pipeOpen = true;
		startToken = native.processStartToken(child.pid) ?? undefined;
		if (startToken === undefined) throw new DarwinVerifiedSpawnError("spawned process start identity is unavailable");
		const loadedIdentity = native.loadedCodeIdentity(child.pid);
		if (loadedIdentity === null) throw new DarwinVerifiedSpawnError("spawned process code identity is unavailable");
		if (native.processStartToken(child.pid) !== startToken)
			throw new DarwinVerifiedSpawnError("spawned process identity changed during attestation");
		if (!identitiesEqual(expectedIdentity, loadedIdentity))
			throw new DarwinVerifiedSpawnError("spawned process code identity does not match verified bytes");
		await options.bindIdentity(child.pid, startToken);
		native.writeAll(child.bootstrapFd, options.bootstrap);
		native.close(child.bootstrapFd);
		pipeOpen = false;
		if (native.processStartToken(child.pid) !== startToken)
			throw new DarwinVerifiedSpawnError("spawned process identity changed before resume");
		if (!native.signal(child.pid, "SIGCONT"))
			throw new DarwinVerifiedSpawnError("spawned process exited before resume");
		resumed = true;
		const verifiedChild = child;
		const verifiedStartToken = startToken;
		return {
			pid: verifiedChild.pid,
			startToken: verifiedStartToken,
			exited: verifiedChild.exited,
			unref: () => verifiedChild.unref(),
			waitForExit: timeoutMs => verifiedChild.waitForExit(timeoutMs),
			signalIfSame: async signal => {
				const current = native.processStartToken(verifiedChild.pid);
				if (current === null)
					return (await verifiedChild.waitForExit(0)) ? "process-exited" : "identity-unavailable";
				if (current !== verifiedStartToken) return "identity-changed";
				return native.signal(verifiedChild.pid, signal) ? "sent" : "process-exited";
			},
		};
	} catch (error) {
		if (child !== undefined && !resumed) await cleanupFailedSpawn(native, child, pipeOpen);
		if (error instanceof DarwinVerifiedSpawnError) throw error;
		throw new DarwinVerifiedSpawnError("Darwin verified spawn failed", { cause: error });
	} finally {
		options.bootstrap.fill(0);
	}
}
