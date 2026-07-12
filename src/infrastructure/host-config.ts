import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { YAML } from "bun";

import {
	type LegionConfig,
	mergeLegionConfig,
	resolveLegionConfig,
} from "../domain/config";
import { LEGION_PLUGIN_NAME, LEGION_SETTING_KEYS } from "../domain/constants";

function parseJsonSetting(value: unknown, key: string): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Legion ${key} JSON: ${message}`);
	}
}

function objectSetting(value: unknown, key: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value === "object" && value !== null && !Array.isArray(value))
		return value as Record<string, unknown>;
	throw new Error(`Legion ${key} must be an object or JSON object string.`);
}

function pluginSettingsLayer(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const hotl = objectSetting(
		parseJsonSetting(
			settings[LEGION_SETTING_KEYS.hotl],
			LEGION_SETTING_KEYS.hotl,
		),
		LEGION_SETTING_KEYS.hotl,
	);
	const hotlLayer = {
		...hotl,
		...(settings[LEGION_SETTING_KEYS.confidenceFloor] !== undefined
			? {
					confidenceFloor: settings[LEGION_SETTING_KEYS.confidenceFloor],
				}
			: {}),
		...(settings[LEGION_SETTING_KEYS.disagreementThreshold] !== undefined
			? {
					disagreementThreshold:
						settings[LEGION_SETTING_KEYS.disagreementThreshold],
				}
			: {}),
		...(settings[LEGION_SETTING_KEYS.costCeiling] !== undefined
			? { costCeiling: settings[LEGION_SETTING_KEYS.costCeiling] }
			: {}),
		...(settings[LEGION_SETTING_KEYS.failureRateCeiling] !== undefined
			? {
					failureRateCeiling: settings[LEGION_SETTING_KEYS.failureRateCeiling],
				}
			: {}),
	};
	const embedding = objectSetting(
		parseJsonSetting(
			settings[LEGION_SETTING_KEYS.embedding],
			LEGION_SETTING_KEYS.embedding,
		),
		LEGION_SETTING_KEYS.embedding,
	);
	const embeddingLayer = {
		...embedding,
		...(settings[LEGION_SETTING_KEYS.embeddingBaseUrl] !== undefined
			? { baseUrl: settings[LEGION_SETTING_KEYS.embeddingBaseUrl] }
			: {}),
		...(settings[LEGION_SETTING_KEYS.embeddingApiKey] !== undefined
			? { apiKey: settings[LEGION_SETTING_KEYS.embeddingApiKey] }
			: {}),
		...(settings[LEGION_SETTING_KEYS.embeddingModel] !== undefined
			? { model: settings[LEGION_SETTING_KEYS.embeddingModel] }
			: {}),
	};
	const layer: Record<string, unknown> = {};
	const modelMap = parseJsonSetting(
		settings[LEGION_SETTING_KEYS.modelMap],
		LEGION_SETTING_KEYS.modelMap,
	);
	if (modelMap !== undefined) layer.modelMap = modelMap;
	if (Object.keys(hotlLayer).length > 0) layer.hotl = hotlLayer;
	if (Object.keys(embeddingLayer).length > 0) layer.embedding = embeddingLayer;
	for (const [key, value] of [
		["defaultEnsembleSize", settings[LEGION_SETTING_KEYS.defaultEnsembleSize]],
		[
			"maxConcurrentExperts",
			settings[LEGION_SETTING_KEYS.maxConcurrentExperts],
		],
		["verifyCommand", settings[LEGION_SETTING_KEYS.verifyCommand]],
		["decisionTimeoutMs", settings[LEGION_SETTING_KEYS.decisionTimeoutMs]],
	] as const) {
		if (value !== undefined) layer[key] = value;
	}
	const decomposer = parseDecomposerOverride(settings);
	if (decomposer !== undefined) layer.decomposer = decomposer;
	return layer;
}

export function parseLegionPluginSettings(
	settings: Record<string, unknown>,
): LegionConfig {
	return mergeLegionConfig(pluginSettingsLayer(settings));
}

/**
 * Reads the decomposer policy from plugin settings. Supports both a nested
 * `decomposer` object and the flat dotted keys `decomposer.models` /
 * `decomposer.temperatureLadder` (matching the host's dotted-key convention),
 * each a JSON string or a real object. Returns `undefined` when no explicit
 * ordered `models` list is present, so the decomposer falls back to the
 * active session model. A `strategy`/`ensembleSize` here is intentionally
 * rejected downstream by the strict decomposer input schema.
 */
function parseDecomposerOverride(settings: Record<string, unknown>): unknown {
	const nested = objectSetting(
		parseJsonSetting(
			settings[LEGION_SETTING_KEYS.decomposer],
			LEGION_SETTING_KEYS.decomposer,
		),
		LEGION_SETTING_KEYS.decomposer,
	);
	const models = parseJsonSetting(
		settings[LEGION_SETTING_KEYS.decomposerModels],
		LEGION_SETTING_KEYS.decomposerModels,
	);
	const temperatureLadder = parseJsonSetting(
		settings[LEGION_SETTING_KEYS.decomposerTemperatureLadder],
		LEGION_SETTING_KEYS.decomposerTemperatureLadder,
	);
	const merged: Record<string, unknown> = {
		...nested,
		...(models !== undefined ? { models } : {}),
		...(temperatureLadder !== undefined ? { temperatureLadder } : {}),
	};
	return Array.isArray(merged.models) && merged.models.length > 0
		? merged
		: undefined;
}

function extractLegionLayer(parsed: unknown): unknown {
	if (typeof parsed !== "object" || parsed === null) return {};
	const root = parsed as Record<string, unknown>;
	const config = root.config;
	if (typeof config === "object" && config !== null) {
		const legion = (config as Record<string, unknown>).legion;
		if (legion !== undefined) return legion;
	}
	return root.legion ?? {};
}

async function loadConfigFileLayer(
	directory: string,
	level: string,
): Promise<unknown> {
	for (const filename of ["config.yml", "config.yaml"]) {
		const path = join(directory, filename);
		const file = Bun.file(path);
		if (!(await file.exists())) continue;
		try {
			return extractLegionLayer(YAML.parse(await file.text()));
		} catch (error) {
			console.warn(
				`Legion ${level} config invalid; ignoring ${path}. ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return {};
		}
	}
	return {};
}

export async function loadLegionConfig(
	cwd: string,
	agentDir?: string,
): Promise<LegionConfig> {
	try {
		const dir = agentDir ?? getAgentDir();
		const [settings, global, project] = await Promise.all([
			getPluginSettings(LEGION_PLUGIN_NAME, cwd),
			loadConfigFileLayer(dir, "global"),
			loadConfigFileLayer(join(cwd, ".omp"), "project"),
		]);
		return resolveLegionConfig({
			global,
			project,
			pluginOverride: pluginSettingsLayer(settings),
		});
	} catch (error) {
		console.warn(
			`Legion configuration invalid; falling back to defaults. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return mergeLegionConfig({});
	}
}
