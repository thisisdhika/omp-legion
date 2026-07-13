import { z } from "zod";
import type { DecomposerAuditEvent } from "./decomposition";

import {
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_TEMPERATURE_LADDER,
	DISPATCH_STRATEGIES,
	LEGION_AGENT_PREFIX,
	MAX_ENSEMBLE_SIZE,
	MIN_ENSEMBLE_SIZE,
} from "./constants";
import type { GovernanceDecision, GovernanceResolution } from "./governance";
import type { SynthesisResult } from "./synthesis";

const modelSelectorSchema = z.string().trim().min(1);

export const dispatchStrategySchema = z.enum(DISPATCH_STRATEGIES);

export const roleModelPolicySchema = z.object({
	models: z.array(modelSelectorSchema).min(1),
	strategy: dispatchStrategySchema.optional(),
	ensembleSize: z
		.number()
		.int()
		.min(MIN_ENSEMBLE_SIZE)
		.max(MAX_ENSEMBLE_SIZE)
		.optional(),
	/**
	 * Overrides the default self-consistency temperature ladder (see
	 * temperatureForAttempts) for this role. Cycled by attempt index, same as
	 * the model list for "diverse" strategy. Ignored for "diverse" strategy
	 * unless explicitly set — model diversity already provides decorrelation
	 * there, so temperature stays at provider default unless asked for.
	 */
	temperatureLadder: z.array(z.number().min(0).max(2)).min(1).optional(),
	/**
	 * Whether attempts for this role run in an isolated git worktree.
	 * Undefined means true (today's default, unchanged behavior). Isolation
	 * exists to let parallel file-editing attempts land independent diffs
	 * without colliding — a read-only role (never calls `edit`/`write`) has
	 * no such collision to guard against, and paying worktree setup/teardown
	 * cost for it is pure overhead. Set false only for roles that never
	 * write files; the executor does not itself verify read-only-ness, so a
	 * write-capable role set to false can silently write into the primary
	 * working tree instead of an isolated one.
	 */
	worktree: z.boolean().optional(),
});

export const dispatchTaskSchema = z.object({
	id: z.string().trim().min(1),
	// Never read: the actual dispatched agent is always resolved from `role`
	// (see resolveAgentName below), never trusted from the caller or the LLM
	// decomposer. Kept optional and unused rather than required, so a caller
	// that omits it (as models routinely do, having no reason to know it's
	// vestigial) doesn't hit a schema validation error over a field with no
	// effect on dispatch.
	agent: z.string().trim().min(1).optional(),
	role: z
		.string()
		.trim()
		.min(1)
		.describe(
			'Bare available legion persona name, such as "reviewer" or "coder"; do not capitalize or prefix with "legion-". Invalid roles reject the dispatch.',
		),
	assignment: z
		.string()
		.trim()
		.describe(
			"The complete, self-contained instruction this expert actually receives and acts on — not a short label. The expert receives task as secondary background context in their system prompt, but it is not the primary instruction; if the real content (file contents, constraints, what to focus on) only lives in task, the expert will not have it as their main directive. Put everything the expert needs to do the work here.",
		),
	description: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Short display label for HUD/logs only; it is display only, not the expert's instruction and does not affect execution.",
		),
});

// Kept short deliberately: this slug becomes the prefix of every attempt id
// for the whole dispatch (see makeAttemptId in dispatch-service.ts's
// #buildPlan), so "a few words to recognize which dispatch this is" beats
// "most of the task text" — the latter made every subagent name in the
// "Subagents" HUD list a near-duplicate wall of text.
const JOB_ID_MAX_LENGTH = 24;
const JOB_ID_MAX_WORDS = 3;
const FALLBACK_JOB_ID = "legion-dispatch";

/**
 * A short, human-readable slug id derived from the task text, so a live
 * escalation/IRC transcript reads "legion-add-a-comment" instead of the
 * host's bare auto-incrementing "bg_1" — the id is otherwise meaningless to
 * a human watching the session. Hyphenated rather than PascalCase-mashed
 * (the original "LegionAddACommentAtTheTop" shape): reading as a slug/id,
 * not a second sentence, matters more here than reading as prose — this
 * value sits right next to the actual task text elsewhere in the UI (see
 * dispatch-card's "Task" section) and mashed-together words made the two
 * hard to tell apart at a glance. Falls back to "legion-dispatch" for task
 * text with no usable word characters (e.g. pure symbols/non-Latin script).
 */
