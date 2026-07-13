import {
	DEFAULT_EMBEDDING_THRESHOLD,
	DEFAULT_ROUGE_L_THRESHOLD,
	MAX_ROUGE_L_TOKEN_COUNT,
} from "./constants";
import type { ExpertResult } from "./dispatch";

export type ClusteringMethod = "embedding" | "rouge-l-fallback";
export type EmbeddingQuality = "real" | "degraded";

export interface EmbeddingProvider {
	embed(
		texts: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly (readonly number[])[] | null>;
}

export interface AnswerCluster {
	readonly representativeAttemptId: string;
	readonly attemptIds: readonly string[];
	readonly size: number;
}

export interface ClusteredAnswers {
	readonly clusters: readonly AnswerCluster[];
	readonly method: ClusteringMethod;
	readonly quality: EmbeddingQuality;
}

export interface AggregatorInput {
	readonly task: string;
	readonly taskId: string;
	readonly experts: readonly ExpertResult[];
	readonly clusters: readonly AnswerCluster[];
	readonly clusteringMethod: ClusteringMethod;
	readonly humanNote?: string;
}

export interface Aggregator {
	synthesize(input: AggregatorInput, signal?: AbortSignal): Promise<string>;
}

export interface SynthesisInput {
	readonly task: string;
	readonly taskId: string;
	readonly experts: readonly ExpertResult[];
	readonly humanNote?: string;
	readonly signal?: AbortSignal;
}

export interface SynthesisRunner {
	synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}

export interface SynthesisResult {
	readonly taskId: string;
	readonly answer: string;
	readonly confidence: number;
	readonly disagreement: number;
	readonly clusteringMethod: ClusteringMethod;
	readonly embeddingQuality: EmbeddingQuality;
	readonly clusters: readonly AnswerCluster[];
	readonly synthesisUsed: boolean;
	/** False only for the dispatch service's explicit degraded fallback. */
	readonly synthesisSucceeded?: boolean;
}

interface Answer {
	readonly attemptId: string;
	readonly text: string;
}

function answerCandidates(experts: readonly ExpertResult[]): Answer[] {
	return experts.flatMap((expert) => {
		const text = expert.output.trim();
		return text.length > 0 ? [{ attemptId: expert.attemptId, text }] : [];
	});
}

function cosineSimilarity(
	left: readonly number[],
	right: readonly number[],
): number {
	if (left.length === 0 || left.length !== right.length) return 0;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const leftValue = left[index];
		const rightValue = right[index];
		if (leftValue === undefined || rightValue === undefined) return 0;
		dot += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function tokens(text: string): string[] {
	return (
		text
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu)
			?.slice(0, MAX_ROUGE_L_TOKEN_COUNT) ?? []
	);
}

function rougeL(left: string, right: string): number {
	const leftTokens = tokens(left);
	const rightTokens = tokens(right);
	if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
	const row = new Uint16Array(rightTokens.length + 1);
	for (const leftToken of leftTokens) {
		let diagonal = 0;
		for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex++) {
			const above = row[rightIndex];
			if (leftToken === rightTokens[rightIndex - 1])
				row[rightIndex] = diagonal + 1;
			else
				row[rightIndex] = Math.max(
					row[rightIndex] ?? 0,
					row[rightIndex - 1] ?? 0,
				);
			diagonal = above ?? 0;
		}
	}
	const lcs = row[rightTokens.length] ?? 0;
	const precision = lcs / leftTokens.length;
	const recall = lcs / rightTokens.length;
	return precision + recall === 0
		? 0
		: (2 * precision * recall) / (precision + recall);
}

function validVectors(
	vectors: readonly (readonly number[])[] | null,
	count: number,
): vectors is readonly (readonly number[])[] {
	if (vectors === null || vectors.length !== count || vectors.length === 0)
		return false;
	const dimension = vectors[0]?.length ?? 0;
	return (
		dimension > 0 &&
		vectors.every(
			(vector) => vector.length === dimension && vector.every(Number.isFinite),
		)
	);
}

