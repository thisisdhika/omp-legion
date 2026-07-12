import { describe, expect, test } from "bun:test";

import {
	mergeLegionConfig,
	resolveLegionConfig,
} from "../../src/domain/config";
import {
	DEFAULT_DISAGREEMENT_THRESHOLD,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
	DEFAULT_MAX_CONCURRENT_EXPERTS,
	DEFAULT_TEMPERATURE_LADDER,
} from "../../src/domain/constants";

describe("mergeLegionConfig", () => {
	test("fills omitted policy values from centralized defaults", () => {
		const config = mergeLegionConfig({
			modelMap: { reviewer: { models: ["provider/reviewer"] } },
			defaultEnsembleSize: 5,
			hotl: { confidenceFloor: 0.8 },
			embedding: { model: "custom-embed" },
			maxConcurrentExperts: 8,
		});

		expect(config).toMatchObject({
			defaultEnsembleSize: 5,
			maxConcurrentExperts: 8,
			modelMap: {
				reviewer: {
					models: ["provider/reviewer"],
					strategy: "self-consistency",
					ensembleSize: 5,
				},
			},
			hotl: {
				confidenceFloor: 0.8,
				disagreementThreshold: DEFAULT_DISAGREEMENT_THRESHOLD,
				costCeiling: DEFAULT_HOTL_THRESHOLDS.costCeiling,
			},
			embedding: {
				baseUrl: DEFAULT_EMBEDDING_SETTINGS.baseUrl,
				model: "custom-embed",
			},
		});
	});

	test("uses centralized defaults for an empty project config", () => {
		const config = mergeLegionConfig({});

		expect(config).toMatchObject({
			modelMap: {},
			defaultEnsembleSize: DEFAULT_ENSEMBLE_SIZE,
			hotl: DEFAULT_HOTL_THRESHOLDS,
			embedding: DEFAULT_EMBEDDING_SETTINGS,
			maxConcurrentExperts: DEFAULT_MAX_CONCURRENT_EXPERTS,
		});
		// Off by default: no execution-grounded verification without explicit opt-in.
		expect(config.verifyCommand).toBeUndefined();
	});

	test("passes through an explicitly configured verifyCommand", () => {
		const config = mergeLegionConfig({ verifyCommand: "bun test" });

		expect(config.verifyCommand).toBe("bun test");
	});

	test("falls back to defaults when a caller supplies present-but-undefined fields", () => {
		// This is the exact shape parseLegionPluginSettings (host-config.ts)
		// builds when a plugin-overrides file omits `hotl`/`embedding` entirely:
		// `{ ...{}, baseUrl: settings[key] ?? undefined, model: settings[key] ?? undefined }`
		// — keys that are present with an `undefined` value, not absent. A plain
		// object spread over that shape would silently overwrite the defaults
		// with `undefined` and fail required-string validation.
		const config = mergeLegionConfig({
			hotl: {
				confidenceFloor: undefined,
				disagreementThreshold: undefined,
				costCeiling: undefined,
			},
			embedding: { baseUrl: undefined, apiKey: undefined, model: undefined },
		});

		expect(config).toMatchObject({
			hotl: DEFAULT_HOTL_THRESHOLDS,
			embedding: DEFAULT_EMBEDDING_SETTINGS,
		});
	});
});

describe("legion.decomposer config", () => {
	test("accepts a decomposer policy with only an ordered models list", () => {
		const config = mergeLegionConfig({
			decomposer: { models: ["provider/a", "provider/b"] },
		});
		expect(config.decomposer).toEqual({
			models: ["provider/a", "provider/b"],
			temperatureLadder: [...DEFAULT_TEMPERATURE_LADDER],
		});
	});

	test("rejects a decomposer policy carrying strategy", () => {
		expect(() =>
			mergeLegionConfig({
				decomposer: { models: ["provider/a"], strategy: "diverse" },
			}),
		).toThrow(/strategy/i);
	});

	test("rejects a decomposer policy carrying ensembleSize", () => {
		expect(() =>
			mergeLegionConfig({
				decomposer: { models: ["provider/a"], ensembleSize: 3 },
			}),
		).toThrow(/ensembleSize/i);
	});

	test("requires at least one model in the decomposer policy", () => {
		expect(() => mergeLegionConfig({ decomposer: { models: [] } })).toThrow();
	});
});

describe("resolveLegionConfig precedence", () => {
	test("deep-merges nested fields so siblings are preserved across layers", () => {
		const config = resolveLegionConfig({
			global: { hotl: { confidenceFloor: 0.5 }, decomposer: { models: ["a"] } },
			project: { hotl: { costCeiling: 100 }, decomposer: { models: ["b"] } },
		});
		// Both nested hotl siblings survive; project's decomposer models win.
		expect(config.hotl).toMatchObject({
			confidenceFloor: 0.5,
			costCeiling: 100,
		});
		expect(config.decomposer?.models).toEqual(["b"]);
	});

	test("per-request overrides plugin override without clobbering siblings", () => {
		const config = resolveLegionConfig({
			pluginOverride: {
				defaultEnsembleSize: 5,
				hotl: { confidenceFloor: 0.8 },
			},
			request: {
				defaultEnsembleSize: 9,
				hotl: { costCeiling: 50 },
			},
		});
		expect(config.defaultEnsembleSize).toBe(9);
		expect(config.hotl).toMatchObject({
			confidenceFloor: 0.8,
			costCeiling: 50,
		});
	});

	test("merges modelMap per role rather than replacing the whole map", () => {
		const config = resolveLegionConfig({
			global: { modelMap: { reviewer: { models: ["p/x"], ensembleSize: 2 } } },
			project: { modelMap: { reviewer: { models: ["p/y"] } } },
		});
		expect(config.modelMap.reviewer).toMatchObject({
			models: ["p/y"],
			ensembleSize: 2,
		});
	});

	test("global -> project -> pluginOverride -> request precedence order", () => {
		const config = resolveLegionConfig({
			global: { defaultEnsembleSize: 1 },
			project: { defaultEnsembleSize: 2 },
			pluginOverride: { defaultEnsembleSize: 3 },
			request: { defaultEnsembleSize: 4 },
		});
		expect(config.defaultEnsembleSize).toBe(4);
	});

	test("invalid decomposer config produces a clear diagnostic", () => {
		expect(() =>
			resolveLegionConfig({
				request: {
					decomposer: { models: ["p/a"], strategy: "self-consistency" },
				},
			}),
		).toThrow(/strategy/i);
	});
});

describe("documented config.example.json", () => {
	test("parses the example, including the decomposer policy", async () => {
		const raw = await Bun.file(
			new URL("../../config.example.json", import.meta.url),
		).text();
		const example = JSON.parse(raw) as {
			settings: { "omp-legion": unknown };
		};
		const config = mergeLegionConfig(example.settings["omp-legion"]);
		expect(config.decomposer).toMatchObject({
			models: ["anthropic/claude-fable-5", "openai-codex/gpt-5.6-luna"],
			temperatureLadder: [0.2, 0.6, 1.0],
		});
	});
});
