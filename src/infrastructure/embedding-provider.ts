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

export interface OllamaEmbeddingOptions {
	readonly baseUrl?: string;
	readonly apiKey?: string;
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

async function readOllamaBatch(
	response: Response,
	count: number,
): Promise<number[][] | null> {
	if (!response.ok) return null;
	const body = (await response.json()) as {
		embeddings?: number[][];
		embedding?: number[];
	};
	if (Array.isArray(body.embeddings) && validVectors(body.embeddings, count))
		return body.embeddings;
	if (
		count === 1 &&
		Array.isArray(body.embedding) &&
		validVectors([body.embedding], 1)
	)
		return [body.embedding];
	return null;
}

export class HostEmbeddingProvider implements EmbeddingProvider {
	readonly #options: OllamaEmbeddingOptions;
	#warned = false;

	constructor(options: OllamaEmbeddingOptions = {}) {
		this.#options = options;
	}

	async embed(
		texts: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly (readonly number[])[] | null> {
		try {
			if (await mnemopiAvailable()) {
				const vectors = await mnemopiEmbed(texts);
				const normalized = vectors?.map((vector) => [...vector]) ?? null;
				if (validVectors(normalized, texts.length)) return normalized;
			}
		} catch {
			// The host Mnemopi path is best effort; Ollama is the explicit local fallback.
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
