import { Semaphore } from "../domain/concurrency";
import type { LegionConfig } from "../domain/config";
import {
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_DISPATCH_TIMEOUT_MS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
	DEFAULT_MAX_CONCURRENT_EXPERTS,
	HOTL_DECISION_APPROVE,
	HOTL_DECISION_EDIT,
	HOTL_DECISION_REJECT,
	HOTL_DECISION_TIMEOUT_MESSAGE,
	HOTL_EMPTY_EDIT_MESSAGE,
	HOTL_NO_DECISION_PROVIDER_MESSAGE,
	LEGION_DISPATCH_JOB_LABEL,
	type LegionDispatchPhase,
} from "../domain/constants";
import {
	type DecomposerAuditEvent,
	type TaskDecomposer,
	fallbackDecomposition,
} from "../domain/decomposition";
import {
	type AgentResolver,
	type DispatchAttempt,
	type DispatchRequest,
	type DispatchStrategy,
	type ExpertResult,
	type ModelAvailability,
	type OrchestrationRepository,
	type ReplacementSpec,
	buildDispatchPlan,
	classifyFailure,
	dispatchRequestSchema,
	nextReplacement,
	pascalCaseJobId,
	selectorKey,
	shortAgentName,
	shortModelName,
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

let dispatchSequence = 0;

function uniqueDispatchJobId(task: string): string {
	dispatchSequence += 1;
	return `${pascalCaseJobId(task)}-${Date.now().toString(36)}-${dispatchSequence}`;
}

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

export interface ReviveExpertParams {
	/** The expert's own prior result — carries the attemptId/agent/role/model needed to resume its exact session. */
	readonly result: ExpertResult;
	/** Sent as the follow-up turn's prompt — typically the human's HOTL edit note. */
	readonly message: string;
	readonly signal: AbortSignal;
	/**
	 * The original attempt's configured max tool-call steps, replayed for
	 * the revived session's step-limit guard. Undefined means unlimited.
	 */
	readonly maxSteps?: number;
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
	/**
	 * Continue a previously run expert with one more turn, reusing its live or
	 * parked session and full prior context (files already read, reasoning
	 * already done) instead of spawning a fresh attempt from zero. Only ever
	 * meaningful for an attempt that ran non-isolated (see `DispatchAttempt.
	 * worktree`) — an isolated run's worktree is merged and cleaned right
	 * after it finishes, so the host can never resume it regardless of
	 * executor support. Callers MUST check the originating attempt's
	 * `worktree` policy before calling this; optional because executors that
	 * never run non-isolated (or don't support revival at all) simply omit it.
	 */
	reviveExpert?(params: ReviveExpertParams): Promise<ExpertResult>;
}

export interface JobRunContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	reportProgress(
		text: string,
		details?: Record<string, unknown>,
	): Promise<void>;
}

export interface JobInfo {
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly resultText?: string;
	readonly errorText?: string;
	readonly lastProgressText?: string;
	/** The details payload attached to the most recent reportProgress call — carries the structured `phase` tag (see LegionDispatchPhase) plus whatever else that stage reported (e.g. completed/total counts), so a live view can read real signals instead of guessing from `lastProgressText`'s prose. */
	readonly lastProgressDetails?: Record<string, unknown>;
	readonly promise: Promise<void>;
}

