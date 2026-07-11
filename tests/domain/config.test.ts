import { describe, expect, test } from "bun:test";

import { mergeLegionConfig } from "../../src/domain/config";
import {
	DEFAULT_DISAGREEMENT_THRESHOLD,
	DEFAULT_EMBEDDING_SETTINGS,
	DEFAULT_ENSEMBLE_SIZE,
	DEFAULT_HOTL_THRESHOLDS,
} from "../../src/domain/constants";

describe("mergeLegionConfig", () => {
	test("fills omitted policy values from centralized defaults", () => {
		const config = mergeLegionConfig({
			modelMap: { reviewer: { models: ["provider/reviewer"] } },
			defaultEnsembleSize: 5,
			hotl: { confidenceFloor: 0.8 },
			embedding: { model: "custom-embed" },
		});

		expect(config).toMatchObject({
			defaultEnsembleSize: 5,
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
		});
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
