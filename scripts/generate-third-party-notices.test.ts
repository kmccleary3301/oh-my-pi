import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { readTarNoticeMembers } from "./generate-third-party-notices";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength > length) throw new Error("test tar field is too long");
	target.set(bytes, offset);
}

function tarGzip(entries: ReadonlyArray<{ readonly path: string; readonly content: string }>): Uint8Array {
	const encoded = entries.map(entry => ({ ...entry, bytes: new TextEncoder().encode(entry.content) }));
	const size = encoded.reduce((total, entry) => total + 512 + Math.ceil(entry.bytes.byteLength / 512) * 512, 0) + 1024;
	const tar = new Uint8Array(size);
	let offset = 0;
	for (const entry of encoded) {
		const header = tar.subarray(offset, offset + 512);
		writeAscii(header, 0, 100, entry.path);
		writeAscii(header, 100, 8, "0000644\0");
		writeAscii(header, 108, 8, "0000000\0");
		writeAscii(header, 116, 8, "0000000\0");
		writeAscii(header, 124, 12, `${entry.bytes.byteLength.toString(8).padStart(11, "0")}\0`);
		writeAscii(header, 136, 12, "00000000000\0");
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		writeAscii(header, 257, 6, "ustar\0");
		writeAscii(header, 263, 2, "00");
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
		tar.set(entry.bytes, offset + 512);
		offset += 512 + Math.ceil(entry.bytes.byteLength / 512) * 512;
	}
	return new Uint8Array(gzipSync(tar));
}

describe("bundled archive notice inspection", () => {
	test("extracts and hashes license members instead of asserting none", () => {
		const content = "BreadBoard SDK license terms\n";
		const members = readTarNoticeMembers(
			tarGzip([
				{ path: "package/LICENSE", content },
				{ path: "package/dist/index.js", content: "export {};\n" },
			]),
		);
		expect(members).toEqual([
			{
				path: "package/LICENSE",
				sha256: sha256(content),
				bytes: Buffer.byteLength(content),
				content,
			},
		]);
	});

	test("sorts archive members by locale-independent code units", () => {
		const members = readTarNoticeMembers(
			tarGzip([
				{ path: "package/NOTICE-ä", content: "umlaut\n" },
				{ path: "package/NOTICE-z", content: "ascii\n" },
			]),
		);
		expect(members.map(member => member.path)).toEqual(["package/NOTICE-z", "package/NOTICE-ä"]);
	});
});

describe("distribution notice bundle", () => {
	test("is deterministic, complete, and bound to the vendored SDK", async () => {
		const check = Bun.spawn(["bun", "scripts/generate-third-party-notices.ts", "--check"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(check.stdout).text(),
			new Response(check.stderr).text(),
			check.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toMatchObject({ mode: "check", entries: 53 });

		const manifest = await Bun.file(path.join(packageRoot, "THIRD_PARTY_NOTICES.manifest.json")).json();
		const bundle = await Bun.file(path.join(packageRoot, "THIRD_PARTY_NOTICES.txt")).text();
		const sdkBytes = new Uint8Array(
			await Bun.file(path.join(packageRoot, "vendor", "breadboard-sdk-0.2.5.tgz")).arrayBuffer(),
		);
		expect(manifest.entries).toHaveLength(53);
		expect(manifest.bundle.sha256).toBe(sha256(bundle));
		expect(manifest.sdk).toMatchObject({
			artifactSha256: sha256(sdkBytes),
			licenseNoticeMemberPresent: false,
			licenseAssertion: "none",
			licenseNoticeMembers: [],
		});
		expect(bundle).toContain("===== BEGIN LICENSE =====");
		expect(bundle).toContain("===== BEGIN crates/pi-natives/src/fonts/Silver.LICENSE =====");
		expect(bundle).toContain("Package: @breadboard/sdk@0.2.5");
		expect(await Bun.file(path.join(packageRoot, "LICENSE")).text()).toBe(
			await Bun.file(path.join(repoRoot, "LICENSE")).text(),
		);
	});
});
