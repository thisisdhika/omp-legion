import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadLegionConfig,
	parseLegionPluginSettings,
} from "../../src/infrastructure/host-config";

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

	/**
	 * The host's getPluginSettings does `{ ...global, ...project }` before
	 * Legion ever sees a settings object — project always wins per top-level
	 * key. These tests simulate that merge directly (rather than mocking the
	 * host's lockfile/overrides file loaders) to verify both of Legion's two
	 * supported authoring styles behave as documented once merged.
	 */
	describe("simulated project-over-global precedence (host's {...global, ...project})", () => {
		test("flat dotted keys override independently, per-field, without clobbering siblings", () => {
			const global = {
				"hotl.confidenceFloor": 0.5,
				"hotl.disagreementThreshold": 0.6,
				"hotl.costCeiling": 100_000,
			};
			const project = {
				// Only overrides one field...
				"hotl.confidenceFloor": 0.9,
			};
			const merged = { ...global, ...project };

			const config = parseLegionPluginSettings(merged);

			expect(config.hotl).toMatchObject({
				confidenceFloor: 0.9, // project wins
				disagreementThreshold: 0.6, // ...but global's sibling fields survive
				costCeiling: 100_000, // — because each is its own top-level settings key.
			});
		});

		test("a nested hotl object from project replaces global's nested object wholesale", () => {
			// The real gotcha: authoring hotl as ONE nested JSON object (rather
			// than flat "hotl.*" keys) means project's partial object clobbers
			// every sibling field global had set — the merge is shallow at the
			// settings-object level, not a deep merge of nested objects.
			const global = {
				hotl: JSON.stringify({
					confidenceFloor: 0.5,
					disagreementThreshold: 0.6,
					costCeiling: 100_000,
					failureRateCeiling: 0.4,
				}),
			};
			const project = {
				hotl: JSON.stringify({ confidenceFloor: 0.9 }),
			};
			const merged = { ...global, ...project };

			const config = parseLegionPluginSettings(merged);

			// disagreementThreshold/costCeiling/failureRateCeiling are NOT
			// global's values here -- they fall all the way through to Legion's
			// own built-in defaults, since project's nested object replaced
			// global's entirely and neither the flat keys nor Legion have any
			// visibility into what global's hotl object used to contain.
			expect(config.hotl.confidenceFloor).toBe(0.9);
			expect(config.hotl.disagreementThreshold).not.toBe(0.6);
		});

		test("a flat dotted key from project wins over a nested object field from global", () => {
			const global = {
				hotl: JSON.stringify({ confidenceFloor: 0.5, costCeiling: 100_000 }),
			};
			const project = {
				"hotl.confidenceFloor": 0.9,
			};
			const merged = { ...global, ...project };

			const config = parseLegionPluginSettings(merged);

			expect(config.hotl.confidenceFloor).toBe(0.9);
			// global's nested object still supplies costCeiling here, since
			// project never set the "hotl" key at all -- only the flat
			// "hotl.confidenceFloor" key, which parseLegionPluginSettings prefers
			// over the same field inside the nested object (settings[flatKey] ??
			// hotl.confidenceFloor).
			expect(config.hotl.costCeiling).toBe(100_000);
		});
	});
});

describe("decomposer policy parsing", () => {
	test("parses a nested decomposer object", () => {
		const config = parseLegionPluginSettings({
			decomposer: JSON.stringify({
				models: ["anthropic/claude-fable-5"],
				temperatureLadder: [0.3],
			}),
		});
		expect(config.decomposer).toMatchObject({
			models: ["anthropic/claude-fable-5"],
			temperatureLadder: [0.3],
		});
	});

	test("parses flat dotted decomposer keys", () => {
		const config = parseLegionPluginSettings({
			"decomposer.models": JSON.stringify(["openai/gpt", "anthropic/claude"]),
		});
		expect(config.decomposer?.models).toEqual([
			"openai/gpt",
			"anthropic/claude",
		]);
	});

	test("decomposer is absent when no explicit models are set (legacy fallback)", () => {
		const config = parseLegionPluginSettings({});
		expect(config.decomposer).toBeUndefined();
	});
});

describe("loadLegionConfig source precedence", () => {
	test("deep-merges global and project config.legion YAML layers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "legion-project-"));
		const home = mkdtempSync(join(tmpdir(), "legion-home-"));
		try {
			mkdirSync(join(home, ".omp", "agent"), { recursive: true });
			mkdirSync(join(cwd, ".omp"), { recursive: true });
			writeFileSync(
				join(home, ".omp", "agent", "config.yml"),
				"config:\n  legion:\n    hotl:\n      confidenceFloor: 0.4\n      costCeiling: 100\n    modelMap:\n      reviewer:\n        models: [global-model]\n        ensembleSize: 2\n",
			);
			writeFileSync(
				join(cwd, ".omp", "config.yml"),
				"config:\n  legion:\n    hotl:\n      confidenceFloor: 0.9\n    modelMap:\n      reviewer:\n        strategy: diverse\n",
			);

			const config = await loadLegionConfig(cwd, join(home, ".omp", "agent"));

			expect(config.hotl.confidenceFloor).toBe(0.9);
			expect(config.hotl.costCeiling).toBe(100);
			expect(config.modelMap.reviewer).toMatchObject({
				models: ["global-model"],
				strategy: "diverse",
				ensembleSize: 2,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
