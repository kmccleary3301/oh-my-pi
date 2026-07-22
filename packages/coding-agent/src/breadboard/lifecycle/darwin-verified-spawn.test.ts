import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	type DarwinCodeIdentity,
	DarwinVerifiedSpawnError,
	type DarwinVerifiedSpawnNative,
	parseDarwinArm64CodeIdentity,
	spawnDarwinVerified,
} from "./darwin-verified-spawn";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;

function codeDirectory(hashType: number, marker: number): Buffer {
	const hashSize = hashType === 2 ? 32 : hashType === 4 ? 48 : 20;
	const bytes = Buffer.alloc(112);
	bytes.writeUInt32BE(CSMAGIC_CODEDIRECTORY, 0);
	bytes.writeUInt32BE(bytes.byteLength, 4);
	bytes.writeUInt32BE(0x20600, 8);
	bytes.writeUInt32BE(112, 16);
	bytes.writeUInt32BE(108, 20);
	bytes[36] = hashSize;
	bytes[37] = hashType;
	bytes[39] = 12;
	bytes.write("id\0", 108, "utf8");
	bytes[111] = marker;
	return bytes;
}

function thinArm64MachO(codeDirectories: ReadonlyArray<{ readonly slot: number; readonly bytes: Buffer }>): Buffer {
	const indexLength = codeDirectories.length * 8;
	const signatureLength = 12 + indexLength + codeDirectories.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
	const bytes = Buffer.alloc(48 + signatureLength);
	bytes.writeUInt32LE(MH_MAGIC_64, 0);
	bytes.writeUInt32LE(CPU_TYPE_ARM64, 4);
	bytes.writeUInt32LE(0, 8);
	bytes.writeUInt32LE(2, 12);
	bytes.writeUInt32LE(1, 16);
	bytes.writeUInt32LE(16, 20);
	bytes.writeUInt32LE(LC_CODE_SIGNATURE, 32);
	bytes.writeUInt32LE(16, 36);
	bytes.writeUInt32LE(48, 40);
	bytes.writeUInt32LE(signatureLength, 44);
	bytes.writeUInt32BE(CSMAGIC_EMBEDDED_SIGNATURE, 48);
	bytes.writeUInt32BE(signatureLength, 52);
	bytes.writeUInt32BE(codeDirectories.length, 56);
	let offset = 12 + indexLength;
	for (let index = 0; index < codeDirectories.length; index += 1) {
		const entry = codeDirectories[index] as { readonly slot: number; readonly bytes: Buffer };
		bytes.writeUInt32BE(entry.slot, 60 + index * 8);
		bytes.writeUInt32BE(offset, 64 + index * 8);
		entry.bytes.copy(bytes, 48 + offset);
		offset += entry.bytes.byteLength;
	}
	return bytes;
}

function fatMachO(slices: ReadonlyArray<{ readonly cpuType: number; readonly bytes: Buffer }>, fat64 = false): Buffer {
	const archSize = fat64 ? 32 : 20;
	const firstOffset = 0x1000;
	const offsets = slices.map((_slice, index) => firstOffset + index * 0x1000);
	const total = (offsets.at(-1) ?? 0) + (slices.at(-1)?.bytes.byteLength ?? 0);
	const bytes = Buffer.alloc(total);
	bytes.writeUInt32BE(fat64 ? FAT_MAGIC_64 : FAT_MAGIC, 0);
	bytes.writeUInt32BE(slices.length, 4);
	for (let index = 0; index < slices.length; index += 1) {
		const slice = slices[index] as { readonly cpuType: number; readonly bytes: Buffer };
		const base = 8 + index * archSize;
		const offset = offsets[index] as number;
		bytes.writeUInt32BE(slice.cpuType, base);
		if (fat64) {
			bytes.writeBigUInt64BE(BigInt(offset), base + 8);
			bytes.writeBigUInt64BE(BigInt(slice.bytes.byteLength), base + 16);
			bytes.writeUInt32BE(12, base + 24);
		} else {
			bytes.writeUInt32BE(offset, base + 8);
			bytes.writeUInt32BE(slice.bytes.byteLength, base + 12);
			bytes.writeUInt32BE(12, base + 16);
		}
		slice.bytes.copy(bytes, offset);
	}
	return bytes;
}

