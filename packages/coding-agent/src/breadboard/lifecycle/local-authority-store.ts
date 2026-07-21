import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import type { OwnerExitPolicy } from "./run-config";

export const AUTHORITY_RECORD_SCHEMA_VERSION = "p30.local-authority.v4" as const;

export interface LocalAuthorityRecord {
	readonly schemaVersion: typeof AUTHORITY_RECORD_SCHEMA_VERSION;
	readonly recordRevision: string;
	readonly engineInstanceId: string;
	readonly engineBootId: string;
	readonly launchId: string;
	readonly ownerGeneration: number;
	readonly pid: number;
	readonly osProcessStartToken: string;
	readonly normalizedEndpoint: string;
	readonly executableSha256: string;
	readonly executablePathSha256: string;
	readonly argvSha256: string;
	readonly engineArtifactSha256: string;
	readonly servedBackendCommit: string;
	readonly ownerExitPolicy: OwnerExitPolicy;
	readonly ownerCredentialRef: string;
	readonly ownerCredentialVerifier: string;
	readonly createdAt: string;
	readonly lastVerifiedAt: string;
}

export interface LocalControlAttempt {
	readonly schemaVersion: "p30.local-control-attempt.v3";
	readonly recordRevision: string;
	readonly engineInstanceId: string;
	readonly engineBootId: string;
	readonly launchId: string;
	readonly ownerGeneration: number;
	readonly operation: "stop" | "restart";
	readonly controlRequestId: string;
	readonly registrationId: string;
	readonly requesterRegistrationGeneration: number;
	readonly requesterClientInstanceId: string;
	readonly requesterCredentialRef: string;
	readonly requesterCredentialVerifier: string;
	readonly expectedAdmissionEpoch: number;
	readonly phase: "begin-pending" | "draining" | "graceful-accepted" | "hard-signal-pending" | "hard-signal-commit-pending";
	readonly drainGeneration?: number;
	readonly createdAtUnix: number;
}
export interface ControlAttemptSecret {
	readonly requesterRegistrationCredential: Buffer;
}
interface ControlAttemptRequester {
	readonly registrationId: string;
	readonly registrationGeneration: number;
	readonly clientInstanceId: string;
	readonly registrationCredential: string;
	readonly admissionEpoch: number;
}


export interface AuthoritySecret {
	readonly ownerCredential: Buffer;
}

export interface PendingStartSecret extends AuthoritySecret {
	readonly bootstrapCredential: Buffer;
}

export interface LocalStartClaim {
	readonly schemaVersion: "p30.local-start-claim.v4";
	readonly token: string;
	readonly pid: number;
	readonly processStartToken: string;
	readonly createdAtUnix: number;
	readonly launchId?: string;
	readonly executableSha256?: string;
	readonly executablePathSha256?: string;
	readonly argvSha256?: string;
	readonly engineArtifactSha256?: string;
	readonly servedBackendCommit?: string;
	readonly pendingSecretRef?: string;
	readonly pendingSecretVerifier?: string;
	readonly enginePid?: number;
	readonly engineProcessStartToken?: string;
	readonly ownerAttemptGeneration?: number;
}

export type StartClaimResult =
	| { readonly kind: "claimed"; readonly claim: LocalStartClaim }
	| { readonly kind: "recoverable"; readonly claim: LocalStartClaim }
	| { readonly kind: "unbound"; readonly claim: LocalStartClaim }
	| { readonly kind: "dead-bound"; readonly claim: LocalStartClaim }
	| { readonly kind: "occupied"; readonly claim: LocalStartClaim };

export interface PrepareStartClaimInput {
	readonly launchId: string;
	readonly executableSha256: string;
	readonly executablePathSha256: string;
	readonly argvSha256: string;
	readonly engineArtifactSha256: string;
	readonly servedBackendCommit: string;
}

export interface LocalAuthorityStoreSeams {
	readonly uid?: () => number;
	readonly now?: () => number;
	readonly randomId?: () => string;
	readonly processStartToken?: () => string;
	readonly isLockOwnerAlive?: (owner: { readonly pid: number; readonly processStartToken: string }) => Promise<boolean | "ambiguous">;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly beforeSecureOpen?: (path: string) => void | Promise<void>;
	readonly beforeAtomicRename?: (from: string, to: string) => void | Promise<void>;
	readonly beforeUnlink?: (path: string) => void | Promise<void>;
	readonly beforeLockIdentityCheck?: (path: string) => void | Promise<void>;
}

export type AuthorityStoreErrorCode =
	| "root_integrity"
	| "record_integrity"
	| "authority_record_invalid"
	| "lock_timeout"
	| "lock_integrity"
	| "generation_conflict"
	| "secret_integrity"
	| "secret_verifier_mismatch"
	| "control_attempt_integrity"
	| "start_claim_integrity";

export class LocalAuthorityStoreError extends Error {
	readonly name = "LocalAuthorityStoreError";
	constructor(readonly code: AuthorityStoreErrorCode, message: string) {
		super(message);
	}
}

interface LockOwner {
	readonly schemaVersion: "p30.local-authority-lock.v2";
	readonly token: string;
	readonly pid: number;
	readonly processStartToken: string;
	readonly createdAtUnix: number;
}



interface RootIdentity {
	readonly dev: number | bigint;
	readonly ino: number | bigint;
}

const RECORD_KEYS: ReadonlyArray<keyof LocalAuthorityRecord> = [
	"schemaVersion",
	"recordRevision",
	"engineInstanceId",
	"engineBootId",
	"launchId",
	"ownerGeneration",
	"pid",
	"executablePathSha256",
	"argvSha256",
	"osProcessStartToken",
	"normalizedEndpoint",
	"executableSha256",
	"engineArtifactSha256",
	"servedBackendCommit",
	"ownerExitPolicy",
	"ownerCredentialRef",
	"ownerCredentialVerifier",
	"createdAt",
	"lastVerifiedAt",
];
const OPAQUE = /^[A-Za-z0-9_-]{20,128}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SECRET_REF = /^[0-9a-f]{64}\.secret\.[1-9][0-9]*\.[A-Za-z0-9_-]{20,128}\.bin$/;
const PENDING_SECRET_REF = /^[0-9a-f]{64}\.starting\.secret\.[A-Za-z0-9_-]{20,128}\.bin$/;
const CONTROL_SECRET_REF = /^[0-9a-f]{64}\.control\.secret\.[A-Za-z0-9_-]{20,128}\.bin$/;
const AUTHORITY_SECRET_MAGIC = Buffer.from("p30.local-authority-secret.v2\0", "utf8");
const PENDING_SECRET_MAGIC = Buffer.from("p30.local-start-secret.v3\0", "utf8");
const CONTROL_SECRET_MAGIC = Buffer.from("p30.local-control-secret.v1\0", "utf8");
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function loadNativeSystem() {
	const symbols = {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
		unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	} as const;
	if (process.platform === "darwin") {
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			...symbols,
			__error: { args: [], returns: FFIType.ptr },
		});
		return {
			flock: library.symbols.flock,
			openat: library.symbols.openat,
			renameat: library.symbols.renameat,
			unlinkat: library.symbols.unlinkat,
			errnoPointer: library.symbols.__error,
		};
	}
	if (process.platform === "linux") {
		const library = dlopen("libc.so.6", {
			...symbols,
			__errno_location: { args: [], returns: FFIType.ptr },
		});
		return {
			flock: library.symbols.flock,
			openat: library.symbols.openat,
			renameat: library.symbols.renameat,
			unlinkat: library.symbols.unlinkat,
			errnoPointer: library.symbols.__errno_location,
		};
	}
	return null;
}

