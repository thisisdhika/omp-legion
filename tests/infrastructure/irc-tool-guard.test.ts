import { describe, expect, test } from "bun:test";

import {
	currentDispatchAgentName,
	runAsDispatchedAgent,
} from "../../src/infrastructure/agent-execution-context";
import { shouldBlockIrc } from "../../src/infrastructure/irc-tool-guard";

describe("shouldBlockIrc", () => {
	test("blocks a legion-* agent", () => {
		expect(shouldBlockIrc("legion-coder")).toBe(true);
	});

	test("does not block a non-legion agent", () => {
		expect(shouldBlockIrc("task")).toBe(false);
	});

	test("does not block when the current agent is unknown (fail open)", () => {
		expect(shouldBlockIrc(undefined)).toBe(false);
	});
});

describe("agent-execution-context", () => {
	test("currentDispatchAgentName reflects the running dispatched agent inside runAsDispatchedAgent", async () => {
		expect(currentDispatchAgentName()).toBeUndefined();
		await runAsDispatchedAgent("legion-reviewer", async () => {
			expect(currentDispatchAgentName()).toBe("legion-reviewer");
		});
		expect(currentDispatchAgentName()).toBeUndefined();
	});

	test("survives an intermediate await, matching runSubprocess's real async chain", async () => {
		let seenInsideAsyncGap: string | undefined;
		await runAsDispatchedAgent("legion-tester", async () => {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			seenInsideAsyncGap = currentDispatchAgentName();
		});
		expect(seenInsideAsyncGap).toBe("legion-tester");
	});

	test("concurrent dispatched agents don't leak into each other's context", async () => {
		const seen: string[] = [];
		await Promise.all([
			runAsDispatchedAgent("legion-coder", async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				seen.push(currentDispatchAgentName() ?? "unknown");
			}),
			runAsDispatchedAgent("legion-reviewer", async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				seen.push(currentDispatchAgentName() ?? "unknown");
			}),
		]);
		expect(seen.sort()).toEqual(["legion-coder", "legion-reviewer"]);
	});
});
