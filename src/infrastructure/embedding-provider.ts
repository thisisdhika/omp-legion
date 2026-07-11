import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	available as mnemopiAvailable,
	embed as mnemopiEmbed,
} from "@oh-my-pi/pi-mnemopi";
import { logger } from "@oh-my-pi/pi-utils";

import {
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
} from "../domain/constants";
import type { EmbeddingProvider } from "../domain/synthesis";

export type EmbeddingModelRegistry = Pick<
	ModelRegistry,
	"find" | "getAll" | "getApiKey" | "getAvailable"
>;

export interface OllamaEmbeddingOptions {
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly model?: string;
	readonly modelRegistry?: EmbeddingModelRegistry;
}

export interface HostModelRegistryEmbeddingOptions {
	readonly modelRegistry: EmbeddingModelRegistry;
	readonly model?: string;
}

function validVectors(
	vectors: readonly (readonly number[])[] | null,
	count: number,
): vectors is readonly (readonly number[])[] {
	if (vectors === null || vectors.length !== count || vectors.length === 0)
		return false;
	const dimension = vectors[0]?.length ?? 0;
	return (
		dimension > 0 &&
		vectors.every(
			(vector) => vector.length === dimension && vector.every(Number.isFinite),
		)
	);
}

function apiUrl(baseUrl: string, path: string): string {
	const normalized = baseUrl.replace(/\/+$/u, "");
	return normalized.endsWith("/api")
		? `${normalized}/${path}`
		: `${normalized}/api/${path}`;
}

function registryEmbeddingUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/u, "");
	return normalized.endsWith("/v1") || normalized.endsWith("/api")
		? `${normalized}/embeddings`
		: `${normalized}/v1/embeddings`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function readVector(value: unknown): number[] | null {
	return Array.isArray(value) && value.every(Number.isFinite) ? value : null;
}

async function readOllamaBatch(
	response: Response,
	count: number,
): Promise<number[][] | null> {
	if (!response.ok) return null;
	const body = readRecord(await response.json());
	const embeddings = body?.embeddings;
	if (Array.isArray(embeddings) && validVectors(embeddings, count))
		return embeddings;
	const embedding = body?.embedding;
	if (count === 1 && Array.isArray(embedding) && validVectors([embedding], 1))
		return [embedding];
	return null;
}

async function readRegistryBatch(
	response: Response,
	count: number,
): Promise<number[][] | null> {
	if (!response.ok) return null;
	const body = readRecord(await response.json());
	if (!body || !Array.isArray(body.data)) return null;
	const vectors = body.data.map((item) => {
		const entry = readRecord(item);
		return readVector(entry?.embedding);
	});
	const resolved = vectors.filter(
		(vector): vector is number[] => vector !== null,
	);
	return resolved.length === vectors.length && validVectors(resolved, count)
		? resolved
		: null;
}

function findRegistryModel(
	registry: EmbeddingModelRegistry,
	selector: string,
): Model<Api> | undefined {
	const separator = selector.indexOf("/");
	if (separator > 0) {
		return registry.find(
			selector.slice(0, separator),
			selector.slice(separator + 1),
		);
	}
	return (
		registry.getAvailable().find((model) => model.id === selector) ??
		registry.getAll().find((model) => model.id === selector)
	);
}

export class HostModelRegistryEmbeddingAdapter implements EmbeddingProvider {
	readonly #options: HostModelRegistryEmbeddingOptions;

	constructor(options: HostModelRegistryEmbeddingOptions) {
		this.#options = options;
	}

	async embed(
		texts: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly (readonly number[])[] | null> {
		try {
			const selector = this.#options.model?.trim();
			if (!selector) return null;
			const model = findRegistryModel(this.#options.modelRegistry, selector);
			if (!model) return null;
			const headers: Record<string, string> = {
				...model.headers,
				"Content-Type": "application/json",
			};
			const apiKey = await this.#options.modelRegistry.getApiKey(model);
			if (apiKey && !headers.Authorization)
				headers.Authorization = `Bearer ${apiKey}`;
			const response = await fetch(registryEmbeddingUrl(model.baseUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ model: model.id, input: texts }),
				signal,
			});
			return await readRegistryBatch(response, texts.length);
		} catch {
			return null;
		}
	}
}

export class HostEmbeddingProvider implements EmbeddingProvider {
	readonly #options: OllamaEmbeddingOptions;
	readonly #registryAdapter?: HostModelRegistryEmbeddingAdapter;
	#warned = false;

	constructor(options: OllamaEmbeddingOptions = {}) {
		this.#options = options;
		this.#registryAdapter = options.modelRegistry
			? new HostModelRegistryEmbeddingAdapter({
					modelRegistry: options.modelRegistry,
					model: options.model,
				})
			: undefined;
	}

	async embed(
		texts: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly (readonly number[])[] | null> {
		if (this.#registryAdapter) {
			const vectors = await this.#registryAdapter.embed(texts, signal);
			if (vectors !== null) return vectors;
		}

		try {
			if (await mnemopiAvailable()) {
				const vectors = await mnemopiEmbed(texts);
				const normalized = vectors?.map((vector) => [...vector]) ?? null;
				if (validVectors(normalized, texts.length)) return normalized;
			}
		} catch {
			// The host Mnemopi path is best effort; local Ollama remains available.
		}

		const vectors = await this.#embedWithOllama(texts, signal);
		if (vectors !== null) return vectors;
		if (!this.#warned) {
			this.#warned = true;
			logger.warn(
				"Legion semantic clustering degraded to Rouge-L; no real embedding provider is available.",
			);
		}
		return null;
	}

	async #embedWithOllama(
		texts: readonly string[],
		signal?: AbortSignal,
	): Promise<number[][] | null> {
		const baseUrl = this.#options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
		const model = this.#options.model ?? DEFAULT_OLLAMA_EMBEDDING_MODEL;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.#options.apiKey)
			headers.Authorization = `Bearer ${this.#options.apiKey}`;
		try {
			const batchResponse = await fetch(apiUrl(baseUrl, "embed"), {
				method: "POST",
				headers,
				body: JSON.stringify({ model, input: texts }),
				signal,
			});
			const batch = await readOllamaBatch(batchResponse, texts.length);
			if (batch !== null) return batch;
		} catch {
			// Try the older one-prompt endpoint below.
		}

		try {
			const vectors = await Promise.all(
				texts.map(async (text) => {
					const response = await fetch(apiUrl(baseUrl, "embeddings"), {
						method: "POST",
						headers,
						body: JSON.stringify({ model, prompt: text }),
						signal,
					});
					const parsed = await readOllamaBatch(response, 1);
					return parsed?.[0] ?? null;
				}),
			);
			return vectors.every((vector) => vector !== null)
				? (vectors as number[][])
				: null;
		} catch {
			return null;
		}
	}
}
