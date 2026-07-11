import { describe, expect, test } from "bun:test";

import { parseLegionPluginSettings } from "../../src/infrastructure/host-config";

describe("parseLegionPluginSettings", () => {
	test("loads nested project settings and JSON modelMap values", () => {
		const config = parseLegionPluginSettings({
			modelMap: JSON.stringify({
				reviewer: {
					models: ["security", "general"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			}),
			"hotl.confidenceFloor": 0.7,
			"hotl.disagreementThreshold": 0.35,
			"hotl.costCeiling": 500,
			"embed.baseUrl": "http://localhost:11434",
			"embed.apiKey": "secret",
			"embed.model": "custom-embed",
		});

		expect(config).toMatchObject({
			modelMap: {
				reviewer: {
					models: ["security", "general"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
			hotl: {
				confidenceFloor: 0.7,
				disagreementThreshold: 0.35,
				costCeiling: 500,
			},
			embedding: {
				baseUrl: "http://localhost:11434",
				apiKey: "secret",
				model: "custom-embed",
			},
		});
	});
});
