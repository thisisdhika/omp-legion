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
	"You have read/grep/glob access to the real project at cwd, but use it narrowly: only to resolve what the task actually refers to (confirm a named file/symbol is real and get its exact path/name right), never to analyze the code's behavior or pre-identify what's wrong with it. Every expert you'd dispatch to already has the same read/grep/glob/lsp tools and will read the code itself, independently — a decomposer that pre-analyzes doesn't help the expert, it correlates every expert's blind spots to your one read of the code and does the expert's job for it twice, un-decorrelated. Stop at 'this is what the task means'; never reach 'this is what's wrong with it.'",
	"The \"assignment\" you write is the entire instruction each expert receives — they never see the user's original message, this conversation, or anything you read while resolving the reference. Enhance a terse or ambiguous input into a clear, self-contained brief: be explicit and direct, carry the real resolved file/symbol reference and any constraint the user stated, and stay silent on *how* to analyze it — never prescribe the dimensions to check, a checklist, or a report structure; the target persona's own system prompt already covers what its role cares about, and re-stating or narrowing that here is redundant at best and homogenizing at worst. Never fabricate code, requirements, or context — everything in the assignment must trace back to either the input task or a fact you confirmed while resolving the reference.",
	"Return only valid JSON with a tasks array; each task must include id, role, and assignment.",
	'"role" is a short specialization label (e.g. "coder", "reviewer", "tester", "generalist") — it selects which configured expert model handles the task, not a literal system agent name. Never invent an "agent" field; it is not part of this contract.',
];

export function buildDecomposerPrompt(input: DecompositionInput): string {
	return [
		`Task to decompose:\n${input.task}`,
		"If the task names a file, function, or symbol, confirm it's real and get its exact path/name before writing anything — don't dispatch an ensemble at a typo or a file that doesn't exist. That's the only reason to read anything here; do not read further to analyze behavior or spot issues, the expert will do that itself.",
		"Decide whether this needs to be split at all. If it's one atomic judgment call, return exactly one task covering the whole thing. If it genuinely has independent workstreams, create the smallest useful set of role-tagged tasks. Do not invent work unrelated to the task.",
		"Write each assignment as the complete, enhanced brief the expert will act on — the real resolved reference and the user's actual ask, not a copy of the raw task text and not an analysis of what you found. Say what the task is about; leave how to think about it to the expert.",
		'Return JSON only, as your final message: {"tasks":[{"id":"...","role":"...","assignment":"...","description":"..."}]}',
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
