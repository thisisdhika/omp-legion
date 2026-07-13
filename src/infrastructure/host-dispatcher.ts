import { tmpdir } from "node:os";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type {
	IsolatedRunOptions,
	IsolationContext,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type {
	AgentDefinition,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent/task/types";

import type {
	ExpertExecution,
	ExpertExecutor,
	JobInfo,
	JobRunContext,
	JobScheduler,
	ReviveExpertParams,
} from "../application/dispatch-service";
import type { ExpertResult } from "../domain/dispatch";
import { runAsDispatchedAgent } from "./agent-execution-context";

export interface HostExecutorOptions {
	readonly cwd: string;
	readonly modelRegistry: ExecutorOptions["modelRegistry"];
	readonly sessionFile?: string | null;
	readonly artifactsDir?: string;
	readonly parentArtifactManager?: ExecutorOptions["parentArtifactManager"];
	/**
	 * Legion's own resolved agent roster (bundled personas + any project/user
	 * override), loaded once at session_start via agent-loader.ts. Agent
	 * resolution itself already happened upstream in buildDispatchPlan
	 * (domain/dispatch.ts's resolveAgentName) — this is only the lookup for
	 * the actual AgentDefinition runSubprocess needs.
	 */
	readonly agents: ReadonlyMap<string, AgentDefinition>;
	/**
	 * The session's shared event bus (`ExtensionAPI.events`, only available at
	 * registration time in index.ts — ExtensionContext does not expose it).
	 * runSubprocess only publishes TASK_SUBAGENT_LIFECYCLE/PROGRESS events
	 * when given one; without it, the host's SessionObserverRegistry never
	 * learns about a spawn, so it never appears in the interactive "Subagents"
	 * HUD — even though the separate, unconditional AgentRegistry
	 * registration inside runSubprocess still happens either way (which is
	 * why IRC and the numeric subagent counter worked before this was wired).
	 */
	readonly eventBus?: ExecutorOptions["eventBus"];
	/**
	 * Wall-clock cap per expert attempt (forwarded to the host's own
	 * `ExecutorOptions.maxRuntimeMs`). Without this, an expert stuck retrying
	 * a tool call it doesn't have (e.g. a read-only role asked to edit a
	 * file) hangs indefinitely — no error, no retry, no escalation, just a
	 * static "N-1/N experts finished" forever (confirmed live). A capped
	 * attempt fails cleanly instead, and synthesis proceeds with whichever
	 * experts did respond.
	 */
	readonly expertTimeoutMs?: number;
}

/** Builds a synthetic failure SingleResult when isolation setup itself throws (not a git repo, no backend available, etc.) — before the subagent ever ran. */
function isolationFailureResult(
	execution: ExpertExecution,
	error: unknown,
): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		index: execution.attempt.index,
		id: execution.attempt.id,
		agent: execution.attempt.agent,
		agentSource: "bundled",
		task: execution.task,
		assignment: execution.attempt.assignment,
		description: execution.attempt.description,
		exitCode: 1,
		output: "",
		stderr: message,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error: message,
	};
}

export class HostExpertExecutor implements ExpertExecutor {
	readonly #options: HostExecutorOptions;

	constructor(options: HostExecutorOptions) {
		this.#options = options;
	}