function expectedIdentity(directory: Buffer, hashType: 1 | 2 | 3 | 4): DarwinCodeIdentity {
	const algorithm = hashType === 1 ? "sha1" : hashType === 4 ? "sha384" : "sha256";
	return { hashType, cdHash: createHash(algorithm).update(directory).digest().subarray(0, 20) };
}

interface NativeScenario {
	readonly loaded?: DarwinCodeIdentity | null;
	readonly tokens?: readonly (string | null)[];
	readonly bindError?: Error;
	readonly writeError?: Error;
	readonly continueResult?: boolean;
}

function scenarioNative(
	expected: DarwinCodeIdentity,
	events: string[],
	scenario: NativeScenario = {},
): DarwinVerifiedSpawnNative {
	let tokenIndex = 0;
	const tokens = scenario.tokens ?? ["darwin:1:2"];
	return {
		spawnSuspended: (path, argv, env) => {
			events.push(`spawn:${path}:${argv.join(",")}:${Object.keys(env).join(",")}`);
			return {
				pid: 42,
				bootstrapFd: 9,
				exited: Promise.resolve(null),
				hasExited: () => false,
				unref: () => events.push("unref"),
				waitForExit: async () => {
					events.push("reap");
					return true;
				},
			};
		},
		processStartToken: () => {
			events.push("token");
			const value = tokens[Math.min(tokenIndex, tokens.length - 1)] ?? null;
			tokenIndex += 1;
			return value;
		},
		loadedCodeIdentity: () => {
			events.push("attest");
			return scenario.loaded === undefined ? expected : scenario.loaded;
		},
		writeAll: () => {
			events.push("write");
			if (scenario.writeError) throw scenario.writeError;
		},
		close: () => events.push("eof"),
		signal: (_pid, signal) => {
			events.push(signal);
			return signal === "SIGCONT" ? scenario.continueResult !== false : true;
		},
	};
}

function spawnOptions(
	executableBytes: Buffer,
	bootstrap: Buffer,
	native: DarwinVerifiedSpawnNative,
	events: string[],
	scenario: NativeScenario = {},
) {
	return {
		executablePath: "/verified/engine",
		executableBytes,
		argv: ["--serve"],
		env: { FIXED: "yes" },
		bootstrap,
		bindIdentity: async () => {
			events.push("bind");
			if (scenario.bindError) throw scenario.bindError;
		},
		native,
	};
}

