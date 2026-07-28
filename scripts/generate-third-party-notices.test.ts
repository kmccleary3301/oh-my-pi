import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

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
		});
		expect(bundle).toContain("===== BEGIN LICENSE =====");
		expect(bundle).toContain("===== BEGIN crates/pi-natives/src/fonts/Silver.LICENSE =====");
		expect(bundle).toContain("Package: @breadboard/sdk@0.2.5");
		expect(await Bun.file(path.join(packageRoot, "LICENSE")).text()).toBe(
			await Bun.file(path.join(repoRoot, "LICENSE")).text(),
		);
	});
});