export function humanReadableJobId(task: string): string {
	const words = task.match(/[a-zA-Z0-9]+/g)?.slice(0, JOB_ID_MAX_WORDS);
	if (!words || words.length === 0) return FALLBACK_JOB_ID;
	const slug = words.join("-").toLowerCase().slice(0, JOB_ID_MAX_LENGTH);
	return slug ? `legion-${slug}` : FALLBACK_JOB_ID;
}

/** Strips the "legion-" persona prefix for compact ids — the surrounding id already reads as Legion's (it's prefixed with the job slug), so repeating "legion-" per attempt is just noise. Non-legion fallback agents (e.g. the host's "task") pass through unchanged. */
export function shortAgentName(agent: string): string {
	return agent.startsWith(LEGION_AGENT_PREFIX)
		? agent.slice(LEGION_AGENT_PREFIX.length)
		: agent;
}

/** Last path segment of a model selector ("openrouter/tencent/hy3:free" -> "hy3:free") — enough to tell attempts apart in an id without the full provider/org routing prefix. */
export function shortModelName(model: string): string {
	const lastSlash = model.lastIndexOf("/");
	return lastSlash === -1 ? model : model.slice(lastSlash + 1);
}

export const dispatchRequestSchema = z.object({
	task: z
		.string()
		.trim()
		.min(1)
		.describe(
			"The whole dispatch's own description — used as the auto-decompose input when `tasks` is omitted, and as secondary background context for every task when `tasks` is supplied explicitly (rendered into each expert's system prompt, not as its primary instruction). When supplying explicit `tasks`, don't put the real per-task content only here and leave `assignment` thin — each task's `assignment` is what the expert actually acts on.",
		),
	tasks: z.array(dispatchTaskSchema).min(1).optional(),
	modelMap: z.record(z.string(), roleModelPolicySchema).default({}),
	defaultEnsembleSize: z
		.number()
		.int()
		.min(MIN_ENSEMBLE_SIZE)
		.max(MAX_ENSEMBLE_SIZE)
		.default(DEFAULT_ENSEMBLE_SIZE),
});

export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;
export type DispatchTask = z.infer<typeof dispatchTaskSchema>;
export type RoleModelPolicy = z.infer<typeof roleModelPolicySchema>;
export type DispatchStrategy = z.infer<typeof dispatchStrategySchema>;

export interface DispatchAttempt {
	readonly id: string;
	readonly taskId: string;
	readonly agent: string;
	readonly role: string;
	readonly assignment: string;
	readonly description?: string;
	readonly model: string;
	readonly index: number;
	/**
	 * Undefined means "use the provider's own default" — never force a value.
	 * Self-consistency samples get a real ladder (see temperatureForAttempts)
	 * so N identical-model attempts have deliberate, not incidental, sampling
	 * diversity — previously the whole point of self-consistency (genuinely
	 * varied samples of the same model) rode entirely on whatever the
	 * provider happened to default to.
	 */
	readonly temperature?: number;
	/** Ordered candidate model selectors for this role (the role's `models` policy, filtered to those resolvable at plan time). Enables runtime fallback / adaptive expansion to advance to the next unattempted selector. */
	readonly candidates?: readonly string[];
	/** Position of `model` within `candidates`. Always 0 for self-consistency (one strongest model); the model index for diverse. */
	readonly candidateIndex?: number;
	/** This role's dispatch strategy, used to choose adaptive-expansion replacements (diverse → next model; self-consistency → next temperature). */
	readonly strategy?: DispatchStrategy;
	/** This role's configured temperature ladder (undefined for diverse unless explicitly set); used by self-consistency expansion. */
	readonly temperatureLadder?: readonly number[];
	/** This role's `worktree` policy (see roleModelPolicySchema). Undefined means true — isolated by default. */
	readonly worktree?: boolean;
}

export interface DispatchPlan {
	readonly task: string;
	readonly attempts: readonly DispatchAttempt[];
	/** Non-fatal config smells worth surfacing to a human, e.g. an ambiguous self-consistency model order. See buildDispatchPlan. */
	readonly warnings: readonly string[];
}

