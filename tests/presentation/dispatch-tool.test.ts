import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

import type { DispatchService } from "../../src/application/dispatch-service";
import {
	createDispatchTool,
	describePhase,
} from "../../src/presentation/dispatch-tool";
import { buildProgressText } from "../../src/presentation/spinner";

let theme: Theme;
beforeAll(async () => {
	const resolved = await getThemeByName("dark");
	if (!resolved) throw new Error("dark theme not found");
	theme = resolved;
});

describe("createDispatchTool description", () => {
	// Regression test for a live-confirmed friction point: given an explicit
	// tasks array to fill in itself, the primary agent burned two rejected
	// dispatch attempts guessing the role-string convention (tried "Correctness
	// reviewer", then "legion-reviewer") before landing on the correct bare
	// "reviewer" on the third try. The tool's own description must state the
	// convention up front so agents get it right the first time.
	test("documents the bare-role-name convention for explicit tasks", () => {
		const tool = createDispatchTool(() => undefined);
		expect(tool.description).toContain("bare role name");
		expect(tool.description).toMatch(/legion-reviewer.*rejected/);
	});

	// Regression test for a live-confirmed bug: a caller supplying explicit
	// tasks wrote a short assignment and put the real content only in the
	// top-level task field, believing task was the primary instruction --
	// it's the reverse (assignment is what the expert actually receives).
	test("warns explicit-tasks callers that assignment, not task, reaches the expert", () => {
		const tool = createDispatchTool(() => undefined);
		expect(tool.description).toMatch(
			/assignment.*is the actual instruction the expert receives/i,
		);
	});

	// Semantic consistency test: the tool description and the schema descriptions
	// must agree on the task/assignment contract. The task field is visible to
	// experts as secondary/background context; assignment is the actual primary
	// instruction. A contradiction between these was caught by a reviewer in
	// commit 4b21caa and must not regress.
	test("tool description agrees with schema: task is secondary background, assignment is primary", () => {
		const tool = createDispatchTool(() => undefined);
		// Tool description must not claim task is invisible
		expect(tool.description).not.toMatch(/expert.*does not see.*task/i);
		expect(tool.description).not.toMatch(/expert never sees.*task/i);
		// Tool description must state task is secondary/background
		expect(tool.description).toMatch(
			/task.*secondary background|secondary.*background.*task/i,
		);
		// Tool description must state assignment is the actual/primary instruction
		expect(tool.description).toMatch(
			/assignment.*(actual|primary) instruction/i,
		);
	});

	test("tool description agrees with schema: assignment is the real instruction", () => {
		const tool = createDispatchTool(() => undefined);
		expect(tool.description).toMatch(
			/assignment.*is the (actual|real|primary) instruction/i,
		);
	});
});

describe("describePhase", () => {
	// Regression coverage for a real incident: the widget showed "ROUTING —
	// selecting experts" for 4+ minutes on a live dispatch that was actually
	// deep into decomposition, then running experts, with subagents visibly
	// executing the whole time — because the old implementation guessed the
	// phase from substring-matching lastProgressText's prose, and nothing had
	// ever reported progress containing a matching keyword yet. Each case
	// here is a real `details` payload dispatch-service.ts actually attaches.
	test("no progress reported yet reads as QUEUED, not a guessed phase", () => {
		expect(describePhase(undefined)).toEqual({
			label: "QUEUED",
			detail: "waiting to start",
		});
	});

	test("decomposing — reported before the (possibly slow) LLM call, not just on failure", () => {
		expect(describePhase({ phase: "decomposing" })).toEqual({
			label: "DECOMPOSING",
			detail: "deciding how to split the task",
		});
	});

	test("running — shows live completed/total counts when reported", () => {
		expect(describePhase({ phase: "running", completed: 2, total: 3 })).toEqual(
			{
				label: "RUNNING",
				detail: "2/3 experts finished",
			},
		);
	});

	test("running — falls back to a generic detail when counts aren't present", () => {
		expect(describePhase({ phase: "running" })).toEqual({
			label: "RUNNING",
			detail: "experts working",
		});
	});

	test("retrying — names the model it retried on, shortened", () => {
		expect(
			describePhase({
				phase: "retrying",
				model: "openrouter/tencent/hy3:free",
			}),
		).toEqual({
			label: "RETRYING",
			detail: "retrying on hy3:free",
		});
	});

	test("expanding — names the expansion model, shortened", () => {
		expect(
			describePhase({
				phase: "expanding",
				model: "opencode-zen/mimo-v2.5-free",
			}),
		).toEqual({
			label: "EXPANDING",
			detail: "one more attempt on mimo-v2.5-free",
		});
	});

	test("synthesizing", () => {
		expect(describePhase({ phase: "synthesizing" })).toEqual({
			label: "SYNTHESIZING",
			detail: "merging outputs",
		});
	});

	test("escalated — names the governance reasons that triggered it", () => {
		expect(
			describePhase({
				phase: "escalated",
				reasons: ["confidence", "disagreement"],
			}),
		).toEqual({
			label: "ESCALATED",
			detail: "waiting on a human — confidence, disagreement",
		});
	});

	test("escalated — falls back to a generic detail when reasons aren't present", () => {
		expect(describePhase({ phase: "escalated" })).toEqual({
			label: "ESCALATED",
			detail: "waiting on a human decision",
		});
	});

	test("an unrecognized phase value falls back to QUEUED rather than throwing", () => {
		expect(describePhase({ phase: "not-a-real-phase" })).toEqual({
			label: "QUEUED",
			detail: "waiting to start",
		});
	});

	test("does not treat total attempts as currently running", () => {
		const text = buildProgressText("RUNNING — 2/3 experts finished", 0);
		expect(text).not.toContain("(3 running)");
	});
});

