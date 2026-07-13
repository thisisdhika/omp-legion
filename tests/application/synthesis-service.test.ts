import { describe, expect, test } from "bun:test";

import type { ExpertResult } from "../../src/domain/dispatch";
import {
	type Aggregator,
	type AggregatorInput,
	type AnswerCluster,
	type EmbeddingProvider,
	SynthesisService,
	clusterExpertAnswers,
	fragmentationDisagreement,
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
		// Two experts, two totally distinct answers (orthogonal embeddings) —
		// maximum possible fragmentation: (clusterCount 2 - 1) / (answerCount 2 - 1).
		expect(result.disagreement).toBe(1);
		expect(result.synthesisUsed).toBe(true);
	});

	// Regression test for a live-confirmed incident: clustering succeeded with
	// real expert answers (5 completed attempts), but the aggregator's own
	// write-up call failed ("Model not found gpt-5.6-luna" — an unrelated
	// model captured at session_start, not any expert's assigned model). The
	// caller previously let this exception propagate, and dispatch-service.ts's
	// generic catch mislabeled it "every expert attempt failed; nothing to
	// synthesize" — discarding genuinely completed expert work over a failure
	// in an entirely different step. Synthesis must degrade to the top
	// cluster's raw answer instead of losing real results to an unrelated
	// aggregator failure.
	test("falls back to the top cluster's raw answer when the aggregator itself fails, instead of discarding real expert results", async () => {
		class FailingAggregator implements Aggregator {
			synthesize(): Promise<string> {
				return Promise.reject(new Error("Model not found gpt-5.6-luna"));
			}
		}
		const service = new SynthesisService({
			embeddingProvider: new StaticEmbeddingProvider([
				[1, 0],
				[0.99, 0.01],
			]),
			aggregator: new FailingAggregator(),
		});
		const result = await service.synthesize({
			task: "Pick the sharpest next question",
			taskId: "task-1",
			experts: [
				expert("attempt-0", "Ask about canonical URL structure."),
				expert("attempt-1", "Ask about canonical URL structure too."),
			],
		});

		// The longer of the two near-identical candidates wins the fallback
		// (see longestAnswer's doc comment in synthesis.ts) — both are valid,
		// real answers here, so this just confirms *a* real answer survives.
		expect(result.answer).toContain("Ask about canonical URL structure too.");
		expect(result.answer).toContain("Model not found gpt-5.6-luna");
		expect(result.synthesisUsed).toBe(false);
		// Clustering itself is unaffected by the aggregator's failure — the real
		// confidence/disagreement signal from the actual expert answers survives.
		expect(result.confidence).toBe(1);
	});

	// Regression test for a second live-confirmed incident on top of the first:
	// the degraded-fallback path above picked `candidates[0]` — whichever
	// attempt happened to be first in *array* order — with no regard for
	// whether that attempt actually finished. Live case: attempt index 0 never
	// called `yield` (stuck retrying with empty completions until it ran out
	// of turns); the host substituted its one leftover planning sentence as
	// the "successful" raw result, which then won the fallback over two other
	// attempts that had genuinely completed with real, full answers — because
	// index 0 beats index 1/2 with no other tiebreaker. The fallback must
	// prefer the longest (most likely actually-finished) surviving answer,
	// not whichever one happened to run first.
	test("prefers the longest surviving answer over attempt-array order when the aggregator fails", async () => {
		class FailingAggregator implements Aggregator {
			synthesize(): Promise<string> {
				return Promise.reject(new Error("Model not found gpt-5.6-luna"));
			}
		}
		const service = new SynthesisService({
			embeddingProvider: new StaticEmbeddingProvider([
				[1, 0],
				[0, 1],
				[0.5, 0.5],
			]),
			aggregator: new FailingAggregator(),
		});
		const result = await service.synthesize({
			task: "Pick the sharpest next question",
			taskId: "task-1",
			experts: [
				// attempt-0: stuck/truncated — a leftover planning sentence, no
				// real answer, but still index 0 in the experts array.
				expert("attempt-0", "I'll help you identify the next decision."),
				expert(
					"attempt-1",
					"What is the readiness gate for CMS as the source of truth for supported regions? Options: strict allowlist, soft fallback, or manual override. Recommend strict allowlist for safety.",
				),
				expert(
					"attempt-2",
					"When CMS becomes authoritative, what is the runtime behavior on a failed or empty fetch? Options: fail closed, fail open, or cached fallback. Recommend fail closed.",
				),
			],
		});

		expect(result.answer).not.toContain("I'll help you identify");
		expect(result.answer).toContain("readiness gate");
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

describe("fragmentationDisagreement", () => {
	test("is zero when every attempt landed in one cluster", () => {
		expect(fragmentationDisagreement(1, 3)).toBe(0);
	});

	test("a lone dissenter at the default ensemble size reads as moderate, not alarming", () => {
		// 2-1 split at N=3: one dominant answer, one dissenter.
		expect(fragmentationDisagreement(2, 3)).toBe(0.5);
	});

	test("full scatter reads as maximum disagreement", () => {
		// 1-1-1 split at N=3: no majority at all.
		expect(fragmentationDisagreement(3, 3)).toBe(1);
	});

	test("is zero for a single answer (nothing to disagree about)", () => {
		expect(fragmentationDisagreement(1, 1)).toBe(0);
	});
});
