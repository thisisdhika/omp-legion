import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import { type LegionConfig, mergeLegionConfig } from "../domain/config";
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

export function parseLegionPluginSettings(
	settings: Record<string, unknown>,
): LegionConfig {
	const hotl = objectSetting(
		parseJsonSetting(
			settings[LEGION_SETTING_KEYS.hotl],
			LEGION_SETTING_KEYS.hotl,
		),
		LEGION_SETTING_KEYS.hotl,
	);
	const embedding = objectSetting(
		parseJsonSetting(
			settings[LEGION_SETTING_KEYS.embedding],
			LEGION_SETTING_KEYS.embedding,
		),
		LEGION_SETTING_KEYS.embedding,
	);
	return mergeLegionConfig({
		modelMap: parseJsonSetting(
			settings[LEGION_SETTING_KEYS.modelMap],
			LEGION_SETTING_KEYS.modelMap,
		),
		defaultEnsembleSize: settings[LEGION_SETTING_KEYS.defaultEnsembleSize],
		maxConcurrentExperts: settings[LEGION_SETTING_KEYS.maxConcurrentExperts],
		verifyCommand: settings[LEGION_SETTING_KEYS.verifyCommand],
		decisionTimeoutMs: settings[LEGION_SETTING_KEYS.decisionTimeoutMs],
		hotl: {
			...hotl,
			confidenceFloor:
				settings[LEGION_SETTING_KEYS.confidenceFloor] ?? hotl.confidenceFloor,
			disagreementThreshold:
				settings[LEGION_SETTING_KEYS.disagreementThreshold] ??
				hotl.disagreementThreshold,
			costCeiling:
				settings[LEGION_SETTING_KEYS.costCeiling] ?? hotl.costCeiling,
			failureRateCeiling:
				settings[LEGION_SETTING_KEYS.failureRateCeiling] ??
				hotl.failureRateCeiling,
		},
		embedding: {
			...embedding,
			baseUrl:
				settings[LEGION_SETTING_KEYS.embeddingBaseUrl] ?? embedding.baseUrl,
			apiKey: settings[LEGION_SETTING_KEYS.embeddingApiKey] ?? embedding.apiKey,
			model: settings[LEGION_SETTING_KEYS.embeddingModel] ?? embedding.model,
		},
	});
}

export async function loadLegionConfig(cwd: string): Promise<LegionConfig> {
	const settings = await getPluginSettings(LEGION_PLUGIN_NAME, cwd);
	return parseLegionPluginSettings(settings);
}
