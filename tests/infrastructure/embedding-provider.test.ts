import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";

import {
	type EmbeddingModelRegistry,
	HostModelRegistryEmbeddingAdapter,
} from "../../src/infrastructure/embedding-provider";

const model = {
	provider: "openai",
	id: "text-embedding-3-small",
	name: "Embedding test model",
	api: "openai-completions",
	baseUrl: "https://models.example/v1",
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1,
	reasoning: false,
	supportsImages: false,
	supportsTools: false,
} as unknown as Model<Api>;

const registry: EmbeddingModelRegistry = {
	find: () => model,
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "registry-token",
};

describe("HostModelRegistryEmbeddingAdapter", () => {
	test("uses the registry model endpoint and credentials", async () => {
		const originalFetch = globalThis.fetch;
		let request: Request | undefined;
		const mockFetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				if (input instanceof Request) request = new Request(input);
				else request = new Request(input.toString(), init);
				return new Response(
					JSON.stringify({
						data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
			{ preconnect: async () => {} },
		);
		globalThis.fetch = mockFetch;

		try {
			const adapter = new HostModelRegistryEmbeddingAdapter({
				modelRegistry: registry,
				model: "openai/text-embedding-3-small",
			});
			const vectors = await adapter.embed(["first", "second"]);

			expect(vectors).toEqual([
				[1, 0],
				[0, 1],
			]);
			expect(request?.url).toBe("https://models.example/v1/embeddings");
			expect(request?.headers.get("Authorization")).toBe(
				"Bearer registry-token",
			);
			expect(await request?.json()).toEqual({
				model: "text-embedding-3-small",
				input: ["first", "second"],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