describe("parseDarwinArm64CodeIdentity", () => {
	test("selects the highest XNU-supported hash rank from a thin arm64 executable", () => {
		const sha1 = codeDirectory(1, 0x11);
		const truncated = codeDirectory(3, 0x33);
		const sha256 = codeDirectory(2, 0x22);
		const sha384 = codeDirectory(4, 0x44);
		const identity = parseDarwinArm64CodeIdentity(
			thinArm64MachO([
				{ slot: 0, bytes: sha1 },
				{ slot: 0x1000, bytes: truncated },
				{ slot: 0x1001, bytes: sha256 },
				{ slot: 0x1002, bytes: sha384 },
			]),
		);
		expect(identity).toEqual(expectedIdentity(sha384, 4));
	});

	test("selects the sole arm64 slice from 32-bit and 64-bit fat headers", () => {
		const directory = codeDirectory(2, 0x52);
		const arm64 = thinArm64MachO([{ slot: 0, bytes: directory }]);
		const other = Buffer.alloc(64, 0xa5);
		for (const bytes of [
			fatMachO([
				{ cpuType: CPU_TYPE_X86_64, bytes: other },
				{ cpuType: CPU_TYPE_ARM64, bytes: arm64 },
			]),
			fatMachO(
				[
					{ cpuType: CPU_TYPE_X86_64, bytes: other },
					{ cpuType: CPU_TYPE_ARM64, bytes: arm64 },
				],
				true,
			),
		])
			expect(parseDarwinArm64CodeIdentity(bytes)).toEqual(expectedIdentity(directory, 2));
	});

	test("rejects duplicate supported hash ranks as ambiguous", () => {
		const bytes = thinArm64MachO([
			{ slot: 0, bytes: codeDirectory(2, 0x01) },
			{ slot: 0x1000, bytes: codeDirectory(2, 0x02) },
		]);
		expect(() => parseDarwinArm64CodeIdentity(bytes)).toThrow("ambiguous duplicate CodeDirectory hash rank");
	});

	test("rejects unsupported CodeDirectory hashes", () => {
		const bytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(5, 0x01) }]);
		expect(() => parseDarwinArm64CodeIdentity(bytes)).toThrow("unsupported CodeDirectory hash type 5");
	});

	test("rejects malformed CodeDirectory offsets, sizes, slots, and identifiers", () => {
		const cases: Buffer[] = [];
		const badHashSize = codeDirectory(2, 0x01);
		badHashSize[36] = 20;
		cases.push(thinArm64MachO([{ slot: 0, bytes: badHashSize }]));
		const badIdentifier = codeDirectory(2, 0x02);
		badIdentifier.writeUInt32BE(badIdentifier.byteLength, 20);
		cases.push(thinArm64MachO([{ slot: 0, bytes: badIdentifier }]));
		const badHashOffset = codeDirectory(2, 0x03);
		badHashOffset.writeUInt32BE(badHashOffset.byteLength + 1, 16);
		cases.push(thinArm64MachO([{ slot: 0, bytes: badHashOffset }]));
		const missingCodeDirectory = thinArm64MachO([{ slot: 5, bytes: codeDirectory(2, 0x04) }]);
		cases.push(missingCodeDirectory);
		for (const bytes of cases) expect(() => parseDarwinArm64CodeIdentity(bytes)).toThrow(DarwinVerifiedSpawnError);
	});

	test("rejects ambiguous fat arm64 slices and malformed load-command ranges", () => {
		const arm64 = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x01) }]);
		expect(() =>
			parseDarwinArm64CodeIdentity(
				fatMachO([
					{ cpuType: CPU_TYPE_ARM64, bytes: arm64 },
					{ cpuType: CPU_TYPE_ARM64, bytes: arm64 },
				]),
			),
		).toThrow("multiple arm64 slices");
		const malformed = Buffer.from(arm64);
		malformed.writeUInt32LE(24, 36);
		expect(() => parseDarwinArm64CodeIdentity(malformed)).toThrow(DarwinVerifiedSpawnError);
	});
});

