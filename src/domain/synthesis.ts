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
		const majority = clustered.clusters[0];
		if (!majority)
			throw new Error(`Task ${input.taskId} has no answer cluster.`);
		const answerCount = clustered.clusters.reduce(
			(total, cluster) => total + cluster.size,
			0,
		);
		const confidence = majority.size / answerCount;
		const disagreement = 1 - confidence;
		const candidates = answerCandidates(input.experts);
		const firstAnswer = candidates[0];
		if (!firstAnswer) throw new Error(`Task ${input.taskId} has no answer.`);

		const shouldAggregate = candidates.length > 1 || Boolean(input.humanNote);
		const answer = shouldAggregate
			? await this.#aggregator.synthesize(
					{
						task: input.task,
						taskId: input.taskId,
						experts: input.experts,
						clusters: clustered.clusters,
						clusteringMethod: clustered.method,
						humanNote: input.humanNote,
					},
					input.signal,
				)
			: firstAnswer.text;
		return {
			taskId: input.taskId,
			answer,
			confidence,
			disagreement,
			clusteringMethod: clustered.method,
			embeddingQuality: clustered.quality,
			clusters: clustered.clusters,
			synthesisUsed: shouldAggregate,
		};
	}
}
