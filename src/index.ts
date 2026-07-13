import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "./application/dispatch-service";
import { mergeLegionConfig } from "./domain/config";
import type { AgentDefinition } from "./infrastructure/agent-loader";
import { loadAgentDefinitions } from "./infrastructure/agent-loader";
import { registerGitCommitGuard } from "./infrastructure/git-commit-guard";
import { loadLegionConfig } from "./infrastructure/host-config";
import { createHostDispatchService } from "./infrastructure/host-dispatch-service";
import { registerIrcToolGuard } from "./infrastructure/irc-tool-guard";
import { registerLegionMetaRiskGuard } from "./infrastructure/legion-meta-risk-guard";
import { loadSubagentRules } from "./infrastructure/rule-loader";
import { registerTaskToolGuard } from "./infrastructure/task-tool-guard";
import { createDispatchTool } from "./presentation/dispatch-tool";

const SESSION_START_LOADER_TIMEOUT_MS = 10_000;

async function loadWithTimeout<T>(
	label: string,
	load: () => Promise<T>,
	fallback: T,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			timer = setTimeout(() => {
				console.warn(
					`Legion ${label} loading exceeded ${SESSION_START_LOADER_TIMEOUT_MS}ms; continuing with fallback.`,
				);
				resolve(fallback);
			}, SESSION_START_LOADER_TIMEOUT_MS);
			load().then(resolve, reject);
		});
	} catch (error) {
		console.warn(
			`Legion ${label} loading failed; continuing with fallback. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

export default function legionExtension(api: ExtensionAPI): void {
	let service: DispatchService | undefined;

	api.on("session_start", async (_event, ctx) => {
		service = undefined;
		const [config, agents, subagentRules] = await Promise.all([
			loadWithTimeout(
				"configuration",
				() => loadLegionConfig(ctx.cwd),
				mergeLegionConfig({}),
			),
			loadWithTimeout(
				"agent definitions",
				() => loadAgentDefinitions(ctx.cwd),
				new Map<string, AgentDefinition>(),
			),
			loadWithTimeout("subagent rules", () => loadSubagentRules(ctx.cwd), []),
		]);
		// api.events is only reachable here, at registration time —
		// ExtensionContext (ctx) does not expose it. Threading it into the
		// executor is what makes Legion's spawns appear in the interactive
		// "Subagents" HUD, which listens for TASK_SUBAGENT_LIFECYCLE/PROGRESS
		// events that runSubprocess only emits when given an event bus.
		service = createHostDispatchService(
			ctx,
			config,
			agents,
			api.events,
			subagentRules,
		);
	});

	registerTaskToolGuard(api);
	registerIrcToolGuard(api);
	registerGitCommitGuard(api);
	registerLegionMetaRiskGuard(api);
	api.registerTool(createDispatchTool(() => service));
}
