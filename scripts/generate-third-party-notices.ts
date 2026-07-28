#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as path from "node:path";

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

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
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
	const sections: string[] = [
		"BREADBOARD / OMP DISTRIBUTION NOTICE BUNDLE",
		"",
		"Generated deterministically by scripts/generate-third-party-notices.ts.",
		"The file sections below preserve every tracked LICENSE/NOTICE text in the source tree.",
		"The bundled BreadBoard SDK record is provenance-only because its archive contains no LICENSE/NOTICE member; this bundle makes no license assertion for that component.",
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
		sections.push(new TextDecoder().decode(bytes).trimEnd());
		sections.push(`===== END ${filePath} =====`);
		sections.push("");
	}

	const sdkArtifactBytes = new Uint8Array(await Bun.file(sdkArtifactPath).arrayBuffer());
	const sdkProvenanceBytes = new Uint8Array(await Bun.file(sdkProvenancePath).arrayBuffer());
	sections.push("===== BEGIN BUNDLED COMPONENT PROVENANCE =====");
	sections.push("Package: @breadboard/sdk@0.2.5");
	sections.push(`Artifact: packages/coding-agent/vendor/breadboard-sdk-0.2.5.tgz`);
	sections.push(`Artifact SHA-256: ${sha256(sdkArtifactBytes)}`);
	sections.push(`Provenance: packages/coding-agent/breadboard-sdk-provenance.json`);
	sections.push(`Provenance SHA-256: ${sha256(sdkProvenanceBytes)}`);
	sections.push("License assertion: none; the bundled archive contains no LICENSE/NOTICE member.");
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
			licenseNoticeMemberPresent: false,
			licenseAssertion: "none",
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
