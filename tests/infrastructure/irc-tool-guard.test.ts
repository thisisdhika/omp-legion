import { describe, expect, test } from "bun:test";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
	currentDispatchContext,
	runAsDispatchedAgent,
	runWithDispatchContext,
} from "../../src/infrastructure/agent-execution-context";
import { evaluateIrcCall } from "../../src/infrastructure/irc-tool-guard";

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

const systemContext: DispatchContext = {
	senderKind: "system",
	parentRoute: PARENT,
	allowedDestination: PARENT,
};

const hostContext: DispatchContext = {
	senderKind: "host",
	agentName: "task",
	parentRoute: PARENT,
	allowedDestination: PARENT,
};

describe("evaluateIrcCall — isolation policy", () => {
	test("allows an expert to report to its authenticated parent", () => {
		expect(evaluateIrcCall(expert(), { op: "send", to: PARENT })).toEqual({
			block: false,
		});
	});

	test("blocks direct expert-to-expert messaging", () => {
		const decision = evaluateIrcCall(expert(), {
			op: "send",
			to: "legion-reviewer",
		});
		expect(decision.block).toBe(true);
	});

	test("blocks a spoofed peer name", () => {
		const decision = evaluateIrcCall(expert(), {
			op: "send",
			to: "legion-tester",
		});
		expect(decision.block).toBe(true);
	});

	test("blocks an aliased peer name", () => {
		const decision = evaluateIrcCall(expert(), {
			op: "send",
			to: "reviewer@legion",
		});
		expect(decision.block).toBe(true);
	});

	test('blocks parallel (to: "all") expert communication', () => {
		const decision = evaluateIrcCall(expert(), { op: "send", to: "all" });
		expect(decision.block).toBe(true);
	});

	test("blocks an expert waiting on a peer instead of its parent", () => {
		const decision = evaluateIrcCall(expert(), {
			op: "wait",
			from: "legion-reviewer",
		});
		expect(decision.block).toBe(true);
	});

	test("allows an expert waiting on its parent", () => {
		expect(evaluateIrcCall(expert(), { op: "wait", from: PARENT })).toEqual({
			block: false,
		});
	});

	test("fails closed when an expert's routing is unknown (no allowedDestination)", () => {
		const decision = evaluateIrcCall(
			expert({ allowedDestination: undefined }),
			{ op: "send", to: PARENT },
		);
		expect(decision.block).toBe(true);
	});

	test("fails closed when an expert sends with no destination", () => {
		const decision = evaluateIrcCall(expert(), { op: "send" });
		expect(decision.block).toBe(true);
	});

	// Regression test for a live-confirmed incident: a native `task`-tool
	// subagent ("ScopedRedundancyAudit", not a legion-* agent at all) hit "IRC
	// blocked: no dispatch context" and lost IRC access entirely. Only
	// Legion's own HostExpertExecutor ever sets a dispatch context — a
	// non-legion-* agent is never wrapped, so it always has undefined
	// context. Undefined context must mean "not a legion-* expert," not
	// "assume the worst and block" — mirrors git-commit-guard.ts's own
	// `context?.senderKind !== "expert"` fail-open policy.
	test("allows IRC when no dispatch context is available — not a legion-* expert", () => {
		expect(evaluateIrcCall(undefined, { op: "send", to: "anyone" })).toEqual({
			block: false,
		});
	});

	test("preserves host/system control for an explicit system sender", () => {
		expect(evaluateIrcCall(systemContext, { op: "send", to: "all" })).toEqual({
			block: false,
		});
	});

	test("preserves host/system control for an explicit host sender", () => {
		expect(
			evaluateIrcCall(hostContext, { op: "send", to: "legion-reviewer" }),
		).toEqual({ block: false });
	});

	test("allows inbox for everyone; blocks list for isolated experts", () => {
		expect(evaluateIrcCall(expert(), { op: "inbox" })).toEqual({
			block: false,
		});
		expect(evaluateIrcCall(expert(), { op: "list" })).toEqual({
			block: true,
			reason:
				"IRC blocked: expert dispatch context has no authenticated parent route (fail-closed).",
		});
	});
});

describe("agent-execution-context — async survival + isolation", () => {
	test("runAsDispatchedAgent tags a legion-* agent as an isolated expert", async () => {
		await runAsDispatchedAgent("legion-coder", async () => {
			const ctx = currentDispatchContext();
			expect(ctx?.senderKind).toBe("expert");
			expect(ctx?.allowedDestination).toBe(PARENT);
			expect(ctx?.agentName).toBe("legion-coder");
		});
	});

	test("uses the dispatch-provided parent route when supplied", async () => {
		await runAsDispatchedAgent(
			"legion-coder",
			async () => {
				expect(currentDispatchContext()?.allowedDestination).toBe("Main");
			},
			"Main",
		);
	});

	test("runAsDispatchedAgent tags a non-legion agent as the control plane", async () => {
		await runAsDispatchedAgent("task", async () => {
			expect(currentDispatchContext()?.senderKind).toBe("host");
		});
	});

	test("context is undefined outside a dispatch wrapper", () => {
		expect(currentDispatchContext()).toBeUndefined();
	});

	test("context survives an intermediate await", async () => {
		let inside: string | undefined;
		await runAsDispatchedAgent("legion-coder", async () => {
			await Promise.resolve();
			inside = currentDispatchContext()?.agentName;
		});
		expect(inside).toBe("legion-coder");
	});

	test("concurrent expert contexts don't leak across parallel attempts", async () => {
		const seen: Array<string | undefined> = [];
		const names = ["legion-coder", "legion-reviewer", "legion-tester"];
		await Promise.all(
			names.map((name) =>
				runAsDispatchedAgent(name, async () => {
					await Promise.resolve();
					await Promise.resolve();
					seen.push(currentDispatchContext()?.agentName);
				}),
			),
		);
		expect(seen.sort()).toEqual([...names].sort());
	});

	test("explicit system context is readable and allowed through evaluateIrcCall", async () => {
		await runWithDispatchContext(systemContext, async () => {
			expect(currentDispatchContext()?.senderKind).toBe("system");
			expect(
				evaluateIrcCall(currentDispatchContext(), {
					op: "send",
					to: "legion-coder",
				}),
			).toEqual({ block: false });
		});
	});
});
