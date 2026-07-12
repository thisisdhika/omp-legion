import { describe, expect, test } from "bun:test";

import {
	type BranchMerger,
	DispatchService,
	type ExpertExecution,
	type ExpertExecutor,
	type JobRunContext,
	type JobScheduler,
	type VerifyRequest,
	type WinningAttempt,
} from "../../src/application/dispatch-service";
import { mergeLegionConfig } from "../../src/domain/config";
import type {
	DispatchRecord,
	ExpertResult,
	OrchestrationRepository,
} from "../../src/domain/dispatch";
import type {
	SynthesisInput,
	SynthesisResult,
	SynthesisRunner,
} from "../../src/domain/synthesis";

class DeferredScheduler implements JobScheduler {
	readonly jobs: Array<(context: JobRunContext) => Promise<string>> = [];

	schedule(
		_label: string,
		run: (context: JobRunContext) => Promise<string>,
	): string {
		this.jobs.push(run);
		return "job-1";
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
		return request.branchName.endsWith("-0");
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

	fail(): void {}

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
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});

		expect(accepted.jobId).toBe("job-1");
		expect(executor.executions).toHaveLength(0);
		expect(scheduler.jobs).toHaveLength(1);
	});
	test("decomposes a bare task inside the background job", async () => {
		const scheduler = new DeferredScheduler();
		const executor = new RecordingExecutor();
		const decomposer = {
			async decompose() {
				return [
					{
						id: "review",
						agent: "reviewer",
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

		expect(accepted.attemptCount).toBe(0);
		expect(executor.executions[0]?.attempt.taskId).toBe("review");
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
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});

		expect(accepted.attemptCount).toBe(5);
		expect(accepted.taskBreakdown).toEqual([
			{ taskId: "review", attemptCount: 5, models: Array(5).fill("frontier") },
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
					agent: "reviewer",
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
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
				{
					id: "implement",
					agent: "coder",
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
					agent: "reviewer",
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
					agent: "reviewer",
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
		expect(branchMerger.merged[0]?.[0]?.branchName).toMatch(/-0$/);

		// The other two attempts' branches are discarded, never merged.
		expect(branchMerger.discarded.flat()).toHaveLength(2);
		expect(
			branchMerger.discarded.flat().every((name) => !name.endsWith("-0")),
		).toBe(true);
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
					agent: "reviewer",
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
		// RecordingVerifier passes only the branch ending in "-0" (attempt index 0).
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
					agent: "reviewer",
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
					agent: "reviewer",
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
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
		});
		const job = scheduler.jobs[0];
		if (!job) throw new Error("Expected a scheduled job.");

		await expect(job(context())).rejects.toThrow(/rejected/);
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
					agent: "reviewer",
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
					agent: "reviewer",
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
		expect(branchMerger.discarded.flat()).toHaveLength(2);
	});
});
