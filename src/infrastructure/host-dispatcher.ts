import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import type {
	ExpertExecution,
	ExpertExecutor,
	JobRunContext,
	JobScheduler,
} from "../application/dispatch-service";
import type { ExpertResult } from "../domain/dispatch";

export interface HostExecutorOptions {
	readonly cwd: string;
	readonly modelRegistry: ExecutorOptions["modelRegistry"];
	readonly sessionFile?: string | null;
	readonly artifactsDir?: string;
	readonly parentArtifactManager?: ExecutorOptions["parentArtifactManager"];
	readonly parentActiveModelPattern?: string;
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
}

export class HostExpertExecutor implements ExpertExecutor {
	readonly #options: HostExecutorOptions;

	constructor(options: HostExecutorOptions) {
		this.#options = options;
	}

	async run(execution: ExpertExecution): Promise<ExpertResult> {
		const agent = this.#options.agents.get(execution.attempt.agent);
		if (!agent)
			throw new Error(`Unknown host agent "${execution.attempt.agent}".`);

		const result = await runSubprocess({
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
			parentActiveModelPattern: this.#options.parentActiveModelPattern,
			sessionFile: this.#options.sessionFile,
			persistArtifacts:
				this.#options.sessionFile !== undefined &&
				this.#options.sessionFile !== null,
			artifactsDir: this.#options.artifactsDir,
			parentArtifactManager: this.#options.parentArtifactManager,
			modelRegistry: this.#options.modelRegistry,
			eventBus: this.#options.eventBus,
			signal: execution.signal,
		});

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
		};
	}
}

export class HostJobScheduler implements JobScheduler {
	readonly #manager: AsyncJobManager;

	constructor(manager: AsyncJobManager) {
		this.#manager = manager;
	}

	schedule(
		label: string,
		run: (context: JobRunContext) => Promise<string>,
		id?: string,
	): string {
		return this.#manager.register(
			"task",
			label,
			(context) =>
				run({
					jobId: context.jobId,
					signal: context.signal,
					reportProgress: context.reportProgress,
				}),
			{ id },
		);
	}
}
