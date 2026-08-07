import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import type { InternalResource, InternalUrl, ProtocolHandler } from "../../src/internal-urls/types";
import { ContextWorkspace } from "../../src/recursive-control/context-workspace";
import type { SessionEntry } from "../../src/session/session-entries";
import type { ToolSession } from "../../src/tools";

class FixtureProtocol implements ProtocolHandler {
	readonly scheme = "fixture";
	readonly immutable = true;
	async resolve(url: InternalUrl): Promise<InternalResource> {
		return { url: url.href, content: `fixture ${url.hostname}${url.pathname}\u001b[31m`, contentType: "text/plain" };
	}
	async complete(): Promise<Array<{ value: string; label?: string; description?: string }>> {
		return [{ value: "alpha", label: "Alpha", description: "Fixture resource" }];
	}
}

let tempRoot = "";
afterEach(async () => {
	InternalUrlRouter.resetForTests();
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = "";
});

function session(entries: SessionEntry[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		sessionManager: { getBranch: () => entries, getEntries: () => entries } as unknown as NonNullable<
			ToolSession["sessionManager"]
		>,
		allocateOutputArtifact: async () => {
			tempRoot ||= await fs.mkdtemp(path.join(os.tmpdir(), "omp-recursive-context-"));
			return { id: "recursive-fixture", path: path.join(tempRoot, "context.md") };
		},
	};
}

describe("ContextWorkspace", () => {
	test("lists, searches, reads, bounds, sanitizes, and materializes canonical references", async () => {
		const entry: SessionEntry = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-06T00:00:00.000Z",
			customType: "fixture",
			content: "authentication failure details",
			display: true,
		};
		const router = InternalUrlRouter.instance();
		router.register(new FixtureProtocol());
		const workspace = new ContextWorkspace(session([entry]), {
			maxItems: 10,
			maxChars: 24,
			maxMaterializeChars: 128,
			router,
		});
		const listed = await workspace.list({ scope: ["conversation", "resources"] });
		expect(listed.items.some(item => item.ref === "conversation:entry-1")).toBeTrue();
		expect(listed.items.some(item => item.ref === "fixture://alpha")).toBeTrue();
		const searched = await workspace.search({ query: "authentication", scope: "conversation" });
		expect(searched.items).toHaveLength(1);
		const first = await workspace.read({ ref: "conversation:entry-1", limit: 12 });
		expect(first.truncated).toBeTrue();
		const stable = await workspace.read({
			ref: "conversation:entry-1",
			expectedFingerprint: first.fingerprint,
			limit: 12,
		});
		expect(stable.fingerprint).toBe(first.fingerprint);
		await expect(workspace.read({ ref: "conversation:entry-1", expectedFingerprint: "stale" })).rejects.toThrow(
			"Stale recursive context reference",
		);
		const fixture = await workspace.read({ ref: "fixture://alpha" });
		expect(fixture.content).not.toContain("\u001b");
		const artifact = await workspace.materialize({ refs: ["conversation:entry-1", "fixture://alpha"] });
		expect(artifact.uri).toBe("artifact://recursive-fixture");
		expect(await Bun.file(path.join(tempRoot, "context.md")).text()).toContain("conversation:entry-1");
	});
});
