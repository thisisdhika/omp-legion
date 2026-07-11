import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tags the async call chain of one dispatched expert's `runSubprocess` call
 * with the agent name it's running as. Subagents re-bind extensions against
 * their own `ExtensionAPI` within the *same process* (host's
 * `task/executor.ts`: "the subagent then re-binds each extension against its
 * own ExtensionAPI"), so a store set once around the `runSubprocess` call
 * stays readable from that subagent's own later `tool_call` events.
 *
 * This exists because neither the host's `tool_call` event nor the reachable
 * `ExtensionContext`/`AgentToolContext` carries the current agent's name
 * anywhere — there is no host-native way to answer "which agent is this
 * call coming from" otherwise.
 */
const store = new AsyncLocalStorage<string>();

export function runAsDispatchedAgent<T>(
	agentName: string,
	fn: () => Promise<T>,
): Promise<T> {
	return store.run(agentName, fn);
}

export function currentDispatchAgentName(): string | undefined {
	return store.getStore();
}
