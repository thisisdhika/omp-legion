import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "./application/dispatch-service";
import { loadDispatchAgents } from "./infrastructure/agent-loader";
import { loadLegionConfig } from "./infrastructure/host-config";
import { createHostDispatchService } from "./infrastructure/host-dispatch-service";
import { registerIrcToolGuard } from "./infrastructure/irc-tool-guard";
import { registerTaskToolGuard } from "./infrastructure/task-tool-guard";
import { createDispatchTool } from "./presentation/dispatch-tool";

export default function legionExtension(api: ExtensionAPI): void {
	let service: DispatchService | undefined;

	api.on("session_start", async (_event, ctx) => {
		service = undefined;
		const [config, agents] = await Promise.all([
			loadLegionConfig(ctx.cwd),
			loadDispatchAgents(ctx.cwd),
		]);
		// api.events is only reachable here, at registration time —
		// ExtensionContext (ctx) does not expose it. Threading it into the
		// executor is what makes Legion's spawns appear in the interactive
		// "Subagents" HUD, which listens for TASK_SUBAGENT_LIFECYCLE/PROGRESS
		// events that runSubprocess only emits when given an event bus.
		service = createHostDispatchService(ctx, config, agents, api.events);
	});

	registerTaskToolGuard(api);
	registerIrcToolGuard(api);
	api.registerTool(createDispatchTool(() => service));
}
