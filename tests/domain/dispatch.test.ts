import { describe, expect, test } from "bun:test";

import {
	buildDispatchPlan,
	classifyFailure,
	dispatchRequestSchema,
	dispatchTaskSchema,
	humanReadableJobId,
	nextReplacement,
	resolveAgentName,
	selectorKey,
	shortAgentName,
	shortModelName,
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

	test("retains unavailable configured candidates for runtime fallback", () => {
		const request = dispatchRequestSchema.parse({
			task: "Review the change",
			tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
			modelMap: {
				reviewer: {
					models: ["a", "b", "c"],
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
		});
		const plan = buildDispatchPlan(
			request,
			undefined,
			(model) => model !== "c",
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts.map((attempt) => attempt.model)).toEqual(["a", "b"]);
		expect(plan.attempts[0]?.candidates).toEqual(["a", "b", "c"]);
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

	// Regression test for a real production incident: /skill:centurion's scout
	// dispatch failed against the session's default model with a bare "No
	// accessible model matched the active session model" error that named
	// neither the role nor the unavailable model, and gave no hint that the
	// real cause was a missing modelMap.scout policy (vs. every configured
	// model genuinely being down). The error must name the role and point at
	// the fix.
	test("names the role and points at the missing modelMap entry when a role has no policy and its session-default fallback is unavailable", () => {
		const request = dispatchRequestSchema.parse({
			task: "Ask the next question",
			tasks: [
				{
					id: "scout-1",
					agent: "scout",
					role: "scout",
					assignment: "Pick the sharpest next question",
				},
			],
		});

		expect(() =>
			buildDispatchPlan(
				request,
				"openai-codex/gpt-5.6-luna",
				() => false,
				(index) => `attempt-${index}`,
				(role) => role,
			),
		).toThrow(
			/No modelMap policy configured for role "scout".*gpt-5\.6-luna.*modelMap\.scout/s,
		);
	});

	test("rejects a task whose role has no legion-* persona, instead of silently dispatching a non-legion agent", () => {
		const request = dispatchRequestSchema.parse({
			task: "Audit the security posture",
			tasks: [
				{
					id: "audit",
					agent: "security-auditor",
					role: "security-auditor",
					assignment: "Audit it",
				},
			],
		});

		expect(() =>
			buildDispatchPlan(
				request,
				"active",
				() => true,
				(index) => `attempt-${index}`,
				// Mirrors resolveAgentName's real contract: undefined when no
				// legion-<role> persona is loaded.
				() => undefined,
			),
		).toThrow(/dispatch this task with the native `task` tool instead/);
	});

	test("passes the resolved agent and attempt model to the id factory", () => {
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
					strategy: "diverse",
					ensembleSize: 2,
				},
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index, taskId, agent, model) => `${taskId}-${agent}-${model}-${index}`,
			() => "legion-reviewer",
		);

		expect(plan.attempts.map((attempt) => attempt.id)).toEqual([
			"review-legion-reviewer-frontier-0",
			"review-legion-reviewer-fallback-1",
		]);
	});

	// worktree threading: a role's modelMap.worktree policy must reach the
	// attempt the executor actually reads (host-dispatcher.ts branches on
	// attempt.worktree === false to skip isolation for read-only roles).
	test("threads a role's worktree: false policy onto every attempt for that role", () => {
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
					strategy: "diverse",
					ensembleSize: 2,
					worktree: false,
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

		expect(plan.attempts.every((attempt) => attempt.worktree === false)).toBe(
			true,
		);
	});

	test("leaves worktree undefined (isolated by default) when a role's policy doesn't set it", () => {
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
			modelMap: {
				coder: { models: ["frontier"], ensembleSize: 1 },
			},
		});

		const plan = buildDispatchPlan(
			request,
			undefined,
			() => true,
			(index) => `attempt-${index}`,
			(role) => role,
		);

		expect(plan.attempts[0]?.worktree).toBeUndefined();
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

	test("returns undefined for an unmatched role instead of falling back to a non-legion agent", () => {
		const available = new Set(["task", "legion-coder"]);
		expect(resolveAgentName("security-auditor", available)).toBeUndefined();
	});

	// legion-decomposer is bundled and loaded like any other persona, but
	// host-dispatch-service.ts deliberately excludes it from the agent-name
	// set passed here — it plans splits, it isn't a candidate for being one
	// of the split pieces. Mirrors that exact filter to lock the behavior in
	// without needing the full ExtensionContext createHostDispatchService
	// requires.
	test("never resolves the decomposer persona, even if a task role is literally 'decomposer'", () => {
		const loaded = new Set(["task", "legion-coder", "legion-decomposer"]);
		const dispatchable = new Set(
			[...loaded].filter((name) => name !== "legion-decomposer"),
		);
		expect(resolveAgentName("decomposer", dispatchable)).toBeUndefined();
	});
});

describe("humanReadableJobId", () => {
	// The host auto-assigns a bare "bg_1"-style id when none is supplied,
	// which is meaningless to a human watching a live escalation/IRC
	// transcript — this gives every dispatch a human-readable job id instead.
	// Hyphenated slug, not PascalCase-mashed: the id sits next to the actual
	// task text elsewhere in the UI (dispatch-card's "Task" section), and
	// mashed-together words read as a second, garbled description of the
	// same thing rather than an id pointing at it.
	test("derives a hyphenated slug from the task text", () => {
		expect(
			humanReadableJobId("Add a comment at the top of sample-bug.js"),
		).toBe("legion-add-a-comment");
	});

	test("falls back to a generic label for unlabelable text", () => {
		expect(humanReadableJobId("!!! 一二三 !!!")).toBe("legion-dispatch");
	});
});

