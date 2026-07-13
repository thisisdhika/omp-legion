import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";

export type { Rule };

/**
 * `rules/legion-dispatch.md`'s own frontmatter-derived name (see
 * buildRuleFromMarkdown — the name comes from the filename, not the
 * frontmatter `name:` key, which is silently inert; confirmed by testing).
 */
const PRIMARY_ONLY_RULE_NAME = "legion-dispatch";

/**
 * Excludes the primary-agent-only rule(s) from a discovered rule set. Pure
 * and separately exported so the filtering behavior itself is unit-testable
 * without a real filesystem-backed discovery call (see loadSubagentRules,
 * which is not — it calls the host's own loadCapability, exercised instead
 * by tests/infrastructure/packaging.test.ts's real pack+extract+discover
 * harness and by live verification).
 */
export function excludePrimaryOnlyRules(rules: readonly Rule[]): Rule[] {
	return rules.filter((rule) => rule.name !== PRIMARY_ONLY_RULE_NAME);
}

/**
 * Rules to forward to every Legion-dispatched expert attempt: everything a
 * subagent would have discovered on its own (project/user rules, every other
 * bundled rule Legion or another extension ships), MINUS
 * `rules/legion-dispatch.md` specifically — that rule documents when/how the
 * *primary* agent should reach for `legion_dispatch`; a dispatched expert
 * can never call that tool at all (it is never in any legion-* persona's
 * `tools:` grant) and gets nothing from seeing it.
 *
 * Must be computed explicitly rather than left to each subagent's own
 * discovery: passing ANY `rules` array to a subagent's ExecutorOptions
 * REPLACES its discovery entirely rather than merging with it (confirmed in
 * the vendored sdk.ts: `options.rules !== undefined ? {items: options.rules}
 * : discover()`) — so this computes the same set discovery would have
 * produced and only removes the one rule that must not reach experts,
 * rather than passing a hand-picked subset that would silently drop the
 * user's own project/user rules for every dispatched attempt.
 */
export async function loadSubagentRules(cwd: string): Promise<Rule[]> {
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	return excludePrimaryOnlyRules(result.items);
}
