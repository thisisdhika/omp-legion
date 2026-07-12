import { z } from "zod";

import {
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
	DEFAULT_MAX_CONCURRENT_EXPERTS,
	DEFAULT_MODEL_MAP,
	MAX_ENSEMBLE_SIZE,
	MIN_ENSEMBLE_SIZE,
} from "./constants";
import {
	type RoleModelPolicy,
	dispatchStrategySchema,
	roleModelPolicySchema,
} from "./dispatch";
const roleModelInputSchema = z.object({
	models: z.array(z.string().trim().min(1)).min(1),
	strategy: dispatchStrategySchema.optional(),
	ensembleSize: z
		.number()
		.int()
		.min(MIN_ENSEMBLE_SIZE)
		.max(MAX_ENSEMBLE_SIZE)
		.optional(),
});
type RoleModelConfigInput = z.infer<typeof roleModelInputSchema>;

/**
 * Zod's `.default()` only fires when a key is absent, not when it's present
 * with an explicit `undefined` value — an object spread of a partial input
 * (e.g. `{ ...raw.embedding, baseUrl: settings[...] ?? raw.embedding.baseUrl }`)
 * produces exactly that: real keys holding `undefined`. Stripping them before
 * merging with defaults restores the "missing key falls back to default"
 * behavior the config surface is documented to have.
 */
function withoutUndefined<T extends Record<string, unknown>>(
	value: T | undefined,
): Partial<T> {
	if (!value) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
	) as Partial<T>;
}

const hotlThresholdInputSchema = z.object({
	confidenceFloor: z.number().min(0).max(1).optional(),
	disagreementThreshold: z.number().min(0).max(1).optional(),
	costCeiling: z.number().nonnegative().optional(),
	failureRateCeiling: z.number().min(0).max(1).optional(),
});

const embeddingInputSchema = z.object({
	baseUrl: z.string().url().optional(),
	apiKey: z.string().trim().min(1).optional(),
	model: z.string().trim().min(1).optional(),
});

const legionConfigInputSchema = z.object({
	modelMap: z.record(z.string(), roleModelInputSchema).optional(),
	hotl: hotlThresholdInputSchema.optional(),
	defaultEnsembleSize: z
		.number()
		.int()
		.min(MIN_ENSEMBLE_SIZE)
		.max(MAX_ENSEMBLE_SIZE)
		.optional(),
	embedding: embeddingInputSchema.optional(),
	maxConcurrentExperts: z.number().int().min(1).optional(),
	verifyCommand: z.string().trim().min(1).optional(),
	decisionTimeoutMs: z.number().int().min(1).optional(),
});

export const legionConfigSchema = z.object({
	modelMap: z
		.record(z.string(), roleModelPolicySchema)
		.default(DEFAULT_MODEL_MAP),
	hotl: z
		.object({
			confidenceFloor: z.number().min(0).max(1),
			disagreementThreshold: z.number().min(0).max(1),
			costCeiling: z.number().nonnegative(),
			failureRateCeiling: z.number().min(0).max(1),
		})
		.default(DEFAULT_HOTL_THRESHOLDS),
	defaultEnsembleSize: z
		.number()
		.int()
		.min(MIN_ENSEMBLE_SIZE)
		.max(MAX_ENSEMBLE_SIZE)
		.default(DEFAULT_ENSEMBLE_SIZE),
	embedding: z
		.object({
			baseUrl: z.string().url(),
			apiKey: z.string().trim().min(1).optional(),
			model: z.string().trim().min(1),
		})
		.default(DEFAULT_EMBEDDING_SETTINGS),
	maxConcurrentExperts: z
		.number()
		.int()
		.min(1)
		.default(DEFAULT_MAX_CONCURRENT_EXPERTS),
	/**
	 * Off by default: execution-grounded verification (running this command
	 * against each code-mutating attempt's isolated branch) only runs when a
	 * project explicitly opts in. Unset means Legion never executes anything
	 * beyond what an expert attempt itself ran.
	 */
	verifyCommand: z.string().trim().min(1).optional(),
	/** How long a HOTL escalation waits for a human before auto-resolving to reject. Never waits forever. */
	decisionTimeoutMs: z
		.number()
		.int()
		.min(1)
		.default(DEFAULT_DECISION_TIMEOUT_MS),
});

export type LegionConfig = z.infer<typeof legionConfigSchema>;

export function mergeLegionConfig(input: unknown): LegionConfig {
	const raw = legionConfigInputSchema.parse(input ?? {});
	const defaultEnsembleSize = raw.defaultEnsembleSize ?? DEFAULT_ENSEMBLE_SIZE;
	const modelMapInput = (raw.modelMap ?? DEFAULT_MODEL_MAP) as Record<
		string,
		RoleModelConfigInput
	>;
	const modelMap: Record<string, RoleModelPolicy> = Object.fromEntries(
		Object.entries(modelMapInput).map(([role, policy]) => [
			role,
			{
				models: policy.models,
				strategy: policy.strategy ?? DEFAULT_DISPATCH_STRATEGY,
				ensembleSize: policy.ensembleSize ?? defaultEnsembleSize,
			},
		]),
	);
	return legionConfigSchema.parse({
		modelMap,
		hotl: {
			...DEFAULT_HOTL_THRESHOLDS,
			...withoutUndefined(raw.hotl),
		},
		defaultEnsembleSize,
		embedding: {
			...DEFAULT_EMBEDDING_SETTINGS,
			...withoutUndefined(raw.embedding),
		},
		maxConcurrentExperts:
			raw.maxConcurrentExperts ?? DEFAULT_MAX_CONCURRENT_EXPERTS,
		verifyCommand: raw.verifyCommand,
		decisionTimeoutMs: raw.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
	});
}
