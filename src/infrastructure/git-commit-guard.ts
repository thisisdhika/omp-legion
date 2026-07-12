import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	currentDispatchContext,
} from "./agent-execution-context";

/**
 * Blocks legion-* expert subagents from creating git commits. A dispatched
 * expert's job is to produce one candidate answer for synthesis/HOTL
 * governance to evaluate — never to land changes on its own. Committing is a
 * primary-agent action, made only when a human has prompted for one.
 *
 * Motivated by a real incident: a dispatched expert ran `git commit` mid-
 * ensemble during manual testing and it landed on `main` with no synthesis,
 * no governance, and no human in the loop.
 *
 * Scoped to the `bash` tool's `command` field — the only path a legion-*
 * expert has to run `git commit`. Only blocks when the caller is positively
 * identified as an expert (`senderKind === "expert"`); unlike irc-tool-guard,
 * an undefined context passes through untouched here, since that's the
 * normal case for the primary agent (which never runs inside a dispatch
 * wrapper) — failing closed would block the primary agent's own bash tool.
 */
const BASH_TOOL_NAME = "bash";

const BLOCK_REASON =
	"legion-* experts may not create git commits — commits are a primary-agent action, made only when a human has prompted for one. Report your result back to the orchestrator instead.";

// Matches `git commit` (and commit-creating plumbing like `commit-tree`) as
// an actual subcommand, tolerating leading flags (`git -C dir commit`,
// `git -c user.name=x commit -am "..."`) and command chaining (`&&`, `;`,
// `|`). Deliberately loose pattern-matching, not a shell parser — same
// posture as the host's own CRITICAL_BASH_PATTERNS: a false positive on a
// command that merely mentions "commit" costs far less than a missed commit
// escaping ensemble review.
const GIT_COMMIT_PATTERN = /\bgit\b(?:\s+(?!commit\b)\S+)*\s+commit\b/i;

export function isGitCommitCommand(command: string | undefined): boolean {
	return typeof command === "string" && GIT_COMMIT_PATTERN.test(command);
}

export interface BashGuardDecision {
	block: boolean;
	reason?: string;
}

/**
 * Pure, side-effect-free decision, shared by the live guard and its tests —
 * mirrors evaluateIrcCall's shape. Only an authenticated expert context
 * blocks; every other sender (undefined, host, parent, system) passes.
 */
export function evaluateBashCall(
	context: DispatchContext | undefined,
	command: string | undefined,
): BashGuardDecision {
	if (context?.senderKind !== "expert") return { block: false };
	if (!isGitCommitCommand(command)) return { block: false };
	return { block: true, reason: BLOCK_REASON };
}

export function registerGitCommitGuard(api: ExtensionAPI): void {
	api.on("tool_call", (event) => {
		if (event.toolName !== BASH_TOOL_NAME) return;
		const input = event.input as { command?: string } | undefined;
		const decision = evaluateBashCall(currentDispatchContext(), input?.command);
		if (decision.block) return { block: true, reason: decision.reason };
		return;
	});
}
