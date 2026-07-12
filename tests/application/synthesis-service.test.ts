import { describe, expect, test } from "bun:test";

import type { ExpertResult } from "../../src/domain/dispatch";
import {
	type Aggregator,
	type AggregatorInput,
	type AnswerCluster,
	type EmbeddingProvider,
	SynthesisService,
	clusterExpertAnswers,
	preferVerifiedCluster,
} from "../../src/domain/synthesis";

function expert(
	attemptId: string,
	output: string,
	verified?: boolean,
): ExpertResult {
	return {
		attemptId,
		taskId: "task-1",
		agent: "reviewer",
		role: "reviewer",
		model: "model-a",
		index: Number(attemptId.replace("attempt-", "")),
		output,
		stderr: "",
		exitCode: 0,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		verified,
	};
}

function cluster(
	representativeAttemptId: string,
	attemptIds: readonly string[],
): AnswerCluster {
	return { representativeAttemptId, attemptIds, size: attemptIds.length };
}

class StaticEmbeddingProvider implements EmbeddingProvider {
	readonly vectors: readonly (readonly number[])[] | null;

	constructor(vectors: readonly (readonly number[])[] | null) {
		this.vectors = vectors;
	}

	embed(): Promise<readonly (readonly number[])[] | null> {
		return Promise.resolve(this.vectors);
	}
}

class RecordingAggregator implements Aggregator {
	input?: AggregatorInput;

	synthesize(input: AggregatorInput): Promise<string> {
		this.input = input;
		return Promise.resolve("merged answer");
	}
}

describe("SynthesisService", () => {
	test("groups near-duplicate answers with real embedding vectors", async () => {
		const answers = [
			expert("attempt-0", "Add a null guard."),
			expert("attempt-1", "Add a null guard before access."),
			expert("attempt-2", "Rewrite the parser."),
		];
		const clustered = await clusterExpertAnswers(
			answers,
			new StaticEmbeddingProvider([
				[1, 0],
				[0.99, 0.01],
				[0, 1],
			]),
		);

		expect(clustered.method).toBe("embedding");
		expect(clustered.quality).toBe("real");
		expect(clustered.clusters[0]?.size).toBe(2);
	});

	test("uses Rouge-L and marks degraded quality without embeddings", async () => {
		const clustered = await clusterExpertAnswers(
			[
				expert("attempt-0", "Add a null guard before accessing fields."),
				expert("attempt-1", "Add a null guard before accessing fields safely."),
			],
			new StaticEmbeddingProvider(null),
		);

		expect(clustered.method).toBe("rouge-l-fallback");
		expect(clustered.quality).toBe("degraded");
		expect(clustered.clusters[0]?.size).toBe(2);
	});

	test("passes every expert output to the real aggregator and records scores", async () => {
		const aggregator = new RecordingAggregator();
		const service = new SynthesisService({
			embeddingProvider: new StaticEmbeddingProvider([
				[1, 0],
				[0, 1],
			]),
			aggregator,
		});
		const result = await service.synthesize({
			task: "Review the change",
			taskId: "task-1",
			experts: [
				expert("attempt-0", "Keep the guard."),
				expert("attempt-1", "Replace the parser."),
			],
		});

		expect(aggregator.input?.experts).toHaveLength(2);
		expect(aggregator.input?.experts.map((item) => item.output)).toEqual([
			"Keep the guard.",
			"Replace the parser.",
		]);
		expect(result.answer).toBe("merged answer");
		expect(result.confidence).toBe(0.5);
		expect(result.disagreement).toBe(0.5);
		expect(result.synthesisUsed).toBe(true);
	});
});

describe("preferVerifiedCluster", () => {
	test("promotes a smaller cluster containing a verified attempt over a larger unverified one", () => {
		const clusters = [
			cluster("attempt-0", ["attempt-0", "attempt-1"]),
			cluster("attempt-2", ["attempt-2"]),
		];
		const experts = [
			expert("attempt-0", "wrong answer", false),
			expert("attempt-1", "wrong answer", false),
			expert("attempt-2", "correct answer", true),
		];

		const reordered = preferVerifiedCluster(clusters, experts);

		expect(reordered[0]?.representativeAttemptId).toBe("attempt-2");
		expect(reordered[0]?.attemptIds).toEqual(["attempt-2"]);
		// The original majority cluster is preserved, just demoted, not lost.
		expect(reordered[1]?.attemptIds).toEqual(["attempt-0", "attempt-1"]);
	});

	test("prefers the verified member as representative within the promoted cluster", () => {
		const clusters = [
			cluster("attempt-0", ["attempt-0", "attempt-1"]),
			cluster("attempt-2", ["attempt-2", "attempt-3"]),
		];
		const experts = [
			expert("attempt-0", "a", false),
			expert("attempt-1", "a", false),
			expert("attempt-2", "b", false),
			expert("attempt-3", "b", true),
		];

		const reordered = preferVerifiedCluster(clusters, experts);

		expect(reordered[0]?.representativeAttemptId).toBe("attempt-3");
	});

	test("is a no-op when no attempt was verified", () => {
		const clusters = [
			cluster("attempt-0", ["attempt-0", "attempt-1"]),
			cluster("attempt-2", ["attempt-2"]),
		];
		const experts = [
			expert("attempt-0", "a"),
			expert("attempt-1", "a"),
			expert("attempt-2", "b", false),
		];

		expect(preferVerifiedCluster(clusters, experts)).toEqual(clusters);
	});

	test("is a no-op when the verified attempt is already in the leading cluster", () => {
		const clusters = [
			cluster("attempt-0", ["attempt-0", "attempt-1"]),
			cluster("attempt-2", ["attempt-2"]),
		];
		const experts = [
			expert("attempt-0", "a", true),
			expert("attempt-1", "a", false),
			expert("attempt-2", "b", false),
		];

		expect(preferVerifiedCluster(clusters, experts)).toEqual(clusters);
	});
});

describe("SynthesisService with execution-grounded verification", () => {
	test("selects the verified-passing attempt over a larger unverified majority", async () => {
		const aggregator = new RecordingAggregator();
		const service = new SynthesisService({
			embeddingProvider: new StaticEmbeddingProvider([
				[1, 0],
				[1, 0],
				[0, 1],
			]),
			aggregator,
		});

		const result = await service.synthesize({
			task: "Fix the bug",
			taskId: "task-1",
			experts: [
				expert("attempt-0", "buggy fix", false),
				expert("attempt-1", "buggy fix", false),
				expert("attempt-2", "correct fix", true),
			],
		});

		expect(result.clusters[0]?.representativeAttemptId).toBe("attempt-2");
	});
});
