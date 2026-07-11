import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import { currentDispatchAgentName } from "./agent-execution-context";
import { isLegionAgentName } from "./agent-loader";

/**
 * Blocks the `irc` tool for any agent currently running as a `legion-*`
 * persona. The host force-adds `irc` to every subagent's tool whitelist
 * unconditionally (`task/executor.ts`: "IRC is always available... a
 * restricted whitelist must still carry `irc`") — there is no
 * `AgentDefinition`-level way to opt a persona out of it. Legion's own
 * ensemble design depends on experts staying independent (see the personas'
 * "you will never see their output" instruction); live peer-to-peer chat
 * between sibling attempts of the same ensemble would correlate their
 * answers, undermining the whole reason ensembling can beat a single model.
 *
 * Fails open: if the current agent can't be determined (store unset — e.g.
 * a non-Legion subagent, or this code running outside a Legion dispatch),
 * the call is never blocked. A detection gap must not accidentally break
 * IRC for unrelated subagents.
 */
const IRC_TOOL_NAME = "irc";

const BLOCK_REASON =
	"legion-* agents must not use irc — ensemble attempts are independent by design and must not coordinate with sibling experts.";

export function shouldBlockIrc(agentName: string | undefined): boolean {
	return agentName !== undefined && isLegionAgentName(agentName);
}

export function registerIrcToolGuard(api: ExtensionAPI): void {
	api.on("tool_call", (event) => {
		if (event.toolName !== IRC_TOOL_NAME) return;
		if (shouldBlockIrc(currentDispatchAgentName())) {
			return { block: true, reason: BLOCK_REASON };
		}
		return;
	});
}