export interface DispatchRecord {
	readonly id: string;
	readonly task: string;
	readonly state: "running" | "completed" | "failed";
	readonly createdAt: number;
	readonly completedAt?: number;
	readonly attempts: readonly DispatchAttempt[];
	readonly results?: readonly ExpertResult[];
	readonly syntheses?: readonly SynthesisResult[];
	readonly governance?: readonly GovernanceDecision[];
	readonly resolutions?: readonly GovernanceResolution[];
	readonly error?: string;
	readonly decomposerAttempts?: readonly DecomposerAuditEvent[];
}

export interface ExpertResult {
	readonly attemptId: string;
	readonly taskId: string;
	readonly agent: string;
	readonly role: string;
	readonly model: string;
	readonly index: number;
	readonly output: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly tokens: number;
	readonly requests: number;
	readonly error?: string;
	/** The temperature the attempt was run with (carried for audit/observability; absent when the executor doesn't report it). */
	readonly temperature?: number;
	readonly aborted?: boolean;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets classifyFailure treat this as authoritative instead of guessing via regex.
	 */
	readonly retryFailure?: {
		readonly attempt: number;
		readonly errorMessage: string;
	};
	/**
	 * Set only when this attempt ran inside host isolation (branch mode) and
	 * actually produced a commit — the not-yet-merged branch holding this
	 * attempt's file changes, isolated from every sibling attempt's own copy
	 * of the repo. Absent for read-only attempts (no changes to commit) and
	 * for failed/aborted attempts.
	 */
	readonly branchName?: string;
	/** Baseline commit SHA `branchName` was created from; required to merge it. */
	readonly baseSha?: string;
	/**
	 * Set only when a project verify command (`verifyCommand` config) actually
	 * ran against this attempt's isolated branch — true/false is a real
	 * execution result, not a text-similarity guess. Undefined when no verify
	 * command is configured, or this attempt produced no branch to check
	 * (read-only roles, or a failed/aborted attempt).
	 */
	readonly verified?: boolean;
	/** When this attempt was a runtime fallback or adaptive expansion replacement, the model selector it replaced. Absent for planned attempts. */
	readonly replacedModel?: string;
	/** Why this attempt was scheduled: a retryable-failure class (e.g. "quota/rate-limit") for fallback, or "adaptive expansion". Absent for planned attempts. */
	readonly replacementReason?: string;
}

export interface DispatchAuditData {
	readonly results: readonly ExpertResult[];
	readonly syntheses: readonly SynthesisResult[];
	readonly governance: readonly GovernanceDecision[];
	readonly resolutions: readonly GovernanceResolution[];
	readonly decomposerAttempts?: readonly DecomposerAuditEvent[];
}

export interface OrchestrationRepository {
	create(record: DispatchRecord): void;
	complete(
		id: string,
		results: readonly ExpertResult[],
		syntheses: readonly SynthesisResult[],
		governance: readonly GovernanceDecision[],
		completedAt: number,
		resolutions?: readonly GovernanceResolution[],
		decomposerAttempts?: readonly DecomposerAuditEvent[],
	): void;
	fail(
		id: string,
		error: string,
		completedAt: number,
		audit?: DispatchAuditData,
	): void;
	get(id: string): DispatchRecord | undefined;
}

export type ModelAvailability = (selector: string) => boolean;
export type AttemptIdFactory = (
	attemptIndex: number,
	taskId: string,
	agent: string,
	model: string,
) => string;
/** Resolves a sub-task's role to the legion-* persona that should run it, or undefined when no such persona is loaded (see resolveAgentName — buildDispatchPlan rejects the task in that case). */
export type AgentResolver = (role: string) => string | undefined;

