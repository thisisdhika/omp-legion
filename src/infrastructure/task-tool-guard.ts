import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { z } from "zod";

import { isLegionAgentName } from "./agent-loader";

/**
 * Blocks the native `task` tool from spawning a `legion-*` persona directly.
 * Legion's HOTL governance, synthesis, and audit trail only apply on the
 * legion_dispatch path — a native `task` call reaching a legion-* agent
 * would run that persona with none of it, defeating the whole point of the
 * naming boundary. Mirrors the halo-agent/native-task guard from the
 * predecessor project, minus its extra machinery (OTel, audit sink, config) —
 * Legion has no config knob for this because there's no legitimate reason to
 * want it off: legion-* personas exist only to be governed.
 *
 * Only calls that actually target a legion-* agent are blocked; every other
 * native `task` call (task, explore, or any of the user's own agents) passes
 * through untouched.
 */
const TASK_TOOL_NAME = "task";

const BLOCK_REASON =
	"legion-* agents must be dispatched via legion_dispatch, not the native task tool.";

const taskToolInputSchema = z
	.object({
		agent: z.string().optional(),
		tasks: z.array(z.object({ agent: z.string().optional() })).optional(),
	})
	.passthrough();

export function targetsLegionAgent(input: unknown): boolean {
	const parsed = taskToolInputSchema.safeParse(input);
	if (!parsed.success) return false;
	const { agent, tasks } = parsed.data;
	if (agent && isLegionAgentName(agent)) return true;
	return (tasks ?? []).some((t) => t.agent && isLegionAgentName(t.agent));
}

export function registerTaskToolGuard(api: ExtensionAPI): void {
	api.on("tool_call", (event) => {
		if (event.toolName !== TASK_TOOL_NAME) return;
		if (targetsLegionAgent(event.input)) {
			return { block: true, reason: BLOCK_REASON };
		}
		return;
	});
}
