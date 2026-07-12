import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import type { DispatchService } from "../../src/application/dispatch-service";
import {
	createDispatchTool,
	describePhase,
} from "../../src/presentation/dispatch-tool";

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
		} as unknown as DispatchService;
		const tool = createDispatchTool(() => service);

		const result = await tool.execute(
			"call-1",
			{
				task: "Review the change",
				tasks: [
					{
						id: "review",
						agent: "reviewer",
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
		expect(result.details?.state).toBe("running");
		expect(result.content?.[0]).toEqual({
			type: "text",
			text: "Legion job job-1 accepted and running in the background.",
		});
	});
});