function availableModels(
	role: string,
	policy: RoleModelPolicy | undefined,
	defaultModel: string | undefined,
	isAvailable: ModelAvailability,
): {
	models: string[];
	candidates: string[];
	strategy: DispatchStrategy;
	ensembleSize: number;
} {
	const candidates = policy?.models ?? (defaultModel ? [defaultModel] : []);
	const models = candidates.filter(isAvailable);
	if (models.length === 0) {
		if (!policy) {
			throw new Error(
				`No modelMap policy configured for role "${role}" and its fallback ` +
					`(the active session model${defaultModel ? ` "${defaultModel}"` : ""}) ` +
					`is unavailable. Add a modelMap.${role} entry to config.yml, or ` +
					"restart the session if you just added one (config loads once at session start).",
			);
		}
		throw new Error(
			`No accessible model matched role "${role}" — tried: ${candidates.join(", ")}.`,
		);
	}

	return {
		models,
		candidates,
		strategy: policy?.strategy ?? DEFAULT_DISPATCH_STRATEGY,
		ensembleSize: policy?.ensembleSize ?? DEFAULT_ENSEMBLE_SIZE,
	};
}

/**
 * Neither ambiguity below is fatal — dispatch still proceeds — but both are
 * silent, easy-to-miss config mistakes worth surfacing to a human rather
 * than leaving as an undocumented assumption about array order.
 */
function selectionWarning(
	role: string,
	selection: { models: string[]; strategy: DispatchStrategy },
	ensembleSize: number,
): string | undefined {
	if (
		selection.strategy === DEFAULT_DISPATCH_STRATEGY &&
		selection.models.length > 1
	) {
		return `Role "${role}" is configured for self-consistency with multiple models (${selection.models.join(", ")}) — only the first, "${selection.models[0]}", is ever sampled. List your strongest model first, or use strategy "diverse" if you meant to spread across all of them.`;
	}
	if (
		selection.strategy === "diverse" &&
		ensembleSize < selection.models.length
	) {
		const unreachable = selection.models.slice(ensembleSize);
		return `Role "${role}" is configured for diverse sampling across ${selection.models.length} models, but ensembleSize ${ensembleSize} only ever reaches the first ${ensembleSize} (${selection.models.slice(0, ensembleSize).join(", ")}). Configured but unreachable at this ensemble size: ${unreachable.join(", ")}.`;
	}
	return undefined;
}

function modelsForAttempts(selection: {
	models: string[];
	strategy: DispatchStrategy;
	ensembleSize: number;
}): string[] {
	const [strongest] = selection.models;
	if (!strongest) throw new Error("Model selection produced no model.");
	if (selection.strategy === DEFAULT_DISPATCH_STRATEGY)
		return Array(selection.ensembleSize).fill(strongest);
	return Array.from({ length: selection.ensembleSize }, (_, index) => {
		const model = selection.models[index % selection.models.length];
		if (!model) throw new Error("Model selection produced no model.");
		return model;
	});
}

/**
 * Undefined entries mean "leave temperature at the provider's own default."
 * Self-consistency gets a real ladder (a configured `temperatureLadder`, or
 * DEFAULT_TEMPERATURE_LADDER) cycled by attempt index — deliberate sampling
 * diversity across N identical-model attempts. "Diverse" strategy leaves
 * temperature alone unless a ladder was explicitly configured, since model
 * diversity already provides decorrelation there.
 */
function temperatureForAttempts(
	strategy: DispatchStrategy,
	ensembleSize: number,
	ladder: readonly number[] | undefined,
): (number | undefined)[] {
	if (
		strategy !== DEFAULT_DISPATCH_STRATEGY &&
		(!ladder || ladder.length === 0)
	)
		return Array(ensembleSize).fill(undefined);
	const activeLadder =
		ladder && ladder.length > 0 ? ladder : DEFAULT_TEMPERATURE_LADDER;
	return Array.from(
		{ length: ensembleSize },
		(_, index) => activeLadder[index % activeLadder.length],
	);
}

/**
 * Given the set of Legion agent names actually loaded (bundled + any
 * project/user override), resolve a role to the LEGION_AGENT_PREFIX-prefixed
 * persona for that role if one exists. This is the only place a sub-task's
 * `agent` is decided — never trusted verbatim from a caller or the LLM
 * decomposer, both of which have no visibility into which agent names are
 * actually resolvable on this host.
 *
 * Returns undefined (never falls back to a non-legion agent) when no
 * matching persona is loaded — legion_dispatch's whole value is the
 * governed ensemble (HOTL, synthesis, audit trail) around a legion-*
 * persona; silently substituting some other agent underneath a caller who
 * asked for a specific role isn't a safe default, it's a surprise. The
 * caller should dispatch that task with the native `task` tool instead (see
 * buildDispatchPlan, which turns this into that exact rejection message).
 */