describe("spawnDarwinVerified", () => {
	test("attests, binds, writes and closes fd3, then resumes in strict order", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x10) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events);
		const bootstrap = Buffer.from("fixture\n", "utf8");
		const child = await spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events));
		expect(child.pid).toBe(42);
		expect(child.startToken).toBe("darwin:1:2");
		expect(events).toEqual([
			"spawn:/verified/engine:--serve:FIXED",
			"token",
			"attest",
			"token",
			"bind",
			"write",
			"eof",
			"token",
			"SIGCONT",
		]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("never binds, writes bootstrap, or resumes when loaded CDHash mismatches", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x11) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, {
			loaded: { hashType: expected.hashType, cdHash: Buffer.alloc(20, 0xff) },
		});
		const bootstrap = Buffer.from("not-a-secret", "utf8");
		await expect(
			spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events)),
		).rejects.toBeInstanceOf(DarwinVerifiedSpawnError);
		expect(events).not.toContain("bind");
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(1)).toEqual(["token", "attest", "token", "eof", "SIGKILL", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("kills and reaps its direct stopped child when initial start-token acquisition fails", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x11) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, { tokens: [null] });
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events))).rejects.toThrow(
			"start identity is unavailable",
		);
		expect(events).not.toContain("attest");
		expect(events).not.toContain("bind");
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(-3)).toEqual(["eof", "SIGKILL", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("rejects a loaded CodeDirectory hash-type mismatch before bind or bootstrap", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x12) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, {
			loaded: { hashType: 3, cdHash: Buffer.from(expected.cdHash) },
		});
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events))).rejects.toThrow(
			"does not match verified bytes",
		);
		expect(events).not.toContain("bind");
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("kills and reaps its direct stopped child when the stable token changes during attestation", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x13) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, { tokens: ["darwin:1:2", "darwin:9:9"] });
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events))).rejects.toThrow(
			"identity changed during attestation",
		);
		expect(events).not.toContain("bind");
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(-2)).toEqual(["SIGKILL", "reap"]);
	});

	test("fails closed when the stopped child dies before code attestation", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x14) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, { loaded: null });
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events))).rejects.toThrow(
			"code identity is unavailable",
		);
		expect(events).not.toContain("bind");
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.at(-1)).toBe("reap");
	});

	test("kills and reaps after binding when the final pre-resume token becomes unavailable", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x15) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, { tokens: ["darwin:1:2", "darwin:1:2", null] });
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events))).rejects.toThrow(
			"identity changed before resume",
		);
		expect(events).toContain("bind");
		expect(events).toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(-3)).toEqual(["token", "SIGKILL", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("kills and reaps without writing or resuming when bindIdentity fails", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x15) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const scenario = {
			bindError: new Error("bind failed"),
			tokens: ["darwin:1:2", "darwin:1:2", null],
		};
		const native = scenarioNative(expected, events, scenario);
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(
			spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events, scenario)),
		).rejects.toBeInstanceOf(DarwinVerifiedSpawnError);
		expect(events).not.toContain("write");
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(-3)).toEqual(["eof", "SIGKILL", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});
	test("does not signal a reused PID after the suspended child was reaped during deferred binding", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x15) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		let settled = false;
		const base = scenarioNative(expected, events);
		const native = {
			...base,
			spawnSuspended: () => ({
				pid: 42,
				bootstrapFd: 9,
				exited: Promise.resolve(null),
				hasExited: () => settled,
				unref: () => events.push("unref"),
				waitForExit: async () => {
					events.push("reap");
					return true;
				},
			}),
		} as DarwinVerifiedSpawnNative;
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(
			spawnDarwinVerified({
				...spawnOptions(executableBytes, bootstrap, native, events),
				bindIdentity: async () => {
					events.push("bind");
					await Bun.sleep(20);
					settled = true;
					events.push("poll-reaped");
					throw new Error("bind failed after child exit");
				},
			}),
		).rejects.toBeInstanceOf(DarwinVerifiedSpawnError);
		expect(events).not.toContain("SIGKILL");
		expect(events.slice(-3)).toEqual(["poll-reaped", "eof", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("closes, kills, and reaps without resume when the bounded write fails", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x16) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const scenario = {
			writeError: new Error("write failed"),
			tokens: ["darwin:1:2", "darwin:1:2", null],
		};
		const native = scenarioNative(expected, events, scenario);
		const bootstrap = Buffer.alloc(16, 0x5a);
		await expect(
			spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, native, events)),
		).rejects.toBeInstanceOf(DarwinVerifiedSpawnError);
		expect(events).not.toContain("SIGCONT");
		expect(events.slice(-4)).toEqual(["write", "eof", "SIGKILL", "reap"]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("rejects an oversized bootstrap before spawning and still zeroes it", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x17) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const bootstrap = Buffer.alloc(33, 0x5a);
		await expect(
			spawnDarwinVerified(spawnOptions(executableBytes, bootstrap, scenarioNative(expected, events), events)),
		).rejects.toThrow("1..32 bytes");
		expect(events).toEqual([]);
		expect(bootstrap.every(byte => byte === 0)).toBe(true);
	});

	test("same-token process control refuses a replacement identity", async () => {
		const executableBytes = thinArm64MachO([{ slot: 0, bytes: codeDirectory(2, 0x18) }]);
		const expected = parseDarwinArm64CodeIdentity(executableBytes);
		const events: string[] = [];
		const native = scenarioNative(expected, events, {
			tokens: ["darwin:1:2", "darwin:1:2", "darwin:1:2", "darwin:9:9"],
		});
		const child = await spawnDarwinVerified(spawnOptions(executableBytes, Buffer.from("fixture"), native, events));
		expect(await child.signalIfSame("SIGKILL")).toBe("identity-changed");
		expect(events.filter(event => event === "SIGKILL")).toHaveLength(0);
	});
});

describe.skipIf(process.platform !== "darwin")("Darwin native verified spawn", () => {
	test("matches /bin/sh parser identity to csops, delivers nonsecret fd3 fixture, and exits zero", async () => {
		const executablePath = "/bin/sh";
		const executableBytes = await readFile(executablePath);
		const bootstrap = Buffer.from("fixture\n", "utf8");
		const child = await spawnDarwinVerified({
			executablePath,
			executableBytes,
			argv: ["-c", 'IFS= read -r value <&3; test "$value" = fixture'],
			env: { PATH: "/usr/bin:/bin" },
			bootstrap,
			bindIdentity: async () => undefined,
		});
		expect(await child.exited).toBe(0);
	});
});