const nativeSystem = loadNativeSystem();

function requireNativeSystem(): NonNullable<typeof nativeSystem> {
	if (nativeSystem === null) throw new Error(`Local authority storage is unsupported on ${process.platform}`);
	return nativeSystem;
}

const libproc =
	process.platform === "darwin"
		? dlopen("/usr/lib/libproc.dylib", {
				proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			})
		: null;

function endpointKey(endpoint: string): string {
	return createHash("sha256").update(endpoint).digest("hex");
}

function darwinProcessStartToken(pid: number): string | null {
	if (libproc === null || !Number.isSafeInteger(pid) || pid < 1) return null;
	const info = new Uint8Array(136);
	const size = libproc.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.byteLength);
	const view = new DataView(info.buffer);
	if (size !== info.byteLength || view.getUint32(12, true) !== pid) return null;
	const seconds = view.getBigUint64(120, true);
	const microseconds = view.getBigUint64(128, true);
	if (seconds === 0n || microseconds >= 1_000_000n) return null;
	return `darwin:${seconds}:${microseconds}`;
}

function isOpaqueBuffer(value: Uint8Array): boolean {
	if (value.byteLength < 20 || value.byteLength > 128) return false;
	for (const byte of value) {
		if (!(
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			(byte >= 0x30 && byte <= 0x39) ||
			byte === 0x5f ||
			byte === 0x2d
		)) return false;
	}
	return true;
}

function credentialVerifier(credential: Uint8Array): string {
	return `sha256:${createHash("sha256").update("breadboard-owner-credential-v2\0").update(credential).digest("hex")}`;
}

function pendingSecretVerifier(secret: PendingStartSecret): string {
	return `sha256:${createHash("sha256")
		.update("breadboard-pending-start-v3\0")
		.update(secret.bootstrapCredential)
		.update("\0")
		.update(secret.ownerCredential)
		.digest("hex")}`;
}
function controlSecretVerifier(credential: Uint8Array): string {
	return `sha256:${createHash("sha256")
		.update("breadboard-control-requester-credential-v1\0")
		.update(credential)
		.digest("hex")}`;
}

function encodeAuthoritySecret(secret: AuthoritySecret): Buffer {
	if (!isOpaqueBuffer(secret.ownerCredential)) {
		throw new LocalAuthorityStoreError("secret_integrity", "owner credential is invalid");
	}
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(secret.ownerCredential.byteLength, 0);
	return Buffer.concat([AUTHORITY_SECRET_MAGIC, length, secret.ownerCredential]);
}

function decodeAuthoritySecret(bytes: Buffer): AuthoritySecret {
	const headerLength = AUTHORITY_SECRET_MAGIC.byteLength + 4;
	if (bytes.byteLength < headerLength || !bytes.subarray(0, AUTHORITY_SECRET_MAGIC.byteLength).equals(AUTHORITY_SECRET_MAGIC)) {
		throw new LocalAuthorityStoreError("secret_integrity", "owner credential record is invalid");
	}
	const ownerLength = bytes.readUInt32BE(AUTHORITY_SECRET_MAGIC.byteLength);
	if (headerLength + ownerLength !== bytes.byteLength) {
		throw new LocalAuthorityStoreError("secret_integrity", "owner credential record is invalid");
	}
	const ownerCredential = Buffer.from(bytes.subarray(headerLength));
	if (!isOpaqueBuffer(ownerCredential)) {
		ownerCredential.fill(0);
		throw new LocalAuthorityStoreError("secret_integrity", "owner credential record is invalid");
	}
	return { ownerCredential };
}
function encodeControlSecret(secret: ControlAttemptSecret): Buffer {
	if (!isOpaqueBuffer(secret.requesterRegistrationCredential)) {
		throw new LocalAuthorityStoreError("secret_integrity", "control requester credential is invalid");
	}
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(secret.requesterRegistrationCredential.byteLength, 0);
	return Buffer.concat([CONTROL_SECRET_MAGIC, length, secret.requesterRegistrationCredential]);
}

function decodeControlSecret(bytes: Buffer): ControlAttemptSecret {
	const headerLength = CONTROL_SECRET_MAGIC.byteLength + 4;
	if (bytes.byteLength < headerLength || !bytes.subarray(0, CONTROL_SECRET_MAGIC.byteLength).equals(CONTROL_SECRET_MAGIC)) {
		throw new LocalAuthorityStoreError("secret_integrity", "control requester credential record is invalid");
	}
	const credentialLength = bytes.readUInt32BE(CONTROL_SECRET_MAGIC.byteLength);
	if (headerLength + credentialLength !== bytes.byteLength) {
		throw new LocalAuthorityStoreError("secret_integrity", "control requester credential record is invalid");
	}
	const requesterRegistrationCredential = Buffer.from(bytes.subarray(headerLength));
	if (!isOpaqueBuffer(requesterRegistrationCredential)) {
		requesterRegistrationCredential.fill(0);
		throw new LocalAuthorityStoreError("secret_integrity", "control requester credential record is invalid");
	}
	return { requesterRegistrationCredential };
}

function encodePendingSecret(secret: PendingStartSecret): Buffer {
	if (secret.bootstrapCredential.byteLength !== 32 || !isOpaqueBuffer(secret.ownerCredential)) {
		throw new LocalAuthorityStoreError("secret_integrity", "pending launch credential is invalid");
	}
	const lengths = Buffer.allocUnsafe(8);
	lengths.writeUInt32BE(secret.bootstrapCredential.byteLength, 0);
	lengths.writeUInt32BE(secret.ownerCredential.byteLength, 4);
	return Buffer.concat([PENDING_SECRET_MAGIC, lengths, secret.bootstrapCredential, secret.ownerCredential]);
}

function decodePendingSecret(bytes: Buffer): PendingStartSecret {
	const headerLength = PENDING_SECRET_MAGIC.byteLength + 8;
	if (bytes.byteLength < headerLength || !bytes.subarray(0, PENDING_SECRET_MAGIC.byteLength).equals(PENDING_SECRET_MAGIC)) {
		throw new LocalAuthorityStoreError("secret_integrity", "pending launch secret is invalid");
	}
	const bootstrapLength = bytes.readUInt32BE(PENDING_SECRET_MAGIC.byteLength);
	const ownerLength = bytes.readUInt32BE(PENDING_SECRET_MAGIC.byteLength + 4);
	if (bootstrapLength !== 32 || headerLength + bootstrapLength + ownerLength !== bytes.byteLength) {
		throw new LocalAuthorityStoreError("secret_integrity", "pending launch secret is invalid");
	}
	const bootstrapCredential = Buffer.from(bytes.subarray(headerLength, headerLength + bootstrapLength));
	const ownerCredential = Buffer.from(bytes.subarray(headerLength + bootstrapLength));
	if (!isOpaqueBuffer(ownerCredential)) {
		bootstrapCredential.fill(0);
		ownerCredential.fill(0);
		throw new LocalAuthorityStoreError("secret_integrity", "pending launch secret is invalid");
	}
	return { bootstrapCredential, ownerCredential };
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function systemError(operation: string, name: string): NodeJS.ErrnoException {
	const pointer = requireNativeSystem().errnoPointer();
	if (pointer === null) throw new Error(`${operation} failed without errno for ${name}`);
	const errno = new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
	const error = new Error(`${operation} failed for ${name}`) as NodeJS.ErrnoException;
	error.errno = errno;
	error.code = errno === 2 ? "ENOENT" : errno === 13 ? "EACCES" : errno === 17 ? "EEXIST" : `ERRNO_${errno}`;
	error.path = name;
	return error;
}

function relativeName(pathOrName: string): string {
	const name = basename(pathOrName);
	if (name !== pathOrName && !pathOrName.endsWith(`/${name}`)) {
		throw new LocalAuthorityStoreError("root_integrity", "authority child path is invalid");
	}
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
		throw new LocalAuthorityStoreError("root_integrity", "authority child name is invalid");
	}
	return name;
}