export interface JobScheduler {
	schedule(
		label: string,
		run: (context: JobRunContext) => Promise<string>,
		id?: string,
		onProgress?: (text: string, details?: Record<string, unknown>) => void,
	): string;
	getJob(id: string): JobInfo | undefined;
	cancel?(id: string): boolean;
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
	/** The Legion persona (or host default agent) dispatched for this task's role — constant across all of the task's attempts, since role→agent resolution happens once per task, before attempts fan out by model/temperature. */
	readonly agent: string;
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
	const agentByTask = new Map<string, string>();
	for (const attempt of attempts) {
		const models = modelsByTask.get(attempt.taskId) ?? [];
		models.push(attempt.model);
		modelsByTask.set(attempt.taskId, models);
		agentByTask.set(attempt.taskId, attempt.agent);
	}
	return [...modelsByTask.entries()].map(([taskId, models]) => ({
		taskId,
		// agentByTask is populated from the same attempts loop, so every
		// taskId present in modelsByTask has a matching entry here.
		agent: agentByTask.get(taskId) as string,
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
		synthesisSucceeded: false,
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
	/** Initial (pre-expansion) synthesis, preserved separately for auditability. */
	readonly initialSynthesis: SynthesisResult;
	/** Initial (pre-expansion) governance decision, preserved separately. */
	readonly initialGovernance: GovernanceDecision;
	/** Present when adaptive expansion ran; carries the expanded synthesis/governance. */
	readonly expansion?: {
		readonly synthesis: SynthesisResult;
		readonly governance: GovernanceDecision;
	};
	/** Every runtime fallback performed for the task, for progress/audit observability. */
	readonly replacements: readonly ReplacementRecord[];
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
function isSuccessfulExpertResult(result: ExpertResult): boolean {
	return result.exitCode === 0 && !result.aborted && !result.error;
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
	_jobId: string,
	outcomes: readonly TaskDispatchOutcome[],
): string {
	const results = outcomes.flatMap((outcome) => outcome.results);
	const completed = results.filter(
		(result) => result.exitCode === 0 && !result.aborted,
	).length;
	const summary = `**${completed}/${results.length} expert attempts completed**`;
	const multipleTasks = outcomes.length > 1;
	const tasks = outcomes.map((outcome) => {
		const {
			taskId,
			synthesis,
			governance,
			resolution,
			results: taskResults,
		} = outcome;
		const sections = [
			multipleTasks ? `**Task: ${taskId}**` : "",
			`**Confidence:** ${synthesis.confidence.toFixed(3)} · **Disagreement:** ${synthesis.disagreement.toFixed(3)} · **Clustering:** ${synthesis.clusteringMethod}`,
			formatGovernance(governance, resolution),
			synthesis.answer,
			taskResults.map(formatExpertLine).join("\n"),
		].filter((section) => section.trim().length > 0);
		return sections.join("\n\n");
	});
	return [summary, ...tasks].join("\n\n---\n\n");
}
interface ReplacementRecord {
	readonly from: string;
	readonly to: string;
	readonly reason: string;
}

/** Decorates a result with fallback/expansion metadata; returns it unchanged when nothing was added. */
function recordReplacement(
	result: ExpertResult,
	replacedModel: string | undefined,
	replacementReason: string | undefined,
): ExpertResult {
	if (replacedModel === undefined && replacementReason === undefined)
		return result;
	return { ...result, replacedModel, replacementReason };
}

/** Short human phrase for why a retryable failure triggered a fallback, derived from the error text. */
function retryableReason(error?: string): string {
	const message = error ?? "unknown provider error";
	if (/\b429\b|quota|rate[\s_-]?limit/i.test(message))
		return "quota/rate-limit";
	if (/unavailable|not (?:available|found)/i.test(message))
		return "model unavailable";
	if (/timed?\s?out|timeout/i.test(message)) return "timeout";
	if (/overload(?:ed)?|capacity|\b50[0-9]\b/i.test(message))
		return "provider overload";
	return "retryable provider error";
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
		const previewRequest =
			request.tasks && request.tasks.length > 0
				? request
				: { ...request, tasks: [...fallbackDecomposition(request.task)] };
		const preview = this.#buildPlan(previewRequest, "preview");
		const jobId = this.#options.scheduler.schedule(
			LEGION_DISPATCH_JOB_LABEL,
			(context) => this.#run(context, request, parentToolCallId),
			uniqueDispatchJobId(request.task),
		);

		return {
			jobId,
			recordId: jobId,
			attemptCount: preview.attempts.length,
			attemptModels: preview.attempts.map((attempt) => attempt.model),
			taskBreakdown: summarizeAttemptsByTask(preview.attempts),
		};
	}

	/** Expose job status so the tool can poll for completion and stream live progress. */
	getJob(id: string): ReturnType<JobScheduler["getJob"]> {
		return this.#options.scheduler.getJob(id);
	}
	/** Hard cap used by the blocking presentation tool wait. */
	getDispatchTimeoutMs(): number {
		return (
			this.#options.config?.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS
		);
	}
	cancel(id: string): boolean {
		return this.#options.scheduler.cancel?.(id) ?? false;
	}

	#buildPlan(request: DispatchRequest, idPrefix: string) {
		return buildDispatchPlan(
			request,
			this.#options.defaultModel,
			this.#options.isModelAvailable,
			// e.g. "LegionReviewTheChange-mrkpc653-1-reviewer-deepseek-v4-pro" —
			// agent and model tell you *what's actually running*; the PascalCase
			// job slug already made the id long before this part even started. A
			// numeric suffix (e.g. "-2") is appended only on collision within the
			// same plan (self-consistency sampling or diverse cycling through a
			// small pool).
			(_index, _taskId, agent, model) =>
				`${idPrefix}-${shortAgentName(agent)}-${shortModelName(model)}`,
			this.#options.resolveAgent,
		);
	}

	async #resolveRequest(
		request: DispatchRequest,
		context: JobRunContext,
		decomposerAttempts: DecomposerAuditEvent[],
	): Promise<DispatchRequest> {
		if (request.tasks && request.tasks.length > 0) return request;
		// This is a real LLM call and can legitimately take a while — reported
		// before awaiting it (not just on failure) so a live view has something
		// accurate to say for however long it's in flight, instead of reading
		// as a stalled/broken widget with nothing to show.
		await context.reportProgress("Legion is deciding how to split the task.", {
			phase: "decomposing" satisfies LegionDispatchPhase,
		});
		try {
			const tasks = await this.#options.decomposer?.decompose({
				task: request.task,
				signal: context.signal,
				onAudit: (event) => decomposerAttempts.push(event),
				jobId: context.jobId,
			});
			if (tasks && tasks.length > 0) return { ...request, tasks: [...tasks] };
		} catch (error) {
			await context.reportProgress(
				"Legion decomposition failed; using the full task as one assignment.",
				{
					phase: "decomposing" satisfies LegionDispatchPhase,
					error: error instanceof Error ? error.message : String(error),
					decomposerAttempts,
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
				} catch {
					// ponytail: fixed #3 — verifier error returns verified:false instead of throwing
					return { ...result, verified: false };
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
		const decomposerAttempts: DecomposerAuditEvent[] = [];
		const resolvedRequest = await this.#resolveRequest(
			request,
			context,
			decomposerAttempts,
		);
		const plan = this.#buildPlan(resolvedRequest, context.jobId);
		const needsIsolation = plan.attempts.some(
			(attempt) => attempt.worktree !== false,
		);
		const jobContext = needsIsolation
			? await this.#options.executor.prepareJob?.()
			: undefined;
		const now = this.#options.now ?? Date.now;
		this.#options.repository.create({
			id: context.jobId,
			task: plan.task,
			state: "running",
			createdAt: now(),
			attempts: plan.attempts,
			decomposerAttempts,
		});
		await context.reportProgress(
			`Legion dispatch ${context.jobId} is running.`,
			{
				phase: "running" satisfies LegionDispatchPhase,
				attempts: plan.attempts.length,
				completed: 0,
			},
		);
		if (plan.warnings.length > 0) {
			await context.reportProgress(
				`Legion dispatch ${context.jobId} has config warnings.`,
				{
					phase: "running" satisfies LegionDispatchPhase,
					warnings: plan.warnings,
				},
			);
		}

		let auditFailurePersisted = false;
		let branchesCleanedUp = false;
		let outcomes: TaskDispatchOutcome[] = [];
		let results: readonly ExpertResult[] = [];
		let syntheses: readonly SynthesisResult[] = [];
		let governance: readonly GovernanceDecision[] = [];
		let resolutions: readonly GovernanceResolution[] = [];
		try {
			const attemptsByTask = new Map<string, DispatchAttempt[]>();
			for (const attempt of plan.attempts) {
				const attempts = attemptsByTask.get(attempt.taskId) ?? [];
				attempts.push(attempt);
				attemptsByTask.set(attempt.taskId, attempts);
			}

			// Prepared once for the whole job (not per attempt, not per task) so
			// every concurrent attempt diffs against the same starting point —
			const jobProgress = { completed: 0, total: plan.attempts.length };

			// see ExpertExecutor.prepareJob's doc comment.

			// Shared across every concurrent #dispatchTask call below so the
			outcomes = await Promise.all(
				[...attemptsByTask.entries()].map(async ([taskId, attempts]) =>
					this.#dispatchTask({
						taskId,
						planned: attempts,
						task: plan.task,
						signal: context.signal,
						jobContext,
						context,
						parentToolCallId,
						jobProgress,
					}),
				),
			);
			results = outcomes.flatMap((outcome) => outcome.results);
			syntheses = outcomes.flatMap((outcome) =>
				outcome.expansion
					? [outcome.initialSynthesis, outcome.expansion.synthesis]
					: [outcome.initialSynthesis],
			);
			governance = outcomes.flatMap((outcome) =>
				outcome.expansion
					? [outcome.initialGovernance, outcome.expansion.governance]
					: [outcome.initialGovernance],
			);
			resolutions = outcomes.flatMap((outcome) =>
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
				branchesCleanedUp = true;
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
						decomposerAttempts,
					},
				);
				await context.reportProgress(
					`Legion dispatch ${context.jobId} rejected by human decision.`,
					{
						phase: "rejected" satisfies LegionDispatchPhase,
						taskId: rejected.taskId,
						humanDecision: rejected.action,
					},
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
			// When mergeWinners throws (e.g. branch conflict), leave ALL branches
			// undiscarded so a human can inspect and promote an alternative — the
			// branch-merger's own "Unmerged branches remain for manual resolution"
			// contract. Setting branchesCleanedUp prevents the generic catch-block
			// cleanup from discarding them.
			try {
				await this.#options.branchMerger?.mergeWinners(winners);
			} catch (error) {
				branchesCleanedUp = true;
				throw error;
			}
			await this.#options.branchMerger?.discardBranches(loserBranches);
			branchesCleanedUp = true;
			this.#options.repository.complete(
				context.jobId,
				results,
				syntheses,
				governance,
				completedAt,
				resolutions,
				decomposerAttempts,
			);
			await context.reportProgress(
				`Legion dispatch ${context.jobId} completed.`,
				{
					phase: "completed" satisfies LegionDispatchPhase,
					attempts: results.length,
					failed: results.filter(
						(result) => result.exitCode !== 0 || result.aborted === true,
					).length,
					successfulAttemptCount: results.filter(
						(result) => result.exitCode === 0 && !result.aborted,
					).length,
					synthesisSucceeded: syntheses.every(
						(synthesis) => synthesis.synthesisSucceeded === true,
					),
					syntheses: syntheses.length,
				},
			);
			return summarizeResults(context.jobId, outcomes);
		} catch (error) {
			if (!auditFailurePersisted) {
				const message = error instanceof Error ? error.message : String(error);
				this.#options.repository.fail(context.jobId, message, now(), {
					results,
					syntheses,
					governance,
					resolutions,
					decomposerAttempts,
				});
			}
			// Discard every isolated attempt branch that was created before the
			// failure — the normal and rejection paths both do this, but an
			// unexpected exception skips those blocks entirely.
			if (!branchesCleanedUp) {
				try {
					await this.#options.branchMerger?.discardBranches(
						results.flatMap((r) => (r.branchName ? [r.branchName] : [])),
					);
				} catch {
					// Best-effort: a discard failure must not mask the original error.
				}
			}
			throw error;
		}
	}
	async #dispatchTask(params: {
		readonly taskId: string;
		readonly planned: readonly DispatchAttempt[];
		readonly task: string;
		readonly signal: AbortSignal;
		readonly jobContext: unknown;
		readonly context: JobRunContext;
		readonly parentToolCallId?: string;
		/** Job-wide completed/total counters, shared and mutated across every
		 * concurrent task in this dispatch — see #run's doc comment. */
		readonly jobProgress: { completed: number; total: number };
	}): Promise<TaskDispatchOutcome> {
		const {
			taskId,
			planned,
			task,
			signal,
			jobContext,
			context,
			parentToolCallId,
			jobProgress,
		} = params;
		const runAttempt = async (
			attempt: DispatchAttempt,
		): Promise<ExpertResult> => {
			const execution: ExpertExecution = {
				attempt,
				task,
				parentToolCallId,
				signal,
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
		};

		const template = planned[0];
		const strategy = template?.strategy ?? DEFAULT_DISPATCH_STRATEGY;
		const candidates = template?.candidates ?? [];
		const temperatureLadder = template?.temperatureLadder;
		const attemptedSelectors = new Set<string>();
		for (const attempt of planned) attemptedSelectors.add(selectorKey(attempt));
		const nextIndex = { value: planned.length };

		// 1. Run the planned attempts concurrently (existing behavior: bounded by
		// #concurrency). Each attempt reports its own completion as it lands —
		// previously the only signal for this whole phase was one "is running"
		// message at job start, then silence until the first retry or the
		// task's synthesis; a live view had nothing to show as experts actually
		// finished one by one.
		const initialResults = await Promise.all(
			planned.map(async (attempt) => {
				const result = await runAttempt(attempt);
				// Mutating a plain object across concurrent tasks is safe here:
				// JS has no true parallelism, only interleaving at await points,
				// so each increment is atomic relative to the others.
				jobProgress.completed += 1;
				await context.reportProgress(
					`Legion: ${jobProgress.completed}/${jobProgress.total} experts finished (task ${taskId}).`,
					{
						phase: "running" satisfies LegionDispatchPhase,
						taskId,
						completed: jobProgress.completed,
						total: jobProgress.total,
					},
				);
				return result;
			}),
		);
		const results: ExpertResult[] = [...initialResults];
		// 2. Runtime model fallback: retry retryable failures on the next unattempted selector.
		const replacements = await this.#runFallback({
			taskId,
			template,
			strategy,
			candidates,
			temperatureLadder,
			initialResults,
			signal,
			context,
			runAttempt,
			attemptedSelectors,
			results,
			nextIndex,
		});

		// 3. Execution-grounded verification of every surviving branch.
		const verifiedResults = await this.#verifyResults(results, signal);

		// 4. Initial synthesis + governance.
		await context.reportProgress(`Legion is synthesizing task ${taskId}.`, {
			phase: "synthesizing" satisfies LegionDispatchPhase,
			taskId,
		});
		const initialSynthesis = await this.#synthesize(
			taskId,
			verifiedResults,
			task,
			signal,
		);
		const initialGovernance = evaluateGovernance({
			metrics: {
				confidence: initialSynthesis.confidence,
				disagreement: initialSynthesis.disagreement,
				cost: expertCost(verifiedResults),
				failureRate: attemptFailureRate(verifiedResults),
			},
			thresholds: this.#options.governanceThresholds,
		});

		// 5. One-step adaptive expansion (bounded, budget-gated) before HOTL.
		const expanded = await this.#runExpansion({
			taskId,
			template,
			strategy,
			candidates,
			temperatureLadder,
			signal,
			context,
			runAttempt,
			attemptedSelectors,
			results,
			nextIndex,
			verifiedResults,
			task,
			initialSynthesis,
			initialGovernance,
		});

		let finalSynthesis = expanded.synthesis;
		let resolution: GovernanceResolution | undefined;
		// Reassigned only on a HOTL "edit" resolution that successfully revived
		// at least one expert (see #reviveExperts) — otherwise stays identical
		// to verifiedResults, preserving prior behavior exactly.
		let editedResults: readonly ExpertResult[] = verifiedResults;
		if (expanded.governance.shouldEscalate) {
			const notice: EscalationNotice = {
				jobId: context.jobId,
				taskId,
				decision: expanded.governance,
				synthesis: expanded.synthesis,
			};
			if (this.#options.notifyEscalation)
				notifyWithoutBlocking(this.#options.notifyEscalation, notice);
			// #resolveEscalation blocks on a human decision (or the configured
			// timeout) — reported before that wait starts, not just implied by
			// the eventual "rejected"/synthesized outcome, so a live view can
			// say "waiting on a human" instead of looking stuck.
			await context.reportProgress(
				`Legion escalated task ${taskId} for human review.`,
				{
					phase: "escalated" satisfies LegionDispatchPhase,
					taskId,
					reasons: expanded.governance.reasons,
					confidence: expanded.synthesis.confidence,
					disagreement: expanded.synthesis.disagreement,
				},
			);
			resolution = await this.#resolveEscalation(notice, signal);
			if (resolution.action === HOTL_DECISION_EDIT) {
				// Revive-eligible only when the role ran non-isolated (worktree:
				// false — see DispatchAttempt.worktree) and the executor supports
				// it; every other case falls through unchanged to re-synthesizing
				// the same verifiedResults, exactly as before this existed.
				editedResults = await this.#reviveExperts(
					template,
					verifiedResults,
					resolution.note ?? "",
					signal,
				);
				finalSynthesis = await this.#synthesize(
					taskId,
					editedResults,
					// ponytail: fixed #1 — use verifiedResults for HOTL re-synthesis
					task,
					signal,
					resolution.note,
				);
			}
		}

		await context.reportProgress(`Legion synthesized task ${taskId}.`, {
			phase: "synthesizing" satisfies LegionDispatchPhase,
			taskId,
			confidence: finalSynthesis.confidence,
			disagreement: finalSynthesis.disagreement,
			clusteringMethod: finalSynthesis.clusteringMethod,
			escalated: expanded.governance.shouldEscalate,
			humanDecision: resolution?.action,
			answer: finalSynthesis.answer,
			replacements,
			expanded: expanded.expansion !== undefined,
			expandedConfidence: expanded.expansion?.synthesis.confidence,
			expandedDisagreement: expanded.expansion?.synthesis.disagreement,
		});

		// ponytail: fixed #1 — return merged verified results in TaskDispatchOutcome
		const mergedVerified = expanded.verifiedResult
			? [...editedResults, expanded.verifiedResult]
			: editedResults;
		return {
			taskId,
			results: mergedVerified,
			synthesis: finalSynthesis,
			governance: expanded.governance,
			resolution,
			initialSynthesis,
			initialGovernance,
			expansion: expanded.expansion,
			replacements,
		};
	}

	async #runFallback(params: {
		readonly taskId: string;
		readonly template: DispatchAttempt | undefined;
		readonly strategy: DispatchStrategy;
		readonly candidates: readonly string[];
		readonly temperatureLadder: readonly number[] | undefined;
		readonly initialResults: readonly ExpertResult[];
		readonly signal: AbortSignal;
		readonly context: JobRunContext;
		readonly runAttempt: (attempt: DispatchAttempt) => Promise<ExpertResult>;
		readonly attemptedSelectors: Set<string>;
		readonly results: ExpertResult[];
		readonly nextIndex: { value: number };
	}): Promise<ReplacementRecord[]> {
		const replacements: ReplacementRecord[] = [];
		const costCeiling = (
			this.#options.governanceThresholds ?? DEFAULT_HOTL_THRESHOLDS
		).costCeiling;
		let fallbackAttempts = 0;
		for (const seed of params.initialResults) {
			if (classifyFailure(seed) !== "retryable") continue;
			if (params.signal.aborted) break;
			let current = seed;
			while (true) {
				if (params.signal.aborted || expertCost(params.results) >= costCeiling)
					break;
				if (++fallbackAttempts > params.candidates.length) break;
				// ponytail: fixed #4 — attempt-count gate bounds fallback loop
				const spec = nextReplacement({
					strategy: params.strategy,
					candidates: params.candidates,
					temperatureLadder: params.temperatureLadder,
					attemptedSelectors: params.attemptedSelectors,
					selfConsistencyCount: params.results.length,
				});
				if (!spec) break;
				const attempt = this.#replacementAttempt(
					params.context.jobId,
					params.template,
					spec,
					params.nextIndex.value,
					params.taskId,
				);
				params.nextIndex.value += 1;
				params.attemptedSelectors.add(selectorKey(attempt));
				const result = await params.runAttempt(attempt);
				const reason = retryableReason(current.error);
				params.results.push(recordReplacement(result, current.model, reason));
				replacements.push({ from: current.model, to: spec.model, reason });
				await params.context.reportProgress(
					`Legion retried task ${params.taskId} on ${spec.model} after a retryable provider failure.`,
					{
						phase: "retrying" satisfies LegionDispatchPhase,
						taskId: params.taskId,
						replacedModel: current.model,
						model: spec.model,
						reason: "fallback",
						replacementReason: reason,
					},
				);
				if (classifyFailure(result) !== "retryable") break;
				current = result;
			}
		}
		return replacements;
	}

	async #runExpansion(params: {
		readonly taskId: string;
		readonly template: DispatchAttempt | undefined;
		readonly strategy: DispatchStrategy;
		readonly candidates: readonly string[];
		readonly temperatureLadder: readonly number[] | undefined;
		readonly signal: AbortSignal;
		readonly context: JobRunContext;
		readonly runAttempt: (attempt: DispatchAttempt) => Promise<ExpertResult>;
		readonly attemptedSelectors: Set<string>;
		readonly results: ExpertResult[];
		readonly nextIndex: { value: number };
		readonly verifiedResults: readonly ExpertResult[];
		readonly task: string;
		readonly initialSynthesis: SynthesisResult;
		readonly initialGovernance: GovernanceDecision;
	}): Promise<{
		synthesis: SynthesisResult;
		governance: GovernanceDecision;
		expansion?: { synthesis: SynthesisResult; governance: GovernanceDecision };
		verifiedResult?: ExpertResult;
	}> {
		const expandable =
			params.initialGovernance.shouldEscalate &&
			params.initialGovernance.reasons.some(
				(reason) => reason === "confidence" || reason === "disagreement",
			);
		const costCeiling = (
			this.#options.governanceThresholds ?? DEFAULT_HOTL_THRESHOLDS
		).costCeiling;
		if (
			!expandable ||
			params.signal.aborted ||
			expertCost(params.verifiedResults) >= costCeiling
		) {
			return {
				synthesis: params.initialSynthesis,
				governance: params.initialGovernance,
			};
		}
		const spec = nextReplacement({
			strategy: params.strategy,
			candidates: params.candidates,
			temperatureLadder: params.temperatureLadder,
			attemptedSelectors: params.attemptedSelectors,
			selfConsistencyCount: params.verifiedResults.length,
		});
		if (!spec)
			return {
				synthesis: params.initialSynthesis,
				governance: params.initialGovernance,
			};
		const attempt = this.#replacementAttempt(
			params.context.jobId,
			params.template,
			spec,
			params.nextIndex.value,
			params.taskId,
		);
		params.nextIndex.value += 1;
		params.attemptedSelectors.add(selectorKey(attempt));
		const expandedResult = await params.runAttempt(attempt);
		const expandedVerified = expandedResult.branchName
			? await this.#verifyOne(expandedResult, params.signal)
			: expandedResult;
		params.results.push(
			recordReplacement(expandedVerified, undefined, "adaptive expansion"),
		);
		const mergedVerified = [...params.verifiedResults, expandedVerified];
		// ponytail: fixed #1 — use merged verified results for expansion synthesis
		const synthesis = await this.#synthesize(
			params.taskId,
			mergedVerified,
			params.task,
			params.signal,
		);
		const governance = evaluateGovernance({
			metrics: {
				confidence: synthesis.confidence,
				disagreement: synthesis.disagreement,
				cost: expertCost(mergedVerified),
				failureRate: attemptFailureRate(mergedVerified),
			},
			thresholds: this.#options.governanceThresholds,
		});
		await params.context.reportProgress(
			`Legion expanded task ${params.taskId} with one ${spec.model} attempt to resolve the escalation.`,
			{
				phase: "expanding" satisfies LegionDispatchPhase,
				taskId: params.taskId,
				model: spec.model,
				reason: "expansion",
				expandedConfidence: synthesis.confidence,
				expandedDisagreement: synthesis.disagreement,
			},
		);
		return {
			synthesis,
			governance,
			expansion: { synthesis, governance },
			verifiedResult: expandedVerified,
		};
	}

	#replacementAttempt(
		jobId: string,
		template: DispatchAttempt | undefined,
		spec: ReplacementSpec,
		index: number,
		taskId: string,
	): DispatchAttempt {
		const agent = template?.agent ?? "";
		const role = template?.role ?? "";
		const assignment = template?.assignment ?? "";
		const description = template?.description;
		const candidates = template?.candidates ?? [];
		const strategy = template?.strategy ?? DEFAULT_DISPATCH_STRATEGY;
		const temperatureLadder = template?.temperatureLadder;
		return {
			id: `${jobId}-${taskId}-r${index}`,
			taskId,
			agent,
			role,
			assignment,
			description,
			model: spec.model,
			temperature: spec.temperature,
			index,
			candidates,
			candidateIndex: spec.candidateIndex,
			strategy,
			temperatureLadder,
			worktree: template?.worktree,
			maxSteps: template?.maxSteps,
		};
	}

	async #verifyOne(
		result: ExpertResult,
		signal: AbortSignal,
	): Promise<ExpertResult> {
		const verified = await this.#verifyResults([result], signal);
		// ponytail: fixed #14 — delegate to #verifyResults to deduplicate verify logic
		return verified[0] ?? result;
	}

	/**
	 * On a HOTL "edit" resolution, give the human's note back to the original
	 * experts as a follow-up turn instead of only re-running the aggregator
	 * over their stale (pre-note) answers — but only when doing so is
	 * possible at all: revival requires both the role having run non-isolated
	 * (`worktree: false` — an isolated attempt's worktree is merged and
	 * cleaned right after it finishes, so the host can never resume it) and
	 * the executor actually supporting `reviveExpert`. Neither condition
	 * holding is the overwhelmingly common case (today's default), in which
	 * this returns `results` completely unchanged — callers of `#synthesize`
	 * see identical behavior to before this existed.
	 *
	 * A result that already errored has no live session to continue, so it
	 * passes through unrevived rather than attempting a follow-up turn on a
	 * subagent that never produced a real answer. A revival attempt that
	 * itself throws (e.g. the parked session failed to resume) falls back to
	 * the expert's original result rather than losing it — an edit note that
	 * fails to apply to one expert must not discard that expert's otherwise
	 * real answer from synthesis.
	 */
	async #reviveExperts(
		template: DispatchAttempt | undefined,
		results: readonly ExpertResult[],
		message: string,
		signal: AbortSignal,
	): Promise<readonly ExpertResult[]> {
		const executor = this.#options.executor;
		const reviveExpert = executor.reviveExpert;
		if (template?.worktree !== false || !reviveExpert) return results;
		const revived = await Promise.all(
			results.map(async (result) => {
				if (result.error) return result;
				try {
					return await reviveExpert.call(executor, {
						result,
						message,
						signal,
						maxSteps: template?.maxSteps,
					});
				} catch {
					return result;
				}
			}),
		);
		const verified = await this.#verifyResults(revived, signal);
		return verified.map((result, index) => {
			if (isSuccessfulExpertResult(result)) return result;
			const original = results[index];
			return original ?? result;
		});
	}

	async #synthesize(
		taskId: string,
		experts: readonly ExpertResult[],
		task: string,
		signal: AbortSignal,
		humanNote?: string,
	): Promise<SynthesisResult> {
		const successful = experts.some(
			(result) => result.exitCode === 0 && !result.aborted,
		);
		if (!successful) {
			return fallbackSynthesis(
				taskId,
				new Error("No expert attempts completed successfully."),
			);
		}
		try {
			const result = await this.#options.synthesizer.synthesize({
				task,
				taskId,
				experts,
				humanNote,
				signal,
			});
			return { ...result, synthesisSucceeded: true };
		} catch (error) {
			return fallbackSynthesis(taskId, error);
		}
	}
}
