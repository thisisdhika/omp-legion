import { describe, expect, test } from "bun:test";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
} from "../../src/infrastructure/agent-execution-context";
import {
	LEGION_META_RISK_PATHS,
	evaluateLegionMetaRiskCommit,
	isSuccessfulLegionDispatchResult,
} from "../../src/infrastructure/legion-meta-risk-guard";

const expert: DispatchContext = {
	senderKind: "expert",
	agentName: "legion-reviewer",
	parentRoute: LEGION_DISPATCH_PARENT_ROUTE,
	allowedDestination: LEGION_DISPATCH_PARENT_ROUTE,
};

describe("isSuccessfulLegionDispatchResult", () => {
	test("requires successful experts and successful synthesis", () => {
		expect(
			isSuccessfulLegionDispatchResult(false, {
				successfulAttemptCount: 1,
				synthesisSucceeded: true,
			}),
		).toBe(true);
		expect(
			isSuccessfulLegionDispatchResult(false, {
				successfulAttemptCount: 1,
				synthesisSucceeded: false,
			}),
		).toBe(false);
		expect(
			isSuccessfulLegionDispatchResult(false, {
				successfulAttemptCount: 0,
				synthesisSucceeded: true,
			}),
		).toBe(false);
		expect(
			isSuccessfulLegionDispatchResult(true, {
				successfulAttemptCount: 3,
				synthesisSucceeded: true,
			}),
		).toBe(false);
	});
});
const primary = undefined;

describe("evaluateLegionMetaRiskCommit", () => {
	test("blocks a primary commit touching a meta-risk file before review", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/second opinion/);
	});

	test("allows a commit after legion_dispatch or task was called", () => {
		expect(
			evaluateLegionMetaRiskCommit(
				primary,
				"git commit -m change",
				["src/domain/dispatch.ts"],
				true,
			),
		).toEqual({ block: false });
	});

	test("allows commits that do not touch meta-risk files", () => {
		expect(
			evaluateLegionMetaRiskCommit(
				primary,
				"git commit -m change",
				["src/index.ts", "tests/example.test.ts"],
				false,
			),
		).toEqual({ block: false });
	});

	test("allows experts because expert commits are handled by the existing guard", () => {
		expect(
			evaluateLegionMetaRiskCommit(
				expert,
				"git commit -m change",
				["src/domain/dispatch.ts"],
				false,
			),
		).toEqual({ block: false });
	});

	test("matches the documented glob paths", () => {
		expect(
			evaluateLegionMetaRiskCommit(
				primary,
				"git commit -m change",
				["rules/legion-dispatch.md"],
				false,
			),
		).toEqual({ block: true, reason: expect.any(String) });
		expect(
			evaluateLegionMetaRiskCommit(
				primary,
				"git commit -m change",
				["agents/legion-reviewer.md"],
				false,
			),
		).toEqual({ block: true, reason: expect.any(String) });
	});
	test("blocks every dispatch-internal source path", () => {
		for (const path of [
			"src/infrastructure/dispatch-concurrency-guard.ts",
			"src/infrastructure/host-dispatcher.ts",
			"src/infrastructure/legion-meta-risk-guard.ts",
			"src/infrastructure/agent-execution-context.ts",
		]) {
			expect(
				evaluateLegionMetaRiskCommit(
					primary,
					"git commit -m change",
					[path],
					false,
				).block,
			).toBe(true);
		}
	});

	test("blocks with specific message when dispatch had 0 successful attempts", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
			{ successfulAttemptCount: 0, synthesisSucceeded: false },
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("0 expert attempts succeeded");
		expect(decision.reason).toContain("synthesis did not fully succeed");
		expect(decision.reason).toContain("Try dispatching again");
	});

	test("blocks with specific message when dispatch had partial expert success but synthesis failed", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
			{ successfulAttemptCount: 2, synthesisSucceeded: false },
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("2 expert attempts succeeded");
		expect(decision.reason).toContain("synthesis did not fully succeed");
		expect(decision.reason).toContain("Try dispatching again");
	});

	test("uses generic message when no failed details provided", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/Call legion_dispatch/);
	});

	test("uses generic message when failed details is null", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
			null,
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/Call legion_dispatch/);
	});

	test("handles empty object details without crashing", () => {
		const decision = evaluateLegionMetaRiskCommit(
			primary,
			"git commit -m change",
			["src/domain/dispatch.ts"],
			false,
			{},
		);
		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("0 expert attempts succeeded");
	});
});

describe("LEGION_META_RISK_PATHS consistency", () => {
	test("every guarded path is mentioned in legion-dispatch.md", async () => {
		const rule = await Bun.file("rules/legion-dispatch.md").text();
		for (const path of LEGION_META_RISK_PATHS) {
			expect(rule).toContain(path);
		}
	});
});
