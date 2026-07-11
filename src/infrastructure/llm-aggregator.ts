import type { Aggregator, AggregatorInput } from "../domain/synthesis";
import {
	AGGREGATOR_SYSTEM_PROMPT,
	buildAggregatorPrompt,
} from "./aggregator-prompts";
import { type HostLlmOptions, completeHostLlm } from "./host-llm";

export type HostLlmAggregatorOptions = HostLlmOptions;

export class HostLlmAggregator implements Aggregator {
	readonly #options: HostLlmAggregatorOptions;

	constructor(options: HostLlmAggregatorOptions) {
		this.#options = options;
	}

	async synthesize(
		input: AggregatorInput,
		signal?: AbortSignal,
	): Promise<string> {
		return completeHostLlm(
			this.#options,
			AGGREGATOR_SYSTEM_PROMPT,
			buildAggregatorPrompt(input),
			signal,
		);
	}
}
