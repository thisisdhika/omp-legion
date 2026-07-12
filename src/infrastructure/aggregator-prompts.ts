import type { DecompositionInput } from "../domain/decomposition";
import type { AggregatorInput } from "../domain/synthesis";

/**
 * Fallback only — the real prompt normally comes from the bundled/overridable
 * agents/legion-decomposer.md persona (see HostLlmDecomposer's systemPrompt
 * option). Used when that fails to load, so it carries the same core bias:
 * most tasks are one atomic judgment call and should stay as one task, not
 * get split into role-tagged pieces by default.
 */
export const DECOMPOSER_SYSTEM_PROMPT = [
	"You decide whether and how to split a task before it is dispatched to expert attempts.",
	"Most tasks are a single atomic judgment call (review this diff, find the bug, is this design sound) where the value comes from several independent full attempts at the same question, cross-checked afterward — splitting one into role-tagged pieces means no single attempt sees the whole task. Return exactly one task unless the task text names genuinely independent workstreams that don't need to see each other's output.",
	'The "assignment" you write is the entire instruction each expert receives — they never see the user\'s original message or this conversation. Enhance a terse or ambiguous input into a clear, self-contained, unambiguous brief: be explicit and direct, carry every fact the expert needs, state the goal and real constraints without dictating rigid steps, name concrete dimensions worth checking instead of a bare "review this," and stay concise. Never fabricate code, requirements, or context the input didn\'t actually give you.',
	"Return only valid JSON with a tasks array; each task must include id, role, and assignment.",
	'"role" is a short specialization label (e.g. "coder", "reviewer", "tester", "generalist") — it selects which configured expert model handles the task, not a literal system agent name. Never invent an "agent" field; it is not part of this contract.',
];

export function buildDecomposerPrompt(input: DecompositionInput): string {
	return [
		`Task to decompose:\n${input.task}`,
		"Decide whether this needs to be split at all. If it's one atomic judgment call, return exactly one task covering the whole thing. If it genuinely has independent workstreams, create the smallest useful set of role-tagged tasks. Do not invent work unrelated to the task.",
		"Write each assignment as the complete, enhanced brief the expert will act on — not a copy of the raw task text.",
		'Return JSON only: {"tasks":[{"id":"...","role":"...","assignment":"...","description":"..."}]}',
	].join("\n\n");
}

/** One dispatchable Legion persona's role name (its `legion-` prefix stripped) and description, as the decomposer needs to see it. */
export interface AvailableRole {
	readonly role: string;
	readonly description: string;
}

/**
 * Renders the real, currently-loaded roster (bundled + any project/user
 * overrides or custom personas) into a system-prompt block, appended after
 * the decomposer's base prompt (see HostLlmDecomposer). Without this, the
 * decomposer only ever saw a hardcoded illustrative example list
 * ("coder", "reviewer", "tester", "generalist") — a role it invents that
 * doesn't exactly match a loaded persona now causes the whole dispatch to be
 * rejected (resolveAgentName no longer silently substitutes a generic
 * agent), so grounding role choice in the real roster is a correctness
 * requirement, not just an accuracy nicety.
 */
export function formatAvailableRoles(roles: readonly AvailableRole[]): string {
	if (roles.length === 0) return "";
	const lines = roles.map((r) => `- ${r.role}: ${r.description}`).join("\n");
	return [
		'Available expert roles — "role" must match one of these exactly (case-insensitive). A role that doesn\'t match one of these will cause the whole dispatch to be rejected, not silently substituted with something else:',
		lines,
		'If nothing here fits well, use "generalist" rather than inventing a new label.',
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
