import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "./application/dispatch-service";
import { loadDispatchAgents } from "./infrastructure/agent-loader";
import { loadLegionConfig } from "./infrastructure/host-config";
import { createHostDispatchService } from "./infrastructure/host-dispatch-service";
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
		service = createHostDispatchService(ctx, config, agents);
	});

	registerTaskToolGuard(api);
	api.registerTool(createDispatchTool(() => service));
}
