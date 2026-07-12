import {
	type Api,
	type Context,
	type Model,
	completeSimple,
} from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

import { AGGREGATOR_DISABLE_REASONING } from "../domain/constants";

export interface HostLlmOptions {
	readonly model: Model<Api>;
	readonly modelRegistry: ModelRegistry;
	readonly cwd: string;
	readonly temperature?: number;
}

function responseText(
	content: Context["messages"][number] | undefined,
): string {
	if (!content || content.role !== "assistant") return "";
	return content.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function completeHostLlm(
	options: HostLlmOptions,
	systemPrompt: string[],
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
	const response = await completeSimple(options.model, context, {
		apiKey: options.modelRegistry.resolver(options.model),
		cwd: options.cwd,
		disableReasoning: AGGREGATOR_DISABLE_REASONING,
		temperature: options.temperature,
		signal,
	});
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(
			response.errorMessage ?? `Host completion ${response.stopReason}.`,
		);
	}
	const text = responseText(response);
	if (text.length === 0) throw new Error("Host completion returned no text.");
	return text;
}