export function resolveAgentName(
	role: string,
	availableAgentNames: ReadonlySet<string>,
): string | undefined {
	const candidate = `${LEGION_AGENT_PREFIX}${role.trim().toLowerCase()}`;
	return availableAgentNames.has(candidate) ? candidate : undefined;
}
/**
 * Classifies an expert attempt result for runtime model fallback. A
 * "retryable" provider failure (quota, rate limit, unavailable model,
 * timeout, overloaded backend) warrants consuming the next candidate
 * selector; any other non-zero exit is a task/validation error that must be
 * preserved, not retried. Aborted attempts are neither — cancellation is
 * handled separately by the caller.
 */
export type FailureClass = "ok" | "retryable" | "fatal";

// ponytail: fixed #5 — /quota/i removed; host treats quota as non-retryable (credential rotation)
// ponytail: fixed #6 — transport errors added
const RETRYABLE_FAILURE_PATTERNS: readonly RegExp[] = [
	/\b429\b/i,
	/\b50[234]\b/i,
	/\b529\b/i,
	/rate[\s_-]?limit(?:ed)?/i,
	/too many requests/i,
	/unavailable/i,
	/not (?:available|found)/i,
	/timed?\s?out/i,
	/timeout/i,
	/overload(?:ed)?/i,
	/capacity/i,
	// Transport-level transient errors
	/fetch failed/i,
	/ECONNRESET/i,
	/ECONNREFUSED/i,
	/ENOTFOUND/i,
	/ETIMEDOUT/i,
	/network/i,
	/DNS/i,
];

export function classifyFailure(result: ExpertResult): FailureClass {
	if (result.aborted) return "fatal";
	if (result.exitCode === 0 && !result.error) return "ok";
	// ponytail: fixed #11 — retryFailure from host is authoritative
	if (result.retryFailure) return "retryable";
	const message = result.error ?? "";
	if (RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message)))
		return "retryable";
	return "fatal";
}

/** Stable identity for a (model, temperature) selector, used to avoid retrying a selector already attempted for a task. */
export function selectorKey(attempt: {
	readonly model: string;
	readonly temperature?: number;
	readonly strategy?: DispatchStrategy;
}): string {
	const strategy = attempt.strategy ?? DEFAULT_DISPATCH_STRATEGY;
	if (strategy !== DEFAULT_DISPATCH_STRATEGY) return attempt.model;
	return `${attempt.model}@${attempt.temperature ?? "default"}`;
}

export interface ReplacementSpec {
	readonly model: string;
	readonly temperature?: number;
	readonly candidateIndex: number;
}

export interface NextReplacementParams {
	readonly strategy: DispatchStrategy;
	readonly candidates: readonly string[];
	readonly temperatureLadder?: readonly number[];
	readonly attemptedSelectors: ReadonlySet<string>;
	readonly selfConsistencyCount: number;
}

// ponytail: fixed #12 — availability re-check documented
/**
 * Picks the next unattempted selector for runtime fallback or adaptive
 * expansion. For "diverse", advances to the next model in `candidates` not yet
 * attempted; for "self-consistency", repeats the strongest model with the next
 * temperature-ladder value. Returns undefined when every selector has already
 * been attempted (candidate exhaustion) — callers must then preserve the
 * failure rather than loop.
 *
 * NOTE on availability: `candidates` is NOT re-filtered for isAvailable here.
 * This is intentional — transient unavailability may resolve by the time the
 * fallback runs, and the cost is merely one attempt that will fail fast if the
 * provider is still unavailable. Callers that need a stronger guarantee should
 * check `expansionHeadroom` before calling, or validate at the point of dispatch.
 */
