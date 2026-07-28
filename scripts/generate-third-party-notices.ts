#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");
const bundlePath = path.join(packageRoot, "THIRD_PARTY_NOTICES.txt");
const manifestPath = path.join(packageRoot, "THIRD_PARTY_NOTICES.manifest.json");
const packageLicensePath = path.join(packageRoot, "LICENSE");
const sdkArtifactPath = path.join(packageRoot, "vendor", "breadboard-sdk-0.2.5.tgz");
const sdkProvenancePath = path.join(packageRoot, "breadboard-sdk-provenance.json");

const GENERATED_PATHS = new Set([
	"packages/coding-agent/LICENSE",
	"packages/coding-agent/THIRD_PARTY_NOTICES.txt",
	"packages/coding-agent/THIRD_PARTY_NOTICES.manifest.json",
]);

interface NoticeEntry {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface ArchiveNoticeMember extends NoticeEntry {
	readonly content: string;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const TAR_BLOCK_BYTES = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function tarString(bytes: Uint8Array, offset: number, length: number): string {
	const field = bytes.subarray(offset, offset + length);
	const nul = field.indexOf(0);
	return utf8.decode(nul === -1 ? field : field.subarray(0, nul));
}

function tarOctal(bytes: Uint8Array, offset: number, length: number, field: string): number {
	const value = tarString(bytes, offset, length).trim();
	if (!/^[0-7]+$/.test(value)) throw new Error(`invalid ${field} in bundled SDK tar header`);
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe ${field} in bundled SDK tar header`);
	return parsed;
}

function validateTarChecksum(header: Uint8Array): void {
	const expected = tarOctal(header, 148, 8, "checksum");
	let actual = 0;
	for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
		actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
	}
	if (actual !== expected) throw new Error("bundled SDK tar header checksum mismatch");
}

function parsePaxPath(bytes: Uint8Array): string | undefined {
	let offset = 0;
	let paxPath: string | undefined;
	while (offset < bytes.byteLength) {
		const space = bytes.indexOf(32, offset);
		if (space === -1) throw new Error("malformed bundled SDK PAX record length");
		const lengthText = utf8.decode(bytes.subarray(offset, space));
		if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("malformed bundled SDK PAX record length");
		const recordLength = Number.parseInt(lengthText, 10);
		const recordEnd = offset + recordLength;
		if (!Number.isSafeInteger(recordLength) || recordEnd > bytes.byteLength || bytes[recordEnd - 1] !== 10) {
			throw new Error("truncated bundled SDK PAX record");
		}
		const record = utf8.decode(bytes.subarray(space + 1, recordEnd - 1));
		const separator = record.indexOf("=");
		if (separator <= 0) throw new Error("malformed bundled SDK PAX record");
		if (record.slice(0, separator) === "path") paxPath = record.slice(separator + 1);
		offset = recordEnd;
	}
	return paxPath;
}

function isLicenseNoticePath(filePath: string): boolean {
	const name = filePath.split("/").at(-1)?.toUpperCase() ?? "";
	return name.startsWith("LICENSE") || name.startsWith("NOTICE") || name.endsWith(".LICENSE");
}

export function readTarNoticeMembers(archiveBytes: Uint8Array): ArchiveNoticeMember[] {
	const tarBytes = new Uint8Array(gunzipSync(archiveBytes));
	const members: ArchiveNoticeMember[] = [];
	let offset = 0;
	let pendingLongPath: string | undefined;
	let pendingPaxPath: string | undefined;
	let globalPaxPath: string | undefined;
	let sawTerminator = false;

	while (offset + TAR_BLOCK_BYTES <= tarBytes.byteLength) {
		const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every(byte => byte === 0)) {
			sawTerminator = true;
			break;
		}
		validateTarChecksum(header);
		const name = tarString(header, 0, 100);
		const prefix = tarString(header, 345, 155);
		const headerPath = prefix ? `${prefix}/${name}` : name;
		const size = tarOctal(header, 124, 12, "size");
		const type = String.fromCharCode(header[156] ?? 0);
		const dataOffset = offset + TAR_BLOCK_BYTES;
		const dataEnd = dataOffset + size;
		if (dataEnd > tarBytes.byteLength) throw new Error("truncated bundled SDK tar member");
		const data = tarBytes.subarray(dataOffset, dataEnd);

		if (type === "L") {
			pendingLongPath = utf8.decode(data).replace(/\0.*$/s, "").trimEnd();
		} else if (type === "x") {
			pendingPaxPath = parsePaxPath(data);
		} else if (type === "g") {
			globalPaxPath = parsePaxPath(data) ?? globalPaxPath;
		} else {
			const memberPath = pendingPaxPath ?? pendingLongPath ?? globalPaxPath ?? headerPath;
			pendingPaxPath = undefined;
			pendingLongPath = undefined;
			if (isLicenseNoticePath(memberPath)) {
				if (type !== "\0" && type !== "0") {
					throw new Error(`bundled SDK license/notice member is not a regular file: ${memberPath}`);
				}
				const contentBytes = Uint8Array.from(data);
				members.push({
					path: memberPath,
					sha256: sha256(contentBytes),
					bytes: contentBytes.byteLength,
					content: utf8.decode(contentBytes),
				});
			}
		}

		offset = dataOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	}
	if (!sawTerminator) throw new Error("bundled SDK tar archive has no terminator block");
	const seen = new Set<string>();
	for (const member of members) {
		if (seen.has(member.path)) throw new Error(`duplicate bundled SDK license/notice member: ${member.path}`);
		seen.add(member.path);
	}
	return members.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function trackedNoticePaths(): Promise<string[]> {
	const child = Bun.spawn(["git", "ls-files", "-z"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ls-files failed with exit ${exitCode}: ${stderr.trim()}`);
	return stdout
		.split("\0")
		.filter(Boolean)
		.filter(filePath => !GENERATED_PATHS.has(filePath))
		.filter(filePath => {
			const name = path.basename(filePath).toUpperCase();
			return name.startsWith("LICENSE") || name.startsWith("NOTICE") || name.endsWith(".LICENSE");
		})
		.sort();
}

async function main(): Promise<void> {
	const paths = await trackedNoticePaths();
	if (!paths.includes("LICENSE")) throw new Error("tracked root LICENSE is missing from the notice inventory");
	const sdkArtifactBytes = new Uint8Array(await Bun.file(sdkArtifactPath).arrayBuffer());
	const sdkNoticeMembers = readTarNoticeMembers(sdkArtifactBytes);
	const sections: string[] = [
		"BREADBOARD / OMP DISTRIBUTION NOTICE BUNDLE",
		"",
		"Generated deterministically by scripts/generate-third-party-notices.ts.",
		"The file sections below preserve every tracked LICENSE/NOTICE text in the source tree.",
		sdkNoticeMembers.length === 0
			? "The bundled BreadBoard SDK archive contains no LICENSE/NOTICE member; this bundle makes no license assertion for that component."
			: "The bundled BreadBoard SDK LICENSE/NOTICE members are reproduced verbatim below.",
		"",
	];
	const entries: NoticeEntry[] = [];
	for (const filePath of paths) {
		const bytes = new Uint8Array(await Bun.file(path.join(repoRoot, filePath)).arrayBuffer());
		const digest = sha256(bytes);
		entries.push({ path: filePath, sha256: digest, bytes: bytes.byteLength });
		sections.push(`===== BEGIN ${filePath} =====`);
		sections.push(`SHA-256: ${digest}`);
		sections.push("");
		sections.push(utf8.decode(bytes).trimEnd());
		sections.push(`===== END ${filePath} =====`);
		sections.push("");
	}
	for (const member of sdkNoticeMembers) {
		const qualifiedPath = `packages/coding-agent/vendor/breadboard-sdk-0.2.5.tgz!${member.path}`;
		sections.push(`===== BEGIN ${qualifiedPath} =====`);
		sections.push(`SHA-256: ${member.sha256}`);
		sections.push("");
		sections.push(member.content.trimEnd());
		sections.push(`===== END ${qualifiedPath} =====`);
		sections.push("");
	}

	const sdkProvenanceBytes = new Uint8Array(await Bun.file(sdkProvenancePath).arrayBuffer());
	sections.push("===== BEGIN BUNDLED COMPONENT PROVENANCE =====");
	sections.push("Package: @breadboard/sdk@0.2.5");
	sections.push(`Artifact: packages/coding-agent/vendor/breadboard-sdk-0.2.5.tgz`);
	sections.push(`Artifact SHA-256: ${sha256(sdkArtifactBytes)}`);
	sections.push(`Provenance: packages/coding-agent/breadboard-sdk-provenance.json`);
	sections.push(`Provenance SHA-256: ${sha256(sdkProvenanceBytes)}`);
	sections.push(
		sdkNoticeMembers.length === 0
			? "License assertion: none; archive inspection found no LICENSE/NOTICE member."
			: `License assertion: ${sdkNoticeMembers.length} archive LICENSE/NOTICE member(s) reproduced above.`,
	);
	sections.push("===== END BUNDLED COMPONENT PROVENANCE =====");
	sections.push("");

	const bundle = `${sections.join("\n")}\n`;
	const rootLicense = await Bun.file(path.join(repoRoot, "LICENSE")).text();
	const manifest = {
		schemaVersion: "p31.third-party-notices-manifest.v1",
		generator: "scripts/generate-third-party-notices.ts",
		bundle: {
			path: "packages/coding-agent/THIRD_PARTY_NOTICES.txt",
			sha256: sha256(bundle),
			bytes: Buffer.byteLength(bundle),
		},
		packageLicense: {
			path: "packages/coding-agent/LICENSE",
			sha256: entries.find(entry => entry.path === "LICENSE")?.sha256,
		},
		sdk: {
			artifactPath: "packages/coding-agent/vendor/breadboard-sdk-0.2.5.tgz",
			artifactSha256: sha256(sdkArtifactBytes),
			provenancePath: "packages/coding-agent/breadboard-sdk-provenance.json",
			provenanceSha256: sha256(sdkProvenanceBytes),
			licenseNoticeMemberPresent: sdkNoticeMembers.length > 0,
			licenseAssertion: sdkNoticeMembers.length > 0 ? "included" : "none",
			licenseNoticeMembers: sdkNoticeMembers.map(({ path: memberPath, sha256: digest, bytes }) => ({
				path: memberPath,
				sha256: digest,
				bytes,
			})),
		},
		entries,
	};
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	const check = process.argv.slice(2).includes("--check");
	if (check) {
		const expected = [
			[bundlePath, bundle],
			[packageLicensePath, rootLicense],
			[manifestPath, manifestText],
		] as const;
		for (const [outputPath, content] of expected) {
			if (!(await Bun.file(outputPath).exists()) || (await Bun.file(outputPath).text()) !== content) {
				throw new Error(
					`${path.relative(repoRoot, outputPath)} is stale; run bun scripts/generate-third-party-notices.ts`,
				);
			}
		}
	} else {
		await Bun.write(bundlePath, bundle);
		await Bun.write(packageLicensePath, rootLicense);
		await Bun.write(manifestPath, manifestText);
	}
	console.log(
		JSON.stringify({
			mode: check ? "check" : "write",
			entries: entries.length,
			bundleSha256: manifest.bundle.sha256,
		}),
	);
}

if (import.meta.main) await main();
