import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function run(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["bun", script, "--check"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("source identity generators", () => {
	test("theme index matches every bundled theme", async () => {
		const result = await run("scripts/sync-themes.ts");
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain("with 98 themes");
	});

	test("published OMP packages remain at v17.0.7 with synchronized dependency references", async () => {
		const result = await run("scripts/sync-versions.ts");
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain("@oh-my-pi/pi-coding-agent: 17.0.7");
		expect(result.stdout).toContain("All packages at same version (lockstep)");
		expect(result.stdout).toContain("All inter-package dependencies already in sync.");
	});
});
