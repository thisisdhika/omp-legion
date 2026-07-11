import { describe, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";

import { dispatchRequestSchema } from "../../src/domain/dispatch";
import { renderDispatchResult } from "../../src/presentation/dispatch-card";

// Minimal stand-in for Theme's optional-chained methods (theme.icon?.x,
// theme.fg?.(name, text)) -- the card only ever reads through those.
const theme = {
	icon: { extensionTool: "⌘", warning: "⚠" },
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function textOf(container: { children: unknown[] }, index: number): string {
	const child = container.children[index];
	if (!(child instanceof Text)) throw new Error(`child ${index} is not Text`);
	return child.getText();
}

describe("renderDispatchResult", () => {
	// renderCall + renderResult on the same tool render as two separately
	// headed blocks rather than one merged card (the predecessor project's
	// documented platform quirk) -- this card is the single combined
	// call+result view, driven only by renderResult's args parameter.
	test("shows auto-decompose when no explicit tasks were given", () => {
		const args = dispatchRequestSchema.parse({ task: "Review the change" });
		const card = renderDispatchResult(
			{
				content: [{ type: "text", text: "scheduled" }],
				details: {
					jobId: "LegionReviewTheChange",
					recordId: "LegionReviewTheChange",
					state: "running",
					attemptCount: 3,
					attemptModels: ["frontier", "frontier", "frontier"],
				},
			},
			theme,
			args,
		);

		const body = textOf(card, 0);
		expect(body).toContain("tasks: auto-decompose");
		expect(body).toContain("job: LegionReviewTheChange");
		expect(body).toContain("attempts: 3");
		expect(body).toContain("models: frontier");
	});

	test("lists each explicit task by id and role", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review and implement",
			tasks: [
				{ id: "t1", agent: "task", role: "reviewer", assignment: "Review it" },
				{ id: "t2", agent: "task", role: "coder", assignment: "Implement it" },
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
				},
			},
			theme,
			args,
		);

		const body = textOf(card, 0);
		expect(body).toContain("tasks: 2 explicit");
		expect(body).toContain("t1 (reviewer)");
		expect(body).toContain("t2 (coder)");
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
			theme,
			args,
		);

		expect(textOf(card, 0)).toContain("Legion dispatch rejected: bad input");
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
				},
			},
			theme,
		);

		expect(textOf(card, 0)).toContain("job: LegionDispatch");
	});
});
