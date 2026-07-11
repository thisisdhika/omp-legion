import type { LegionConfig } from "../domain/config";
import {
	DEFAULT_ENSEMBLE_SIZE,
	HOTL_DECISION_EDIT,
	HOTL_DECISION_REJECT,
	HOTL_EMPTY_EDIT_MESSAGE,
	HOTL_NO_DECISION_PROVIDER_MESSAGE,
	LEGION_DISPATCH_JOB_LABEL,
} from "../domain/constants";
import {
	type TaskDecomposer,
	fallbackDecomposition,
} from "../domain/decomposition";
import {
	type DispatchAttempt,
	type DispatchRequest,
	type ExpertResult,
	type ModelAvailability,
	type OrchestrationRepository,
	buildDispatchPlan,
	dispatchRequestSchema,
	humanReadableJobId,
} from "../domain/dispatch";
import {
	type GovernanceDecision,
	type GovernanceResolution,
	type GovernanceThresholds,
	type HumanDecision,
	evaluateGovernance,
	isHumanDecisionAction,
} from "../domain/governance";
import type { SynthesisResult, SynthesisRunner } from "../domain/synthesis";

export interface ExpertExecution {
	readonly attempt: DispatchAttempt;
	readonly task: string;
	readonly parentToolCallId?: string;
	readonly signal: AbortSignal;
}

export interface ExpertExecutor {
	run(execution: ExpertExecution): Promise<ExpertResult>;
}

export interface JobRunContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	reportProgress(
		text: string,
		details?: Record<string, unknown>,
	): Promise<void>;
}

export interface JobScheduler {
	schedule(
		label: string,
		run: (context: JobRunContext) => Promise<string>,
		id?: string,
	): string;
}

export interface EscalationNotice {
	readonly jobId: string;
	readonly taskId: string;
	readonly decision: GovernanceDecision;
	readonly synthesis: SynthesisResult;
}

export type EscalationNotifier = (
	notice: EscalationNotice,
) => void | Promise<void>;

export type HumanDecisionGate = (
	notice: EscalationNotice,
	signal: AbortSignal,
) => Promise<HumanDecision>;

export interface DispatchServiceOptions {
	readonly scheduler: JobScheduler;
	readonly executor: ExpertExecutor;
	readonly synthesizer: SynthesisRunner;
	readonly repository: OrchestrationRepository;
	readonly config?: LegionConfig;
	readonly defaultModel?: string;
	readonly isModelAvailable: ModelAvailability;
	readonly governanceThresholds?: GovernanceThresholds;
	readonly decomposer?: TaskDecomposer;
	readonly notifyEscalation?: EscalationNotifier;
	readonly decisionGate?: HumanDecisionGate;
	readonly now?: () => number;
}

export interface DispatchAccepted {
	readonly jobId: string;
	readonly recordId: string;
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
}

function failedResult(
	execution: ExpertExecution,
	error: unknown,
): ExpertResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		attemptId: execution.attempt.id,
		taskId: execution.attempt.taskId,
		agent: execution.attempt.agent,
		role: execution.attempt.role,
		model: execution.attempt.model,
		index: execution.attempt.index,
		output: "",
		stderr: message,
		exitCode: 1,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error: message,
	};
}
function applyConfigDefaults(
	request: DispatchRequest,
	config: LegionConfig | undefined,
): DispatchRequest {
	if (!config) return request;
	const modelMap: DispatchRequest["modelMap"] = { ...config.modelMap };
	for (const role of Object.keys(request.modelMap)) {
		const policy = request.modelMap[role];
		if (policy) modelMap[role] = { ...config.modelMap[role], ...policy };
	}
	return {
		...request,
		modelMap,
		defaultEnsembleSize:
			request.defaultEnsembleSize === DEFAULT_ENSEMBLE_SIZE
				? config.defaultEnsembleSize
				: request.defaultEnsembleSize,
	};
}

interface TaskDispatchOutcome {
	readonly taskId: string;
	readonly results: readonly ExpertResult[];
	readonly synthesis: SynthesisResult;
	readonly governance: GovernanceDecision;
	readonly resolution?: GovernanceResolution;
}

