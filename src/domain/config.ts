import { z } from "zod";

import {
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_DISPATCH_STRATEGY,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
	DEFAULT_MAX_CONCURRENT_EXPERTS,
	DEFAULT_MODEL_MAP,
	DEFAULT_TEMPERATURE_LADDER,
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
	temperatureLadder: z.array(z.number().min(0).max(2)).min(1).optional(),
});
/**
 * The decomposer always runs exactly one model at a time — it is an
 * independent sequential policy, NOT the expert role map. It therefore
 * exposes only an ordered `models` list and an optional `temperatureLadder`;
 * `strategy`/`ensembleSize` are expert-only concepts that don't apply to a
 * single-model-at-a-time loop, so the input schema is `.strict()` to reject
 * them with a clear diagnostic rather than silently ignoring them.
 */
const decomposerInputSchema = z
	.object({
		// Allow inline `//` documentation comments (the project's config
		// convention) without silently swallowing real policy keys.
		"//": z.string().optional(),
		models: z.array(z.string().trim().min(1)).min(1),
		temperatureLadder: z.array(z.number().min(0).max(2)).min(1).optional(),
	})
	.strict();

/**
 * Resolved decomposer policy. `temperatureLadder` defaults to the shared
 * ladder so sequential attempts use focused -> balanced -> creative sampling
 * (see DEFAULT_TEMPERATURE_LADDER) unless the config overrides it.
 */
export const decomposerSchema = z.object({
	models: z.array(z.string().trim().min(1)).min(1),
	temperatureLadder: z
		.array(z.number().min(0).max(2))
		.min(1)
		.default([...DEFAULT_TEMPERATURE_LADDER]),
});
export type DecomposerPolicy = z.infer<typeof decomposerSchema>;
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
	decomposer: decomposerInputSchema.optional(),
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
	decomposer: decomposerSchema.optional(),
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
				// Previously dropped here even when present on the input (and,
				// before roleModelInputSchema declared this field at all, also
				// stripped by zod during input parsing) — a role's configured
				// temperatureLadder never reached the attempts that needed it,
				// silently falling back to DEFAULT_TEMPERATURE_LADDER instead.
				temperatureLadder: policy.temperatureLadder,
			},
		]),
	);
	const decomposer = raw.decomposer
		? decomposerSchema.parse({
				models: raw.decomposer.models,
				temperatureLadder: raw.decomposer.temperatureLadder,
			})
		: undefined;
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
		decomposer,
	});
}

/**
 * Precedence layers for Legion configuration resolution.
 *
 * Order matters: each later layer deep-merges over the earlier ones, so the
 * effective precedence (lowest -> highest) is:
 *   global -> project -> pluginOverride -> request
 * Nested objects (modelMap, hotl, embedding, decomposer) merge by field so a
 * partial override composes with unrelated config instead of replacing it.
 *
 * Note on sources: the host's third-party-plugin config surface is
 * `getPluginSettings` (project `.omp/plugin-overrides.json` over the global
 * plugin lock). Arbitrary `config.legion` keys in `config.yml` are not
 * exposed through a stable host API, so they are NOT read here; the
 * plugin-override layer carries whatever the host delivered (which already
 * composes global + project plugin overrides with project winning).
 */
export interface LegionConfigLayers {
	readonly global?: unknown;
	readonly project?: unknown;
	readonly pluginOverride?: unknown;
	readonly request?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value)) return false;
	return true;
}

/**
 * Deep-merge `override` over `base`. Plain objects recurse field-by-field;
 * arrays and scalars replace. `undefined` entries are dropped so a partial
 * override doesn't clobber an existing value with `undefined` (mirrors
 * `withoutUndefined` in mergeLegionConfig).
 */
function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (!isPlainObject(base) || !isPlainObject(override)) return override;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		result[key] = deepMerge(base[key], value);
	}
	return result;
}

/**
 * Resolve Legion configuration from ordered precedence layers with deep field
 * merges, then validate and fill defaults. Throws a clear Zod diagnostic on
 * invalid values (e.g. a decomposer policy carrying `strategy`/`ensembleSize`).
 */
export function resolveLegionConfig(layers: LegionConfigLayers): LegionConfig {
	const ordered = [
		layers.global,
		layers.project,
		layers.pluginOverride,
		layers.request,
	].filter((layer) => layer != null);
	const merged = ordered.reduce<Record<string, unknown>>(
		(acc, layer) => deepMerge(acc, layer) as Record<string, unknown>,
		{},
	);
	return mergeLegionConfig(merged);
}
