import { Semaphore } from "../domain/concurrency";
import type { LegionConfig } from "../domain/config";
import {
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_MAX_CONCURRENT_EXPERTS,
	HOTL_DECISION_APPROVE,
	HOTL_DECISION_EDIT,
	HOTL_DECISION_REJECT,
	HOTL_DECISION_TIMEOUT_MESSAGE,
	HOTL_EMPTY_EDIT_MESSAGE,
	HOTL_NO_DECISION_PROVIDER_MESSAGE,
	LEGION_DISPATCH_JOB_LABEL,
} from "../domain/constants";
import {
	type TaskDecomposer,
	fallbackDecomposition,
} from "../domain/decomposition";
import {
	type AgentResolver,
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
	/**
	 * Job-scoped context returned by {@link ExpertExecutor.prepareJob}, opaque
	 * to this layer (its real shape — an isolation baseline — is a host
	 * concern; see infrastructure/host-dispatcher.ts). Undefined for
	 * executors that don't implement `prepareJob`.
	 */
	readonly jobContext?: unknown;
}

export interface ExpertExecutor {
	run(execution: ExpertExecution): Promise<ExpertResult>;
	/**
	 * Called once per dispatch job, before any attempt runs, when isolation
	 * needs a stable baseline shared across every attempt in the job (so
	 * concurrent attempts diff against the same starting point rather than
	 * each capturing a slightly different one). The returned value is passed
	 * back verbatim as every subsequent `run()` call's `jobContext`. Executors
	 * that don't need job-scoped state simply omit this method.
	 */
	prepareJob?(): Promise<unknown>;
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

/** A task's winning attempt (per SynthesisResult.clusters[0].representativeAttemptId) that actually produced a branch. */
export interface WinningAttempt {
	readonly taskId: string;
	readonly branchName: string;
	readonly baseSha?: string;
}

/**
 * Merges isolated attempts' branches back onto the real repo. Every attempt
 * ran in its own isolated worktree (see infrastructure/host-dispatcher.ts) —
 * only the synthesis-selected winner per task should ever land on disk;
 * every sibling attempt's branch is discarded, merged or not.
 */
export interface BranchMerger {
	/** Merge each task's winning attempt branch onto the real repo. Never called for a rejected job — see #run(). */
	mergeWinners(winners: readonly WinningAttempt[]): Promise<void>;
	/** Delete branches that will never be merged — losing attempts, or every attempt when the whole job was rejected. */
	discardBranches(branchNames: readonly string[]): Promise<void>;
}

export interface VerifyRequest {
	readonly branchName: string;
	readonly baseSha?: string;
}

/**
 * Independently re-runs a project's own verify command (test suite, build,
 * typecheck — whatever `verifyCommand` names) against one attempt's isolated
 * branch. Execution-grounded, not a text-similarity guess: arXiv 2604.15618
 * and 2605.08680 show execution-based consensus beats output-pattern
 * majority voting by 19-52pp on code specifically. Only meaningful for
 * attempts that actually produced a branch (read-only roles never do).
 */
export interface Verifier {
	verify(request: VerifyRequest, signal?: AbortSignal): Promise<boolean>;
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
	readonly resolveAgent: AgentResolver;
	readonly governanceThresholds?: GovernanceThresholds;
	readonly decomposer?: TaskDecomposer;
	readonly notifyEscalation?: EscalationNotifier;
	readonly decisionGate?: HumanDecisionGate;
	readonly now?: () => number;
	/** Caps total concurrent expert attempts across one dispatch (all tasks combined). See domain/concurrency.ts. */
	readonly maxConcurrentExperts?: number;
	/** Omit when the executor doesn't isolate attempts (e.g. test doubles) — no merge/discard step runs. */
	readonly branchMerger?: BranchMerger;
	/** Omit when no `verifyCommand` is configured — execution-grounded verification simply doesn't run. */
	readonly verifier?: Verifier;
	/** How long an escalation waits for a human before auto-resolving to reject. Defaults to DEFAULT_DECISION_TIMEOUT_MS. */
	readonly decisionTimeoutMs?: number;
}

export interface TaskAttemptSummary {
	readonly taskId: string;
	readonly attemptCount: number;
	readonly models: readonly string[];
}

export interface DispatchAccepted {
	readonly jobId: string;
	readonly recordId: string;
	readonly attemptCount: number;
	readonly attemptModels: readonly string[];
	readonly taskBreakdown: readonly TaskAttemptSummary[];
}

/** Groups a plan's attempts by taskId, preserving each task's first-seen order. */
function summarizeAttemptsByTask(
	attempts: readonly DispatchAttempt[],
): TaskAttemptSummary[] {
	const modelsByTask = new Map<string, string[]>();
	for (const attempt of attempts) {
		const models = modelsByTask.get(attempt.taskId) ?? [];
		models.push(attempt.model);
		modelsByTask.set(attempt.taskId, models);
	}
	return [...modelsByTask.entries()].map(([taskId, models]) => ({
		taskId,
		attemptCount: models.length,
		models,
	}));
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

/**
 * Built when every expert for a task failed and `synthesizer.synthesize`
 * has nothing to cluster (clusterExpertAnswers throws "Cannot cluster
 * expert results without output" in exactly this case). Without this, that
 * throw propagates through the outer Promise.all and fails the *entire*
 * multi-task dispatch, discarding any sibling tasks that succeeded — one
 * task with zero surviving experts should be this task's own bad outcome,
 * not everyone else's. `failureRate` on the resulting metrics will be 1.0,
 * which the existing failureRateCeiling governance check (Phase 3) already
 * escalates correctly — no separate "did synthesis fail" plumbing needed.
 */
function fallbackSynthesis(taskId: string, error: unknown): SynthesisResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		taskId,
		answer: `Every expert attempt for this task failed; nothing to synthesize (${message}).`,
		confidence: 0,
		disagreement: 1,
		clusteringMethod: "rouge-l-fallback",
		embeddingQuality: "degraded",
		clusters: [],
		synthesisUsed: false,
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

/**
 * Mean tokens per attempt, not a dispatch-wide sum. A flat sum against
 * costCeiling scales mechanically with ensembleSize — a larger, perfectly
 * healthy ensemble would trip the same absolute ceiling a smaller one never
 * would, for no reason related to actual cost per unit of work. The mean is
 * scale-invariant regardless of how many attempts were configured.
 */
function expertCost(results: readonly ExpertResult[]): number {
	if (results.length === 0) return 0;
	const total = results.reduce((sum, result) => sum + result.tokens, 0);
	return total / results.length;
}

/**
 * Read directly off the raw attempt results, independent of what synthesis
 * saw — confidence is computed only over experts that produced an answer
 * (empty/failed output is filtered out before clustering), so a task where
 * most experts crashed and one survived would otherwise report maximum
 * confidence. See GovernanceThresholds.failureRateCeiling.
 */
function attemptFailureRate(results: readonly ExpertResult[]): number {
	if (results.length === 0) return 0;
	const failed = results.filter(
		(result) => result.exitCode !== 0 || result.aborted === true,
	).length;
	return failed / results.length;
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

function formatExpertLine(result: ExpertResult): string {
	const ok = result.exitCode === 0 && !result.aborted;
	const status = ok ? "✓" : "✗";
	const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
	const note = ok ? "" : ` — ${result.error ?? "failed"}`;
	return `- ${status} \`${result.model}\` (${duration}, ${result.tokens} tok)${note}`;
}

/**
 * Governance/resolution are computed but were previously invisible in the
 * delivered outcome text — a human could approve or reject an escalation and
 * the final summary would never say which happened. This is the actual
 * "what happened" a human reads, so it must say so explicitly.
 */
function formatGovernance(
	governance: GovernanceDecision,
	resolution: GovernanceResolution | undefined,
): string {
	if (!governance.shouldEscalate) return "";
	const reasons = governance.reasons.join(", ");
	if (!resolution)
		return `**Escalated** (${reasons}) — awaiting human decision.`;
	const verb =
		resolution.action === HOTL_DECISION_APPROVE
			? "approved"
			: resolution.action === HOTL_DECISION_EDIT
				? "edited"
				: "rejected";
	const note = resolution.note ? ` — "${resolution.note}"` : "";
	return `**Escalated** (${reasons}) → **${verb}** by human decision${note}.`;
}

function summarizeResults(
	jobId: string,
	outcomes: readonly TaskDispatchOutcome[],
): string {
	const results = outcomes.flatMap((outcome) => outcome.results);
	const completed = results.filter(
		(result) => result.exitCode === 0 && !result.aborted,
	).length;
	const header = `## Legion Dispatch — ${jobId}\n\n**${completed}/${results.length} expert attempts completed**`;
	const tasks = outcomes.map((outcome) => {
		const {
			taskId,
			synthesis,
			governance,
			resolution,
			results: taskResults,
		} = outcome;
		const sections = [
			`### ${taskId}`,
			`**Confidence:** ${synthesis.confidence.toFixed(3)} · **Disagreement:** ${synthesis.disagreement.toFixed(3)} · **Clustering:** ${synthesis.clusteringMethod}`,
			formatGovernance(governance, resolution),
			synthesis.answer,
			taskResults.map(formatExpertLine).join("\n"),
		].filter((section) => section.trim().length > 0);
		return sections.join("\n\n");
	});
	return [header, ...tasks].join("\n\n---\n\n");
}

export class DispatchService {
	readonly #options: DispatchServiceOptions;
	readonly #concurrency: Semaphore;

	constructor(options: DispatchServiceOptions) {
		this.#options = options;
		this.#concurrency = new Semaphore(
			options.maxConcurrentExperts ?? DEFAULT_MAX_CONCURRENT_EXPERTS,
		);
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
			taskBreakdown: summarizeAttemptsByTask(preview.attempts),
		};
	}

	#buildPlan(request: DispatchRequest, idPrefix: string) {
		return buildDispatchPlan(
			request,
			this.#options.defaultModel,
			this.#options.isModelAvailable,
			(index, taskId) => `${idPrefix}-${taskId}-${index}`,
			this.#options.resolveAgent,
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

	/**
	 * Never waits forever — genuinely races the decision against a timeout at
	 * this level, rather than only passing an abort signal down and trusting
	 * the callee to honor it. A `decisionGate` that ignores its signal (a
	 * test double, or a real implementation with a bug) would otherwise hang
	 * this job — and every other job queued behind a shared concurrency slot
	 * — forever. Cooperative implementations still get the combined signal so
	 * they can cancel their own underlying UI call cleanly.
	 */
	async #resolveEscalation(
		notice: EscalationNotice,
		signal: AbortSignal,
	): Promise<GovernanceResolution> {
		if (!this.#options.decisionGate)
			return normalizeHumanDecision(notice.taskId, undefined);
		const timeoutMs =
			this.#options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
		const combinedSignal = AbortSignal.any([
			signal,
			AbortSignal.timeout(timeoutMs),
		]);
		const timedOut = new Promise<undefined>((resolve) => {
			if (combinedSignal.aborted) {
				resolve(undefined);
				return;
			}
			combinedSignal.addEventListener("abort", () => resolve(undefined), {
				once: true,
			});
		});
		try {
			const decision = await Promise.race([
				this.#options.decisionGate(notice, combinedSignal),
				timedOut,
			]);
			if (!decision) throw new Error(HOTL_DECISION_TIMEOUT_MESSAGE);
			return normalizeHumanDecision(notice.taskId, decision);
		} catch {
			return {
				taskId: notice.taskId,
				action: HOTL_DECISION_REJECT,
				note: HOTL_DECISION_TIMEOUT_MESSAGE,
			};
		}
	}

	/**
	 * Independently re-verifies every result that produced a branch (read-only
	 * roles never do) against the project's own verify command — a no-op when
	 * no verifier is configured. Bounded by the same concurrency semaphore as
	 * expert dispatch, since a verify run is a comparable-cost operation
	 * (spawns a process, does real work) that could otherwise pile up
	 * alongside a following task's own dispatch.
	 */
	async #verifyResults(
		results: readonly ExpertResult[],
		signal: AbortSignal,
	): Promise<readonly ExpertResult[]> {
		const verifier = this.#options.verifier;
		if (!verifier) return results;
		return Promise.all(
			results.map(async (result) => {
				if (!result.branchName) return result;
				await this.#concurrency.acquire();
				try {
					const verified = await verifier.verify(
						{ branchName: result.branchName, baseSha: result.baseSha },
						signal,
					);
					return { ...result, verified };
				} finally {
					this.#concurrency.release();
				}
			}),
		);
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
		if (plan.warnings.length > 0) {
			await context.reportProgress(
				`Legion dispatch ${context.jobId} has config warnings.`,
				{ warnings: plan.warnings },
			);
		}

		let auditFailurePersisted = false;
		try {
			const attemptsByTask = new Map<string, DispatchAttempt[]>();
			for (const attempt of plan.attempts) {
				const attempts = attemptsByTask.get(attempt.taskId) ?? [];
				attempts.push(attempt);
				attemptsByTask.set(attempt.taskId, attempts);
			}

			// Prepared once for the whole job (not per attempt, not per task) so
			// every concurrent attempt diffs against the same starting point —
			// see ExpertExecutor.prepareJob's doc comment.
			const jobContext = await this.#options.executor.prepareJob?.();

			const outcomes = await Promise.all(
				[...attemptsByTask.entries()].map(async ([taskId, attempts]) => {
					const results = await Promise.all(
						attempts.map(async (attempt) => {
							const execution: ExpertExecution = {
								attempt,
								task: plan.task,
								parentToolCallId,
								signal: context.signal,
								jobContext,
							};
							await this.#concurrency.acquire();
							try {
								return await this.#options.executor.run(execution);
							} catch (error) {
								return failedResult(execution, error);
							} finally {
								this.#concurrency.release();
							}
						}),
					);
					const verifiedResults = await this.#verifyResults(
						results,
						context.signal,
					);
					let synthesis: SynthesisResult;
					try {
						synthesis = await this.#options.synthesizer.synthesize({
							task: plan.task,
							taskId,
							experts: verifiedResults,
							signal: context.signal,
						});
					} catch (error) {
						synthesis = fallbackSynthesis(taskId, error);
					}
					const governance = evaluateGovernance({
						metrics: {
							confidence: synthesis.confidence,
							disagreement: synthesis.disagreement,
							cost: expertCost(verifiedResults),
							failureRate: attemptFailureRate(verifiedResults),
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
								experts: verifiedResults,
								humanNote: resolution.note,
								signal: context.signal,
							});
						}
					}
					// The host's AsyncJobManager delivers one final text per job, once,
					// on completion — there is no per-unit "deliver this now" channel
					// (see docs/plan/algorithm-audit-and-hardening-v2.md Phase 3). So a
					// task that finishes early cannot be delivered independently of a
					// sibling task still awaiting a human decision — but its answer can
					// still be surfaced right now, via progress, rather than making a
					// human wait on the slowest task before seeing anything at all.
					await context.reportProgress(`Legion synthesized task ${taskId}.`, {
						taskId,
						confidence: finalSynthesis.confidence,
						disagreement: finalSynthesis.disagreement,
						clusteringMethod: finalSynthesis.clusteringMethod,
						escalated: governance.shouldEscalate,
						humanDecision: resolution?.action,
						answer: finalSynthesis.answer,
					});
					return {
						taskId,
						results: verifiedResults,
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
				// The whole job failed — nothing gets merged, but every isolated
				// attempt's branch (across every task) still needs discarding.
				await this.#options.branchMerger?.discardBranches(
					results.flatMap((result) =>
						result.branchName ? [result.branchName] : [],
					),
				);
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
			// Only the synthesis-selected winner per task ever lands on disk —
			// every sibling attempt's isolated branch is discarded regardless of
			// whether it was merged, matching the self-consistency/diverse
			// selection policy already used for text synthesis (spec §5-6).
			const winners: WinningAttempt[] = [];
			const loserBranches: string[] = [];
			for (const outcome of outcomes) {
				const winnerId = outcome.synthesis.clusters[0]?.representativeAttemptId;
				for (const result of outcome.results) {
					if (!result.branchName) continue;
					if (result.attemptId === winnerId) {
						winners.push({
							taskId: outcome.taskId,
							branchName: result.branchName,
							baseSha: result.baseSha,
						});
					} else {
						loserBranches.push(result.branchName);
					}
				}
			}
			await this.#options.branchMerger?.discardBranches(loserBranches);
			await this.#options.branchMerger?.mergeWinners(winners);
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
