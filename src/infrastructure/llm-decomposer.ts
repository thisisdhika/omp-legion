import {
	type DecompositionInput,
	type TaskDecomposer,
	parseDecompositionResponse,
} from "../domain/decomposition";
import type { DispatchTask } from "../domain/dispatch";
import {
	DECOMPOSER_SYSTEM_PROMPT,
	buildDecomposerPrompt,
} from "./aggregator-prompts";
import { type HostLlmOptions, completeHostLlm } from "./host-llm";

export type HostLlmDecomposerOptions = HostLlmOptions;

export class HostLlmDecomposer implements TaskDecomposer {
	readonly #options: HostLlmDecomposerOptions;

	constructor(options: HostLlmDecomposerOptions) {
		this.#options = options;
	}

	async decompose(input: DecompositionInput): Promise<readonly DispatchTask[]> {
		const output = await completeHostLlm(
			this.#options,
			DECOMPOSER_SYSTEM_PROMPT,
			buildDecomposerPrompt(input),
			input.signal,
		);
		return parseDecompositionResponse(output);
	}
}
