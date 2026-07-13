import { describe, expect, test } from "bun:test";

import {
	type DispatchContext,
	LEGION_DISPATCH_PARENT_ROUTE,
} from "../../src/infrastructure/agent-execution-context";
import {
	LEGION_META_RISK_PATHS,
	evaluateLegionMetaRiskCommit,
} from "../../src/infrastructure/legion-meta-risk-guard";

const expert: DispatchContext = {
	senderKind: "expert",
	agentName: "legion-reviewer",
	parentRoute: LEGION_DISPATCH_PARENT_ROUTE,
	allowedDestination: LEGION_DISPATCH_PARENT_ROUTE,
};

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
});

describe("LEGION_META_RISK_PATHS consistency", () => {
	test("every guarded path is mentioned in legion-dispatch.md", async () => {
		const rule = await Bun.file("rules/legion-dispatch.md").text();
		for (const path of LEGION_META_RISK_PATHS) {
			expect(rule).toContain(path);
		}
	});
});