function expertCost(results: readonly ExpertResult[]): number {
	return results.reduce((total, result) => total + result.tokens, 0);
}

function normalizeHumanDecision(
	taskId: string,
	decision: HumanDecision | undefined,
): GovernanceResolution {
	if (!decision || !isHumanDecisionAction(decision.action)) {
		return {
			taskId,
			action: HOTL_DECISION_REJECT,
			note: HOTL_NO_DECISION_PROVIDER_MESSAGE,
		};
	}
	const note = decision.note?.trim();
	if (decision.action === "edit" && !note) {
		return {
			taskId,
			action: HOTL_DECISION_REJECT,
			note: HOTL_EMPTY_EDIT_MESSAGE,
		};
	}
	return { taskId, action: decision.action, note };
}

function notifyWithoutBlocking(
	notifier: EscalationNotifier,
	notice: EscalationNotice,
): void {
	try {
		Promise.resolve(notifier(notice)).catch(() => undefined);
	} catch {
		// Escalation is best effort and must not change job completion.
	}
}

function summarizeResults(
	jobId: string,
	outcomes: readonly TaskDispatchOutcome[],
): string {
	const results = outcomes.flatMap((outcome) => outcome.results);
	const completed = results.filter(
		(result) => result.exitCode === 0 && !result.aborted,
	).length;
	const header = `Legion dispatch ${jobId} completed ${completed}/${results.length} expert attempts.`;
	const tasks = outcomes.map(
		({ taskId, synthesis }) =>
			`## ${taskId}\n${synthesis.answer}\n\nConfidence: ${synthesis.confidence.toFixed(3)} · Disagreement: ${synthesis.disagreement.toFixed(3)} · Clustering: ${synthesis.clusteringMethod}`,
	);
	return [header, ...tasks].join("\n\n");
}

export class DispatchService {
	readonly #options: DispatchServiceOptions;

	constructor(options: DispatchServiceOptions) {
		this.#options = options;
	}

	dispatch(rawRequest: unknown, parentToolCallId?: string): DispatchAccepted {
		const request = applyConfigDefaults(
			dispatchRequestSchema.parse(rawRequest),
			this.#options.config,
		);
		const preview = this.#buildPlan(request, "preview");
		const jobId = this.#options.scheduler.schedule(
			LEGION_DISPATCH_JOB_LABEL,
			(context) => this.#run(context, request, parentToolCallId),
			humanReadableJobId(request.task),
		);