function cPath(name: string): Buffer {
	return Buffer.from(`${name}\0`, "utf8");
}

function sameRecord(left: LocalAuthorityRecord, right: LocalAuthorityRecord): boolean {
	return RECORD_KEYS.every(key => left[key] === right[key]);
}

function assertRecord(value: unknown, expectedKey: string): LocalAuthorityRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LocalAuthorityStoreError("authority_record_invalid", "authority record is not an object");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !Object.hasOwn(record, key))) {
		throw new LocalAuthorityStoreError("authority_record_invalid", "authority record fields are invalid");
	}
	if (
		record.schemaVersion !== AUTHORITY_RECORD_SCHEMA_VERSION ||
		typeof record.recordRevision !== "string" ||
		!OPAQUE.test(record.recordRevision) ||
		typeof record.engineInstanceId !== "string" ||
		!OPAQUE.test(record.engineInstanceId) ||
		typeof record.engineBootId !== "string" ||
		!OPAQUE.test(record.engineBootId) ||
		typeof record.launchId !== "string" ||
		!OPAQUE.test(record.launchId) ||
		!Number.isSafeInteger(record.ownerGeneration) ||
		(record.ownerGeneration as number) < 1 ||
		!Number.isSafeInteger(record.pid) ||
		(record.pid as number) < 1 ||
		typeof record.osProcessStartToken !== "string" ||
		record.osProcessStartToken.length < 8 ||
		typeof record.normalizedEndpoint !== "string" ||
		endpointKey(record.normalizedEndpoint) !== expectedKey ||
		typeof record.executableSha256 !== "string" ||
		!SHA256.test(record.executableSha256) ||
		typeof record.executablePathSha256 !== "string" ||
		!SHA256.test(record.executablePathSha256) ||
		typeof record.argvSha256 !== "string" ||
		!SHA256.test(record.argvSha256) ||
		typeof record.engineArtifactSha256 !== "string" ||
		!SHA256.test(record.engineArtifactSha256) ||
		typeof record.servedBackendCommit !== "string" ||
		!/^[0-9a-f]{40,64}$/.test(record.servedBackendCommit) ||
		(record.ownerExitPolicy !== "attached" && record.ownerExitPolicy !== "detached") ||
		typeof record.ownerCredentialRef !== "string" ||
		!SECRET_REF.test(record.ownerCredentialRef) ||
		typeof record.ownerCredentialVerifier !== "string" ||
		!SHA256.test(record.ownerCredentialVerifier) ||
		typeof record.createdAt !== "string" ||
		!Number.isFinite(Date.parse(record.createdAt)) ||
		typeof record.lastVerifiedAt !== "string" ||
		!Number.isFinite(Date.parse(record.lastVerifiedAt))
	) {
		throw new LocalAuthorityStoreError("authority_record_invalid", "authority record values are invalid");
	}
	return Object.freeze(record as unknown as LocalAuthorityRecord);
}

function assertStartClaim(value: unknown): LocalStartClaim {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LocalAuthorityStoreError("start_claim_integrity", "start claim is not an object");
	}
	const claim = value as Record<string, unknown>;
	const pendingFields = ["launchId", "executableSha256", "executablePathSha256", "argvSha256", "engineArtifactSha256", "servedBackendCommit", "pendingSecretRef", "pendingSecretVerifier"];
	const pendingCount = pendingFields.reduce((count, field) => count + (claim[field] === undefined ? 0 : 1), 0);
	const engineFields = [claim.enginePid, claim.engineProcessStartToken];
	const ownerAttemptGeneration = claim.ownerAttemptGeneration;
	if (
		claim.schemaVersion !== "p30.local-start-claim.v4" ||
		typeof claim.token !== "string" ||
		!OPAQUE.test(claim.token) ||
		!Number.isSafeInteger(claim.pid) ||
		(claim.pid as number) < 1 ||
		typeof claim.processStartToken !== "string" ||
		claim.processStartToken.length < 3 ||
		!Number.isSafeInteger(claim.createdAtUnix) ||
		(pendingCount !== 0 && pendingCount !== pendingFields.length) ||
		(pendingCount > 0 && (
			typeof claim.launchId !== "string" || !OPAQUE.test(claim.launchId) ||
			typeof claim.executableSha256 !== "string" || !SHA256.test(claim.executableSha256) ||
			typeof claim.executablePathSha256 !== "string" || !SHA256.test(claim.executablePathSha256) ||
			typeof claim.argvSha256 !== "string" || !SHA256.test(claim.argvSha256) ||
			typeof claim.engineArtifactSha256 !== "string" || !SHA256.test(claim.engineArtifactSha256) ||
			typeof claim.servedBackendCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(claim.servedBackendCommit) ||
			typeof claim.pendingSecretRef !== "string" || !PENDING_SECRET_REF.test(claim.pendingSecretRef) ||
			typeof claim.pendingSecretVerifier !== "string" || !SHA256.test(claim.pendingSecretVerifier)
		)) ||
		(engineFields.some(field => field !== undefined) && (
			!Number.isSafeInteger(claim.enginePid) || (claim.enginePid as number) < 1 ||
			typeof claim.engineProcessStartToken !== "string" || claim.engineProcessStartToken.length < 8
		)) ||
		(ownerAttemptGeneration !== undefined && (
			!Number.isSafeInteger(ownerAttemptGeneration) || (ownerAttemptGeneration as number) < 1 ||
			pendingCount !== pendingFields.length ||
			engineFields.some(field => field === undefined)
		))
	) {
		throw new LocalAuthorityStoreError("start_claim_integrity", "start claim is invalid");
	}
	return Object.freeze(claim as unknown as LocalStartClaim);
}

