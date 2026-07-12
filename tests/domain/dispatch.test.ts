import { describe, expect, test } from "bun:test";

import {
	buildDispatchPlan,
	dispatchRequestSchema,
	humanReadableJobId,
	resolveAgentName,
} from "../../src/domain/dispatch";

describe("dispatch planning", () => {
	test("samples the strongest accessible model for self-consistency", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["frontier", "fallback"],
					strategy: "self-consistency",
					ensembleSize: 3,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			(model) => model === "frontier",
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts.map((attempt) => attempt.model)).toEqual([
			"frontier",
			"frontier",
			"frontier",
		]);
	});

	test("cycles through configured models only for explicit diversity", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["security", "general"],
					strategy: "diverse",
					ensembleSize: 3,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts.map((attempt) => attempt.model)).toEqual([
			"security",
			"general",
			"security",
		]);
	});

	test("uses the active model when a role has no explicit mapping", () => {
		const request = dispatchRequestSchema.parse({
			task: "Implement the change",
			tasks: [
				{
					id: "code",
					agent: "coder",
					role: "coder",
					assignment: "Implement it",
				},
			],
		});

		const plan = buildDispatchPlan(
			request,
			"active",
			(model) => model === "active",
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts).toHaveLength(3);
		expect(plan.attempts.every((attempt) => attempt.model === "active")).toBe(
			true,
		);
	});

	test("warns when self-consistency has multiple models configured", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["frontier", "fallback"],
					strategy: "self-consistency",
					ensembleSize: 3,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]).toContain("reviewer");
		expect(plan.warnings[0]).toContain("self-consistency");
	});

	test("warns when diverse ensembleSize leaves configured models unreachable", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["security", "general", "extra"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]).toContain("extra");
	});

	test("produces no warnings for an unambiguous configuration", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["frontier"],
					strategy: "self-consistency",
					ensembleSize: 3,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.warnings).toEqual([]);
	});

	test("applies the default temperature ladder to self-consistency attempts, cycling past its length", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["frontier"],
					strategy: "self-consistency",
					ensembleSize: 4,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts.map((attempt) => attempt.temperature)).toEqual([
			0.2, 0.6, 1.0, 0.2,
		]);
	});

	test("leaves temperature at the provider default for diverse strategy unless configured", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["security", "general"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(
			plan.attempts.every((attempt) => attempt.temperature === undefined),
		).toBe(true);
	});

	test("honors a configured temperatureLadder override", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "review",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Review it",
				},
			],
			modelMap: {
				reviewer: {
					models: ["frontier"],
					strategy: "self-consistency",
					ensembleSize: 2,
					temperatureLadder: [0, 1],
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts.map((attempt) => attempt.temperature)).toEqual([0, 1]);
	});

	test("rejects duplicate task ids before dispatch", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [
				{
					id: "same",
					agent: "reviewer",
					role: "reviewer",
					assignment: "First",
				},
				{
					id: "same",
					agent: "reviewer",
					role: "reviewer",
					assignment: "Second",
				},
			],
		});

		expect(() =>
			buildDispatchPlan(
				request,
				"active",
				() => true,
				(index) => `attempt-${index}`,
				(role) => role,
			),
		).toThrow('Duplicate dispatch task id "same".');
	});
});

describe("resolveAgentName", () => {
	// Agent is never trusted from the decomposer or caller (both invented
	// unresolvable host agent names in practice) — it is always looked up
	// here, against the roster Legion actually loaded.
	test("picks the matching legion-<role> persona when one is loaded", () => {
		const available = new Set(["task", "legion-coder", "legion-reviewer"]);
		expect(resolveAgentName("coder", available)).toBe("legion-coder");
	});

	test("is case-insensitive and trims the role", () => {
		const available = new Set(["legion-reviewer"]);
		expect(resolveAgentName(" Reviewer ", available)).toBe("legion-reviewer");
	});

	test("falls back to the safe host default for an unmatched role", () => {
		const available = new Set(["task", "legion-coder"]);
		expect(resolveAgentName("security-auditor", available)).toBe("task");
	});
});

describe("humanReadableJobId", () => {
	// The host auto-assigns a bare "bg_1"-style id when none is supplied,
	// which is meaningless to a human watching a live escalation/IRC
	// transcript — this gives every dispatch a human-readable job id instead.
	test("derives a PascalCase id from the task text", () => {
		expect(
			humanReadableJobId("Add a comment at the top of sample-bug.js"),
		).toBe("LegionAddACommentAtTheTop");
	});

	test("falls back to a generic label for unlabelable text", () => {
		expect(humanReadableJobId("!!! 一二三 !!!")).toBe("LegionDispatch");
	});
});