export function nextReplacement(
	params: NextReplacementParams,
): ReplacementSpec | undefined {
	const {
		strategy,
		candidates,
		temperatureLadder,
		attemptedSelectors,
		selfConsistencyCount,
	} = params;
	// ponytail: fixed #12 — candidates NOT re-checked for isAvailable (see doc above)
	if (strategy === DEFAULT_DISPATCH_STRATEGY) {
		const ladder =
			temperatureLadder && temperatureLadder.length > 0
				? temperatureLadder
				: DEFAULT_TEMPERATURE_LADDER;
		const strongest = candidates[0];
		if (strongest === undefined) return undefined;
		const temperature = ladder[selfConsistencyCount % ladder.length];
		if (attemptedSelectors.has(`${strongest}@${temperature}`)) return undefined;
		return { model: strongest, candidateIndex: 0, temperature };
	}
	for (let index = 0; index < candidates.length; index++) {
		const model = candidates[index];
		if (model !== undefined && !attemptedSelectors.has(model)) {
			const temperature =
				temperatureLadder && temperatureLadder.length > 0
					? temperatureLadder[index % temperatureLadder.length]
					: undefined;
			return { model, candidateIndex: index, temperature };
		}
	}
	return undefined;
}
/**
 * Checks whether adaptive expansion has headroom beyond an initial ensemble.
 * For "self-consistency", returns true when the temperature ladder has more
 * rungs than the initial ensemble consumes. For "diverse", returns true when
 * there are more candidate models than ensembleSize.
 *
 * Callers should check this before calling `nextReplacement` to surface a
 * warning when expansion is silently unavailable under default config
 * (e.g. ensemble 3 + ladder [0.2, 0.6, 1.0] for self-consistency exhausts
 * every selector in the initial plan).
 *
 * ponytail: fixed #13 — expansion headroom helper
 */
export function expansionHeadroom(
	strategy: DispatchStrategy,
	candidates: readonly string[],
	temperatureLadder: readonly number[] | undefined,
	ensembleSize: number,
): boolean {
	if (candidates.length === 0) return false;
	if (strategy === DEFAULT_DISPATCH_STRATEGY) {
		const ladder =
			temperatureLadder && temperatureLadder.length > 0
				? temperatureLadder
				: DEFAULT_TEMPERATURE_LADDER;
		return ladder.length > ensembleSize;
	}
	return candidates.length > ensembleSize;
}

export function buildDispatchPlan(
	request: DispatchRequest,
	defaultModel: string | undefined,
	isAvailable: ModelAvailability,
	makeAttemptId: AttemptIdFactory,
	resolveAgent: AgentResolver,
): DispatchPlan {
	const attempts: DispatchAttempt[] = [];
	let attemptIndex = 0;
	const taskIds = new Set<string>();
	const warnedRoles = new Set<string>();
	const warnings: string[] = [];

	for (const task of request.tasks ?? []) {
		if (taskIds.has(task.id))
			throw new Error(`Duplicate dispatch task id "${task.id}".`);
		taskIds.add(task.id);
		const policy = request.modelMap[task.role];
		const selection = availableModels(
			task.role,
			policy,
			defaultModel,
			isAvailable,
		);
		const ensembleSize = policy?.ensembleSize ?? request.defaultEnsembleSize;
		const models = modelsForAttempts({ ...selection, ensembleSize });
		const temperatures = temperatureForAttempts(
			selection.strategy,
			ensembleSize,
			policy?.temperatureLadder,
		);

		if (!warnedRoles.has(task.role)) {
			const warning = selectionWarning(task.role, selection, ensembleSize);
			if (warning) {
				warnedRoles.add(task.role);
				warnings.push(warning);
			}
		}

		const agent = resolveAgent(task.role);
		if (!agent) {
			throw new Error(
				`Legion has no "${LEGION_AGENT_PREFIX}${task.role.trim().toLowerCase()}" persona for role "${task.role}" (task "${task.id}"); dispatch this task with the native \`task\` tool instead.`,
			);
		}
		for (const [attemptOffset, model] of models.entries()) {
			attempts.push({
				id: makeAttemptId(attemptIndex, task.id, agent, model),
				taskId: task.id,
				agent,
				role: task.role,
				assignment: task.assignment,
				description: task.description,
				model,
				temperature: temperatures[attemptOffset],
				index: attemptIndex,
				candidates: selection.candidates,
				candidateIndex:
					selection.strategy === DEFAULT_DISPATCH_STRATEGY ? 0 : attemptOffset,
				strategy: selection.strategy,
				temperatureLadder: policy?.temperatureLadder,
				worktree: policy?.worktree,
			});
			attemptIndex += 1;
		}
	}

	return { task: request.task, attempts, warnings };
}
