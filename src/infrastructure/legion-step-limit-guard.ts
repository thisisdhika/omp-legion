import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import { currentDispatchContext } from "./agent-execution-context";

/**
 * Block message for when an expert exceeds its configured maxSteps. Instructs
 * the model to respond with a text-only summary instead of continuing to call
 * tools — mirroring opencode.ai's actual behavior (force text-only response,
 * not an outright attempt failure), so the attempt still produces a usable
 * (if partial) result for synthesis rather than erroring out.
 */
const BLOCK_REASON =
	"This expert has exceeded its configured step limit. " +
	"Do not call any more tools. Instead, respond now with a text-only " +
	"summary of the work completed and any remaining tasks.";

/**
 * Increments the step counter on each tool_call and blocks further tool
 * access once the configured maxSteps is exceeded. Only acts on expert
 * attempts with a dispatch context where `senderKind === "expert"` and
 * `maxSteps` is set — primary/host/system calls and roles with no configured
 * limit are never touched.
 */
export function registerLegionStepLimitGuard(api: ExtensionAPI): void {
	api.on("tool_call", (_event) => {
		const context = currentDispatchContext();

		// Only enforce limits for known expert attempts with a configured max.
		if (context?.senderKind !== "expert") return;
		if (context.maxSteps === undefined) return;

		// Increment the step counter. This mutates the same object instance
		// that `currentDispatchContext()` returns — safe because each concurrent
		// attempt gets its own isolated DispatchContext via AsyncLocalStorage.
		context.stepCount = (context.stepCount ?? 0) + 1;

		// Once the limit is exceeded, block every subsequent tool call.
		if (context.stepCount > context.maxSteps) {
			return { block: true, reason: BLOCK_REASON };
		}

		return;
	});
}