function unionFindClusters(
	answers: readonly Answer[],
	similarity: (
		left: Answer,
		right: Answer,
		leftIndex: number,
		rightIndex: number,
	) => number,
	threshold: number,
): AnswerCluster[] {
	const parents = answers.map((_, index) => index);
	const find = (index: number): number => {
		let root = index;
		while (parents[root] !== root) root = parents[root] ?? root;
		let cursor = index;
		while (parents[cursor] !== cursor) {
			const next = parents[cursor] ?? cursor;
			parents[cursor] = root;
			cursor = next;
		}
		return root;
	};
	const union = (left: number, right: number): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
	};

	for (let leftIndex = 0; leftIndex < answers.length; leftIndex++) {
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < answers.length;
			rightIndex++
		) {
			const leftAnswer = answers[leftIndex];
			const rightAnswer = answers[rightIndex];
			if (!leftAnswer || !rightAnswer) continue;
			if (
				similarity(leftAnswer, rightAnswer, leftIndex, rightIndex) >= threshold
			) {
				union(leftIndex, rightIndex);
			}
		}
	}

	const grouped = new Map<number, Answer[]>();
	for (let index = 0; index < answers.length; index++) {
		const answer = answers[index];
		if (!answer) continue;
		const root = find(index);
		const group = grouped.get(root) ?? [];
		group.push(answer);
		grouped.set(root, group);
	}
	return [...grouped.values()]
		.sort((left, right) => right.length - left.length)
		.map((group) => {
			const representative = group[0];
			if (!representative)
				throw new Error("Cannot build an empty answer cluster.");
			return {
				representativeAttemptId: representative.attemptId,
				attemptIds: group.map((answer) => answer.attemptId),
				size: group.length,
			};
		});
}

export async function clusterExpertAnswers(
	experts: readonly ExpertResult[],
	provider: EmbeddingProvider,
	signal?: AbortSignal,
): Promise<ClusteredAnswers> {
	const answers = answerCandidates(experts);
	if (answers.length === 0)
		throw new Error("Cannot cluster expert results without output.");
	let vectors: readonly (readonly number[])[] | null = null;
	try {
		vectors = await provider.embed(
			answers.map((answer) => answer.text),
			signal,
		);
	} catch {
		vectors = null;
	}
	if (validVectors(vectors, answers.length)) {
		return {
			clusters: unionFindClusters(
				answers,
				(_left, _right, leftIndex, rightIndex) => {
					const leftVector = vectors[leftIndex];
					const rightVector = vectors[rightIndex];
					return leftVector && rightVector
						? cosineSimilarity(leftVector, rightVector)
						: 0;
				},
				DEFAULT_EMBEDDING_THRESHOLD,
			),
			method: "embedding",
			quality: "real",
		};
	}
	return {
		clusters: unionFindClusters(
			answers,
			(left, right) => rougeL(left.text, right.text),
			DEFAULT_ROUGE_L_THRESHOLD,
		),
		method: "rouge-l-fallback",
		quality: "degraded",
	};
}

/**
 * Execution-grounded override: when a project's own verify command actually
 * ran against an attempt's isolated branch (`verified === true` — a real
 * execution result, not a text-similarity guess), the cluster containing
 * that attempt is treated as the answer even if a larger, unverified
 * cluster exists — per arXiv 2604.15618 and 2605.08680, execution-based
 * consensus beats output-pattern majority voting by 19-52pp on code. Only
 * reorders which cluster leads and which of its members is representative;
 * does not touch confidence/disagreement (that recalibration is deferred —
 * see docs/plan/algorithm-audit-and-hardening-v2.md Phase 3) or split/merge
 * any cluster. A no-op when no attempt was verified (roles with nothing to
 * execute, like legion-reviewer, or no `verifyCommand` configured at all).
 */
export function preferVerifiedCluster(
	clusters: readonly AnswerCluster[],
	experts: readonly ExpertResult[],
): readonly AnswerCluster[] {
	const verifiedIds = new Set(
		experts
			.filter((expert) => expert.verified === true)
			.map((expert) => expert.attemptId),
	);
	if (verifiedIds.size === 0) return clusters;
	const index = clusters.findIndex((cluster) =>
		cluster.attemptIds.some((id) => verifiedIds.has(id)),
	);
	if (index <= 0) return clusters;
	const promoted = clusters[index];
	if (!promoted) return clusters;
	const withVerifiedRepresentative: AnswerCluster = {
		...promoted,
		representativeAttemptId:
			promoted.attemptIds.find((id) => verifiedIds.has(id)) ??
			promoted.representativeAttemptId,
	};
	const rest = clusters.filter((_, clusterIndex) => clusterIndex !== index);
	return [withVerifiedRepresentative, ...rest];
}

