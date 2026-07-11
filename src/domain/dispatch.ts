import { z } from "zod";

import {
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_ENSEMBLE_SIZE,
	DISPATCH_STRATEGIES,
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
});

export const dispatchTaskSchema = z.object({
	id: z.string().trim().min(1),
	agent: z.string().trim().min(1),
	role: z.string().trim().min(1),
	assignment: z.string().trim().min(1),
	description: z.string().trim().min(1).optional(),
});

const SLUG_MAX_LENGTH = 40;
const SLUG_MAX_WORDS = 6;

/**
 * A short, human-readable job-id slug derived from the task text, so a live
 * escalation/IRC transcript reads "legion-add-formatdate-export" instead of
 * the host's bare auto-incrementing "bg_1" — the id is otherwise meaningless
 * to a human watching the session. Falls back to "legion-dispatch" for task
 * text with no usable word characters (e.g. pure symbols/non-Latin script).
 */
export function slugifyTaskId(task: string): string {
	const words = task
		.toLowerCase()
		.match(/[a-z0-9]+/g)
		?.slice(0, SLUG_MAX_WORDS);
	if (!words || words.length === 0) return "legion-dispatch";
	const slug = words.join("-").slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
	return slug ? `legion-${slug}` : "legion-dispatch";
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
}

export interface DispatchPlan {
	readonly task: string;
	readonly attempts: readonly DispatchAttempt[];
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

export function buildDispatchPlan(
	request: DispatchRequest,
	defaultModel: string | undefined,
	isAvailable: ModelAvailability,
	makeAttemptId: AttemptIdFactory,
): DispatchPlan {
	const attempts: DispatchAttempt[] = [];
	let attemptIndex = 0;
	const taskIds = new Set<string>();

	for (const task of request.tasks ?? []) {
		if (taskIds.has(task.id))
			throw new Error(`Duplicate dispatch task id "${task.id}".`);
		taskIds.add(task.id);
		const policy = request.modelMap[task.role];
		const selection = availableModels(policy, defaultModel, isAvailable);
		const ensembleSize = policy?.ensembleSize ?? request.defaultEnsembleSize;
		const models = modelsForAttempts({ ...selection, ensembleSize });

		for (const model of models) {
			attempts.push({
				id: makeAttemptId(attemptIndex, task.id),
				taskId: task.id,
				agent: task.agent,
				role: task.role,
				assignment: task.assignment,
				description: task.description,
				model,
				index: attemptIndex,
			});
			attemptIndex += 1;
		}
	}

	return { task: request.task, attempts };
}
