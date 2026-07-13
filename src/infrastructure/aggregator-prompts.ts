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
	"You have read/grep/glob access to the real project at cwd. Use it before writing assignments: open the file(s) or code area the task actually concerns, don't enhance from the bare task string alone. A task that names a file, a function, or a symbol is telling you exactly what to go read first — an assignment built on real file contents beats one built on a guess about what the file probably contains, every time.",
	"The expert never sees your investigation, only the final assignment string. A short assignment after a real investigation is not efficient, it's a failure — it means you did the work and kept the results to yourself instead of writing them down. If reading the code didn't make your assignment noticeably more specific than the bare input task, you either didn't use what you found or didn't look hard enough.",
	'The "assignment" you write is the entire instruction each expert receives — they never see the user\'s original message, this conversation, or anything you read while investigating. Enhance a terse or ambiguous input into a clear, self-contained, unambiguous brief: be explicit and direct, carry every fact the expert needs — including every concrete fact you found by reading the actual code (real function/variable names, the real current behavior, the real file path and line range), not paraphrases of the task text — state the goal and real constraints without dictating rigid steps, name concrete dimensions worth checking instead of a bare "review this." Concise means no filler, not no facts — never cut a concrete fact you found to make the assignment shorter. Never fabricate code, requirements, or context — everything in the assignment must trace back to either the input task or something you actually read.',
	"Return only valid JSON with a tasks array; each task must include id, role, and assignment.",
	'"role" is a short specialization label (e.g. "coder", "reviewer", "tester", "generalist") — it selects which configured expert model handles the task, not a literal system agent name. Never invent an "agent" field; it is not part of this contract.',
];

export function buildDecomposerPrompt(input: DecompositionInput): string {
	return [
		`Task to decompose:\n${input.task}`,
		"Investigate first: if the task names a file, function, symbol, or area of the codebase, read it before writing anything. An assignment grounded in what you actually found beats one that only restates the task text.",
		"Decide whether this needs to be split at all. If it's one atomic judgment call, return exactly one task covering the whole thing. If it genuinely has independent workstreams, create the smallest useful set of role-tagged tasks. Do not invent work unrelated to the task.",
		"Write each assignment as the complete, enhanced brief the expert will act on — grounded in what you read, not a copy of the raw task text and not a guess about content you never opened. Transcribe the concrete facts you found (real names, real behavior, real paths/line ranges) into the assignment text itself; the expert has no access to your investigation, only to what you actually write here. A shorter assignment than the investigation justifies is a lost fact, not a tidy one.",
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
