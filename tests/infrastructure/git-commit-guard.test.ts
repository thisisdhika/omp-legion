import { describe, expect, test } from "bun:test";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
} from "../../src/infrastructure/agent-execution-context";
import {
	evaluateBashCall,
	isGitCommitCommand,
} from "../../src/infrastructure/git-commit-guard";

const PARENT = LEGION_DISPATCH_PARENT_ROUTE;

function expert(over: Partial<DispatchContext> = {}): DispatchContext {
	return {
		senderKind: "expert",
		agentName: "legion-coder",
		parentRoute: PARENT,
		allowedDestination: PARENT,
		...over,
	};
}

const hostContext: DispatchContext = {
	senderKind: "host",
	agentName: "task",
	parentRoute: PARENT,
	allowedDestination: PARENT,
};

describe("isGitCommitCommand", () => {
	test("matches a plain commit", () => {
		expect(isGitCommitCommand('git commit -m "message"')).toBe(true);
	});

	test("matches an amend", () => {
		expect(isGitCommitCommand("git commit --amend --no-edit")).toBe(true);
	});

	test("matches through leading flags/options", () => {
		expect(isGitCommitCommand("git -C /repo commit -am 'x'")).toBe(true);
		expect(
			isGitCommitCommand("git -c user.name=x -c user.email=y commit"),
		).toBe(true);
	});

	test("matches when chained after another command", () => {
		expect(isGitCommitCommand("npm test && git commit -m done")).toBe(true);
	});

	test("does not match unrelated git subcommands", () => {
		expect(isGitCommitCommand("git status")).toBe(false);
		expect(isGitCommitCommand("git log --oneline -5")).toBe(false);
		expect(isGitCommitCommand("git diff")).toBe(false);
	});

	test("does not match commands that merely mention the word commit", () => {
		expect(isGitCommitCommand("echo 'ready to commit'")).toBe(false);
	});

	test("handles undefined input", () => {
		expect(isGitCommitCommand(undefined)).toBe(false);
	});
});

describe("evaluateBashCall — expert commit isolation", () => {
	test("blocks a legion-* expert from committing", () => {
		const decision = evaluateBashCall(expert(), "git commit -m done");
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/may not create git commits/);
	});

	test("allows a legion-* expert to run other git commands", () => {
		expect(evaluateBashCall(expert(), "git status")).toEqual({
			block: false,
		});
		expect(evaluateBashCall(expert(), "git diff HEAD~1")).toEqual({
			block: false,
		});
	});

	test("allows the primary agent (no dispatch context) to commit", () => {
		expect(evaluateBashCall(undefined, "git commit -m done")).toEqual({
			block: false,
		});
	});

	test("allows the trusted control plane (host/parent/system) to commit", () => {
		expect(evaluateBashCall(hostContext, "git commit -m done")).toEqual({
			block: false,
		});
	});

	test("does not block non-git commands from an expert", () => {
		expect(evaluateBashCall(expert(), "npm test")).toEqual({ block: false });
	});
});
