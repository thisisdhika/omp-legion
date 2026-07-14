import { describe, expect, test } from "bun:test";

import {
	type BranchMerger,
	DispatchService,
	type ExpertExecution,
	type ExpertExecutor,
	type JobInfo,
	type JobRunContext,
	type JobScheduler,
	type ReviveExpertParams,
	type VerifyRequest,
	type WinningAttempt,
} from "../../src/application/dispatch-service";
import { mergeLegionConfig } from "../../src/domain/config";
import type {
	DispatchAuditData,
	DispatchRecord,
	ExpertResult,
	OrchestrationRepository,
} from "../../src/domain/dispatch";
import type {
	SynthesisInput,
	SynthesisResult,
	SynthesisRunner,
} from "../../src/domain/synthesis";
import { InMemoryOrchestrationRepository } from "../../src/infrastructure/in-memory-orchestration-repository";

class DeferredScheduler implements JobScheduler {
	readonly jobs: Array<(context: JobRunContext) => Promise<string>> = [];

	schedule(
		_label: string,
		run: (context: JobRunContext) => Promise<string>,
	): string {
		this.jobs.push(run);
		return "job-1";
	}

	getJob(_id: string): JobInfo | undefined {
		return undefined;
	}
}

class IdentityRecordingScheduler implements JobScheduler {
	readonly jobs: Array<{
		id: string;
		run: (context: JobRunContext) => Promise<string>;
	}> = [];

	schedule(
		_label: string,
		run: (context: JobRunContext) => Promise<string>,
		id?: string,
	): string {
		if (!id) throw new Error("Expected a dispatch identity.");
		this.jobs.push({ id, run });
		return id;
	}

	getJob(_id: string): JobInfo | undefined {
		return undefined;
	}
}

class RecordingExecutor implements ExpertExecutor {
	readonly executions: ExpertExecution[] = [];

	async run(execution: ExpertExecution): Promise<ExpertResult> {
		this.executions.push(execution);
		return {
			attemptId: execution.attempt.id,
			taskId: execution.attempt.taskId,
			agent: execution.attempt.agent,
			role: execution.attempt.role,
			model: execution.attempt.model,
			index: execution.attempt.index,
			output: `output-${execution.attempt.index}`,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
			tokens: 2,
			requests: 1,
		};
	}
}
class PrepareFailingExecutor extends RecordingExecutor {
	async prepareJob(): Promise<never> {
		throw new Error(
			"Legion requires cwd to be a git repository for isolated dispatch execution; run git init or dispatch from an existing repository.",
		);
	}
}

/** Every attempt "succeeds" with its own isolated branch, so merge/discard decisions are observable. */
class BranchingExecutor implements ExpertExecutor {
	readonly executions: ExpertExecution[] = [];

	async run(execution: ExpertExecution): Promise<ExpertResult> {
		this.executions.push(execution);
		return {
			attemptId: execution.attempt.id,
			taskId: execution.attempt.taskId,
			agent: execution.attempt.agent,
			role: execution.attempt.role,
			model: execution.attempt.model,
			index: execution.attempt.index,
			output: `output-${execution.attempt.index}`,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
			tokens: 2,
			requests: 1,
			branchName: `branch-${execution.attempt.id}`,
			baseSha: "base-sha",
		};
	}
}

class RecordingBranchMerger implements BranchMerger {
	readonly merged: WinningAttempt[][] = [];
	readonly discarded: string[][] = [];

	async mergeWinners(winners: readonly WinningAttempt[]): Promise<void> {
		this.merged.push([...winners]);
	}

	async discardBranches(branchNames: readonly string[]): Promise<void> {
		this.discarded.push([...branchNames]);
	}
}

class RecordingVerifier {
	readonly calls: VerifyRequest[] = [];

	async verify(request: VerifyRequest): Promise<boolean> {
		this.calls.push(request);
		return !/\d$/.test(request.branchName);
	}
}
class FailingMergeBranchMerger extends RecordingBranchMerger {
	readonly events: string[] = [];

	override async mergeWinners(
		winners: readonly WinningAttempt[],
	): Promise<void> {
		this.events.push(`merge:${winners.length}`);
		throw new Error("merge failed");
	}

	override async discardBranches(
		branchNames: readonly string[],
	): Promise<void> {
		this.events.push(`discard:${branchNames.length}`);
		await super.discardBranches(branchNames);
	}
}
class FailingDiscardBranchMerger extends RecordingBranchMerger {
	override async discardBranches(
		branchNames: readonly string[],
	): Promise<void> {
		await super.discardBranches(branchNames);
		throw new Error("discard failed");
	}
}

class RecordingSynthesizer implements SynthesisRunner {
	readonly inputs: SynthesisInput[] = [];

	async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
		this.inputs.push(input);
		return {
			taskId: input.taskId,
			answer: `synthesis-${input.taskId}`,
			confidence: 0.75,
			disagreement: 0.25,
			clusteringMethod: "embedding",
			embeddingQuality: "real",
			clusters: [
				{
					representativeAttemptId: input.experts[0]?.attemptId ?? "none",
					attemptIds: input.experts.map((expert) => expert.attemptId),
					size: input.experts.length,
				},
			],
			synthesisUsed: true,
		};
	}
}

class RecordingRepository implements OrchestrationRepository {
	record?: DispatchRecord;
	completed?: readonly ExpertResult[];

	create(record: DispatchRecord): void {
		this.record = record;
	}

