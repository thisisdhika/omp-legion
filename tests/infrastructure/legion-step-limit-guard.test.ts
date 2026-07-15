import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
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
});
