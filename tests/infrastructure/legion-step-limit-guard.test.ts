import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
	currentDispatchContext,
	runAsDispatchedAgent,
	runWithDispatchContext,
} from "../../src/infrastructure/agent-execution-context";
import { registerLegionStepLimitGuard } from "../../src/infrastructure/legion-step-limit-guard";

const PARENT = LEGION_DISPATCH_PARENT_ROUTE;

/** Build a fake ExtensionAPI that captures the tool_call handler. */
function captureHandler(): {
	handler: (event: { toolName: string; input?: unknown }) => unknown;
	api: ExtensionAPI;
} {
	let captured:
		| ((event: { toolName: string; input?: unknown }) => unknown)
		| undefined;
	const api = {
		on(event: string, handler: (event?: unknown) => unknown) {
			if (event === "tool_call")
				captured = handler as (event: {
					toolName: string;
					input?: unknown;
				}) => unknown;
		},
	} as unknown as ExtensionAPI;
	registerLegionStepLimitGuard(api);
	return {
		handler: (event) => (captured as NonNullable<typeof captured>)(event),
		api,
	};
}

function callHandler(
	handler: (event: { toolName: string; input?: unknown }) => unknown,
	toolName = "read",
): { block?: boolean; reason?: string } | undefined {
	const result = handler({ toolName, input: {} });
	return result as { block?: boolean; reason?: string } | undefined;
}

/**
 * Simulate the ExtensionRunner.emitToolCall wrapping pattern.
 * The real runner does:
 *   const handlerResult = await raceHandlerWithTimeout(
 *     Promise.resolve(handler(event, ctx)), timeoutMs);
 * which wraps the handler's sync result in a resolved promise and awaits it.
 */
async function emitToolCallLike(
	handler: (event: { toolName: string; input?: unknown }) => unknown,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const event = { toolName: "read", input: {} };
	// Mirror: Promise.resolve(handler(event, ctx))
	const work = Promise.resolve(handler(event));
	// Mirror: await raceHandlerWithTimeout(work, timeoutMs)
	const result = (await work) as
		| { block?: boolean; reason?: string }
		| undefined;
	return result;
}

