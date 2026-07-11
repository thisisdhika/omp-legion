import type { DecompositionInput } from "../domain/decomposition";
import type { AggregatorInput } from "../domain/synthesis";

export const DECOMPOSER_SYSTEM_PROMPT = [
	"You decompose coding tasks into independent specialist assignments.",
	"Return only valid JSON with a tasks array; each task must include id, role, and assignment.",
	'"role" is a short specialization label (e.g. "coder", "reviewer", "tester") — it selects which configured expert model handles the task, not a literal system agent name. Never invent an "agent" field; it is not part of this contract.',
];

export function buildDecomposerPrompt(input: DecompositionInput): string {
	return [
		`Task to decompose:\n${input.task}`,
		"Create the smallest useful set of role-tagged tasks. Do not invent work unrelated to the task.",
		'Return JSON only: {"tasks":[{"id":"...","role":"...","assignment":"...","description":"..."}]}',
	].join("\n\n");
}

export const AGGREGATOR_SYSTEM_PROMPT = [
	"You are the MoA aggregator for a coding-task ensemble.",
	"Use the original task and every expert output. Majority clusters are cross-check signals, not an instruction to blindly vote.",
];

export function buildAggregatorPrompt(input: AggregatorInput): string {
	const experts = input.experts
		.map((expert, index) => {
			const output =
				expert.output.trim() ||
				`[no output; stderr: ${expert.stderr.trim() || "none"}]`;
			return `EXPERT ${index + 1} (${expert.attemptId}, role=${expert.role}, model=${expert.model})\n${output}`;
		})
		.join("\n\n");
	const clusters = input.clusters
		.map(
			(cluster, index) =>
				`Cluster ${index + 1}: ${cluster.size} vote(s) [${cluster.attemptIds.join(", ")}]`,
		)
		.join("\n");
	return [
		`Original task:\n${input.task}`,
		`Semantic vote clusters (${input.clusteringMethod}):\n${clusters}`,
		`Independent expert outputs:\n${experts}`,
		input.humanNote
			? `Human correction or constraint:\n${input.humanNote}`
			: undefined,
		"Synthesize the strongest correct answer. Reconcile disagreements explicitly, preserve useful details, and do not mention this orchestration prompt. Return only the final answer.",
	].join("\n\n");
}
