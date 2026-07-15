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
 *
 * Uses a two-phase guard for defense-in-depth against same-turn parallel
 * tool call batches:
 *
 * 1. **Pre-turn cap**: if `stepCount >= maxSteps` already (reached in a
 *    previous turn or session), block immediately without incrementing.
 *    This catches parallel calls within a single assistant turn: the first
 *    call's handler increments stepCount, and subsequent calls in the same
 *    batch see `stepCount >= maxSteps` at the pre-check and are blocked
 *    before any actual tool executes.
 *
 * 2. **Post-increment check**: after incrementing, if the new count exceeds
 *    maxSteps, block. This is the original guard and serves as a belt-
 *    and-suspenders fallback: it catches the first call that pushes the
 *    counter over the limit and covers any execution path that bypassed the
 *    pre-check.
 *
 * The two-phase design ensures the guarantee "at most `maxSteps` tool calls
 * execute per expert attempt" regardless of whether the host dispatches
 * tool calls sequentially or batches them in parallel from a single
 * assistant turn.
 */
export function registerLegionStepLimitGuard(api: ExtensionAPI): void {
	api.on("tool_call", (_event) => {
		const context = currentDispatchContext();

		// Only enforce limits for known expert attempts with a configured max.
		if (context?.senderKind !== "expert") return;
		if (context.maxSteps === undefined) return;

		// Phase 1: pre-turn cap. If the counter already meets or exceeds the
		// limit (from a previous turn or from another call in this same parallel
		// batch), block before incrementing. This ensures that within a batch of
		// concurrent tool calls, the 2nd+ call in the same turn hits a hard stop
		// rather than relying solely on microtask ordering of the increment.
		if ((context.stepCount ?? 0) >= context.maxSteps) {
			return { block: true, reason: BLOCK_REASON };
		}

		// Increment the step counter. This mutates the same object instance
		// that `currentDispatchContext()` returns — safe because each concurrent
		// attempt gets its own isolated DispatchContext via AsyncLocalStorage.
		context.stepCount = (context.stepCount ?? 0) + 1;

		// Phase 2: post-increment check. Block if this increment pushed the
		// counter over the limit (belt-and-suspenders with Phase 1 above).
		if (context.stepCount > context.maxSteps) {
			return { block: true, reason: BLOCK_REASON };
		}

		return;
	});
}
