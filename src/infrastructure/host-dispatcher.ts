import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import {
	type AgentDefinition,
	discoverAgents,
	getAgent,
} from "@oh-my-pi/pi-coding-agent/task";
import {
	type ExecutorOptions,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";

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
}

export class HostExpertExecutor implements ExpertExecutor {
	readonly #options: HostExecutorOptions;
	readonly #agents: Promise<AgentDefinition[]>;

	constructor(options: HostExecutorOptions) {
		this.#options = options;
		this.#agents = discoverAgents(options.cwd).then((result) => result.agents);
	}

	async run(execution: ExpertExecution): Promise<ExpertResult> {
		const agent = getAgent(await this.#agents, execution.attempt.agent);
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
