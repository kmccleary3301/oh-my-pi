import { describe, expect, test } from "bun:test";
import { createCanonicalBreadboardEnginePort } from "./engine-port";
import type { LifecycleReadyHandle } from "./lifecycle/lifecycle-state";

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("createCanonicalBreadboardEnginePort", () => {
	test("binds provider, model, and feature requests to the lifecycle-injected transport", async () => {
		const requests: Array<{ url: string; method: string; body?: unknown }> = [];
		const requestFetch = (async (input, init) => {
			const url = String(input);
			requests.push({
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (url.includes("/v1/features")) return jsonResponse({ status: "ok" });
			if (url.includes("/v1/models")) return jsonResponse({ models: [], default_model: null });
			if (url.includes("/v1/provider-auth/status")) return jsonResponse({ attached: [] });
			if (url.includes("/v1/provider-auth/attach")) return jsonResponse({ status: "attached" });
			if (url.includes("/v1/provider-auth/detach")) return jsonResponse({ status: "detached" });
			throw new Error(`unexpected request: ${url}`);
		}) as typeof fetch;
		const binding = {
			endpoint: "http://127.0.0.1:19116",
			engineInstanceId: "engine-instance",
		} as LifecycleReadyHandle["binding"];
		const registration = { id: "registration-1", generation: 4 } as LifecycleReadyHandle["registration"];
		const handle = {
			mode: "local-external",
			binding,
			requestFetch,
			registration,
			ownerGeneration: 4,
		} satisfies Parameters<typeof createCanonicalBreadboardEnginePort>[0];

		const port = createCanonicalBreadboardEnginePort(handle, {
			requestTimeoutMs: 5_000,
			onLateSessionCloseError: () => {},
		});
		await port.getFeatures();
		await port.getModelCatalog("agent configs/session.yaml");
		await port.getProviderAuthStatus();
		await port.attachProviderAuth({ material: { provider_id: "openai", api_key: "ephemeral-secret" } });
		await port.detachProviderAuth({ provider_id: "openai", alias: "work" });

		expect(port.authority).toEqual({
			mode: "local-external",
			binding,
			registration,
			ownerGeneration: 4,
		});
		expect(requests).toEqual([
			{ url: "http://127.0.0.1:19116/v1/features", method: "GET", body: undefined },
			{
				url: "http://127.0.0.1:19116/v1/models?config_path=agent+configs%2Fsession.yaml",
				method: "GET",
				body: undefined,
			},
			{ url: "http://127.0.0.1:19116/v1/provider-auth/status", method: "GET", body: undefined },
			{
				url: "http://127.0.0.1:19116/v1/provider-auth/attach",
				method: "POST",
				body: { material: { provider_id: "openai", api_key: "ephemeral-secret" } },
			},
			{
				url: "http://127.0.0.1:19116/v1/provider-auth/detach",
				method: "POST",
				body: { provider_id: "openai", alias: "work" },
			},
		]);
	});
});