function assertControlAttempt(value: unknown): LocalControlAttempt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LocalAuthorityStoreError("control_attempt_integrity", "control attempt is not an object");
	}
	const attempt = value as Record<string, unknown>;
	const requiredKeys: ReadonlyArray<keyof LocalControlAttempt> = [
		"schemaVersion",
		"recordRevision",
		"engineInstanceId",
		"engineBootId",
		"launchId",
		"ownerGeneration",
		"operation",
		"controlRequestId",
		"registrationId",
		"requesterRegistrationGeneration",
		"requesterClientInstanceId",
		"requesterCredentialRef",
		"requesterCredentialVerifier",
		"expectedAdmissionEpoch",
		"phase",
		"createdAtUnix",
	];
	const hasDrain = attempt.phase === "draining" || attempt.phase === "graceful-accepted" || attempt.phase === "hard-signal-pending" || attempt.phase === "hard-signal-commit-pending";
	if (
		Object.keys(attempt).length !== requiredKeys.length + (hasDrain ? 1 : 0) ||
		requiredKeys.some(key => !Object.hasOwn(attempt, key)) ||
		(hasDrain !== Object.hasOwn(attempt, "drainGeneration")) ||
		attempt.schemaVersion !== "p30.local-control-attempt.v3" ||
		typeof attempt.recordRevision !== "string" || !OPAQUE.test(attempt.recordRevision) ||
		typeof attempt.engineInstanceId !== "string" || !OPAQUE.test(attempt.engineInstanceId) ||
		typeof attempt.engineBootId !== "string" || !OPAQUE.test(attempt.engineBootId) ||
		typeof attempt.launchId !== "string" || !OPAQUE.test(attempt.launchId) ||
		!Number.isSafeInteger(attempt.ownerGeneration) || (attempt.ownerGeneration as number) < 1 ||
		(attempt.operation !== "stop" && attempt.operation !== "restart") ||
		typeof attempt.controlRequestId !== "string" || !OPAQUE.test(attempt.controlRequestId) ||
		typeof attempt.registrationId !== "string" || !OPAQUE.test(attempt.registrationId) ||
		!Number.isSafeInteger(attempt.requesterRegistrationGeneration) || (attempt.requesterRegistrationGeneration as number) < 1 ||
		typeof attempt.requesterClientInstanceId !== "string" || !OPAQUE.test(attempt.requesterClientInstanceId) ||
		typeof attempt.requesterCredentialRef !== "string" || !CONTROL_SECRET_REF.test(attempt.requesterCredentialRef) ||
		typeof attempt.requesterCredentialVerifier !== "string" || !SHA256.test(attempt.requesterCredentialVerifier) ||
		!Number.isSafeInteger(attempt.expectedAdmissionEpoch) || (attempt.expectedAdmissionEpoch as number) < 0 ||
		(attempt.phase !== "begin-pending" && attempt.phase !== "draining" && attempt.phase !== "graceful-accepted" && attempt.phase !== "hard-signal-pending" && attempt.phase !== "hard-signal-commit-pending") ||
		(hasDrain && (!Number.isSafeInteger(attempt.drainGeneration) || (attempt.drainGeneration as number) < 1)) ||
		!Number.isSafeInteger(attempt.createdAtUnix) || (attempt.createdAtUnix as number) < 0
	) {
		throw new LocalAuthorityStoreError("control_attempt_integrity", "control attempt is invalid");
	}
	return Object.freeze(attempt as unknown as LocalControlAttempt);
}

export class LocalAuthorityStore {
	readonly #uid: () => number;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #processStartToken: () => string;
	readonly #isLockOwnerAlive: NonNullable<LocalAuthorityStoreSeams["isLockOwnerAlive"]>;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	#rootIdentity: RootIdentity | undefined;
	#rootDescriptor: FileHandle | undefined;

