import type { Api, Model } from "@oh-my-pi/pi-ai";

import type { Aggregator, AggregatorInput } from "../domain/synthesis";
import {
	AGGREGATOR_SYSTEM_PROMPT,
	buildAggregatorPrompt,
} from "./aggregator-prompts";
import {
	type HostLlmOptions,
	completeHostLlm,
	defaultResolveModel,
} from "./host-llm";

export interface HostLlmAggregatorOptions extends HostLlmOptions {
	/**
	 * Ordered model selectors to retry, one at a time, if the primary `model`
	 * fails — the primary is a single `Model` resolved once at session_start
	 * (see host-dispatch-service.ts), unrelated to any expert's own model, and
	 * has been live-confirmed to occasionally fail to resolve when invoked
	 * from a background job with no retry of any kind: the aggregator threw
	 * once and gave up, relying entirely on SynthesisService's own
	 * degrade-to-raw-answer fallback. That fallback is still the right last
	 * resort (a lost write-up must never discard real expert work), but it
	 * shouldn't be the *first* response to a plain transient model failure
	 * when other configured models could just produce the real write-up
	 * instead. Reuses the same selector list the decomposer already retries
	 * through (`config.decomposer.models`) rather than adding a new,
	 * separately-configured model list for what is the same kind of
	 * single-model utility completion.
	 */
	readonly fallbackModels?: readonly string[];
	/** Resolves a fallback selector to a host `Model`. Defaults to a provider/id split against `modelRegistry`, same default as the decomposer's. */
	readonly resolveModel?: (selector: string) => Model<Api> | undefined;
	/** Injectable completion function; defaults to the real host completeHostLlm. Mirrors the decomposer's injectable runSubprocess — lets the retry ladder be unit-tested without a real model call. */
	readonly complete?: typeof completeHostLlm;
}

export class HostLlmAggregator implements Aggregator {
	readonly #options: HostLlmAggregatorOptions;
	readonly #resolveModel: (selector: string) => Model<Api> | undefined;
	readonly #complete: typeof completeHostLlm;

	constructor(options: HostLlmAggregatorOptions) {
		this.#options = options;
		this.#resolveModel =
			options.resolveModel ??
			((selector) => defaultResolveModel(options.modelRegistry, selector));
		this.#complete = options.complete ?? completeHostLlm;
	}

	async synthesize(
		input: AggregatorInput,
		signal?: AbortSignal,
	): Promise<string> {
		const systemPrompt = AGGREGATOR_SYSTEM_PROMPT;
		const prompt = buildAggregatorPrompt(input);
		try {
			return await this.#complete(this.#options, systemPrompt, prompt, signal);
		} catch (primaryError) {
			let lastError = primaryError;
			for (const selector of this.#options.fallbackModels ?? []) {
				const model = this.#resolveModel(selector);
				if (!model) continue;
				try {
					return await this.#complete(
						{ ...this.#options, model },
						systemPrompt,
						prompt,
						signal,
					);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		}
	}
}