		return {
			jobId,
			recordId: jobId,
			attemptCount: preview.attempts.length,
			attemptModels: preview.attempts.map((attempt) => attempt.model),
		};
	}

	#buildPlan(request: DispatchRequest, idPrefix: string) {
		return buildDispatchPlan(
			request,
			this.#options.defaultModel,
			this.#options.isModelAvailable,
			(index, taskId) => `${idPrefix}-${taskId}-${index}`,
		);
	}

	async #resolveRequest(
		request: DispatchRequest,
		context: JobRunContext,
	): Promise<DispatchRequest> {
		if (request.tasks && request.tasks.length > 0) return request;
		try {
			const tasks = await this.#options.decomposer?.decompose({
				task: request.task,
				signal: context.signal,
			});
			if (tasks && tasks.length > 0) return { ...request, tasks: [...tasks] };
		} catch (error) {
			await context.reportProgress(
				"Legion decomposition failed; using the full task as one assignment.",
				{
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
		return { ...request, tasks: [...fallbackDecomposition(request.task)] };
	}

	async #resolveEscalation(
		notice: EscalationNotice,
		signal: AbortSignal,
	): Promise<GovernanceResolution> {
		const decision = this.#options.decisionGate
			? await this.#options.decisionGate(notice, signal)
			: undefined;
		return normalizeHumanDecision(notice.taskId, decision);
	}

	async #run(
		context: JobRunContext,
		request: DispatchRequest,
		parentToolCallId?: string,
	): Promise<string> {
		const resolvedRequest = await this.#resolveRequest(request, context);
		const plan = this.#buildPlan(resolvedRequest, context.jobId);
		const now = this.#options.now ?? Date.now;
		this.#options.repository.create({
			id: context.jobId,
			task: plan.task,
			state: "running",
			createdAt: now(),
			attempts: plan.attempts,
		});
		await context.reportProgress(
			`Legion dispatch ${context.jobId} is running.`,
			{ attempts: plan.attempts.length },
		);

		let auditFailurePersisted = false;
		try {
			const attemptsByTask = new Map<string, DispatchAttempt[]>();
			for (const attempt of plan.attempts) {
				const attempts = attemptsByTask.get(attempt.taskId) ?? [];
				attempts.push(attempt);
				attemptsByTask.set(attempt.taskId, attempts);
			}

			const outcomes = await Promise.all(
				[...attemptsByTask.entries()].map(async ([taskId, attempts]) => {
					const results = await Promise.all(
						attempts.map(async (attempt) => {
							const execution: ExpertExecution = {
								attempt,
								task: plan.task,
								parentToolCallId,
								signal: context.signal,
							};
							try {
								return await this.#options.executor.run(execution);
							} catch (error) {
								return failedResult(execution, error);
							}
						}),
					);
					const synthesis = await this.#options.synthesizer.synthesize({
						task: plan.task,
						taskId,
						experts: results,
						signal: context.signal,
					});
					const governance = evaluateGovernance({
						metrics: {
							confidence: synthesis.confidence,
							disagreement: synthesis.disagreement,
							cost: expertCost(results),
						},
						thresholds: this.#options.governanceThresholds,
					});
					let finalSynthesis = synthesis;
					let resolution: GovernanceResolution | undefined;
					if (governance.shouldEscalate) {
						const notice: EscalationNotice = {
							jobId: context.jobId,
							taskId,
							decision: governance,
							synthesis,
						};
						if (this.#options.notifyEscalation)
							notifyWithoutBlocking(this.#options.notifyEscalation, notice);
						resolution = await this.#resolveEscalation(notice, context.signal);
						if (resolution.action === HOTL_DECISION_EDIT) {
							finalSynthesis = await this.#options.synthesizer.synthesize({
								task: plan.task,
								taskId,
								experts: results,
								humanNote: resolution.note,
								signal: context.signal,
							});
						}
					}
					await context.reportProgress(`Legion synthesized task ${taskId}.`, {
						taskId,
						confidence: finalSynthesis.confidence,
						disagreement: finalSynthesis.disagreement,
						clusteringMethod: finalSynthesis.clusteringMethod,
						escalated: governance.shouldEscalate,
						humanDecision: resolution?.action,
					});
					return {
						taskId,
						results,
						synthesis: finalSynthesis,
						governance,
						resolution,
					};
				}),
			);
			const results = outcomes.flatMap((outcome) => outcome.results);
			const syntheses = outcomes.map((outcome) => outcome.synthesis);
			const governance = outcomes.map((outcome) => outcome.governance);
			const resolutions = outcomes.flatMap((outcome) =>
				outcome.resolution ? [outcome.resolution] : [],
			);
			const rejected = resolutions.find(
				(resolution) => resolution.action === HOTL_DECISION_REJECT,
			);
			const completedAt = now();
			if (rejected) {
				auditFailurePersisted = true;
				this.#options.repository.fail(
					context.jobId,
					`Human rejected task "${rejected.taskId}".`,
					completedAt,
					{
						results,
						syntheses,
						governance,
						resolutions,
					},
				);
				await context.reportProgress(
					`Legion dispatch ${context.jobId} rejected by human decision.`,
					{ taskId: rejected.taskId, humanDecision: rejected.action },
				);
				throw new Error(`Human rejected task "${rejected.taskId}".`);
			}
			this.#options.repository.complete(
				context.jobId,
				results,
				syntheses,
				governance,
				completedAt,
				resolutions,
			);
			await context.reportProgress(
				`Legion dispatch ${context.jobId} completed.`,
				{
					attempts: results.length,
					failed: results.filter(
						(result) => result.exitCode !== 0 || result.aborted === true,
					).length,
					syntheses: syntheses.length,
				},
			);
			return summarizeResults(context.jobId, outcomes);
		} catch (error) {
			if (!auditFailurePersisted) {
				const message = error instanceof Error ? error.message : String(error);
				this.#options.repository.fail(context.jobId, message, now());
			}
			throw error;
		}
	}
}