describe("createDispatchTool", () => {
	test("dispatches through the session-scoped service resolver", async () => {
		const calls: string[] = [];
		const service = {
			dispatch(_params: unknown, toolCallId?: string) {
				calls.push(toolCallId ?? "missing");
				return {
					jobId: "job-1",
					recordId: "job-1",
					attemptCount: 3,
					attemptModels: ["provider/model"],
					taskBreakdown: [
						{ taskId: "review", attemptCount: 3, models: ["provider/model"] },
					],
				};
			},
			getJob() {
				return {
					status: "completed" as const,
					resultText: "Synthesized result",
					promise: Promise.resolve(),
				};
			},
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		const result = await tool.execute(
			"call-1",
			{
				task: "Review the change",
				tasks: [
					{
						id: "review",
						role: "reviewer",
						assignment: "Review it",
					},
				],
				modelMap: {},
				defaultEnsembleSize: 3,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(calls).toEqual(["call-1"]);
		expect(result.details?.jobId).toBe("job-1");
		expect(result.details?.state).toBe("completed");
		expect(result.content?.[0]).toEqual({
			type: "text",
			text: "Synthesized result",
		});
	});

	test("cancels and returns a clear error when the outer wait times out", async () => {
		let cancelled = false;
		const service = {
			dispatch: () => ({
				jobId: "job-timeout",
				recordId: "job-timeout",
				attemptCount: 1,
				attemptModels: ["provider/model"],
				taskBreakdown: [],
			}),
			getDispatchTimeoutMs: () => 10,
			cancel: () => {
				cancelled = true;
				return true;
			},
			getJob: () => ({
				status: "running" as const,
				promise: new Promise<void>(() => {}),
			}),
		} as unknown as DispatchService;
		const result = await createDispatchTool(() => service).execute(
			"call-timeout",
			{
				task: "Review the change",
				tasks: [{ id: "review", role: "reviewer", assignment: "Review it" }],
				modelMap: {},
				defaultEnsembleSize: 3,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(cancelled).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]).toEqual({
			type: "text",
			text: "Legion dispatch timed out after 10ms.",
		});
	});

	// Regression test for a live-confirmed bug: two or more concurrent
	// dispatches (a genuinely multi-part user request fanning out into
	// several legion_dispatch calls) rendered visually identical widgets --
	// "Legion | 0:54" with no way to tell which task each belonged to. The
	// widget header must include a label distinguishing this job from any
	// sibling job running at the same time.
	test("labels the live widget with the job's own short id, not a bare 'Legion'", async () => {
		const service = {
			dispatch() {
				return {
					jobId: "legion-review-the-following",
					recordId: "legion-review-the-following",
					attemptCount: 3,
					attemptModels: ["provider/model"],
					taskBreakdown: [],
				};
			},
			getJob() {
				// Completed immediately so monitorWidget's background loop exits
				// on its first check without ever needing a real sleep/timer.
				return {
					status: "completed" as const,
					lastProgressDetails: undefined,
					promise: Promise.resolve(),
				};
			},
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		let capturedRender:
			| ((
					tui: unknown,
					theme: Theme,
			  ) => { render: (width: number) => readonly string[] })
			| undefined;
		const ctx = {
			ui: {
				setWidget: (
					_key: string,
					render:
						| ((
								tui: unknown,
								theme: Theme,
						  ) => { render: (width: number) => readonly string[] })
						| undefined,
				) => {
					if (render) capturedRender = render;
				},
			},
		} as unknown as ExtensionContext;

		await tool.execute(
			"call-1",
			{
				task: "Review the following module",
				modelMap: {},
				defaultEnsembleSize: 3,
			},
			undefined,
			undefined,
			ctx,
		);

		expect(capturedRender).toBeDefined();
		const box = capturedRender?.(undefined, theme);
		const lines = box?.render(80) ?? [];
		const headerLine = lines.find((line) => line.includes("Legion"));
		expect(headerLine).toContain("review-the-following");
	});

	// Regression test for a user-reported ordering bug: concurrent dispatches
	// used to render into separate widget keys, one per job. The host's own
	// setHookWidget unconditionally deletes and re-inserts a key's entry into
	// its internal Map on every single call -- even an in-place update --
	// which pushes that key to the end of the Map's iteration order every
	// time. With one widget key per job, two concurrent dispatches ticking
	// their own spinners independently would keep leapfrogging each other in
	// display order. All concurrent jobs must render into one shared widget,
	// ordered by first-appeared order, and that order must stay stable as
	// each job's own spinner keeps ticking independently.
	test("keeps concurrent jobs in first-appeared order across independent spinner ticks", async () => {
		const jobs = new Map<string, { status: "running" | "completed" }>();
		const service = {
			dispatch(params: { task: string }) {
				const jobId = params.task === "first" ? "legion-alpha" : "legion-beta";
				jobs.set(jobId, { status: "running" });
				return {
					jobId,
					recordId: jobId,
					attemptCount: 1,
					attemptModels: ["provider/model"],
					taskBreakdown: [],
				};
			},
			getJob(jobId: string) {
				return {
					status: jobs.get(jobId)?.status ?? "running",
					lastProgressDetails: undefined,
					promise: Promise.resolve(),
				};
			},
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		let capturedRender:
			| ((
					tui: unknown,
					theme: Theme,
			  ) => { render: (width: number) => readonly string[] })
			| undefined;
		const ctx = {
			ui: {
				setWidget: (
					_key: string,
					render:
						| ((
								tui: unknown,
								theme: Theme,
						  ) => { render: (width: number) => readonly string[] })
						| undefined,
				) => {
					if (render) capturedRender = render;
				},
			},
		} as unknown as ExtensionContext;

		await tool.execute(
			"call-1",
			{ task: "first", modelMap: {}, defaultEnsembleSize: 3 },
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"call-2",
			{ task: "second", modelMap: {}, defaultEnsembleSize: 3 },
			undefined,
			undefined,
			ctx,
		);

		const readOrder = () => {
			const lines = capturedRender?.(undefined, theme)?.render(80) ?? [];
			const text = lines.join("\n");
			return { alphaAt: text.indexOf("alpha"), betaAt: text.indexOf("beta") };
		};

		const initial = readOrder();
		expect(initial.alphaAt).toBeGreaterThanOrEqual(0);
		expect(initial.betaAt).toBeGreaterThan(initial.alphaAt);

		// Let each job's independent spinner interval tick a few times (they
		// are not synchronized with each other) and re-render repeatedly --
		// order must stay alpha-before-beta throughout, not swap.
		await new Promise((resolve) => setTimeout(resolve, 250));
		const afterTicks = readOrder();
		expect(afterTicks.alphaAt).toBeGreaterThanOrEqual(0);
		expect(afterTicks.betaAt).toBeGreaterThan(afterTicks.alphaAt);

		jobs.set("legion-alpha", { status: "completed" });
		jobs.set("legion-beta", { status: "completed" });
	});

	// Regression test for a live-confirmed bug: the widget's spinner tick
	// (reading lastProgressDetails.phase) and its separate background loop
	// (polling job.status) can disagree about whether the job is done -- a
	// live run showed "[COMPLETED] done" with a still-ticking clock because
	// lastProgressDetails already said "completed" while job.status hadn't
	// caught up yet. The widget must clear as soon as EITHER signal says the
	// job reached a terminal phase, not only once both agree.
	test("clears the widget as soon as lastProgressDetails reports a terminal phase, even if job.status lags", async () => {
		const service = {
			dispatch() {
				return {
					jobId: "job-1",
					recordId: "job-1",
					attemptCount: 1,
					attemptModels: ["provider/model"],
					taskBreakdown: [],
				};
			},
			getJob() {
				return {
					// status deliberately still "running" -- simulates the
					// scheduler lagging behind the job's own last progress report.
					status: "running" as const,
					lastProgressDetails: { phase: "completed" },
					promise: Promise.resolve(),
					resultText: "done",
				};
			},
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		let widgetCleared = false;
		const ctx = {
			ui: {
				setWidget: (_key: string, render: unknown) => {
					if (render === undefined) widgetCleared = true;
				},
			},
		} as unknown as ExtensionContext;

		await tool.execute(
			"call-1",
			{ task: "Review the change", modelMap: {}, defaultEnsembleSize: 3 },
			undefined,
			undefined,
			ctx,
		);

		expect(widgetCleared).toBe(true);
	});
});
