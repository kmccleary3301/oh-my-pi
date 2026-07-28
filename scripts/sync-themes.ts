#!/usr/bin/env bun
/**
 * Syncs the theme index file with the JSON files in the defaults directory.
 * Usage: bun scripts/sync-themes.ts [--check]
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const THEMES_DIR = join(process.cwd(), "packages/coding-agent/src/modes/theme/defaults");
const INDEX_FILE = join(THEMES_DIR, "index.ts");

async function main() {
	const files = await readdir(THEMES_DIR);
	const jsonFiles = files.filter(f => f.endsWith(".json")).sort();

	const imports: string[] = [];
	const exportEntries: string[] = [];

	for (const file of jsonFiles) {
		const name = file.replace(".json", "");
		const varName = name.replace(/-/g, "_");
		const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);

		imports.push(`import ${varName} from "./${file}" with { type: "json" };`);
		exportEntries.push(`	${key}: ${varName},`);
	}

	let content = imports.join("\n");
	content += "\n\nexport const defaultThemes = {\n";
	content += exportEntries.join("\n");
	content += "\n};\n";

	if (process.argv.includes("--check")) {
		if (!(await Bun.file(INDEX_FILE).exists()) || (await Bun.file(INDEX_FILE).text()) !== content) {
			throw new Error(`${INDEX_FILE} is stale; run bun scripts/sync-themes.ts`);
		}
		console.log(`Verified ${INDEX_FILE} with ${jsonFiles.length} themes.`);
		return;
	}

	await Bun.write(INDEX_FILE, content);
	console.log(`Updated ${INDEX_FILE} with ${jsonFiles.length} themes.`);
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
