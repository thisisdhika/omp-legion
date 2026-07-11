import { z } from "zod";

import {
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
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

const hotlThresholdInputSchema = z.object({
	confidenceFloor: z.number().min(0).max(1).optional(),
	disagreementThreshold: z.number().min(0).max(1).optional(),
	costCeiling: z.number().nonnegative().optional(),
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
			...raw.hotl,
		},
		defaultEnsembleSize,
		embedding: {
			...DEFAULT_EMBEDDING_SETTINGS,
			...raw.embedding,
		},
	});
}
