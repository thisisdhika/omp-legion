import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

import type { DecomposerPolicy } from "../domain/config";
import {
	type DecomposerAuditEvent,
	type DecompositionInput,
	type TaskDecomposer,
	parseDecompositionResponse,
} from "../domain/decomposition";
import type { DispatchTask } from "../domain/dispatch";
import {
	type AvailableRole,
	DECOMPOSER_SYSTEM_PROMPT,
	buildDecomposerPrompt,
	formatAvailableRoles,
} from "./aggregator-prompts";
import { type HostLlmOptions, completeHostLlm } from "./host-llm";

export type HostLlmDecomposerOptions = HostLlmOptions & {
	/**
	 * Resolved decomposer policy: an ordered list of model selectors run one at
	 * a time. When omitted, the decomposer falls back to the active session
	 * model (the legacy single-model behavior).
	 */
	readonly policy?: DecomposerPolicy;
	/**
	 * Resolves a model selector string to a host `Model`. Defaults to a
	 * provider/id split against the model registry; callers with richer
	 * resolution (e.g. `ctx.models.resolve`) should pass it explicitly.
	 */
	readonly resolveModel?: (selector: string) => Model<Api> | undefined;
	/** Bounds total attempts; defaults to the policy's model count. */
	readonly budget?: { readonly maxAttempts?: number };
	/** Sink for per-attempt audit events (recorded into the dispatch audit). */
	readonly audit?: (event: DecomposerAuditEvent) => void;
	/** Injectable completion fn; defaults to the real host completion. */
	readonly complete?: typeof completeHostLlm;
	/**
	 * The legion-decomposer persona's system prompt (bundled, with
	 * project/user override support — see loadAgentDefinitions and
	 * agents/legion-decomposer.md). Falls back to the hardcoded
	 * DECOMPOSER_SYSTEM_PROMPT when absent (e.g. bundled agent failed to
	 * load, or a caller — a test — doesn't wire one through).
	 */
	readonly systemPrompt?: string;
	/**
	 * The real, currently-loaded dispatchable roster (bundled + any
	 * project/user overrides or custom personas) — without this the
	 * decomposer only ever sees a hardcoded illustrative example list and can
	 * invent a role that doesn't match any loaded persona, which now gets the
	 * whole dispatch rejected rather than silently substituted (see
	 * resolveAgentName). See host-dispatch-service.ts for how this is built.
	 */
	readonly availableRoles?: readonly AvailableRole[];
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ponytail: fixed #10 — distinguish fatal from retryable decomposer errors
function isRetryableDecomposerError(error: unknown): boolean {
	const msg = messageOf(error);
	const FATAL_PATTERNS = [
		/\b401\b/,
		/\b403\b/,
		/context[_ ]?length/i,
		/maximum context/i,
	];
	return !FATAL_PATTERNS.some((p) => p.test(msg));
}

function defaultResolveModel(
	registry: ModelRegistry,
	selector: string,
): Model<Api> | undefined {
	const slash = selector.indexOf("/");
	if (slash < 0) return registry.find(selector, "");
	return registry.find(selector.slice(0, slash), selector.slice(slash + 1));
}

export class HostLlmDecomposer implements TaskDecomposer {
	readonly #options: HostLlmDecomposerOptions;
	readonly #complete: typeof completeHostLlm;
	readonly #resolveModel: (selector: string) => Model<Api> | undefined;
	readonly #systemPrompt: string[];

	constructor(options: HostLlmDecomposerOptions) {
		this.#options = options;
		this.#complete = options.complete ?? completeHostLlm;
		this.#resolveModel =
			options.resolveModel ??
			((selector) => defaultResolveModel(options.modelRegistry, selector));
		const base = options.systemPrompt
			? [options.systemPrompt]
			: DECOMPOSER_SYSTEM_PROMPT;
		const roster = options.availableRoles
			? formatAvailableRoles(options.availableRoles)
			: "";
		this.#systemPrompt = roster ? [...base, roster] : base;
	}

	async decompose(input: DecompositionInput): Promise<readonly DispatchTask[]> {
		const policy = this.#options.policy;
		if (!policy || policy.models.length === 0) {
			return this.#legacyDecompose(input);
		}

		const maxAttempts =
			this.#options.budget?.maxAttempts ?? policy.models.length;
		const attempted = new Set<string>();
		let index = 0;
		for (const selector of policy.models) {
			if (input.signal?.aborted) {
				this.#record(input, {
					selector,
					index,
					status: "cancelled",
					error: "Decomposition cancelled.",
				});
				throw new Error("Decomposition cancelled.");
			}
			if (attempted.size >= maxAttempts) break;
			if (attempted.has(selector)) continue;
			attempted.add(selector);

			const temperature =
				policy.temperatureLadder[index % policy.temperatureLadder.length];
			const model = this.#resolveModel(selector);
			if (!model) {
				this.#record(input, {
					selector,
					index,
					temperature,
					status: "unavailable",
					error: `Model not available: ${selector}`,
				});
				index += 1;
				continue;
			}

			let output: string;
			try {
				output = await this.#complete(
					{
						model,
						modelRegistry: this.#options.modelRegistry,
						cwd: this.#options.cwd,
						temperature,
					},
					this.#systemPrompt,
					buildDecomposerPrompt(input),
					input.signal,
				);
			} catch (error) {
				if (input.signal?.aborted) {
					this.#record(input, {
						selector,
						index,
						temperature,
						status: "cancelled",
						error: messageOf(error),
					});
					throw error;
				}
				if (!isRetryableDecomposerError(error)) {
					// Fatal provider failure: record and throw — don't advance to next model.
					this.#record(input, {
						selector,
						index,
						temperature,
						status: "fatal-failure",
						error: messageOf(error),
					});
					throw error;
				}
				// Retryable provider failure: record and advance to next selector.
				this.#record(input, {
					selector,
					index,
					temperature,
					status: "retryable-failure",
					error: messageOf(error),
				});
				index += 1;
				continue;
			}

			// Completion succeeded: a parse/validation failure is a task-level
			// error and must NOT advance to the next model.
			try {
				const tasks = parseDecompositionResponse(output);
				this.#record(input, {
					selector,
					index,
					temperature,
					status: "success",
				});
				return tasks;
			} catch (parseError) {
				this.#record(input, {
					selector,
					index,
					temperature,
					status: "validation-failure",
					error: messageOf(parseError),
				});
				throw parseError;
			}
		}

		throw new Error(
			`Decomposer exhausted all ${attempted.size} candidate model(s) without a valid decomposition.`,
		);
	}

	/** Legacy single-model fallback when no decomposer policy is configured. */
	async #legacyDecompose(
		input: DecompositionInput,
	): Promise<readonly DispatchTask[]> {
		const model = this.#options.model;
		const selector = `${model.provider}/${model.id}`;
		const run = async (): Promise<readonly DispatchTask[]> => {
			const output = await this.#complete(
				{
					model,
					modelRegistry: this.#options.modelRegistry,
					cwd: this.#options.cwd,
				},
				this.#systemPrompt,
				buildDecomposerPrompt(input),
				input.signal,
			);
			return parseDecompositionResponse(output);
		};
		try {
			const tasks = await run();
			this.#record(input, { selector, index: 0, status: "success" });
			return tasks;
		} catch (error) {
			this.#record(input, {
				selector,
				index: 0,
				status: input.signal?.aborted ? "cancelled" : "retryable-failure",
				error: messageOf(error),
			});
			throw error;
		}
	}

	#record(
		input: DecompositionInput,
		event: Omit<DecomposerAuditEvent, "timestamp">,
	): void {
		const full: DecomposerAuditEvent = { ...event, timestamp: Date.now() };
		this.#options.audit?.(full);
		input.onAudit?.(full);
	}
}
