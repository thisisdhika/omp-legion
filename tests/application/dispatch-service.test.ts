import { describe, expect, test } from "bun:test";

import {
	DispatchService,
	type ExpertExecution,
	type ExpertExecutor,
	type JobRunContext,
	type JobScheduler,
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
		await run;

		expect(repository.record?.state).toBe("completed");
	});
});
