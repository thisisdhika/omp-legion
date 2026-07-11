import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "./application/dispatch-service";
import { loadLegionConfig } from "./infrastructure/host-config";
import { createHostDispatchService } from "./infrastructure/host-dispatch-service";
import { createDispatchTool } from "./presentation/dispatch-tool";

export default function legionExtension(api: ExtensionAPI): void {
	let service: DispatchService | undefined;

	api.on("session_start", async (_event, ctx) => {
		service = undefined;
		const config = await loadLegionConfig(ctx.cwd);
		service = createHostDispatchService(ctx, config);
	});

	api.registerTool(createDispatchTool(() => service));
}