describe("shortAgentName", () => {
	test("strips the legion- prefix", () => {
		expect(shortAgentName("legion-coder")).toBe("coder");
		expect(shortAgentName("legion-reviewer")).toBe("reviewer");
	});

	test("passes through a non-legion (host fallback) agent unchanged", () => {
		expect(shortAgentName("task")).toBe("task");
	});
});

describe("shortModelName", () => {
	test("keeps only the last path segment", () => {
		expect(shortModelName("openrouter/tencent/hy3:free")).toBe("hy3:free");
		expect(shortModelName("opencode-zen/mimo-v2.5-free")).toBe(
			"mimo-v2.5-free",
		);
	});

	test("passes through a selector with no path segments unchanged", () => {
		expect(shortModelName("frontier")).toBe("frontier");
	});
});

describe("runtime fallback classification", () => {
	function result(
		overrides: Partial<{
			exitCode: number;
			error?: string;
			aborted?: boolean;
		}>,
	) {
		return {
			attemptId: "a",
			taskId: "t",
			agent: "coder",
			role: "coder",
			model: "m",
			index: 0,
			output: "",
			stderr: "",
			exitCode: 0,
			durationMs: 1,
			tokens: 1,
			requests: 1,
			...overrides,
		};
	}

	test("treats a clean exit as ok", () => {
		expect(classifyFailure(result({ exitCode: 0 }))).toBe("ok");
	});

	test("classifies retryable provider failures (rate-limit, unavailable, timeout)", () => {
		for (const error of [
			"429 Too Many Requests",
			"rate limit reached, slow down",
			"model 'm' is unavailable",
			"unavailable model",
			"request timed out after 30s",
		]) {
			expect(classifyFailure(result({ exitCode: 1, error }))).toBe("retryable");
		}
	});

	test("classifies ordinary task/validation errors as fatal", () => {
		expect(
			classifyFailure(result({ exitCode: 1, error: "subagent crashed" })),
		).toBe("fatal");
		expect(
			classifyFailure(
				result({ exitCode: 1, error: "invalid assignment schema" }),
			),
		).toBe("fatal");
		expect(
			classifyFailure(
				result({ exitCode: 1, error: "quota exceeded for this project" }),
			),
		).toBe("fatal");
	});
	test("treats aborted attempts as fatal (cancellation, not retry)", () => {
		expect(
			classifyFailure(result({ exitCode: 1, error: "quota", aborted: true })),
		).toBe("fatal");
	});
});

describe("selectorKey and nextReplacement", () => {
	test("selectorKey distinguishes model for diverse but model+temperature for self-consistency", () => {
		expect(selectorKey({ model: "a", strategy: "diverse" })).toBe("a");
		expect(
			selectorKey({
				model: "a",
				temperature: 0.6,
				strategy: "self-consistency",
			}),
		).toBe("a@0.6");
	});

	test("diverse advances to the next unattempted model and exhausts", () => {
		const candidates = ["a", "b", "c"];
		expect(
			nextReplacement({
				strategy: "diverse",
				candidates,
				attemptedSelectors: new Set(["a", "b"]),
				selfConsistencyCount: 0,
			}),
		).toEqual({ model: "c", temperature: undefined, candidateIndex: 2 });
		expect(
			nextReplacement({
				strategy: "diverse",
				candidates,
				attemptedSelectors: new Set(["a", "b", "c"]),
				selfConsistencyCount: 0,
			}),
		).toBeUndefined();
	});

	test("self-consistency repeats the strongest model on the next ladder temperature and exhausts on cycle", () => {
		const candidates = ["frontier"];
		const ladder = [0.2, 0.6, 1.0];
		expect(
			nextReplacement({
				strategy: "self-consistency",
				candidates,
				temperatureLadder: ladder,
				attemptedSelectors: new Set(["frontier@0.2", "frontier@0.6"]),
				selfConsistencyCount: 2,
			}),
		).toEqual({ model: "frontier", temperature: 1.0, candidateIndex: 0 });
		expect(
			nextReplacement({
				strategy: "self-consistency",
				candidates,
				temperatureLadder: ladder,
				attemptedSelectors: new Set([
					"frontier@0.2",
					"frontier@0.6",
					"frontier@1.0",
				]),
				selfConsistencyCount: 3,
			}),
		).toBeUndefined();
	});
});

// Regression test for a live-confirmed bug: a caller supplying an explicit
// `tasks` array wrote a short `assignment` and put the real content (full
// file contents, constraints, what to check) only in the top-level `task`
// field -- believing `task` was the primary instruction and `assignment` a
// display label. It's the reverse: `assignment` is what the expert actually
// receives and acts on (dispatch.ts's buildDispatchPlan sets
// `assignment: task.assignment` on every attempt, which host-dispatcher.ts
// then sends as the expert's literal user-turn prompt); `task` only becomes
// secondary system-prompt background for the whole dispatch. Nothing in the
// schema said so, so the caller reasonably guessed backwards.
describe("assignment vs task field documentation", () => {
	test("assignment's own schema description states it's the real instruction, not a label", () => {
		const description = dispatchTaskSchema.shape.assignment.description;
		expect(description).toMatch(/actually receives and acts on/i);
		expect(description).toMatch(/not a short label/i);
	});

	test("description's own schema description states it's display-only", () => {
		const description = dispatchTaskSchema.shape.description.description;
		expect(description).toMatch(/display only/i);
	});

	test("task's own schema description warns against front-loading real content there instead of assignment", () => {
		const description = dispatchRequestSchema.shape.task.description;
		expect(description).toMatch(/secondary background/i);
		expect(description).toMatch(/assignment.*thin/i);
	});
});