	complete(
		_id: string,
		results: readonly ExpertResult[],
		syntheses: DispatchRecord["syntheses"],
		governance: DispatchRecord["governance"],
		_completedAt: number,
	): void {
		this.completed = results;
		if (this.record)
			this.record = {
				...this.record,
				state: "completed",
				results,
				syntheses,
				governance,
			};
	}

	fail(
		_id: string,
		error: string,
		_completedAt: number,
		audit?: DispatchAuditData,
	): void {
		if (this.record)
			this.record = {
				...this.record,
				state: "failed",
				error,
				...(audit ?? {}),
			};
	}

	get(): DispatchRecord | undefined {
		return this.record;
	}
}

function context(): JobRunContext {
	return {
		jobId: "job-1",
		signal: new AbortController().signal,
		reportProgress: async () => {},
	};
}

describe("DispatchService", () => {
	test("returns a host job id before expert execution starts", () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const service = new DispatchService({
			scheduler,
			executor,
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		const accepted = service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});

		expect(accepted.jobId).toBe("job-1");
		expect(executor.executions).toHaveLength(0);
		expect(scheduler.jobs).toHaveLength(1);
	});

	test("allows the same task payload to retry after a failed job", async () => {
		const scheduler = new IdentityRecordingScheduler();
		const repository = new InMemoryOrchestrationRepository();
		let executions = 0;
		const executor: ExpertExecutor = {
			async run(execution) {
				executions += 1;
				return {
					attemptId: execution.attempt.id,
					taskId: execution.attempt.taskId,
					agent: execution.attempt.agent,
					role: execution.attempt.role,
					model: execution.attempt.model,
					index: execution.attempt.index,
					output: executions === 1 ? "" : "retry succeeded",
					stderr: executions === 1 ? "forced first failure" : "",
					exitCode: executions === 1 ? 1 : 0,
					durationMs: 1,
					tokens: 1,
					requests: 1,
				};
			},
		};
		const service = new DispatchService({
			scheduler,
			executor,
			synthesizer: new RecordingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});
		const request = {
			task: "Retry this exact dispatch after failure",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
		};

		const first = service.dispatch(request);
		const firstJob = scheduler.jobs[0];
		if (!firstJob) throw new Error("Expected the first scheduled job.");
		await firstJob.run({ ...context(), jobId: first.jobId });

		const second = service.dispatch(request);
		const secondJob = scheduler.jobs[1];
		if (!secondJob) throw new Error("Expected the retry scheduled job.");
		await secondJob.run({ ...context(), jobId: second.jobId });
		expect(second.jobId).not.toBe(first.jobId);
		expect(repository.get(first.jobId)?.state).toBe("completed");
		expect(repository.get(first.jobId)?.results?.[0]?.exitCode).toBe(1);
		expect(repository.get(second.jobId)?.state).toBe("completed");
	});
	test("decomposes a bare task inside the background job", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const decomposer = {
			async decompose() {
				return [
					{
						id: "review",
						role: "reviewer",
						assignment: "Review the change",
					},
				];
			},
		};
		const service = new DispatchService({
			scheduler,
			executor,
			decomposer,
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		const accepted = service.dispatch({ task: "Review the change" });
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(accepted.attemptCount).toBe(3);
		expect(executor.executions[0]?.attempt.taskId).toBe("review");
	});
	// Regression coverage for a real incident: a live dispatch's progress
	// widget showed "ROUTING — selecting experts" for 4+ minutes while the
	// job was actually deep into decomposition, then running experts —
	// because reportProgress carried no structured signal a consumer could
	// read reliably, only freeform prose. Every reportProgress call now
	// tags a `phase` (see LegionDispatchPhase); this locks in that each
	// real stage of a run reports the phase it claims to be in, and that
	// "running" carries live completed/total counts as attempts land one
	// by one (previously a single "is running" message, then silence).
	test("reports a structured phase — including live attempt counts — at every real stage of a run", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const decomposer = {
			async decompose() {
				return [
					{
						id: "review",
						role: "reviewer",
						assignment: "Review the change",
					},
				];
			},
		};
		const service = new DispatchService({
			scheduler,
			executor,
			decomposer,
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({ task: "Review the change" });
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		const reported: Array<{ text: string; details?: Record<string, unknown> }> =
			[];
		await job({
			jobId: "job-1",
			signal: new AbortController().signal,
			reportProgress: async (text, details) => {
				reported.push({ text, details });
			},
		});

		const phases = reported.map((r) => r.details?.phase);
		expect(phases).toContain("decomposing");
		expect(phases).toContain("running");
		expect(phases).toContain("synthesizing");
		expect(phases).toContain("completed");
		// "decomposing" must be reported before any "running" progress, not
		// just discoverable somewhere in the list.
		expect(phases.indexOf("decomposing")).toBeLessThan(
			phases.indexOf("running"),
		);

		const runningUpdates = reported.filter(
			(r) => r.details?.phase === "running" && "completed" in (r.details ?? {}),
		);
		expect(runningUpdates.length).toBeGreaterThan(0);
		const last = runningUpdates.at(-1);
		expect(last?.details?.completed).toBe(last?.details?.total);
		expect(last?.details?.total).toBeGreaterThan(0);
	});
	// Regression test for a live-confirmed bug: a multi-task explicit dispatch
	// reported "running" progress with completed/total scoped to whichever
	// task's own attempts happened to land most recently (e.g. "1/3" for one
	// task) instead of the whole job's total across every task — visibly
	// inconsistent with the Mixtures card's own job-wide attempt count.
	test("aggregates completed/total across every task in a multi-task dispatch", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const service = new DispatchService({
			scheduler,
			executor,
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			config: mergeLegionConfig({ defaultEnsembleSize: 3 }),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		const accepted = service.dispatch({
			task: "Review two files",
			tasks: [
				{
					id: "t1",
					role: "reviewer",
					assignment: "Review A",
				},
				{
					id: "t2",
					role: "reviewer",
					assignment: "Review B",
				},
			],
		});
		// 2 tasks x ensembleSize 3 = 6 total attempts across the whole job.
		expect(accepted.attemptCount).toBe(6);

		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		const reported: Array<{ details?: Record<string, unknown> }> = [];
		await job({
			jobId: "job-1",
			signal: new AbortController().signal,
			reportProgress: async (_text, details) => {
				reported.push({ details });
			},
		});

		const runningUpdates = reported.filter(
			(r) => r.details?.phase === "running" && "completed" in (r.details ?? {}),
		);
		const last = runningUpdates.at(-1);
		// The last "running" update must reflect the whole job (6/6), not a
		// single task's own local total (3/3) -- both would satisfy
		// completed === total, so assert the actual value, not just equality.
		expect(last?.details?.total).toBe(6);
		expect(last?.details?.completed).toBe(6);
	});

	test("falls back to one task when decomposition fails", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const service = new DispatchService({
			scheduler,
			executor,
			decomposer: {
				async decompose() {
					throw new Error("model unavailable");
				},
			},
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({ task: "Review the change" });
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		// Agent is now resolved from role (never trusted from decomposition
		// output) — the fallback's role, "generalist", is what matters here.
		expect(executor.executions[0]?.attempt.role).toBe("generalist");
		expect(executor.executions[0]?.attempt.assignment).toBe(
			"Review the change",
		);
	});

	test("checks isolation prerequisites when the plan needs isolation", async () => {
		const scheduler = new DeferredScheduler();
		let decomposed = false;
		const executor: ExpertExecutor = {
			async prepareJob() {
				throw new Error(
					"Legion requires cwd to be a git repository for isolated dispatch execution; run git init or dispatch from an existing repository.",
				);
			},
			async run() {
				throw new Error("must not run");
			},
		};
		const service = new DispatchService({
			scheduler,
			executor,
			decomposer: {
				async decompose() {
					decomposed = true;
					return [];
				},
			},
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({ task: "Review the change" });
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		await expect(job(context())).rejects.toThrow(
			/ requires cwd to be a git repository /,
		);
		expect(decomposed).toBe(true);
	});
	test("runs all-read-only dispatches without preparing Git isolation", async () => {
		const scheduler = new DeferredScheduler();
		const service = new DispatchService({
			scheduler,
			executor: new PrepareFailingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
			modelMap: {
				reviewer: {
					models: ["frontier"],
					ensembleSize: 1,
					worktree: false,
				},
			},
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await expect(job(context())).resolves.toContain(
			"expert attempts completed",
		);
	});

	test("uses session config defaults when request omits policy", () => {
		const scheduler = new DeferredScheduler();
		const service = new DispatchService({
			scheduler,
			executor: new RecordingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			config: mergeLegionConfig({ defaultEnsembleSize: 5 }),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		const accepted = service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});

		expect(accepted.attemptCount).toBe(5);
		expect(accepted.taskBreakdown).toEqual([
			{
				taskId: "review",
				agent: "reviewer",
				attemptCount: 5,
				models: Array(5).fill("frontier"),
			},
		]);
	});
	test("runs every planned attempt with one persona and correlated model overrides", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const repository = new RecordingRepository();
		const synthesizer = new RecordingSynthesizer();
		const service = new DispatchService({
			scheduler,
			executor,
			repository,
			synthesizer,
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["security", "general"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(
			executor.executions.map((execution) => execution.attempt.agent),
		).toEqual(["reviewer", "reviewer"]);
		expect(
			executor.executions.map((execution) => execution.attempt.model),
		).toEqual(["security", "general"]);
		expect(
			executor.executions.every(
				(execution) => execution.task === "Review the change",
			),
		).toBe(true);
		expect(repository.completed).toHaveLength(2);
		expect(synthesizer.inputs).toHaveLength(1);
		expect(synthesizer.inputs[0]?.experts).toHaveLength(2);
		expect(repository.record?.syntheses?.[0]?.answer).toBe("synthesis-review");
		expect(repository.record?.syntheses?.[0]?.confidence).toBe(0.75);
		expect(repository.record?.syntheses?.[0]?.disagreement).toBe(0.25);
	});
	test("synthesizes each task after its own attempts settle", async () => {
		const scheduler = new DeferredScheduler();
		const synthesizer = new RecordingSynthesizer();
		const service = new DispatchService({
			scheduler,
			executor: new RecordingExecutor(),
			synthesizer,
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
		});

		service.dispatch({
			task: "Review and implement",
			defaultEnsembleSize: 1,
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
				{
					id: "implement",
					role: "coder",
					assignment: "Implement it",
				},
			],
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(synthesizer.inputs.map((input) => input.taskId)).toEqual([
			"review",
			"implement",
		]);
	});
	test("awaits human approval before completing an escalation", async () => {
		const scheduler = new DeferredScheduler();
		const repository = new RecordingRepository();
		let notifications = 0;
		let resolveDecision!: (decision: { action: "approve" }) => void;
		let resolveGateStarted!: () => void;
		const humanDecision = new Promise<{ action: "approve" }>((resolve) => {
			resolveDecision = resolve;
		});
		const gateStarted = new Promise<void>((resolve) => {
			resolveGateStarted = resolve;
		});
		const pendingNotification = new Promise<void>(() => {});
		const service = new DispatchService({
			scheduler,
			executor: new RecordingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			notifyEscalation: () => {
				notifications += 1;
				return pendingNotification;
			},
			decisionGate: async () => {
				resolveGateStarted();
				return humanDecision;
			},
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		const run = job(context());
		await gateStarted;

		expect(repository.record?.state).toBe("running");
		expect(notifications).toBe(1);

		resolveDecision({ action: "approve" });
		const summary = await run;

		expect(repository.record?.state).toBe("completed");
		// The delivered outcome text is the only place a human sees what
		// actually happened — it must say an escalation occurred and how a
		// human resolved it, not just the merged answer and raw stats.
		expect(summary).toContain("**Escalated**");
		expect(summary).toContain("**approved** by human decision");
	});

	// Regression/feature coverage for the "wake" mechanism: a HOTL "edit"
	// resolution on a non-isolated (worktree: false) role gives the human's
	// note back to the ORIGINAL experts as a follow-up turn (reusing their
	// live/parked session and prior context) instead of only re-running the
	// aggregator over stale, pre-note answers.
	class RevivingExecutor implements ExpertExecutor {
		readonly revivals: ReviveExpertParams[] = [];

		async run(execution: ExpertExecution): Promise<ExpertResult> {
			return {
				attemptId: execution.attempt.id,
				taskId: execution.attempt.taskId,
				agent: execution.attempt.agent,
				role: execution.attempt.role,
				model: execution.attempt.model,
				index: execution.attempt.index,
				output: "original answer",
				stderr: "",
				exitCode: 0,
				durationMs: 1,
				tokens: 2,
				requests: 1,
			};
		}

		async reviveExpert(params: ReviveExpertParams): Promise<ExpertResult> {
			this.revivals.push(params);
			return { ...params.result, output: "revised answer after human note" };
		}
	}
	class FailedRevivingExecutor extends RevivingExecutor {
		override async reviveExpert(
			params: ReviveExpertParams,
		): Promise<ExpertResult> {
			this.revivals.push(params);
			return { ...params.result, output: "failed revival", exitCode: 1 };
		}
	}

	test("revives the original expert with the human's edit note instead of only re-synthesizing stale answers", async () => {
		const scheduler = new DeferredScheduler();
		const repository = new RecordingRepository();
		const synthesizer = new RecordingSynthesizer();
		const executor = new RevivingExecutor();
		const service = new DispatchService({
			scheduler,
			executor,
			synthesizer,
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionGate: async () => ({
				action: "edit",
				note: "double-check the null case",
			}),
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				// "diverse" + exactly one candidate at ensembleSize 1 leaves no
				// adaptive-expansion headroom (expansionHeadroom requires more
				// candidates than ensembleSize) — keeps this test to exactly one
				// attempt/one revival rather than coupling it to expansion's
				// own (unrelated) internal behavior.
				reviewer: {
					models: ["frontier"],
					strategy: "diverse",
					ensembleSize: 1,
					worktree: false,
				},
			},
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(executor.revivals).toHaveLength(1);
		expect(executor.revivals[0]?.message).toBe("double-check the null case");
		expect(executor.revivals[0]?.result.output).toBe("original answer");
		// The re-synthesis after revival must see the REVIVED answer, not the
		// stale pre-note one.
		const finalCall = synthesizer.inputs.at(-1);
		expect(finalCall?.experts.map((e) => e.output)).toEqual([
			"revised answer after human note",
		]);
	});
	test("preserves the original result when revival returns a failed result", async () => {
		const scheduler = new DeferredScheduler();
		const synthesizer = new RecordingSynthesizer();
		const service = new DispatchService({
			scheduler,
			executor: new FailedRevivingExecutor(),
			synthesizer,
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionGate: async () => ({
				action: "edit",
				note: "double-check the null case",
			}),
		});

		service.dispatch({
			task: "Review the change",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
			modelMap: {
				reviewer: {
					models: ["frontier"],
					strategy: "diverse",
					ensembleSize: 1,
					worktree: false,
				},
			},
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		const finalCall = synthesizer.inputs.at(-1);
		expect(finalCall?.experts.map((expert) => expert.output)).toEqual([
			"original answer",
		]);
	});

	test("does not attempt revival when the role ran isolated (worktree left at default)", async () => {
		const scheduler = new DeferredScheduler();
		const repository = new RecordingRepository();
		const executor = new RevivingExecutor();
		const service = new DispatchService({
			scheduler,
			executor,
			synthesizer: new RecordingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionGate: async () => ({ action: "edit", note: "reconsider" }),
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: { reviewer: { models: ["frontier"], ensembleSize: 1 } },
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(executor.revivals).toHaveLength(0);
	});

	test("merges only the synthesis-selected winner's branch and discards every sibling", async () => {
		const scheduler = new DeferredScheduler();
		const branchMerger = new RecordingBranchMerger();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			branchMerger,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 3,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		// RecordingSynthesizer picks experts[0] (attempt index 0) as the
		// representative — only that attempt's branch should ever be merged.
		expect(branchMerger.merged).toHaveLength(1);
		expect(branchMerger.merged[0]).toHaveLength(1);
		expect(branchMerger.merged[0]?.[0]?.taskId).toBe("review");
		expect(branchMerger.merged[0]?.[0]?.branchName).not.toMatch(/\d$/);

		// The other two attempts' branches are discarded, never merged.
		expect(branchMerger.discarded.flat()).toHaveLength(2);
		expect(
			branchMerger.discarded.flat().every((name) => /\d$/.test(name)),
		).toBe(true);
	});
	test("retains audit evidence and loser branches when winner merge fails", async () => {
		const scheduler = new DeferredScheduler();
		const branchMerger = new FailingMergeBranchMerger();
		const repository = new RecordingRepository();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			branchMerger,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
			defaultEnsembleSize: 2,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await expect(job(context())).rejects.toThrow("merge failed");

		// The merge failure is handled at the mergeWinners call site: branches
		// are deliberately left undiscarded so a human can inspect and promote
		// an alternative — matching the branch-merger's "Unmerged branches
		// remain for manual resolution" contract.
		expect(repository.record?.state).toBe("failed");
		expect(repository.record?.results).toHaveLength(2);
		expect(repository.record?.syntheses).toHaveLength(1);
		expect(repository.record?.governance).toHaveLength(1);
		expect(branchMerger.events).toEqual(["merge:1"]);
		expect(branchMerger.discarded).toHaveLength(0);
	});

	test("independently verifies every branched attempt and passes the result to synthesis", async () => {
		const scheduler = new DeferredScheduler();
		const verifier = new RecordingVerifier();
		const synthesizer = new RecordingSynthesizer();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer,
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			verifier,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 3,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		// Every attempt produced a branch (BranchingExecutor), so every one is
		// independently re-verified — not merely trusted from its own report.
		expect(verifier.calls).toHaveLength(3);
		const verifiedFlags = synthesizer.inputs[0]?.experts.map(
			(expert) => expert.verified,
		);
		// RecordingVerifier passes only the unsuffixed branch (attempt index 0).
		expect(verifiedFlags).toEqual([true, false, false]);
	});

	test("computes governance cost as mean tokens per attempt, not a dispatch-wide sum", async () => {
		class FixedTokenExecutor implements ExpertExecutor {
			async run(execution: ExpertExecution): Promise<ExpertResult> {
				return {
					attemptId: execution.attempt.id,
					taskId: execution.attempt.taskId,
					agent: execution.attempt.agent,
					role: execution.attempt.role,
					model: execution.attempt.model,
					index: execution.attempt.index,
					output: "ok",
					stderr: "",
					exitCode: 0,
					durationMs: 1,
					tokens: 40,
					requests: 1,
				};
			}
		}

		const scheduler = new DeferredScheduler();
		let escalated = false;
		const service = new DispatchService({
			scheduler,
			executor: new FixedTokenExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0,
				disagreementThreshold: 1,
				failureRateCeiling: 1,
				// Between the true mean (40) and what a flat sum across 5
				// attempts would have been (200) — only escalates if cost is
				// still (wrongly) computed as a sum.
				costCeiling: 50,
			},
			notifyEscalation: () => {
				escalated = true;
			},
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 5,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(escalated).toBe(false);
	});

	test("escalates on failure rate even when the lone survivor reports maximum confidence", async () => {
		class MixedOutcomeExecutor implements ExpertExecutor {
			async run(execution: ExpertExecution): Promise<ExpertResult> {
				if (execution.attempt.index > 0) {
					throw new Error("subagent crashed");
				}
				return {
					attemptId: execution.attempt.id,
					taskId: execution.attempt.taskId,
					agent: execution.attempt.agent,
					role: execution.attempt.role,
					model: execution.attempt.model,
					index: execution.attempt.index,
					output: "the one survivor's answer",
					stderr: "",
					exitCode: 0,
					durationMs: 1,
					tokens: 1,
					requests: 1,
				};
			}
		}

		const scheduler = new DeferredScheduler();
		let escalationReasons: readonly string[] = [];
		const service = new DispatchService({
			scheduler,
			executor: new MixedOutcomeExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0,
				disagreementThreshold: 1,
				costCeiling: 1_000_000,
				failureRateCeiling: 0.5,
			},
			notifyEscalation: (notice) => {
				escalationReasons = notice.decision.reasons;
			},
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 3,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await expect(job(context())).rejects.toThrow();

		// 2 of 3 attempts crashed -- RecordingSynthesizer would otherwise report
		// confidence 0.75 (its fixed stub value) regardless, so only the
		// independently-computed failureRate metric catches this.
		expect(escalationReasons).toContain("failureRate");
	});

	test("reports zero confidence when every expert attempt fails", async () => {
		const scheduler = new DeferredScheduler();
		const repository = new RecordingRepository();
		const synthesizer = new RecordingSynthesizer();
		const service = new DispatchService({
			scheduler,
			executor: {
				async run() {
					throw new Error("provider unavailable");
				},
			},
			synthesizer,
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0,
				disagreementThreshold: 1,
				costCeiling: 1_000_000,
				failureRateCeiling: 1,
			},
		});

		service.dispatch({
			task: "Review the change",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
			defaultEnsembleSize: 3,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(synthesizer.inputs).toHaveLength(0);
		expect(repository.record?.syntheses?.[0]?.confidence).toBe(0);
		expect(repository.record?.syntheses?.[0]?.disagreement).toBe(1);
	});

	test("auto-resolves an escalation to reject once the decision timeout elapses", async () => {
		const scheduler = new DeferredScheduler();
		const service = new DispatchService({
			scheduler,
			executor: new RecordingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionTimeoutMs: 20,
			decisionGate: () => new Promise(() => {}), // never resolves on its own
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		await expect(job(context())).rejects.toThrow(/rejected/);
	});

	test("turns an all-experts-failed task into a per-task outcome instead of killing sibling tasks", async () => {
		// Simulates clusterExpertAnswers's real "Cannot cluster expert results
		// without output" throw for a task with zero surviving experts, while a
		// sibling task's synthesis succeeds normally.
		class PartiallyThrowingSynthesizer implements SynthesisRunner {
			async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
				if (input.taskId === "doomed") {
					throw new Error("Cannot cluster expert results without output.");
				}
				return {
					taskId: input.taskId,
					answer: "fine answer",
					confidence: 1,
					disagreement: 0,
					clusteringMethod: "embedding",
					embeddingQuality: "real",
					clusters: [
						{
							representativeAttemptId: input.experts[0]?.attemptId ?? "none",
							attemptIds: input.experts.map((expert) => expert.attemptId),
							size: input.experts.length,
						},
					],
					synthesisUsed: false,
				};
			}
		}

		const scheduler = new DeferredScheduler();
		const repository = new RecordingRepository();
		const service = new DispatchService({
			scheduler,
			executor: new RecordingExecutor(),
			synthesizer: new PartiallyThrowingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0,
				disagreementThreshold: 1,
				costCeiling: 1_000_000,
				failureRateCeiling: 0.99,
			},
		});

		service.dispatch({
			task: "Review two things",
			tasks: [
				{
					id: "doomed",
					role: "reviewer",
					assignment: "This will fail to synthesize",
				},
				{
					id: "fine",
					role: "reviewer",
					assignment: "This will not",
				},
			],
			defaultEnsembleSize: 1,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		// The point: "doomed"'s synthesis throwing doesn't take "fine" down with
		// it -- the job still completes, with both tasks' outcomes recorded.
		const summary = await job(context());

		expect(repository.record?.state).toBe("completed");
		expect(summary).toContain("doomed");
		expect(summary).toContain("fine");
		expect(summary).toContain("Every expert attempt for this task failed");
	});

	test("caps total concurrent expert attempts at maxConcurrentExperts", async () => {
		let inFlight = 0;
		let maxObserved = 0;
		class ConcurrencyTrackingExecutor implements ExpertExecutor {
			async run(execution: ExpertExecution): Promise<ExpertResult> {
				inFlight += 1;
				maxObserved = Math.max(maxObserved, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return {
					attemptId: execution.attempt.id,
					taskId: execution.attempt.taskId,
					agent: execution.attempt.agent,
					role: execution.attempt.role,
					model: execution.attempt.model,
					index: execution.attempt.index,
					output: "ok",
					stderr: "",
					exitCode: 0,
					durationMs: 1,
					tokens: 1,
					requests: 1,
				};
			}
		}

		const scheduler = new DeferredScheduler();
		const service = new DispatchService({
			scheduler,
			executor: new ConcurrencyTrackingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			maxConcurrentExperts: 2,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 6,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await job(context());

		expect(maxObserved).toBeLessThanOrEqual(2);
	});

	test("discards every branch and merges nothing when a human rejects the task", async () => {
		const scheduler = new DeferredScheduler();
		const branchMerger = new RecordingBranchMerger();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			branchMerger,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionGate: async () => ({ action: "reject" }),
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 2,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await expect(job(context())).rejects.toThrow();

		// Nothing is ever merged once a task is rejected — every isolated
		// attempt's branch (winner included) is discarded instead.
		expect(branchMerger.merged).toHaveLength(0);
		expect(branchMerger.discarded.flat()).toHaveLength(4);
	});
	test("discards every created branch when an unexpected exception aborts the dispatch", async () => {
		const scheduler = new DeferredScheduler();
		const branchMerger = new FailingDiscardBranchMerger();
		const repository = new RecordingRepository();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository,
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			branchMerger,
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 2,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");
		await expect(job(context())).rejects.toThrow("discard failed");

		// The discard failure mid-completion was caught by the catch-block
		// cleanup, which discards every branch (including the already-merged
		// winner) so nothing dangles.
		expect(repository.record?.state).toBe("failed");
		expect(branchMerger.merged).toHaveLength(1);
		// Two calls: normal path's loser discard (threw), then catch block's
		// full discard (throw swallowed).
		expect(branchMerger.discarded).toHaveLength(2);
		expect(branchMerger.discarded[0]).toHaveLength(1);
		expect(branchMerger.discarded[1]).toHaveLength(2);
	});

	// Regression coverage: #resolveEscalation blocks on a human decision (or
	// the configured timeout), which can take a while — a live view had no
	// way to distinguish "waiting on a human" from any other silent stretch
	// until this phase was reported.
	test("reports the escalated phase before the human decision resolves", async () => {
		const scheduler = new DeferredScheduler();
		const service = new DispatchService({
			scheduler,
			executor: new BranchingExecutor(),
			synthesizer: new RecordingSynthesizer(),
			repository: new RecordingRepository(),
			defaultModel: "frontier",
			isModelAvailable: () => true,
			resolveAgent: (role) => role,
			governanceThresholds: {
				confidenceFloor: 0.8,
				disagreementThreshold: 0.4,
				costCeiling: 100,
				failureRateCeiling: 0.5,
			},
			decisionGate: async () => ({ action: "reject" }),
		});

		service.dispatch({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			defaultEnsembleSize: 2,
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		const reported: Array<{ text: string; details?: Record<string, unknown> }> =
			[];
		await expect(
			job({
				jobId: "job-1",
				signal: new AbortController().signal,
				reportProgress: async (text, details) => {
					reported.push({ text, details });
				},
			}),
		).rejects.toThrow();

		const phases = reported.map((r) => r.details?.phase);
		expect(phases).toContain("escalated");
		expect(phases).toContain("rejected");
		expect(phases.indexOf("escalated")).toBeLessThan(
			phases.indexOf("rejected"),
		);
		const escalation = reported.find((r) => r.details?.phase === "escalated");
		expect(escalation?.details?.reasons).toEqual(["confidence"]);
	});

	describe("DispatchService runtime model fallback and adaptive expansion", () => {
		class ScriptedExecutor implements ExpertExecutor {
			readonly executions: ExpertExecution[] = [];
			constructor(
				private readonly behave: (execution: ExpertExecution) => ExpertResult,
			) {}
			async run(execution: ExpertExecution): Promise<ExpertResult> {
				this.executions.push(execution);
				return this.behave(execution);
			}
		}

		function retryableResult(
			execution: ExpertExecution,
			error: string,
		): ExpertResult {
			return {
				attemptId: execution.attempt.id,
				taskId: execution.attempt.taskId,
				agent: execution.attempt.agent,
				role: execution.attempt.role,
				model: execution.attempt.model,
				index: execution.attempt.index,
				temperature: execution.attempt.temperature,
				output: "",
				stderr: error,
				exitCode: 1,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error,
			};
		}

		function okResult(execution: ExpertExecution, tokens = 2): ExpertResult {
			return {
				attemptId: execution.attempt.id,
				taskId: execution.attempt.taskId,
				agent: execution.attempt.agent,
				role: execution.attempt.role,
				model: execution.attempt.model,
				index: execution.attempt.index,
				temperature: execution.attempt.temperature,
				output: `output-${execution.attempt.index}`,
				stderr: "",
				exitCode: 0,
				durationMs: 1,
				tokens,
				requests: 1,
			};
		}

		function capturingContext(): JobRunContext & {
			progresses: Array<Record<string, unknown>>;
		} {
			const progresses: Array<Record<string, unknown>> = [];
			return {
				jobId: "job-1",
				signal: new AbortController().signal,
				reportProgress: async (
					text: string,
					details?: Record<string, unknown>,
				) => {
					progresses.push({ text, ...(details ?? {}) });
				},
				progresses,
			};
		}

		function singleTask(
			modelMap?: Record<string, unknown>,
			extra?: Record<string, unknown>,
		) {
			return {
				task: "Do the thing",
				tasks: [{ id: "task", role: "coder", assignment: "Do it" }],
				modelMap: modelMap ?? {},
				...extra,
			};
		}

		test("falls back to the next candidate model on a quota/rate-limit failure (diverse)", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "a"
					? retryableResult(execution, "429 Too Many Requests: quota exhausted")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			// The replacement (model "c") runs; the failed attempt is preserved.
			expect(executor.executions.map((e) => e.attempt.model)).toEqual([
				"a",
				"b",
				"c",
			]);
			const failed = repository.record?.results?.find((r) => r.model === "a");
			expect(failed?.error).toContain("429");
			const replacement = repository.record?.results?.find(
				(r) => r.model === "c",
			);
			expect(replacement?.replacementReason).toBe("quota/rate-limit");
			expect(replacement?.replacedModel).toBe("a");
			expect(ctx.progresses.some((p) => p.reason === "fallback")).toBe(true);
		});

		// Regression test: #replacementAttempt (built for a runtime fallback
		// retry) used to drop the original template attempt's `worktree` field
		// entirely — a read-only role configured worktree: false would silently
		// fall back to isolated execution on its very first retry, defeating
		// the whole point of the opt-out.
		test("preserves worktree: false onto a runtime-fallback replacement attempt", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "a"
					? retryableResult(execution, "429 Too Many Requests: quota exhausted")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
						worktree: false,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			await job(capturingContext());

			expect(
				executor.executions.every((e) => e.attempt.worktree === false),
			).toBe(true);
		});

		test("does not retry an ordinary (non-retryable) task/validation error", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "a"
					? retryableResult(execution, "subagent crashed")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			expect(executor.executions.map((e) => e.attempt.model)).toEqual([
				"a",
				"b",
			]);
			const failed = repository.record?.results?.find((r) => r.model === "a");
			expect(failed?.replacementReason).toBeUndefined();
			expect(ctx.progresses.some((p) => p.reason === "fallback")).toBe(false);
		});

		test("falls back on an unavailable-model failure (diverse)", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "a"
					? retryableResult(execution, "model 'a' is unavailable")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			expect(executor.executions.map((e) => e.attempt.model)).toEqual([
				"a",
				"b",
				"c",
			]);
			expect(
				repository.record?.results?.find((r) => r.model === "c")
					?.replacementReason,
			).toBe("model unavailable");
		});

		test("exhausts candidates without duplicating a selector (diverse)", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "c"
					? okResult(execution)
					: retryableResult(execution, "rate limit exceeded"),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
				governanceThresholds: {
					confidenceFloor: 0,
					disagreementThreshold: 1,
					costCeiling: 1_000_000,
					failureRateCeiling: 1,
				},
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			// "a" and "b" both fail; only "a" gets the single replacement "c".
			// "b" is preserved as failed with no replacement (candidates exhausted).
			expect(executor.executions.map((e) => e.attempt.model)).toEqual([
				"a",
				"b",
				"c",
			]);
			expect(
				repository.record?.results?.find((r) => r.model === "b")
					?.replacementReason,
			).toBeUndefined();
		});

		test("stops scheduling fallbacks once the job is cancelled", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const controller = new AbortController();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.model === "a"
					? retryableResult(execution, "quota exhausted")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "a",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["a", "b", "c"],
						strategy: "diverse",
						ensembleSize: 2,
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			controller.abort();
			await job({
				jobId: "job-1",
				signal: controller.signal,
				reportProgress: async () => {},
			});

			expect(executor.executions.map((e) => e.attempt.model)).toEqual([
				"a",
				"b",
			]);
		});

		test("retries self-consistency on the next temperature-ladder value", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.temperature === 0.2
					? retryableResult(execution, "model unavailable")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "frontier",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["frontier"],
						strategy: "self-consistency",
						ensembleSize: 2,
						temperatureLadder: [0.2, 0.6, 1.0],
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			expect(executor.executions.map((e) => e.attempt.temperature)).toEqual([
				0.2, 0.6, 1.0,
			]);
			expect(
				repository.record?.results?.find((r) => r.temperature === 1.0)
					?.replacedModel,
			).toBe("frontier");
		});

		test("self-consistency fallback is bounded by the temperature ladder (candidate exhaustion)", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			const executor = new ScriptedExecutor((execution) =>
				execution.attempt.temperature === 0.2
					? retryableResult(execution, "model unavailable")
					: okResult(execution),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new RecordingSynthesizer(),
				repository,
				defaultModel: "frontier",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
			});
			service.dispatch(
				singleTask({
					coder: {
						models: ["frontier"],
						strategy: "self-consistency",
						ensembleSize: 3,
						temperatureLadder: [0.2, 0.6, 1.0],
					},
				}),
			);
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			// All three ladder values already attempted; no unique replacement exists.
			expect(executor.executions).toHaveLength(3);
		});

		class ExpandingSynthesizer implements SynthesisRunner {
			async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
				const confidence = Math.min(1, 0.7 + 0.1 * input.experts.length);
				return {
					taskId: input.taskId,
					answer: "a",
					confidence,
					disagreement: 0.1,
					clusteringMethod: "embedding",
					embeddingQuality: "real",
					clusters: [
						{
							representativeAttemptId: input.experts[0]?.attemptId ?? "none",
							attemptIds: input.experts.map((e) => e.attemptId),
							size: input.experts.length,
						},
					],
					synthesisUsed: true,
				};
			}
		}

		test("adds one adaptive-expansion attempt that can resolve a confidence escalation", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			let notifications = 0;
			const executor = new ScriptedExecutor((execution) => okResult(execution));
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new ExpandingSynthesizer(),
				repository,
				defaultModel: "frontier",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
				governanceThresholds: {
					confidenceFloor: 0.95,
					disagreementThreshold: 1,
					costCeiling: 1_000_000,
					failureRateCeiling: 0.5,
				},
				notifyEscalation: () => {
					notifications += 1;
				},
			});
			service.dispatch(singleTask(undefined, { defaultEnsembleSize: 2 }));
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await job(ctx);

			// 2 planned + 1 expansion; expansion lifted confidence above the floor.
			expect(executor.executions).toHaveLength(3);
			expect(notifications).toBe(0);
			expect(repository.record?.state).toBe("completed");
			expect(repository.record?.syntheses).toHaveLength(2);
			expect(ctx.progresses.some((p) => p.reason === "expansion")).toBe(true);
		});

		test("skips adaptive expansion when the cost budget is already exceeded", async () => {
			const scheduler = new DeferredScheduler();
			const repository = new RecordingRepository();
			let notifications = 0;
			const executor = new ScriptedExecutor((execution) =>
				okResult(execution, 500),
			);
			const service = new DispatchService({
				scheduler,
				executor,
				synthesizer: new ExpandingSynthesizer(),
				repository,
				defaultModel: "frontier",
				isModelAvailable: () => true,
				resolveAgent: (role) => role,
				governanceThresholds: {
					confidenceFloor: 0.95,
					disagreementThreshold: 1,
					costCeiling: 5,
					failureRateCeiling: 0.5,
				},
				notifyEscalation: () => {
					notifications += 1;
				},
				decisionGate: async () => ({ action: "reject" }),
			});
			service.dispatch(singleTask(undefined, { defaultEnsembleSize: 2 }));
			const job = scheduler.jobs[0];
			if (!job) throw new Error("Expected a scheduled job.");
			const ctx = capturingContext();
			await expect(job(ctx)).rejects.toThrow();

			// Budget gate prevents the expansion; escalation still goes to HOTL.
			expect(executor.executions).toHaveLength(2);
			expect(notifications).toBe(1);
			expect(ctx.progresses.some((p) => p.reason === "expansion")).toBe(false);
		});
	});
});