/**
 * `disagreement` used to be defined as `1 - confidence` — a hard
 * mathematical identity, not an independent measurement. At the default
 * thresholds (confidenceFloor 0.6, disagreementThreshold 0.4, summing to
 * exactly 1.0) the two governance checks always co-fired together: one weak
 * signal double-counted as two, not two corroborating ones (see
 * docs/plan/algorithm-audit-and-hardening-v2.md §1.2/Phase 3). This measures
 * fragmentation instead — how many distinct clusters exist relative to the
 * most a fully-disagreeing vote could produce — so a 5-1-1 split (one
 * dominant answer, two different lone dissenters) reads as more disagreement
 * than a 5-2 split (one dominant answer, one alternative) even though both
 * can share the same majority-fraction confidence.
 */
export function fragmentationDisagreement(
	clusterCount: number,
	answerCount: number,
): number {
	if (answerCount <= 1) return 0;
	return (clusterCount - 1) / (answerCount - 1);
}

export class SynthesisService implements SynthesisRunner {
	readonly #embeddingProvider: EmbeddingProvider;
	readonly #aggregator: Aggregator;

	constructor(options: {
		embeddingProvider: EmbeddingProvider;
		aggregator: Aggregator;
	}) {
		this.#embeddingProvider = options.embeddingProvider;
		this.#aggregator = options.aggregator;
	}

	async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
		const clustered = await clusterExpertAnswers(
			input.experts,
			this.#embeddingProvider,
			input.signal,
		);
		const orderedClusters = preferVerifiedCluster(
			clustered.clusters,
			input.experts,
		);
		const majority = orderedClusters[0];
		if (!majority)
			throw new Error(`Task ${input.taskId} has no answer cluster.`);
		const answerCount = orderedClusters.reduce(
			(total, cluster) => total + cluster.size,
			0,
		);
		const confidence = majority.size / answerCount;
		const disagreement = fragmentationDisagreement(
			orderedClusters.length,
			answerCount,
		);
		const candidates = answerCandidates(input.experts);
		const firstAnswer = candidates[0];
		if (!firstAnswer) throw new Error(`Task ${input.taskId} has no answer.`);
		// Live-confirmed failure mode of the degraded-fallback path below:
		// firstAnswer is whichever attempt happens to be first in *array* order
		// (attempt index 0), which carries no quality signal at all. An expert
		// that never called `yield` (stuck retrying, ran out of turns) still
		// produces a "successful" ExpertResult — the host substitutes its last
		// assistant message as the raw result — so a genuinely broken attempt
		// (a leftover one-sentence planning remark, no real answer) can easily
		// land at index 0 ahead of two other attempts that finished properly.
		// The longest candidate is a cheap, generically useful proxy for "an
		// attempt that actually finished" — a stuck/truncated attempt's leftover
		// text is reliably much shorter than a real finished answer.
		const longestAnswer = candidates.reduce(
			(best, candidate) =>
				candidate.text.length > best.text.length ? candidate : best,
			firstAnswer,
		);

		const shouldAggregate = candidates.length > 1 || Boolean(input.humanNote);
		// Real expert answers already exist at this point (clustering succeeded);
		// the aggregator only produces the human-readable write-up on top of
		// them. A live incident confirmed the aggregator's own model (captured
		// once at session_start, never re-resolved) can fail to resolve when
		// called from a background job — losing that write-up must never
		// discard 5 genuinely completed expert results and report "every
		// expert attempt failed" (see dispatch-service.ts's fallbackSynthesis,
		// which is for the real zero-survivors case, not this one). Fall back
		// to the longest surviving raw answer instead (see longestAnswer above).
		let answer = firstAnswer.text;
		let synthesisUsed = false;
		if (shouldAggregate) {
			try {
				answer = await this.#aggregator.synthesize(
					{
						task: input.task,
						taskId: input.taskId,
						experts: input.experts,
						clusters: orderedClusters,
						clusteringMethod: clustered.method,
						humanNote: input.humanNote,
					},
					input.signal,
				);
				synthesisUsed = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				answer = `${longestAnswer.text}\n\n(Note: automatic synthesis of ${candidates.length} expert answers failed — ${message}. Showing the most complete expert's raw answer instead.)`;
			}
		}
		return {
			taskId: input.taskId,
			answer,
			confidence,
			disagreement,
			clusteringMethod: clustered.method,
			embeddingQuality: clustered.quality,
			clusters: orderedClusters,
			synthesisUsed,
		};
	}
}