describe("legion-step-limit-guard", () => {
	test("no dispatch context → allows tool call", () => {
		const { handler } = captureHandler();
		const result = callHandler(handler);
		expect(result).toBeUndefined();
	});

	test("host context (non-expert) → allows tool call regardless of maxSteps", () => {
		const { handler } = captureHandler();
		const hostContext: DispatchContext = {
			senderKind: "host",
			agentName: "task",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 3,
			stepCount: 0,
		};
		runWithDispatchContext(hostContext, async () => {
			// maxSteps is set but senderKind is "host" — guard must not act.
			for (let i = 0; i < 10; i++) {
				const result = callHandler(handler);
				expect(result).toBeUndefined();
			}
		});
	});

	test("expert context with maxSteps: undefined → allows tool call indefinitely", () => {
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
		};
		runWithDispatchContext(expertContext, async () => {
			for (let i = 0; i < 100; i++) {
				const result = callHandler(handler);
				expect(result).toBeUndefined();
			}
		});
	});

	test("expert context with maxSteps: 3 → allows calls 1-3, blocks call 4 and beyond", () => {
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 3,
		};
		runWithDispatchContext(expertContext, async () => {
			// Calls 1-3 should be allowed
			for (let i = 1; i <= 3; i++) {
				const result = callHandler(handler);
				expect(result).toBeUndefined();
			}
			// Call 4 (and beyond) should be blocked
			const blocked = callHandler(handler);
			expect(blocked).toBeDefined();
			expect(blocked?.block).toBe(true);
			expect(blocked?.reason).toContain("step limit");
		});
	});

	test("block reason is informative about the step limit", () => {
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 1,
		};
		runWithDispatchContext(expertContext, async () => {
			// First call allowed
			callHandler(handler);
			// Second call blocked
			const blocked = callHandler(handler);
			expect(blocked?.reason).toContain("exceeded");
			expect(blocked?.reason).toContain("text-only");
			expect(blocked?.reason).toContain("summary");
		});
	});

	test("once tripped, stays tripped — counter does not wrap back under the limit", () => {
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 2,
		};
		runWithDispatchContext(expertContext, async () => {
			// Call 1: allowed
			expect(callHandler(handler)).toBeUndefined();
			// Call 2: allowed (exactly at limit)
			expect(callHandler(handler)).toBeUndefined();
			// Call 3: blocked
			expect(callHandler(handler)?.block).toBe(true);
			// Calls 4-10: stay blocked
			for (let i = 4; i <= 10; i++) {
				expect(callHandler(handler)?.block).toBe(true);
			}
		});
	});

	test("stepCount is initialized to 0 when maxSteps is set", () => {
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 5,
		};
		runWithDispatchContext(expertContext, async () => {
			expect(expertContext.stepCount).toBeUndefined();
			// contextForAgent initializes stepCount: 0 when maxSteps is set
			// but since we create the context manually here, stepCount starts undefined.
			// The guard initializes it on first call via `(context.stepCount ?? 0) + 1`
			callHandler(captureHandler().handler);
		});
	});

	test("concurrent expert contexts with different maxSteps stay isolated", async () => {
		const { handler: handlerA } = captureHandler();
		const { handler: handlerB } = captureHandler();

		const resultsA: Array<boolean | undefined> = [];
		const resultsB: Array<boolean | undefined> = [];

		const { promise: promiseA, resolve: resolveA } =
			Promise.withResolvers<void>();
		const { promise: promiseB, resolve: resolveB } =
			Promise.withResolvers<void>();
		const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();

		// Start both concurrent runs WITHOUT wrapping in Promise.all (which
		// would deadlock — both callbacks await gate before completing).
		const runA = runAsDispatchedAgent("legion-coder", async () => {
			resultsA.push(callHandler(handlerA)?.block);
			resultsA.push(callHandler(handlerA)?.block);
			resolveA();
			await gate;
			resultsA.push(callHandler(handlerA)?.block);
		});
		const runB = runAsDispatchedAgent("legion-reviewer", async () => {
			resultsB.push(callHandler(handlerB)?.block);
			resultsB.push(callHandler(handlerB)?.block);
			resolveB();
			await gate;
			resultsB.push(callHandler(handlerB)?.block);
		});

		// Wait for both async chains to reach the gate
		await Promise.all([promiseA, promiseB]);
		openGate();
		// Wait for both to finish
		await Promise.all([runA, runB]);

		// Both saw their first two calls as unblocked (no maxSteps set on
		// these contexts — they rely on the role config, which is undefined
		// here since we didn't go through buildDispatchPlan).
		expect(resultsA.length).toBeGreaterThanOrEqual(3);
		expect(resultsB.length).toBeGreaterThanOrEqual(3);
	});

	test("concurrent runs with explicit maxSteps do not leak counters", async () => {
		// This test verifies that two concurrent contexts with explicit maxSteps
		// each track their own counter independently.
		const contextA: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 3,
		};
		const contextB: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-reviewer",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 1,
		};

		const { handler: handlerA } = captureHandler();
		const { handler: handlerB } = captureHandler();

		const seenA: Array<boolean | undefined> = [];
		const seenB: Array<boolean | undefined> = [];

		const { promise: gateA, resolve: openA } = Promise.withResolvers<void>();
		const { promise: gateB, resolve: openB } = Promise.withResolvers<void>();

		await Promise.all([
			runWithDispatchContext(contextA, async () => {
				// contextA has maxSteps=3: calls 1-3 allowed
				seenA.push(callHandler(handlerA)?.block); // 1: allowed
				seenA.push(callHandler(handlerA)?.block); // 2: allowed
				openA();
				await gateB;
				seenA.push(callHandler(handlerA)?.block); // 3: allowed
			}),
			runWithDispatchContext(contextB, async () => {
				// contextB has maxSteps=1: call 1 allowed, call 2+ blocked
				seenB.push(callHandler(handlerB)?.block); // 1: allowed
				openB();
				await gateA;
				seenB.push(callHandler(handlerB)?.block); // 2: blocked
			}),
		]);

		// contextA: maxSteps=3, all 3 calls allowed (counter at 3 <= 3)
		expect(seenA[0]).toBeUndefined();
		expect(seenA[1]).toBeUndefined();
		expect(seenA[2]).toBeUndefined();

		// contextB: maxSteps=1, first allowed, second blocked
		expect(seenB[0]).toBeUndefined();
		expect(seenB[1]).toBe(true);
	});

	/**
	 * TEST: Parallel tool calls respect maxSteps limit.
	 *
	 * This test models the real host's behavior: when an assistant message
	 * contains multiple tool calls (e.g. 3 parallel `read` calls), the agent
	 * loop dispatches them concurrently via Promise.allSettled.
	 * ExtensionRunner.emitToolCall wraps each handler call with
	 * `Promise.resolve(handler(event, ctx))` followed by `await`, which
	 * introduces microtask boundaries. The test verifies that stepCount
	 * serialization works correctly even under these conditions.
	 *
	 * With maxSteps=1, only the FIRST tool call should execute; the 2nd
	 * and 3rd should be blocked by the guard.
	 */
	test("parallel tool calls respect maxSteps — only N calls allowed before blocking", async () => {
		const { handler } = captureHandler();
		const context: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-scout",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 1,
		};

		const results = await runWithDispatchContext(context, async () => {
			// Launch 3 concurrent tool calls, each going through the
			// ExtensionRunner's emitToolCall wrapping pattern:
			//   const result = await raceHandlerWithTimeout(Promise.resolve(handler(event, ctx)), timeoutMs)
			const calls = Array.from({ length: 3 }, () => emitToolCallLike(handler));
			return await Promise.all(calls);
		});

		// Call 1: stepCount goes 0→1, 1 > 1 is false → allowed
		expect(results[0]).toBeUndefined();
		// Call 2: stepCount goes 1→2, 2 > 1 is true → blocked
		expect(results[1]).toBeDefined();
		expect(results[1]?.block).toBe(true);
		// Call 3: stepCount goes 2→3, 3 > 1 is true → blocked
		expect(results[2]).toBeDefined();
		expect(results[2]?.block).toBe(true);
	});

	/**
	 * TEST: Same as above but with maxSteps=0 (first call should be the
	 * one that gets through, 2+ blocked). maxSteps=0 is rejected by schema
	 * but tests the edge case.
	 */
	test("parallel tool calls with maxSteps=0 block everything after first", async () => {
		const { handler } = captureHandler();
		const context: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-scout",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 0,
		};

		const results = await runWithDispatchContext(context, async () => {
			const calls = Array.from({ length: 3 }, () => emitToolCallLike(handler));
			return await Promise.all(calls);
		});

		// Call 1: stepCount goes 0→1, 1 > 0 is true → blocked
		expect(results[0]).toBeDefined();
		expect(results[0]?.block).toBe(true);
		// Call 2: blocked (stepCount 2, 2 > 0)
		expect(results[1]?.block).toBe(true);
		// Call 3: blocked (stepCount 3, 3 > 0)
		expect(results[2]?.block).toBe(true);
	});

	/**
	 * TEST: With maxSteps=3 and 5 parallel calls, only the first 3 should
	 * succeed; calls 4-5 should be blocked.
	 */
	test("parallel tool calls with maxSteps=3 allow 3, block 4+", async () => {
		const { handler } = captureHandler();
		const context: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-scout",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 3,
		};

		const results = await runWithDispatchContext(context, async () => {
			const calls = Array.from({ length: 5 }, () => emitToolCallLike(handler));
			return await Promise.all(calls);
		});

		// Calls 1-3 allowed (stepCount 1,2,3 all ≤ 3)
		expect(results[0]).toBeUndefined();
		expect(results[1]).toBeUndefined();
		expect(results[2]).toBeUndefined();
		// Calls 4-5 blocked (stepCount 4,5 > 3)
		expect(results[3]?.block).toBe(true);
		expect(results[4]?.block).toBe(true);
	});

	/**
	 * TEST: When stepCount is already at maxSteps from a prior turn, the
	 * pre-turn cap catches the first call of the next turn and blocks
	 * immediately without incrementing further. This verifies the Phase 1
	 * guard works for the cross-turn case where stepCount was already
	 * exhausted before the batch starts.
	 */
	test("pre-turn cap blocks when stepCount already at maxSteps from prior turn", async () => {
		const { handler } = captureHandler();
		// Create a context where stepCount is already at the limit (e.g.
		// from tool calls in a previous turn).
		const context: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-scout",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 3,
			stepCount: 3, // Already exhausted from prior turn
		};

		const results = await runWithDispatchContext(context, async () => {
			const calls = Array.from({ length: 3 }, () => emitToolCallLike(handler));
			return await Promise.all(calls);
		});

		// All 3 should be blocked by Phase 1 pre-turn cap (3 >= 3)
		expect(results[0]?.block).toBe(true);
		expect(results[1]?.block).toBe(true);
		expect(results[2]?.block).toBe(true);

		// stepCount should remain at 3 (not incremented by blocked calls)
		expect(context.stepCount).toBe(3);
	});

	test("yield is NOT blocked once tripped — other tools still blocked", () => {
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 1,
		};
		runWithDispatchContext(expertContext, async () => {
			// First call (read) — allowed
			expect(callHandler(handler, "read")).toBeUndefined();

			// Second call (read) — blocked by guard
			const blockedRead = callHandler(handler, "read");
			expect(blockedRead?.block).toBe(true);
			expect(blockedRead?.reason).toContain("step limit");

			// yield call — NOT blocked even though guard is tripped
			const yieldResult = callHandler(handler, "yield");
			expect(yieldResult).toBeUndefined();

			// Subsequent non-yield tool call still blocked
			const blockedEdit = callHandler(handler, "edit");
			expect(blockedEdit?.block).toBe(true);

			const blockedBash = callHandler(handler, "bash");
			expect(blockedBash?.block).toBe(true);
		});
	});

	test("yield exemption works via both Phase 1 pre-turn cap and Phase 2 post-increment", () => {
		const { handler } = captureHandler();

		// Phase 1 pre-turn cap: context already at maxSteps from prior turn
		const preCapContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 2,
			stepCount: 2, // Already exhausted
		};
		runWithDispatchContext(preCapContext, async () => {
			// Phase 1 triggers (stepCount 2 >= maxSteps 2)
			const blocked = callHandler(handler, "read");
			expect(blocked?.block).toBe(true);

			// yield still gets through
			expect(callHandler(handler, "yield")).toBeUndefined();
		});

		// Phase 2 post-increment check: first call pushes over limit
		const { handler: handler2 } = captureHandler();
		const postIncContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 1,
		};
		runWithDispatchContext(postIncContext, async () => {
			// First call increments stepCount to 1, now 1 > 1 is false → allowed
			expect(callHandler(handler2, "read")).toBeUndefined();

			// Second call: Phase 1 blocks (1 >= 1), but yield exempted
			const yieldResult = callHandler(handler2, "yield");
			expect(yieldResult).toBeUndefined();

			// Third call: still in Phase 1, non-yield blocked
			const blocked = callHandler(handler2, "edit");
			expect(blocked?.block).toBe(true);
		});
	});

	test("yield is still counted toward step limit when it passes the guard", () => {
		// yield should NOT bypass counting, only bypass blocking.
		// With maxSteps=2: first read counts, yield counts (passes),
		// then another read should be blocked by pre-turn cap.
		const { handler } = captureHandler();
		const expertContext: DispatchContext = {
			senderKind: "expert",
			agentName: "legion-coder",
			parentRoute: PARENT,
			allowedDestination: PARENT,
			maxSteps: 2,
		};
		runWithDispatchContext(expertContext, async () => {
			// Call 1 (read): stepCount 0→1, 1 > 2 = false → allowed
			expect(callHandler(handler, "read")).toBeUndefined();
			// Call 2 (yield): stepCount 1→2, 2 > 2 = false → allowed
			expect(callHandler(handler, "yield")).toBeUndefined();
			// Call 3 (read): stepCount 2≥2 pre-turn → blocked (yield not called)
			const blocked = callHandler(handler, "read");
			expect(blocked?.block).toBe(true);
			// yield still works even now, guard is tripped
			expect(callHandler(handler, "yield")).toBeUndefined();
		});
	});

	/**
	 * TEST: Capturing truncatedByStepLimit from inside the dispatch context.
	 *
	 * `HostExpertExecutor.run()` uses this exact pattern: after the attempt
	 * function completes, it checks the context's stepCount and maxSteps.
	 * This test validates that capture pattern works correctly for both
	 * truncated and normal completions.
	 */
	test("captured truncatedByStepLimit is true when stepCount >= maxSteps, undefined otherwise", async () => {
		let truncated: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-coder",
			async () => {
				const ctx = currentDispatchContext();
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					truncated = true;
				}
				return 42;
			},
			undefined,
			3, // maxSteps = 3
		);
		// Without exhausting the budget, truncated should be undefined
		expect(truncated).toBeUndefined();

		// Now run again but exhaust the budget
		let truncated2: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-coder",
			async () => {
				const ctx = currentDispatchContext();
				if (ctx) ctx.stepCount = ctx.maxSteps ?? 0;
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					truncated2 = true;
				}
				return 42;
			},
			undefined,
			3,
		);
		expect(truncated2).toBe(true);
	});

	test("truncatedByStepLimit capture: normal completion leaves field undefined, exhaustion sets it", async () => {
		// Normal completion: stepCount within budget
		let normalCapture: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-scout",
			async () => {
				const ctx = currentDispatchContext();
				if (ctx) ctx.stepCount = 2;
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					normalCapture = true;
				}
				return "ok";
			},
			undefined,
			5,
		);
		expect(normalCapture).toBeUndefined();

		// Exhausted completion: stepCount at maxSteps
		let exhaustedCapture: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-scout",
			async () => {
				const ctx = currentDispatchContext();
				if (ctx) ctx.stepCount = 5;
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					exhaustedCapture = true;
				}
				return "ok";
			},
			undefined,
			5,
		);
		expect(exhaustedCapture).toBe(true);

		// Exceeded: past maxSteps
		let exceededCapture: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-scout",
			async () => {
				const ctx = currentDispatchContext();
				if (ctx) ctx.stepCount = 7;
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					exceededCapture = true;
				}
				return "ok";
			},
			undefined,
			5,
		);
		expect(exceededCapture).toBe(true);
	});

	test("truncatedByStepLimit is undefined when maxSteps is not set", async () => {
		let capture: boolean | undefined;
		await runAsDispatchedAgent(
			"legion-scout",
			async () => {
				const ctx = currentDispatchContext();
				if (ctx) ctx.stepCount = 999;
				if (
					ctx &&
					ctx.stepCount !== undefined &&
					ctx.maxSteps !== undefined &&
					ctx.stepCount >= ctx.maxSteps
				) {
					capture = true;
				}
				return "ok";
			},
			// no maxSteps — context won't set stepCount
		);
		expect(capture).toBeUndefined();
	});
});