	constructor(
		readonly root: string,
		readonly seams: LocalAuthorityStoreSeams = {},
	) {
		this.#uid = seams.uid ?? (() => process.geteuid?.() ?? process.getuid?.() ?? -1);
		this.#now = seams.now ?? Date.now;
		this.#randomId = seams.randomId ?? (() => randomBytes(18).toString("hex"));
		const currentProcessStartToken = darwinProcessStartToken(process.pid);
		this.#processStartToken = seams.processStartToken ?? (() => {
			if (currentProcessStartToken === null) {
				throw new LocalAuthorityStoreError("lock_integrity", "current process identity is unavailable");
			}
			return currentProcessStartToken;
		});
		this.#sleep = seams.sleep ?? (milliseconds => Bun.sleep(milliseconds));
		this.#isLockOwnerAlive = seams.isLockOwnerAlive ?? (async owner => {
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				return isErrno(error, "ESRCH") ? false : "ambiguous";
			}
			const current = darwinProcessStartToken(owner.pid);
			return current === null ? "ambiguous" : current === owner.processStartToken;
		});
	}

	static endpointKey(endpoint: string): string {
		return endpointKey(endpoint);
	}

	#validateRoot(metadata: Stats): void {
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.#uid() || (metadata.mode & 0o777) !== 0o700) {
			throw new LocalAuthorityStoreError("root_integrity", "authority store root identity or permissions are invalid");
		}
		if (this.#rootIdentity && (metadata.dev !== this.#rootIdentity.dev || metadata.ino !== this.#rootIdentity.ino)) {
			throw new LocalAuthorityStoreError("root_integrity", "authority store root identity changed");
		}
	}

	async #assertRootIdentity(): Promise<void> {
		const descriptor = this.#rootDescriptor;
		const identity = this.#rootIdentity;
		if (!descriptor || !identity) throw new LocalAuthorityStoreError("root_integrity", "authority root descriptor is not pinned");
		const descriptorMetadata = await descriptor.stat();
		this.#validateRoot(descriptorMetadata);
		const pathMetadata = await lstat(this.root);
		this.#validateRoot(pathMetadata);
		if (
			descriptorMetadata.dev !== identity.dev ||
			descriptorMetadata.ino !== identity.ino ||
			pathMetadata.dev !== identity.dev ||
			pathMetadata.ino !== identity.ino
		) {
			throw new LocalAuthorityStoreError("root_integrity", "authority store root identity changed");
		}
	}

	async #readOnlyRootAvailable(): Promise<boolean> {
		if (this.#rootDescriptor) {
			await this.#assertRootIdentity();
			return true;
		}
		try {
			await this.#pinRoot();
			return true;
		} catch (error) {
			if (isErrno(error, "ENOENT")) return false;
			throw error;
		}
	}

	async initialize(): Promise<void> {
		if (this.#rootDescriptor) {
			await this.#assertRootIdentity();
			return;
		}
		const createdPath = await mkdir(this.root, { recursive: true, mode: 0o700 });
		let metadata = await lstat(this.root);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== this.#uid()) {
			throw new LocalAuthorityStoreError("root_integrity", "authority store root owner or type is invalid");
		}
		if ((metadata.mode & 0o777) !== 0o700) {
			if (createdPath === undefined) {
				throw new LocalAuthorityStoreError("root_integrity", "pre-existing authority store permissions are invalid");
			}
			await chmod(this.root, 0o700);
			metadata = await lstat(this.root);
		}
		this.#validateRoot(metadata);
		await this.#pinRoot();
	}

	async #pinRoot(): Promise<void> {
		const descriptor = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const metadata = await descriptor.stat();
			this.#validateRoot(metadata);
			this.#rootIdentity = { dev: metadata.dev, ino: metadata.ino };
			this.#rootDescriptor = descriptor;
			await this.#assertRootIdentity();
		} catch (error) {
			this.#rootDescriptor = undefined;
			this.#rootIdentity = undefined;
			await descriptor.close();
			throw error;
		}
	}

	#rootFd(): number {
		if (!this.#rootDescriptor) throw new LocalAuthorityStoreError("root_integrity", "authority root descriptor is not pinned");
		return this.#rootDescriptor.fd;
	}

	async #openAt(pathOrName: string, flags: number, mode = 0, createdMode?: number): Promise<number> {
		const name = relativeName(pathOrName);
		await this.seams.beforeSecureOpen?.(join(this.root, name));
		await this.#assertRootIdentity();
		const nameBuffer = cPath(name);
		const rootFd = this.#rootFd();
		const fd = Number(requireNativeSystem().openat(rootFd, ptr(nameBuffer), flags, mode));
		if (fd < 0) throw systemError(`openat(fd=${rootFd},flags=${flags},mode=${mode})`, name);
		try {
			if (createdMode !== undefined) fchmodSync(fd, createdMode);
			await this.#assertRootIdentity();
			return fd;
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	async #renameAt(fromPathOrName: string, toPathOrName: string): Promise<void> {
		const from = relativeName(fromPathOrName);
		const to = relativeName(toPathOrName);
		await this.seams.beforeAtomicRename?.(join(this.root, from), join(this.root, to));
		await this.#assertRootIdentity();
		const fromBuffer = cPath(from);
		const toBuffer = cPath(to);
		if (Number(requireNativeSystem().renameat(this.#rootFd(), ptr(fromBuffer), this.#rootFd(), ptr(toBuffer))) !== 0) {
			throw systemError("renameat", from);
		}
		await this.#assertRootIdentity();
	}

	async #unlinkAt(pathOrName: string, force = false): Promise<void> {
		const name = relativeName(pathOrName);
		await this.seams.beforeUnlink?.(join(this.root, name));
		await this.#assertRootIdentity();
		const nameBuffer = cPath(name);
		if (Number(requireNativeSystem().unlinkat(this.#rootFd(), ptr(nameBuffer), 0)) !== 0) {
			const error = systemError("unlinkat", name);
			if (!force || !isErrno(error, "ENOENT")) throw error;
		}
		await this.#assertRootIdentity();
	}

	async #cleanupOrphanAuthoritySecrets(key: string): Promise<void> {
		const prefix = `${key}.secret.`;
		const controlPrefix = `${key}.control.secret.`;
		const controlName = `${key}.control.json`;
		let removed = false;
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (
				entry.name === controlName ||
				(entry.name.startsWith(prefix) && SECRET_REF.test(entry.name)) ||
				(entry.name.startsWith(controlPrefix) && CONTROL_SECRET_REF.test(entry.name))
			) {
				await this.#unlinkAt(entry.name, true);
				removed = true;
			}
		}
		if (removed) await this.#syncParent();
	}
	async #cleanupUnreferencedControlSecrets(key: string, referenced: string | undefined): Promise<void> {
		let removed = false;
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (
				entry.name !== referenced &&
				entry.name.startsWith(`${key}.control.secret.`) &&
				CONTROL_SECRET_REF.test(entry.name)
			) {
				await this.#unlinkAt(entry.name, true);
				removed = true;
			}
		}
		if (removed) await this.#syncParent();
	}


	async #openLockFile(name: string): Promise<number> {
		try {
			return await this.#openAt(name, constants.O_RDWR | constants.O_NOFOLLOW);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		try {
			return await this.#openAt(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600, 0o600);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			return await this.#openAt(name, constants.O_RDWR | constants.O_NOFOLLOW);
		}
	}

	async withExclusiveLock<T>(endpoint: string, operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
		await this.initialize();
		const lockName = `${endpointKey(endpoint)}.lock`;
		const lockPath = join(this.root, lockName);
		const started = this.#now();
		let delay = 5;
		while (true) {
			const fd = await this.#openLockFile(lockName);
			let acquired = false;
			try {
				const descriptorMetadata = fstatSync(fd);
				if (!descriptorMetadata.isFile() || descriptorMetadata.nlink !== 1 || descriptorMetadata.uid !== this.#uid() || (descriptorMetadata.mode & 0o077) !== 0) {
					throw new LocalAuthorityStoreError("lock_integrity", "authority lock ownership or link integrity is invalid");
				}
				fchmodSync(fd, 0o600);
				acquired = requireNativeSystem().flock(fd, LOCK_EX | LOCK_NB) === 0;
				if (!acquired) {
					if (this.#now() - started >= timeoutMs) throw new LocalAuthorityStoreError("lock_timeout", "authority lock could not be acquired");
				} else {
					await this.seams.beforeLockIdentityCheck?.(lockPath);
					const pathFd = await this.#openAt(lockName, constants.O_RDONLY | constants.O_NOFOLLOW);
					try {
						const pathMetadata = fstatSync(pathFd);
						if (pathMetadata.dev !== descriptorMetadata.dev || pathMetadata.ino !== descriptorMetadata.ino || pathMetadata.nlink !== 1) {
							throw new LocalAuthorityStoreError("lock_integrity", "authority lock path identity changed");
						}
					} finally {
						closeSync(pathFd);
					}
					const owner: LockOwner = {
						schemaVersion: "p30.local-authority-lock.v2",
						token: this.#randomId(),
						pid: process.pid,
						processStartToken: this.#processStartToken(),
						createdAtUnix: this.#now(),
					};
					ftruncateSync(fd, 0);
					writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
					fsyncSync(fd);
					await this.#syncParent();
					const result = await operation();
					await this.#assertRootIdentity();
					return result;
				}
			} finally {
				if (acquired) requireNativeSystem().flock(fd, LOCK_UN);
				closeSync(fd);
			}
			await this.#sleep(delay);
			delay = Math.min(delay * 2, 100);
		}
	}

	async claimStart(endpoint: string): Promise<StartClaimResult> {
		await this.#assertRootIdentity();
		const key = endpointKey(endpoint);
		const claimPath = join(this.root, `${key}.starting.json`);
		let current: LocalStartClaim | null = null;
		try {
			current = assertStartClaim(await this.#readSecureJson<unknown>(claimPath, "start_claim_integrity"));
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		if (current) {
			const starterAlive = await this.#isLockOwnerAlive({ pid: current.pid, processStartToken: current.processStartToken });
			if (starterAlive !== false) return { kind: "occupied", claim: current };
			if (current.pendingSecretRef && current.enginePid === undefined && current.engineProcessStartToken === undefined) {
				return { kind: "unbound", claim: current };
			}
			if (current.pendingSecretRef && current.enginePid !== undefined && current.engineProcessStartToken !== undefined) {
				const engineAlive = await this.#isLockOwnerAlive({ pid: current.enginePid, processStartToken: current.engineProcessStartToken });
				if (engineAlive === true) return { kind: "recoverable", claim: current };
				if (engineAlive === "ambiguous") return { kind: "occupied", claim: current };
				return { kind: "dead-bound", claim: current };
			}
			const retired = join(this.root, `${key}.starting.dead.${current.token}.${this.#randomId()}`);
			if (current.pendingSecretRef) await this.#unlinkAt(current.pendingSecretRef, true);
			await this.#renameAt(claimPath, retired);
			await this.#syncParent();
		}
		if (await this.probeCurrent(endpoint) === null) await this.#cleanupOrphanAuthoritySecrets(key);
		const claim: LocalStartClaim = Object.freeze({
			schemaVersion: "p30.local-start-claim.v4",
			token: this.#randomId(),
			pid: process.pid,
			processStartToken: this.#processStartToken(),
			createdAtUnix: this.#now(),
		});
		await this.#exclusiveWrite(`${key}.starting.json`, `${JSON.stringify(claim)}\n`, "start_claim_integrity");
		return { kind: "claimed", claim };
	}

	async prepareStartClaim(endpoint: string, token: string, input: PrepareStartClaimInput, secret: PendingStartSecret): Promise<LocalStartClaim> {
		if (
			!OPAQUE.test(input.launchId) ||
			!SHA256.test(input.executableSha256) ||
			!SHA256.test(input.executablePathSha256) ||
			!SHA256.test(input.argvSha256) ||
			!SHA256.test(input.engineArtifactSha256) ||
			!/^[0-9a-f]{40,64}$/.test(input.servedBackendCommit)
		) {
			throw new LocalAuthorityStoreError("start_claim_integrity", "pending launch identity is invalid");
		}
		if (secret.bootstrapCredential.byteLength !== 32 || !isOpaqueBuffer(secret.ownerCredential)) {
			throw new LocalAuthorityStoreError("secret_integrity", "pending launch credential is invalid");
		}
		const key = endpointKey(endpoint);
		const claim = await this.#readStartClaim(key);
		if (claim.token !== token || claim.pendingSecretRef !== undefined) throw new LocalAuthorityStoreError("generation_conflict", "start claim generation changed");
		const pendingSecretRef = `${key}.starting.secret.${token}.bin`;
		const verifier = pendingSecretVerifier(secret);
		const pendingSecret = encodePendingSecret(secret);
		try {
			await this.#exclusiveWrite(pendingSecretRef, pendingSecret, "secret_integrity");
		} finally {
			pendingSecret.fill(0);
		}
		const prepared = assertStartClaim({ ...claim, ...input, pendingSecretRef, pendingSecretVerifier: verifier });
		try {
			await this.#atomicWrite(`${key}.starting.json`, `${JSON.stringify(prepared)}\n`);
			return prepared;
		} catch (error) {
			await this.#unlinkAt(pendingSecretRef, true);
			await this.#syncParent();
			throw error;
		}
	}

	async bindStartClaimProcess(endpoint: string, token: string, pid: number, processStartToken: string): Promise<LocalStartClaim> {
		const key = endpointKey(endpoint);
		const claim = await this.#readStartClaim(key);
		if (claim.token !== token || claim.pendingSecretRef === undefined) throw new LocalAuthorityStoreError("generation_conflict", "start claim generation changed");
		const bound = assertStartClaim({ ...claim, enginePid: pid, engineProcessStartToken: processStartToken });
		await this.#atomicWrite(`${key}.starting.json`, `${JSON.stringify(bound)}\n`);
		return bound;
	}

	async markOwnerAttempt(endpoint: string, expected: LocalStartClaim): Promise<LocalStartClaim> {
		const key = endpointKey(endpoint);
		const claim = await this.#readStartClaim(key);
		if (JSON.stringify(claim) !== JSON.stringify(expected) || claim.enginePid === undefined || claim.engineProcessStartToken === undefined) {
			throw new LocalAuthorityStoreError("generation_conflict", "start claim identity changed");
		}
		const nextGeneration = (claim.ownerAttemptGeneration ?? 0) + 1;
		if (!Number.isSafeInteger(nextGeneration)) {
			throw new LocalAuthorityStoreError("start_claim_integrity", "owner attempt generation overflow");
		}
		const attempted = assertStartClaim({ ...claim, ownerAttemptGeneration: nextGeneration });
		await this.#atomicWrite(`${key}.starting.json`, `${JSON.stringify(attempted)}\n`);
		return attempted;
	}
	async rollbackOwnerAttempt(endpoint: string, expected: LocalStartClaim): Promise<LocalStartClaim> {
		const key = endpointKey(endpoint);
		const claim = await this.#readStartClaim(key);
		if (
			JSON.stringify(claim) !== JSON.stringify(expected) ||
			claim.enginePid === undefined ||
			claim.engineProcessStartToken === undefined ||
			claim.ownerAttemptGeneration === undefined ||
			claim.ownerAttemptGeneration < 2
		) {
			throw new LocalAuthorityStoreError("generation_conflict", "start claim owner attempt cannot be rolled back");
		}
		const rolledBack = assertStartClaim({
			...claim,
			ownerAttemptGeneration: claim.ownerAttemptGeneration - 1,
		});
		await this.#atomicWrite(`${key}.starting.json`, `${JSON.stringify(rolledBack)}\n`);
		return rolledBack;
	}


	async verifyStartClaim(endpoint: string, expected: LocalStartClaim): Promise<void> {
		const current = await this.#readStartClaim(endpointKey(endpoint));
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new LocalAuthorityStoreError("generation_conflict", "start claim identity changed");
		}
	}

	async readPendingSecret(claim: LocalStartClaim): Promise<PendingStartSecret> {
		if (!claim.pendingSecretRef || !claim.pendingSecretVerifier) throw new LocalAuthorityStoreError("secret_integrity", "pending launch secret reference is unavailable");
		const bytes = await this.#readSecureBytes(join(this.root, claim.pendingSecretRef), "secret_integrity");
		try {
			const secret = decodePendingSecret(bytes);
			if (pendingSecretVerifier(secret) !== claim.pendingSecretVerifier) {
				secret.bootstrapCredential.fill(0);
				secret.ownerCredential.fill(0);
				throw new LocalAuthorityStoreError("secret_verifier_mismatch", "pending launch secret verifier does not match");
			}
			return secret;
		} finally {
			bytes.fill(0);
		}
	}

	async releaseStartClaim(endpoint: string, token: string): Promise<void> {
		const key = endpointKey(endpoint);
		let current: LocalStartClaim;
		try {
			current = await this.#readStartClaim(key);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return;
			throw error;
		}
		if (current.token !== token) throw new LocalAuthorityStoreError("generation_conflict", "start claim generation changed");
		if (current.pendingSecretRef) await this.#unlinkAt(current.pendingSecretRef, true);
		await this.#unlinkAt(`${key}.starting.json`);
		await this.#syncParent();
	}

	async retireDeadStartClaim(endpoint: string, expected: LocalStartClaim): Promise<void> {
		const key = endpointKey(endpoint);
		const claim = await this.#readStartClaim(key);
		if (JSON.stringify(claim) !== JSON.stringify(expected)) {
			throw new LocalAuthorityStoreError("generation_conflict", "start claim identity changed");
		}
		if (claim.pendingSecretRef) await this.#unlinkAt(claim.pendingSecretRef, true);
		await this.#renameAt(
			join(this.root, `${key}.starting.json`),
			join(this.root, `${key}.starting.dead.${claim.token}.${this.#randomId()}`),
		);
		await this.#syncParent();
	}

	async #readStartClaim(key: string): Promise<LocalStartClaim> {
		return assertStartClaim(await this.#readSecureJson<unknown>(join(this.root, `${key}.starting.json`), "start_claim_integrity"));
	}

	async probeCurrent(endpoint: string): Promise<LocalAuthorityRecord | null> {
		if (!(await this.#readOnlyRootAvailable())) return null;
		const key = endpointKey(endpoint);
		try {
			return assertRecord(JSON.parse(await this.#readSecureText(join(this.root, `${key}.authority.json`), "record_integrity")), key);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return null;
			if (error instanceof LocalAuthorityStoreError) throw error;
			throw new LocalAuthorityStoreError("authority_record_invalid", "authority record JSON is invalid");
		}
	}

	async readCurrent(endpoint: string): Promise<LocalAuthorityRecord | null> {
		return await this.probeCurrent(endpoint);
	}

	async readCurrentForRecovery(endpoint: string): Promise<LocalAuthorityRecord | null> {
		try {
			return await this.probeCurrent(endpoint);
		} catch (error) {
			if (!(error instanceof LocalAuthorityStoreError) || error.code !== "authority_record_invalid") throw error;
			const key = endpointKey(endpoint);
			const recordPath = join(this.root, `${key}.authority.json`);
			const bytes = await this.#readSecureText(recordPath, "record_integrity");
			const digest = createHash("sha256").update(bytes).digest("hex");
			const quarantine = join(this.root, `${key}.authority.invalid.${this.#now()}.${digest}`);
			await this.#renameAt(recordPath, quarantine);
			await this.#syncParent();
			throw error;
		}
	}

	async commit(
		endpoint: string,
		expected: LocalAuthorityRecord | null,
		record: Omit<LocalAuthorityRecord, "schemaVersion" | "recordRevision" | "ownerCredentialRef" | "ownerCredentialVerifier">,
		secret: AuthoritySecret,
	): Promise<LocalAuthorityRecord> {
		if (!isOpaqueBuffer(secret.ownerCredential)) {
			throw new LocalAuthorityStoreError("secret_integrity", "owner credential is invalid");
		}
		const current = await this.probeCurrent(endpoint);
		if ((expected === null) !== (current === null) || (expected && current && !sameRecord(expected, current))) {
			throw new LocalAuthorityStoreError("generation_conflict", "authority record identity changed");
		}
		if (expected && record.ownerGeneration <= expected.ownerGeneration) throw new LocalAuthorityStoreError("generation_conflict", "authority generation must increase");
		const key = endpointKey(endpoint);
		const recordRevision = this.#randomId();
		const ownerCredentialRef = `${key}.secret.${record.ownerGeneration}.${recordRevision}.bin`;
		const complete: LocalAuthorityRecord = {
			...record,
			schemaVersion: AUTHORITY_RECORD_SCHEMA_VERSION,
			recordRevision,
			ownerCredentialRef,
			ownerCredentialVerifier: credentialVerifier(secret.ownerCredential),
		};
		assertRecord(complete, key);
		const encodedSecret = encodeAuthoritySecret(secret);
		try {
			await this.#atomicWrite(ownerCredentialRef, encodedSecret);
		} finally {
			encodedSecret.fill(0);
		}
		try {
			await this.#atomicWrite(`${key}.authority.json`, `${JSON.stringify(complete)}\n`);
		} catch (error) {
			await this.#unlinkAt(ownerCredentialRef, true);
			await this.#syncParent();
			throw error;
		}
		if (expected && expected.ownerCredentialRef !== ownerCredentialRef) {
			await this.#unlinkAt(expected.ownerCredentialRef, true);
			await this.#syncParent();
		}
		return Object.freeze(complete);
	}

	async readSecret(record: LocalAuthorityRecord): Promise<AuthoritySecret> {
		if (!SECRET_REF.test(record.ownerCredentialRef)) throw new LocalAuthorityStoreError("secret_integrity", "authority secret reference is invalid");
		const bytes = await this.#readSecureBytes(join(this.root, record.ownerCredentialRef), "secret_integrity");
		try {
			const secret = decodeAuthoritySecret(bytes);
			if (credentialVerifier(secret.ownerCredential) !== record.ownerCredentialVerifier) {
				secret.ownerCredential.fill(0);
				throw new LocalAuthorityStoreError("secret_verifier_mismatch", "authority secret verifier does not match");
			}
			return Object.freeze(secret);
		} finally {
			bytes.fill(0);
		}
	}

	async readControlAttempt(endpoint: string, record: LocalAuthorityRecord): Promise<LocalControlAttempt | null> {
		const key = endpointKey(endpoint);
		let attempt: LocalControlAttempt;
		try {
			attempt = assertControlAttempt(await this.#readSecureJson<unknown>(join(this.root, `${key}.control.json`), "control_attempt_integrity"));
		} catch (error) {
			if (isErrno(error, "ENOENT")) return null;
			throw error;
		}
		if (
			attempt.engineInstanceId !== record.engineInstanceId ||
			attempt.engineBootId !== record.engineBootId ||
			attempt.launchId !== record.launchId ||
			(attempt.phase === "begin-pending" && (
				attempt.recordRevision !== record.recordRevision ||
				attempt.ownerGeneration !== record.ownerGeneration
			))
		) {
			throw new LocalAuthorityStoreError("generation_conflict", "control attempt authority changed");
		}
		return attempt;
	}
	async readControlAttemptSecret(attempt: LocalControlAttempt): Promise<ControlAttemptSecret> {
		if (!CONTROL_SECRET_REF.test(attempt.requesterCredentialRef)) {
			throw new LocalAuthorityStoreError("secret_integrity", "control requester secret reference is invalid");
		}
		const bytes = await this.#readSecureBytes(join(this.root, attempt.requesterCredentialRef), "secret_integrity");
		try {
			const secret = decodeControlSecret(bytes);
			if (controlSecretVerifier(secret.requesterRegistrationCredential) !== attempt.requesterCredentialVerifier) {
				secret.requesterRegistrationCredential.fill(0);
				throw new LocalAuthorityStoreError("secret_verifier_mismatch", "control requester secret verifier does not match");
			}
			return Object.freeze(secret);
		} finally {
			bytes.fill(0);
		}
	}


	async prepareControlAttempt(
		endpoint: string,
		record: LocalAuthorityRecord,
		operation: "stop" | "restart",
		controlRequestId: string,
		requester: ControlAttemptRequester,
	): Promise<LocalControlAttempt> {
		const current = await this.probeCurrent(endpoint);
		if (!current || !sameRecord(current, record)) {
			throw new LocalAuthorityStoreError("generation_conflict", "authority record changed before control");
		}
		const existing = await this.readControlAttempt(endpoint, record);
		await this.#cleanupUnreferencedControlSecrets(endpointKey(endpoint), existing?.requesterCredentialRef);
		if (existing) {
			if (existing.operation !== operation) {
				throw new LocalAuthorityStoreError("generation_conflict", "another control operation is pending");
			}
			return existing;
		}
		const credential = Buffer.from(requester.registrationCredential, "utf8");
		const requesterCredentialRef = `${endpointKey(endpoint)}.control.secret.${controlRequestId}.bin`;
		const requesterCredentialVerifier = controlSecretVerifier(credential);
		const encoded = encodeControlSecret({ requesterRegistrationCredential: credential });
		try {
			await this.#atomicWrite(requesterCredentialRef, encoded);
		} finally {
			encoded.fill(0);
			credential.fill(0);
		}
		const attempt = assertControlAttempt({
			schemaVersion: "p30.local-control-attempt.v3",
			recordRevision: record.recordRevision,
			engineInstanceId: record.engineInstanceId,
			engineBootId: record.engineBootId,
			launchId: record.launchId,
			ownerGeneration: record.ownerGeneration,
			operation,
			controlRequestId,
			registrationId: requester.registrationId,
			requesterRegistrationGeneration: requester.registrationGeneration,
			requesterClientInstanceId: requester.clientInstanceId,
			requesterCredentialRef,
			requesterCredentialVerifier,
			expectedAdmissionEpoch: requester.admissionEpoch,
			phase: "begin-pending",
			createdAtUnix: this.#now(),
		});
		try {
			await this.#atomicWrite(`${endpointKey(endpoint)}.control.json`, `${JSON.stringify(attempt)}\n`);
			return attempt;
		} catch (error) {
			await this.#unlinkAt(requesterCredentialRef, true);
			await this.#syncParent();
			throw error;
		}
	}
	async replaceExpiredBeginControlAttempt(
		endpoint: string,
		record: LocalAuthorityRecord,
		expired: LocalControlAttempt,
		operation: "stop" | "restart",
		controlRequestId: string,
		requester: ControlAttemptRequester,
	): Promise<LocalControlAttempt> {
		const currentAuthority = await this.probeCurrent(endpoint);
		if (!currentAuthority || !sameRecord(currentAuthority, record)) {
			throw new LocalAuthorityStoreError("generation_conflict", "authority record changed before expired control replacement");
		}
		const current = await this.readControlAttempt(endpoint, record);
		if (current === null) {
			return await this.prepareControlAttempt(endpoint, record, operation, controlRequestId, requester);
		}
		if (JSON.stringify(current) !== JSON.stringify(expired)) {
			if (current.operation !== operation) {
				throw new LocalAuthorityStoreError("generation_conflict", "another control operation replaced the expired attempt");
			}
			return current;
		}
		if (current.phase !== "begin-pending") {
			throw new LocalAuthorityStoreError("generation_conflict", "only a pending begin can be replaced after requester expiry");
		}
		const secret = await this.readControlAttemptSecret(current);
		secret.requesterRegistrationCredential.fill(0);
		await this.clearControlAttempt(endpoint, current);
		return await this.prepareControlAttempt(endpoint, record, operation, controlRequestId, requester);
	}


	async markControlAttemptDraining(
		endpoint: string,
		expected: LocalControlAttempt,
		drainGeneration: number,
	): Promise<LocalControlAttempt> {
		const key = endpointKey(endpoint);
		const current = assertControlAttempt(await this.#readSecureJson<unknown>(join(this.root, `${key}.control.json`), "control_attempt_integrity"));
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new LocalAuthorityStoreError("generation_conflict", "control attempt changed before drain commit");
		}
		if (expected.phase === "draining") {
			if (expected.drainGeneration !== drainGeneration) {
				throw new LocalAuthorityStoreError("generation_conflict", "control drain generation changed");
			}
			return current;
		}
		if (expected.phase !== "begin-pending") {
			throw new LocalAuthorityStoreError("generation_conflict", "control drain phase transition is invalid");
		}
		const draining = assertControlAttempt({ ...expected, phase: "draining", drainGeneration });
		await this.#atomicWrite(`${key}.control.json`, `${JSON.stringify(draining)}\n`);
		return draining;
	}

	async advanceControlAttempt(
		endpoint: string,
		expected: LocalControlAttempt,
		phase: "graceful-accepted" | "hard-signal-pending" | "hard-signal-commit-pending",
	): Promise<LocalControlAttempt> {
		const key = endpointKey(endpoint);
		const current = assertControlAttempt(await this.#readSecureJson<unknown>(join(this.root, `${key}.control.json`), "control_attempt_integrity"));
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new LocalAuthorityStoreError("generation_conflict", "control attempt changed before phase commit");
		}
		const allowed = (expected.phase === "draining" && phase === "graceful-accepted")
			|| (expected.phase === "graceful-accepted" && phase === "hard-signal-pending")
			|| (expected.phase === "hard-signal-pending" && phase === "hard-signal-commit-pending");
		if (!allowed) {
			if (expected.phase === phase) return current;
			throw new LocalAuthorityStoreError("generation_conflict", "control attempt phase transition is invalid");
		}
		const advanced = assertControlAttempt({ ...expected, phase });
		await this.#atomicWrite(`${key}.control.json`, `${JSON.stringify(advanced)}\n`);
		return advanced;
	}

	async clearControlAttempt(endpoint: string, expected: LocalControlAttempt): Promise<void> {
		const key = endpointKey(endpoint);
		const current = assertControlAttempt(await this.#readSecureJson<unknown>(join(this.root, `${key}.control.json`), "control_attempt_integrity"));
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new LocalAuthorityStoreError("generation_conflict", "control attempt changed");
		}
		await this.#unlinkAt(`${key}.control.json`);
		await this.#syncParent();
		await this.#unlinkAt(current.requesterCredentialRef, true);
		await this.#syncParent();
	}

	async retireDeadGeneration(endpoint: string, expected: LocalAuthorityRecord): Promise<void> {
		const key = endpointKey(endpoint);
		const current = await this.probeCurrent(endpoint);
		if (!current || !sameRecord(current, expected)) throw new LocalAuthorityStoreError("generation_conflict", "authority record identity changed before retirement");
		const controlAttempt = await this.readControlAttempt(endpoint, current);
		const suffix = `retired.${expected.ownerGeneration}.${expected.recordRevision}.${this.#now()}.${this.#randomId()}`;
		const recordPath = join(this.root, `${key}.authority.json`);
		const retiredRecordPath = join(this.root, `${key}.authority.${suffix}`);
		const secret = await this.readSecret(current);
		secret.ownerCredential.fill(0);
		await this.#renameAt(recordPath, retiredRecordPath);
		await this.#syncParent();
		await this.#unlinkAt(`${key}.control.json`, true);
		if (controlAttempt) await this.#unlinkAt(controlAttempt.requesterCredentialRef, true);
		await this.#unlinkAt(current.ownerCredentialRef, true);
		await this.#syncParent();
	}

	async #readSecureBytes(path: string, errorCode: AuthorityStoreErrorCode): Promise<Buffer> {
		const fd = await this.#openAt(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const metadata = fstatSync(fd);
			if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== this.#uid() || (metadata.mode & 0o077) !== 0) {
				throw new LocalAuthorityStoreError(errorCode, "authority file ownership or link integrity is invalid");
			}
			const bytes = readFileSync(fd);
			await this.#assertRootIdentity();
			return bytes;
		} finally {
			closeSync(fd);
		}
	}

	async #readSecureText(path: string, errorCode: AuthorityStoreErrorCode): Promise<string> {
		const bytes = await this.#readSecureBytes(path, errorCode);
		try {
			return bytes.toString("utf8");
		} finally {
			bytes.fill(0);
		}
	}

	async #readSecureJson<T>(path: string, errorCode: AuthorityStoreErrorCode): Promise<T> {
		try {
			return JSON.parse(await this.#readSecureText(path, errorCode)) as T;
		} catch (error) {
			if (error instanceof LocalAuthorityStoreError || isErrno(error, "ENOENT")) throw error;
			throw new LocalAuthorityStoreError(errorCode, "authority file JSON is invalid");
		}
	}

	async #exclusiveWrite(name: string, content: string | Uint8Array, errorCode: AuthorityStoreErrorCode): Promise<void> {
		let fd: number;
		try {
			fd = await this.#openAt(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600, 0o600);
		} catch (error) {
			if (isErrno(error, "EEXIST")) throw new LocalAuthorityStoreError(errorCode, "authority file already exists");
			throw error;
		}
		try {
			const metadata = fstatSync(fd);
			if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== this.#uid()) {
				throw new LocalAuthorityStoreError(errorCode, "authority file ownership or link integrity is invalid");
			}
			fchmodSync(fd, 0o600);
			if (typeof content === "string") writeFileSync(fd, content, "utf8");
			else writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		await this.#syncParent();
	}

	async #atomicWrite(name: string, content: string | Uint8Array): Promise<void> {
		const temporary = `.${name}.${this.#randomId()}.tmp`;
		const fd = await this.#openAt(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600, 0o600);
		try {
			const metadata = fstatSync(fd);
			if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== this.#uid()) {
				throw new LocalAuthorityStoreError("record_integrity", "atomic write temporary integrity is invalid");
			}
			fchmodSync(fd, 0o600);
			if (typeof content === "string") writeFileSync(fd, content, "utf8");
			else writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			let targetFd: number | undefined;
			try {
				targetFd = await this.#openAt(name, constants.O_RDONLY | constants.O_NOFOLLOW);
				const targetMetadata = fstatSync(targetFd);
				if (!targetMetadata.isFile() || targetMetadata.nlink !== 1 || targetMetadata.uid !== this.#uid()) {
					throw new LocalAuthorityStoreError("record_integrity", "atomic write target integrity is invalid");
				}
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			} finally {
				if (targetFd !== undefined) closeSync(targetFd);
			}
			await this.#renameAt(temporary, name);
			await this.#syncParent();
		} finally {
			await this.#unlinkAt(temporary, true);
		}
	}

	async #syncParent(): Promise<void> {
		await this.#assertRootIdentity();
		fsyncSync(this.#rootFd());
		await this.#assertRootIdentity();
	}
}
