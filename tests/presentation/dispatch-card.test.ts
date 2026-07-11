import { describe, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";

import { dispatchRequestSchema } from "../../src/domain/dispatch";
import {
	renderDispatchCall,
	renderDispatchResult,
} from "../../src/presentation/dispatch-card";

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

describe("renderDispatchCall", () => {
	test("shows auto-decompose when no explicit tasks are given", () => {
		const args = dispatchRequestSchema.parse({ task: "Review the change" });
		const card = renderDispatchCall(args, theme);

		expect(textOf(card, 0)).toContain("Legion Dispatch");
		expect(textOf(card, 1)).toContain("tasks: auto-decompose");
	});

	test("lists each explicit task by id and role", () => {
		const args = dispatchRequestSchema.parse({
			task: "Review and implement",
			tasks: [
				{ id: "t1", agent: "task", role: "reviewer", assignment: "Review it" },
				{ id: "t2", agent: "task", role: "coder", assignment: "Implement it" },
			],
		});
		const card = renderDispatchCall(args, theme);

		const body = textOf(card, 1);
		expect(body).toContain("tasks: 2 explicit");
		expect(body).toContain("t1 (reviewer)");
		expect(body).toContain("t2 (coder)");
	});
});

describe("renderDispatchResult", () => {
	test("shows job id, attempt count, and models on success", () => {
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
		);

		const body = textOf(card, 1);
		expect(body).toContain("job: LegionReviewTheChange");
		expect(body).toContain("attempts: 3");
		expect(body).toContain("models: frontier");
	});

	test("shows the error message when dispatch was rejected", () => {
		const card = renderDispatchResult(
			{
				content: [
					{ type: "text", text: "Legion dispatch rejected: bad input" },
				],
				isError: true,
			},
			theme,
		);

		expect(textOf(card, 1)).toContain("Legion dispatch rejected: bad input");
	});
});
