import { beforeAll, describe, expect, test } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

import { dispatchRequestSchema } from "../../src/domain/dispatch";
import { renderDispatchResult } from "../../src/presentation/dispatch-card";

const defaultOptions = { expanded: false, isPartial: false };
const WIDTH = 100;

// The card is built on the platform's framedBlock/renderStatusLine (the same
// primitives the built-in `task` tool uses), which read real Theme surface
// (boxRound, sep, getBgAnsi, styledSymbol, ...) well beyond what a hand-rolled
// stub could cheaply fake -- so exercise it against an actual built-in theme
// and assert on the rendered (ANSI-stripped) text, same as a terminal would.
let theme: Theme;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes for text assertions
const ANSI = /\x1b\[[0-9;]*m/g;

function renderText(card: {
	render(width: number): readonly string[];
}): string {
	return card.render(WIDTH).join("\n").replace(ANSI, "");
}

beforeAll(async () => {
	const resolved = await getThemeByName("dark");
	if (!resolved) throw new Error("dark theme not found");
	theme = resolved;
});

describe("renderDispatchResult", () => {
	test("shows the actual auto-decomposed breakdown, not a static placeholder", () => {
		const args = dispatchRequestSchema.parse({ task: "Review the change" });
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "LegionReviewTheChange",
					recordId: "LegionReviewTheChange",
					state: "running",
					attemptCount: 3,
					attemptModels: ["frontier-a", "frontier-b", "frontier-c"],
					// dispatch() always resolves >=1 breakdown entry, even for
					// auto-decompose — this is what a real accepted dispatch looks
					// like (a single generic task attempted by 3 experts).
					taskBreakdown: [
						{
							taskId: "task",
							agent: "legion-coder",
							attemptCount: 3,
							models: ["frontier-a", "frontier-b", "frontier-c"],
						},
					],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("Legion");
		expect(body).toContain("running in background");
		expect(body).toContain("Task");
		expect(body).toContain("Review the change");
		expect(body).not.toContain("auto-decompose");
		expect(body).toContain("Mixtures");
		expect(body).toContain("ref: LegionReviewTheChange");
		expect(body).toContain("experts: ~3 models");
	});

	// Regression test: dispatch()'s synchronous preview (what this card
	// renders) always resolves auto-decompose through fallbackDecomposition,
	// a generic placeholder role/agent -- the real decomposer runs later, in
	// the background job, and picks the actual role (e.g. "reviewer") based
	// on the task. That real choice is invisible to this card, so naming the
	// placeholder agent here ("generalist"/"legion-coder"/whatever the
	// fallback happened to resolve to) previously showed a guess as though it
	// were the real, final routing decision -- which it demonstrably wasn't.
	test("never names a specific agent for auto-decompose (the breakdown is a placeholder guess)", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review this JavaScript function for bugs",
		});
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "legion-review-this-javascript",
					recordId: "legion-review-this-javascript",
					state: "running",
					attemptCount: 2,
					attemptModels: ["frontier-a", "frontier-b"],
					taskBreakdown: [
						{
							taskId: "task",
							agent: "legion-generalist",
							attemptCount: 2,
							models: ["frontier-a", "frontier-b"],
						},
					],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("ref: legion-review-this-javascript");
		expect(body).toContain("experts: ~2 models");
		expect(body).not.toContain("generalist");
		expect(body).not.toContain("legion-generalist");
	});

	test("groups explicit tasks by agent and doesn't leak full model paths", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review this JavaScript function for bugs",
			tasks: [
				{
					id: "t1",
					role: "coder",
					assignment: "Find the bug",
				},
				{
					id: "t2",
					role: "reviewer",
					assignment: "Review the fix",
				},
			],
		});
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "legion-review-this-javascript",
					recordId: "legion-review-this-javascript",
					state: "running",
					attemptCount: 3,
					attemptModels: [
						"opencode-zen/mimo-v2.5-free",
						"openrouter/tencent/hy3:free",
						"opencode-zen/mimo-v2.5-free",
					],
					taskBreakdown: [
						{
							taskId: "t1",
							agent: "legion-coder",
							attemptCount: 2,
							models: [
								"opencode-zen/mimo-v2.5-free",
								"openrouter/tencent/hy3:free",
							],
						},
						{
							taskId: "t2",
							agent: "legion-reviewer",
							attemptCount: 1,
							models: ["opencode-zen/mimo-v2.5-free"],
						},
					],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("ref: legion-review-this-javascript");
		expect(body).toContain("experts:");
		expect(body).toContain("coder: ~2 models");
		expect(body).toContain("reviewer: ~1 model");
		// Model names/routing prefixes aren't listed -- the retry/expansion
		// system can swap them out from under this snapshot.
		expect(body).not.toContain("mimo-v2.5-free");
		expect(body).not.toContain("hy3:free");
	});

	// Regression test for a live-confirmed bug: two explicit tasks assigned to
	// the same role/agent, each drawing from the identical 3-model ensemble,
	// previously summed attempt counts across tasks (2 tasks x 3 attempts = 6)
	// and showed "~6 models" -- overstating diversity, since only 3 distinct
	// models actually back the ensemble. Deduping by model identifier across
	// both tasks must report the true distinct count.
	test("dedupes distinct models across multiple tasks assigned to the same role", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review file A and file B",
			tasks: [
				{
					id: "t1",
					role: "reviewer",
					assignment: "Review file A",
				},
				{
					id: "t2",
					role: "reviewer",
					assignment: "Review file B",
				},
			],
		});
		const sharedModels = [
			"provider/model-a",
			"provider/model-b",
			"provider/model-c",
		];
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "legion-two-reviews",
					recordId: "legion-two-reviews",
					state: "running",
					attemptCount: 6,
					attemptModels: [...sharedModels, ...sharedModels],
					taskBreakdown: [
						{
							taskId: "t1",
							agent: "legion-reviewer",
							attemptCount: 3,
							models: sharedModels,
						},
						{
							taskId: "t2",
							agent: "legion-reviewer",
							attemptCount: 3,
							models: sharedModels,
						},
					],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("reviewer: ~3 models");
		expect(body).not.toContain("~6 models");
	});

	test("parses markdown in the task text instead of printing it literally", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review this function:\n\n```js\nfunction add(a,b){return a+b}\n```",
		});
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "LegionReviewFn",
					recordId: "LegionReviewFn",
					state: "running",
					attemptCount: 1,
					attemptModels: ["frontier"],
					taskBreakdown: [],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		// Parsed as a fenced code block (indented, set apart from the prose
		// line above it by a blank line) rather than dumped as one literal run.
		expect(body).toContain("Review this function:");
		expect(body).toContain("  function add(a,b){return a+b}");
	});

	test("groups explicit multi-task requests by agent the same way as auto-decomposed ones", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review and implement",
			tasks: [
				{ id: "t1", role: "reviewer", assignment: "Review it" },
				{ id: "t2", role: "coder", assignment: "Implement it" },
			],
		});
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "LegionReviewAndImplement",
					recordId: "LegionReviewAndImplement",
					state: "running",
					attemptCount: 2,
					attemptModels: ["frontier", "frontier"],
					taskBreakdown: [
						{
							taskId: "t1",
							agent: "legion-reviewer",
							attemptCount: 1,
							models: ["frontier"],
						},
						{
							taskId: "t2",
							agent: "legion-coder",
							attemptCount: 1,
							models: ["claude"],
						},
					],
				},
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("Task");
		expect(body).toContain("Review and implement");
		expect(body).toContain("ref: LegionReviewAndImplement");
		expect(body).toContain("experts:");
		expect(body).toContain("reviewer: ~1 model");
		expect(body).toContain("coder: ~1 model");
		// The internal task ids (t1/t2) are bookkeeping, not something a human
		// needs to see — only the resolved agent doing each piece of work.
		expect(body).not.toContain("t1");
		expect(body).not.toContain("t2");
	});

	test("shows the error message when dispatch was rejected", () => {
		const args = dispatchRequestSchema.parse({ task: "Review the change" });
		const card = renderDispatchResult(
			{
				content: [
					{ type: "text", text: "Legion dispatch rejected: bad input" },
				],
				isError: true,
			},
			defaultOptions,
			theme,
			args,
		);

		const body = renderText(card);
		expect(body).toContain("dispatch failed");
		expect(body).toContain("Legion dispatch rejected: bad input");
	});

	test("renders without args when none are available", () => {
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "LegionDispatch",
					recordId: "LegionDispatch",
					state: "running",
					attemptCount: 1,
					attemptModels: ["frontier"],
					taskBreakdown: [],
				},
			},
			defaultOptions,
			theme,
		);

		const body = renderText(card);
		expect(body).toContain("ref: LegionDispatch");
		expect(body).toContain("experts: ~1 model");
	});

	test("shows a spinner-driven header when isPartial is true", () => {
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "⠋ SYNTHESIZING — merging outputs…" }],
				details: {
					jobId: "LegionJob",
					recordId: "LegionJob",
					state: "running",
					attemptCount: 3,
					attemptModels: [],
					taskBreakdown: [],
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);

		const body = renderText(card);
		expect(body).toContain("Legion");
		expect(body).toContain("SYNTHESIZING — merging outputs");
	});

	test("renders the synthesis result as a labeled Result section", () => {
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "## ignored duplicate" }],
				details: {
					jobId: "LegionJob",
					recordId: "LegionJob",
					state: "completed",
					attemptCount: 2,
					attemptModels: ["frontier"],
					taskBreakdown: [],
					resultText: "## Synthesis\n\n**Answer:** done",
				},
			},
			defaultOptions,
			theme,
		);

		const body = renderText(card);
		expect(body).toContain("synthesis complete");
		expect(body).toContain("Result");
		expect(body).toContain("Synthesis");
		expect(body).toContain("Answer:");
		expect(body).toContain("done");
	});
});
