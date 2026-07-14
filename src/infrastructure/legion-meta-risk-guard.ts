import { execFileSync } from "node:child_process";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	currentDispatchContext,
} from "./agent-execution-context";
import { isGitCommitCommand } from "./git-commit-guard";

/** Paths whose edits can change Legion's own invocation and delivery behavior. */
export const LEGION_META_RISK_PATHS = [
	"src/presentation/dispatch-tool.ts",
	"src/domain/dispatch.ts",
	"rules/legion-*.md",
	"agents/legion-*.md",
	"src/infrastructure/rule-loader.ts",
	"src/infrastructure/host-dispatch-service.ts",
	"src/infrastructure/host-dispatcher.ts",
	"src/infrastructure/dispatch-concurrency-guard.ts",
	"src/infrastructure/legion-meta-risk-guard.ts",
	"src/infrastructure/agent-execution-context.ts",
	"src/application/dispatch-service.ts",
	"src/domain/decomposition.ts",
	"src/domain/synthesis.ts",
] as const;

const BASH_TOOL_NAME = "bash";
const TASK_TOOL_NAME = "task";
const LEGION_DISPATCH_TOOL_NAME = "legion_dispatch";
const BLOCK_REASON =
	"This commit touches Legion-internal files. Call legion_dispatch for a second opinion before finalizing the commit.";

export interface LegionMetaRiskDecision {
	block: boolean;
	reason?: string;
}

function matchesMetaRiskPath(path: string): boolean {
	return LEGION_META_RISK_PATHS.some((pattern) => {
		if (pattern.endsWith("*.md")) {
			return (
				path.startsWith(pattern.slice(0, -"*.md".length)) &&
				path.endsWith(".md")
			);
		}
		return path === pattern;
	});
}

export function evaluateLegionMetaRiskCommit(
	context: DispatchContext | undefined,
	command: string | undefined,
	stagedFiles: readonly string[],
	hasSecondOpinion: boolean,
): LegionMetaRiskDecision {
	if (context?.senderKind === "expert") return { block: false };
	if (!isGitCommitCommand(command) || hasSecondOpinion) return { block: false };
	if (!stagedFiles.some(matchesMetaRiskPath)) return { block: false };
	return { block: true, reason: BLOCK_REASON };
}

function stagedFiles(): string[] {
	try {
		return execFileSync("git", ["diff", "--cached", "--name-only"], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

export function isSuccessfulLegionDispatchResult(
	isError: boolean,
	details: unknown,
): boolean {
	if (isError || typeof details !== "object" || details === null) return false;
	if (!("successfulAttemptCount" in details)) return false;
	if (!("synthesisSucceeded" in details)) return false;
	const successfulAttemptCount = details.successfulAttemptCount;
	return (
		typeof successfulAttemptCount === "number" &&
		successfulAttemptCount > 0 &&
		details.synthesisSucceeded === true
	);
}

export function registerLegionMetaRiskGuard(api: ExtensionAPI): void {
	let hasSecondOpinion = false;
	const pendingDispatches = new Set<string>();
	api.on("session_start", () => {
		hasSecondOpinion = false;
		pendingDispatches.clear();
	});
	api.on("tool_call", (event) => {
		if (event.toolName === LEGION_DISPATCH_TOOL_NAME) {
			pendingDispatches.add(event.toolCallId);
			return;
		}
		if (event.toolName === TASK_TOOL_NAME) {
			hasSecondOpinion = true;
			return;
		}
		if (event.toolName !== BASH_TOOL_NAME) return;
		const input = event.input as { command?: string } | undefined;
		const decision = evaluateLegionMetaRiskCommit(
			currentDispatchContext(),
			input?.command,
			stagedFiles(),
			hasSecondOpinion,
		);
		if (decision.block) return { block: true, reason: decision.reason };
		return;
	});
	api.on("tool_result", (event) => {
		if (event.toolName !== LEGION_DISPATCH_TOOL_NAME) return;
		if (!pendingDispatches.delete(event.toolCallId)) return;
		if (isSuccessfulLegionDispatchResult(event.isError, event.details)) {
			hasSecondOpinion = true;
		}
		return;
	});
}
