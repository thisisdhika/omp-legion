import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	currentDispatchContext,
} from "./agent-execution-context";

/**
 * Replaces the old name-only guard. IRC is now gated by an *authenticated
 * dispatch context* (set by the trusted dispatch layer around each expert's
 * subprocess — an agent can never set its own context), carrying the sender
 * kind, the parent route, and the single destination the sender may address.
 *
 * Why the control plane stays open: the host force-adds `irc` to every
 * subagent's tool whitelist unconditionally (`task/executor.ts`: "IRC is
 * always available... a restricted whitelist must still carry `irc`"), so we
 * cannot opt Legion personas out at the tool level. The previous guard simply
 * blocked every legion-* agent. That over-blocked: it also stopped a legion-*
 * expert from legitimately reporting to its parent, and it left the control
 * plane unauthenticated.
 *
 * New policy (see evaluateIrcCall):
 *  - Non-expert senders (parent/host/system) → full IRC rights.
 *  - Expert with unknown routing (no authenticated allowedDestination) →
 *    FAIL CLOSED (block). A detection gap must never let an expert coordinate.
 *  - Expert addressing anything other than its authenticated parent route →
 *    block. This covers direct expert-to-expert, spoofed/aliased peer names,
 *    and parallel (`to: "all"`) communication — exactly what would correlate
 *    ensemble attempts and defeat the reason ensembling can beat a single model.
 *  - No dispatch context at all → **allow**, not block. Only Legion's own
 *    HostExpertExecutor ever wraps a call with runAsDispatchedAgent — a
 *    context is set if and only if this call originated from a legion-*
 *    dispatch. A native `task`-tool subagent (any non-legion-* agent) never
 *    gets wrapped at all, so it always has undefined context; the old
 *    fail-closed default here blocked those agents from IRC entirely, live-
 *    confirmed (a "ScopedRedundancyAudit" native subagent hit "no dispatch
 *    context" and lost IRC access despite never being a Legion expert).
 *    Mirrors git-commit-guard.ts's own established policy
 *    (`context?.senderKind !== "expert"` → allow) — only ever restrict a
 *    call this guard can actually attribute to a legion-* expert.
 */
const IRC_TOOL_NAME = "irc";

const EXPERT_ISOLATION_REASON =
	'legion-* experts may only address their parent/orchestrator over IRC; direct expert-to-expert, spoofed/aliased peer names, and parallel (to:"all") messaging are blocked to keep ensemble attempts independent.';

const EXPERT_UNKNOWN_ROUTING_REASON =
	"IRC blocked: expert dispatch context has no authenticated parent route (fail-closed).";

export interface IrcCallInput {
	op?: string;
	to?: string;
	from?: string;
	[k: string]: unknown;
}

export interface IrcDecision {
	block: boolean;
	reason?: string;
}

/**
 * Pure, side-effect-free IRC authorization decision, shared by the live guard
 * and the tests. Only `inbox` is truly read-only (reading one's own messages);
 * `list` leaks sibling ensemble peer info for isolated experts, so it is gated
 * identically to `send`/`wait` — falls through to the expert routing check and
 * is blocked only when context identifies the caller as a legion-* expert
 * with unauthenticated or out-of-route destination.
 */
export function evaluateIrcCall(
	context: DispatchContext | undefined,
	input: IrcCallInput | undefined,
): IrcDecision {
	const op = input?.op;
	if (op === "inbox") return { block: false };

	// Non-expert senders (parent/host/system) are always trusted — allow. This
	// also covers undefined context: only a legion-* dispatch ever sets one
	// (see this function's own doc comment), so no context means this call
	// was never a legion-* expert in the first place — never block it here.
	if (context?.senderKind !== "expert") return { block: false };

	// Expert tier — fail closed when routing is unknown.
	if (!context.allowedDestination) {
		return { block: true, reason: EXPERT_UNKNOWN_ROUTING_REASON };
	}

	// `send` targets `to`; `wait` targets `from`. Either way, an isolated
	// expert may only name its authenticated parent route.
	const target = op === "send" ? input?.to : input?.from;
	if (target === undefined || target === null || target === "") {
		return { block: true, reason: EXPERT_UNKNOWN_ROUTING_REASON };
	}
	if (target !== context.allowedDestination) {
		return { block: true, reason: EXPERT_ISOLATION_REASON };
	}
	return { block: false };
}

export function registerIrcToolGuard(api: ExtensionAPI): void {
	api.on("tool_call", (event) => {
		if (event.toolName !== IRC_TOOL_NAME) return;
		const decision = evaluateIrcCall(
			currentDispatchContext(),
			event.input as IrcCallInput | undefined,
		);
		if (decision.block) return { block: true, reason: decision.reason };
		return;
	});
}
