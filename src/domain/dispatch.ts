import { z } from "zod";

import {
	DEFAULT_DECOMPOSITION_AGENT,
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
	role: z.string().trim().min(1),
	assignment: z.string().trim().min(1),
	description: z.string().trim().min(1).optional(),
});

const JOB_ID_MAX_LENGTH = 48;
const JOB_ID_MAX_WORDS = 6;
const FALLBACK_JOB_ID = "LegionDispatch";

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A short, human-readable PascalCase job id derived from the task text, so a
 * live escalation/IRC transcript reads "LegionAddACommentAtTheTop" instead of
 * the host's bare auto-incrementing "bg_1" — the id is otherwise meaningless
 * to a human watching the session. Falls back to "LegionDispatch" for task
 * text with no usable word characters (e.g. pure symbols/non-Latin script).
 */
export function humanReadableJobId(task: string): string {
	const words = task.match(/[a-zA-Z0-9]+/g)?.slice(0, JOB_ID_MAX_WORDS);
	if (!words || words.length === 0) return FALLBACK_JOB_ID;
	const pascal = words.map(capitalize).join("").slice(0, JOB_ID_MAX_LENGTH);
	return pascal ? `Legion${pascal}` : FALLBACK_JOB_ID;
}

export const dispatchRequestSchema = z.object({
	task: z.string().trim().min(1),
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
	readonly aborted?: boolean;
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
}

export interface DispatchAuditData {
	readonly results: readonly ExpertResult[];
	readonly syntheses: readonly SynthesisResult[];
	readonly governance: readonly GovernanceDecision[];
	readonly resolutions: readonly GovernanceResolution[];
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
export type AttemptIdFactory = (attemptIndex: number, taskId: string) => string;
/** Resolves a sub-task's role to the host agent name that should run it. */
export type AgentResolver = (role: string) => string;

function availableModels(
	policy: RoleModelPolicy | undefined,
	defaultModel: string | undefined,
	isAvailable: ModelAvailability,
): { models: string[]; strategy: DispatchStrategy; ensembleSize: number } {
	const candidates = policy?.models ?? (defaultModel ? [defaultModel] : []);
	const models = candidates.filter(isAvailable);
	if (models.length === 0) {
		const role = policy?.models.join(", ") || "the active session model";
		throw new Error(`No accessible model matched ${role}.`);
	}

	return {
		models,
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
 * persona for that role if one exists, else the safe host default. This is
 * the only place a sub-task's `agent` is decided — never trusted verbatim
 * from a caller or the LLM decomposer, both of which have no visibility into
 * which agent names are actually resolvable on this host.
 */
export function resolveAgentName(
	role: string,
	availableAgentNames: ReadonlySet<string>,
): string {
	const candidate = `${LEGION_AGENT_PREFIX}${role.trim().toLowerCase()}`;
	return availableAgentNames.has(candidate)
		? candidate
		: DEFAULT_DECOMPOSITION_AGENT;
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
		const selection = availableModels(policy, defaultModel, isAvailable);
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

		for (const [attemptOffset, model] of models.entries()) {
			attempts.push({
				id: makeAttemptId(attemptIndex, task.id),
				taskId: task.id,
				agent: resolveAgent(task.role),
				role: task.role,
				assignment: task.assignment,
				description: task.description,
				model,
				temperature: temperatures[attemptOffset],
				index: attemptIndex,
			});
			attemptIndex += 1;
		}
	}

	return { task: request.task, attempts, warnings };
}
