import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import type { DecomposerPolicy } from "../domain/config";
import { DEFAULT_DECOMPOSER_TIMEOUT_MS } from "../domain/constants";
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
import { defaultResolveModel } from "./host-llm";

/**
 * Read-only tool grant for the built-in fallback definition (used only when
 * the bundled agents/legion-decomposer.md persona failed to load). Mirrors
 * that persona's own frontmatter — see the comment on `agent` below for why
 * this matters at all.
 */
const FALLBACK_DECOMPOSER_TOOLS = ["read", "grep", "glob"];

function fallbackAgent(): AgentDefinition {
	return {
		name: "legion-decomposer",
		description: "Internal task-splitting planner (fallback definition).",
		systemPrompt: DECOMPOSER_SYSTEM_PROMPT.join("\n\n"),
		tools: FALLBACK_DECOMPOSER_TOOLS,
		source: "bundled",
	};
}

export type HostLlmDecomposerOptions = {
	readonly cwd: string;
	readonly modelRegistry: ModelRegistry;
	/** Active session model, used as the sole candidate when no `policy` is configured. */
	readonly model: Model<Api>;
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
	/** Bounds total attempts; defaults to the candidate selector count. */
	readonly budget?: { readonly maxAttempts?: number };
	/** Sink for per-attempt audit events (recorded into the dispatch audit). */
	readonly audit?: (event: DecomposerAuditEvent) => void;
	/**
	 * The legion-decomposer persona's full `AgentDefinition` (bundled, with
	 * project/user override support — see loadAgentDefinitions and
	 * agents/legion-decomposer.md). Its own `tools:` grant (read/grep/glob) is
	 * what lets the decomposer actually open the file(s) a task references
	 * before writing assignments, instead of enhancing a bare task string
	 * from guesswork alone — a real, previously-structural limitation: the
	 * decomposer used to run as a bare one-shot text completion with zero
	 * tool access and zero codebase context beyond the literal task string,
	 * which is why its enhanced assignments read as short, narrow, and
	 * context-free regardless of how the prompt was worded. Falls back to a
	 * built-in definition (same tool grant, DECOMPOSER_SYSTEM_PROMPT as its
	 * system prompt) when the bundled persona failed to load.
	 */
	readonly agent?: AgentDefinition;
	/**
	 * The real, currently-loaded dispatchable roster (bundled + any
	 * project/user overrides or custom personas) — without this the
	 * decomposer only ever sees a hardcoded illustrative example list and can
	 * invent a role that doesn't match any loaded persona, which now gets the
	 * whole dispatch rejected rather than silently substituted (see
	 * resolveAgentName). See host-dispatch-service.ts for how this is built.
	 */
	readonly availableRoles?: readonly AvailableRole[];
	/** Threaded through so the decomposer's own investigation appears in the interactive "Subagents" HUD, same as any other spawn. */
	readonly eventBus?: ExecutorOptions["eventBus"];
	/** Hard wall-clock cap for one decomposer subprocess attempt. */
	readonly decomposerTimeoutMs?: number;
	/** Injectable subprocess runner; defaults to the real host runSubprocess. */
	readonly runSubprocess?: typeof runSubprocess;
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

export class HostLlmDecomposer implements TaskDecomposer {
	readonly #options: HostLlmDecomposerOptions;
	readonly #runSubprocess: typeof runSubprocess;
	readonly #resolveModel: (selector: string) => Model<Api> | undefined;
	readonly #agent: AgentDefinition;

	constructor(options: HostLlmDecomposerOptions) {
		this.#options = options;
		this.#runSubprocess = options.runSubprocess ?? runSubprocess;
		this.#resolveModel =
			options.resolveModel ??
			((selector) => defaultResolveModel(options.modelRegistry, selector));
		this.#agent = options.agent ?? fallbackAgent();
	}

	async decompose(input: DecompositionInput): Promise<readonly DispatchTask[]> {
		const policy = this.#options.policy;
		const selectors =
			policy && policy.models.length > 0
				? policy.models
				: [`${this.#options.model.provider}/${this.#options.model.id}`];
		const temperatureLadder = policy?.temperatureLadder ?? [];
		const maxAttempts = this.#options.budget?.maxAttempts ?? selectors.length;

		const attempted = new Set<string>();
		let index = 0;
		for (const selector of selectors) {
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
				temperatureLadder.length > 0
					? temperatureLadder[index % temperatureLadder.length]
					: undefined;
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
				output = await this.#runOnce(input, selector, index, temperature);
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

			// Run succeeded: a parse/validation failure is a task-level error and
			// must NOT advance to the next model.
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

	/**
	 * Runs the decomposer as a real, tool-using subagent (not a bare
	 * completion) — a non-isolated `runSubprocess` call, since a read-only
	 * agent has nothing to isolate against. The roster (`availableRoles`) is
	 * threaded through `context`, the one `ExecutorOptions` field documented
	 * as "rendered into the subagent's system prompt", so it doesn't need to
	 * be spliced into the agent's own `systemPrompt` string by hand.
	 */
	async #runOnce(
		input: DecompositionInput,
		selector: string,
		index: number,
		temperature: number | undefined,
	): Promise<string> {
		const roster = this.#options.availableRoles
			? formatAvailableRoles(this.#options.availableRoles)
			: "";
		const jobId = input.jobId ?? "legion-decompose";
		const id = `${jobId}-decomposer-${index}`;
		const prompt = buildDecomposerPrompt(input);
		const result = await this.#runSubprocess({
			cwd: this.#options.cwd,
			agent: this.#agent,
			task: prompt,
			assignment: prompt,
			index,
			id,
			modelOverride: selector,
			context: roster || undefined,
			maxRuntimeMs:
				this.#options.decomposerTimeoutMs ?? DEFAULT_DECOMPOSER_TIMEOUT_MS,
			signal: input.signal,
			detached: true,
			settings: Settings.isolated(
				temperature !== undefined ? { temperature } : {},
			),
		});
		if (result.aborted) {
			throw new Error(result.error ?? "Decomposer subprocess aborted.");
		}
		if (result.exitCode !== 0 || result.error) {
			throw new Error(
				result.error ||
					result.stderr ||
					`Decomposer subprocess exited ${result.exitCode}.`,
			);
		}
		if (!result.output || result.output.trim().length === 0) {
			throw new Error("Decomposer subprocess returned no output.");
		}
		return result.output;
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
