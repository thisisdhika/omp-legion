import { AsyncLocalStorage } from "node:async_hooks";

import { LEGION_AGENT_PREFIX } from "../domain/constants";

/**
 * Who is sending an IRC message, as established by the trusted dispatch layer
 * (never by the agent itself — an agent cannot invoke runAsDispatchedAgent).
 *
 * - "expert": a legion-* subagent spawned by dispatch. Strictly isolated: it
 *   may only address `allowedDestination` (its parent/orchestrator).
 * - "parent": the dispatch orchestrator / calling session.
 * - "host":   the host runtime on behalf of a non-Legion agent (task, explore,
 *   the user's own native agents).
 * - "system": out-of-band system control (escalation, orchestration bus).
 *
 * A caller with no authenticated context is treated as the trusted control
 * plane (host/system) — see irc-tool-guard for why that is safe.
 */
export type SenderKind = "expert" | "parent" | "host" | "system";

export interface DispatchContext {
	/** Set for experts; the legion-* persona name. */
	agentName?: string;
	/** The authenticated parent/orchestrator route this sender belongs to. */
	parentRoute: string;
	/**
	 * The single destination an expert is permitted to address. Equals
	 * `parentRoute` for normal dispatch; it can only be widened by the dispatch
	 * layer, never by the agent.
	 */
	allowedDestination: string;
	senderKind: SenderKind;
}

/**
 * The route experts must use to report to their parent/orchestrator. The
 * dispatch layer is responsible for listening on this id; an expert's only
 * permitted IRC destination is this exact string (see irc-tool-guard).
 *
 * This is the DEFAULT contract. `runAsDispatchedAgent(agentName)` cannot
 * derive the real parent id because host-dispatcher calls it with only the
 * persona name (dispatch files are out of scope for this change), so the
 * constant is the agreed rendezvous. To use the live parent identity instead,
 * the dispatch layer should wrap experts with `runWithDispatchContext`:
 *   runWithDispatchContext(
 *     { senderKind: "expert", agentName, parentRoute: <parentIrcPeerId>,
 *       allowedDestination: <parentIrcPeerId> }, fn)
 * where `<parentIrcPeerId>` is the spawning session's irc peer id (available
 * from the host `ctx`/session manager at dispatch time). Either way, the guard
 * enforces isolation: an expert may only address its authenticated parent route.
 */
export const LEGION_DISPATCH_PARENT_ROUTE = "legion-dispatch";

/**
 * Tags the async call chain of one dispatched expert's `runSubprocess` call
 * with an authenticated dispatch context. Subagents re-bind extensions against
 * their own `ExtensionAPI` within the *same process* (host's
 * `task/executor.ts`: "the subagent then re-binds each extension against its
 * own ExtensionAPI"), so a store set once around the `runSubprocess` call
 * stays readable from that subagent's own later `tool_call` events.
 *
 * This exists because neither the host's `tool_call` event nor the reachable
 * `ExtensionContext`/`AgentToolContext` carries the current agent's name
 * anywhere — there is no host-native way to answer "which agent is this
 * call coming from" otherwise.
 *
 * AsyncLocalStorage keeps each concurrent attempt isolated: sibling experts
 * running in parallel each see only their own context, with no leakage (see
 * irc-tool-guard concurrent tests).
 */
const store = new AsyncLocalStorage<DispatchContext>();

/** Derive an authenticated context from a dispatched agent name. */
function contextForAgent(
	agentName: string,
	parentRoute = LEGION_DISPATCH_PARENT_ROUTE,
): DispatchContext {
	if (agentName.startsWith(LEGION_AGENT_PREFIX)) {
		return {
			senderKind: "expert",
			agentName,
			parentRoute,
			allowedDestination: parentRoute,
		};
	}
	return {
		senderKind: "host",
		agentName,
		parentRoute,
		allowedDestination: parentRoute,
	};
}

/**
 * Wrap `fn` in an authenticated dispatch context derived from `agentName`.
 * Kept string-compatible because host-dispatcher calls it with the attempt's
 * persona name; legion-* names become isolated experts, anything else is the
 * trusted control plane.
 */
export function runAsDispatchedAgent<T>(
	agentName: string,
	fn: () => Promise<T>,
	parentRoute?: string,
): Promise<T> {
	// ponytail: fixed #2 — set env so isolated subprocess loads can detect
	// they were spawned by dispatch and act accordingly. Note: ALS cannot cross
	// the Node module-cache split, so the actual fix is in irc-tool-guard's
	// fail-closed guard — this is a supplementary signal.
	process.env.LEGION_ISOLATED = "1";
	return store.run(contextForAgent(agentName, parentRoute), fn);
}

/** Wrap `fn` in an explicit dispatch context (tests + future callers). */
export function runWithDispatchContext<T>(
	context: DispatchContext,
	fn: () => Promise<T>,
): Promise<T> {
	return store.run(context, fn);
}

/** The authenticated dispatch context for the current async chain, if any. */
export function currentDispatchContext(): DispatchContext | undefined {
	return store.getStore();
}