	/**
	 * Resolved once per dispatch job (see ExpertExecutor.prepareJob's doc
	 * comment) so every concurrent attempt in this job diffs against the same
	 * git baseline, rather than each attempt capturing a slightly different
	 * one depending on when it happened to start.
	 */
	async prepareJob(): Promise<IsolationContext> {
		return prepareIsolationContext(this.#options.cwd);
	}

	async run(execution: ExpertExecution): Promise<ExpertResult> {
		const agent = this.#options.agents.get(execution.attempt.agent);
		if (!agent)
			throw new Error(`Unknown host agent "${execution.attempt.agent}".`);

		const isolationContext = execution.jobContext as
			| IsolationContext
			| undefined;
		if (!isolationContext) {
			throw new Error(
				"Legion isolation context missing; prepareJob() must run before any attempt.",
			);
		}

		const baseOptions: ExecutorOptions = {
			cwd: this.#options.cwd,
			agent,
			task: execution.attempt.assignment,
			assignment: execution.attempt.assignment,
			context: execution.task,
			description: execution.attempt.description,
			role: execution.attempt.role,
			index: execution.attempt.index,
			id: execution.attempt.id,
			parentToolCallId: execution.parentToolCallId,
			detached: true,
			modelOverride: execution.attempt.model,
			// Deliberately omitted: ExecutorOptions.parentActiveModelPattern makes
			// the host silently substitute the PRIMARY session's own active model
			// whenever an attempt's assigned model fails its auth check — bypassing
			// Legion's own modelMap fallback chain (nextReplacement/#runFallback,
			// which already walks the role's configured candidates in order) and
			// masking which candidate actually failed behind an unrelated "Model
			// not found <primary's model>" from a substitution that itself doesn't
			// always resolve inside an isolated subagent's settings snapshot.
			// Live-confirmed: a scout dispatch failed outright with "Model not
			// found gpt-5.6-luna" (the primary session's own model, never part of
			// modelMap.scout) instead of falling through to the role's next
			// configured candidate.
			sessionFile: this.#options.sessionFile,
			persistArtifacts:
				this.#options.sessionFile !== undefined &&
				this.#options.sessionFile !== null,
			artifactsDir: this.#options.artifactsDir,
			parentArtifactManager: this.#options.parentArtifactManager,
			modelRegistry: this.#options.modelRegistry,
			eventBus: this.#options.eventBus,
			signal: execution.signal,
			maxRuntimeMs: this.#options.expertTimeoutMs,
			// Deliberately constructed rather than omitted: without this, every
			// spawn silently discarded whatever session-level settings existed
			// (runSubprocess falls back to a blank Settings.isolated() when given
			// none at all). Passing execution.attempt.temperature here — set for
			// self-consistency attempts, undefined otherwise — is what actually
			// makes N samples of the same model produce genuinely varied output
			// rather than riding on the provider's own untracked default.
			//
			// "mcp.discoveryMode": true is forced unconditionally, not inherited
			// from the interactive session's own setting. Live-confirmed: personas
			// that grant search_tool_bm25 (host/tools/index.ts gates it behind
			// resolveEffectiveToolDiscoveryMode, "off" unless tools.discoveryMode
			// is "all"/"mcp-only", mcp.discoveryMode is true, or "auto" with >40
			// active tools) silently lost the tool from their active set — a blank
			// Settings.isolated() defaults tools.discoveryMode to "auto" with a
			// role's ~8-tool grant nowhere near that threshold, so the tool never
			// even entered the registry regardless of the persona's own frontmatter
			// grant or the user's real global discoveryMode setting (which this
			// isolated snapshot never sees at all).
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				...(execution.attempt.temperature !== undefined
					? { temperature: execution.attempt.temperature }
					: {}),
			}),
		};

		// Tags this attempt's entire runSubprocess call chain (reached inside
		// runIsolatedSubprocess) with its agent name so irc-tool-guard.ts can
		// identify legion-* callers later, from inside that same subagent's own
		// tool_call events — see agent-execution-context.ts.
		//
		// worktree: false skips isolation entirely — no worktree prep, no
		// branch/merge bookkeeping. Isolation exists so parallel file-editing
		// attempts land independent diffs without colliding; a read-only role
		// (never calls edit/write) has nothing to collide over, so paying that
		// setup/teardown cost is pure overhead. This also makes the attempt
		// keep-alive/revivable by the host's AgentLifecycleManager (isolated
		// runs are parked without adopting — never resumable, since their
		// worktree is merged and cleaned right after) — see
		// runSubagentFollowUpTurn's doc comment in the vendored executor.
		if (execution.attempt.worktree === false) {
			const result = await runAsDispatchedAgent(execution.attempt.agent, () =>
				runSubprocess(baseOptions),
			);
			return {
				attemptId: execution.attempt.id,
				taskId: execution.attempt.taskId,
				agent: execution.attempt.agent,
				role: execution.attempt.role,
				model: execution.attempt.model,
				index: execution.attempt.index,
				output: result.output,
				stderr: result.stderr,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				tokens: result.tokens,
				requests: result.requests,
				error: result.error,
				aborted: result.aborted,
				retryFailure: result.retryFailure,
			};
		}

		const isolatedOptions: IsolatedRunOptions = {
			baseOptions,
			context: isolationContext,
			// undefined lets the host's own backend resolver (PAL) pick whatever
			// copy-on-write mechanism is actually available on this machine.
			preferredBackend: undefined,
			agentId: execution.attempt.id,
			mergeMode: "branch",
			// Only consulted when a successful run's branch commit fails — the
			// isolated diff still needs somewhere to land as a .patch fallback.
			artifactsDir: this.#options.artifactsDir ?? tmpdir(),
			description: execution.attempt.description,
			buildFailureResult: (err) => isolationFailureResult(execution, err),
		};

		const result = await runAsDispatchedAgent(execution.attempt.agent, () =>
			runIsolatedSubprocess(isolatedOptions),
		);
		return {
			attemptId: execution.attempt.id,
			taskId: execution.attempt.taskId,
			agent: execution.attempt.agent,
			role: execution.attempt.role,
			model: execution.attempt.model,
			index: execution.attempt.index,
			output: result.output,
			stderr: result.stderr,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			tokens: result.tokens,
			requests: result.requests,
			error: result.error,
			aborted: result.aborted,
			branchName: result.branchName,
			baseSha: result.branchBaseSha,
			// ponytail: fixed #11 — preserve host's retryFailure signal
			retryFailure: result.retryFailure,
		};
	}

	/**
	 * Continue a previously run, non-isolated expert with one more turn via
	 * the host's own `runSubagentFollowUpTurn` — revives it from parked if
	 * needed, replays its full prior conversation (files already read,
	 * reasoning already done), and drives it to `yield` again exactly like a
	 * first run. Only ever called by DispatchService's `#reviveExperts` after
	 * confirming the originating attempt ran with `worktree: false`; calling
	 * this on an isolated result's id would throw inside the host (its
	 * worktree is merged and cleaned right after the run, so
	 * `AgentLifecycleManager.ensureLive` can never resume it) — this method
	 * does not itself re-check that, the caller owns the invariant.
	 */
	async reviveExpert(params: ReviveExpertParams): Promise<ExpertResult> {
		const { result, message, signal } = params;
		const agent = this.#options.agents.get(result.agent);
		if (!agent) throw new Error(`Unknown host agent "${result.agent}".`);
		const revived = await runAsDispatchedAgent(result.agent, () =>
			runSubagentFollowUpTurn({
				id: result.attemptId,
				agent,
				message,
				signal,
				eventBus: this.#options.eventBus,
				maxRuntimeMs: this.#options.expertTimeoutMs,
			}),
		);
		return {
			attemptId: result.attemptId,
			taskId: result.taskId,
			agent: result.agent,
			role: result.role,
			model: result.model,
			index: result.index,
			output: revived.output,
			stderr: revived.stderr,
			exitCode: revived.exitCode,
			durationMs: revived.durationMs,
			tokens: revived.tokens,
			requests: revived.requests,
			error: revived.error,
			aborted: revived.aborted,
			retryFailure: revived.retryFailure,
		};
	}
}

export class HostJobScheduler implements JobScheduler {
	readonly #manager: AsyncJobManager;
	readonly #lastProgress = new Map<
		string,
		{ text: string; details?: Record<string, unknown> }
	>();

	constructor(manager: AsyncJobManager) {
		this.#manager = manager;
	}

	schedule(
		label: string,
		run: (context: JobRunContext) => Promise<string>,
		id?: string,
		onProgress?: (text: string, details?: Record<string, unknown>) => void,
	): string {
		// The manager's own onProgress callback already receives every
		// reportProgress call with its (text, details) pair, keyed by the same
		// id the run callback sees as context.jobId — tracking it here alone
		// (rather than also re-wrapping context.reportProgress) is the single
		// source of truth getJob() reads back.
		return this.#manager.register("task", label, run, {
			id,
			onProgress: (text, details) => {
				this.#lastProgress.set(id ?? "", { text, details });
				onProgress?.(text, details);
			},
		});
	}
	getJob(id: string): JobInfo | undefined {
		const job = this.#manager.getJob(id);
		if (!job) return undefined;
		const lastProgress = this.#lastProgress.get(id);
		return {
			status: job.status,
			resultText: job.resultText,
			errorText: job.errorText,
			lastProgressText: lastProgress?.text,
			lastProgressDetails: lastProgress?.details,
			promise: job.promise,
		};
	}
}
