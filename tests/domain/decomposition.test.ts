import { describe, expect, test } from "bun:test";

import {
	fallbackDecomposition,
	parseDecompositionResponse,
} from "../../src/domain/decomposition";

describe("task decomposition", () => {
	test("parses role-tagged tasks from the host model JSON", () => {
		const tasks = parseDecompositionResponse(`\n\`\`\`json
{"tasks":[{"id":"inspect","role":"security","assignment":"Inspect auth paths."}]}
\`\`\`
`);

		expect(tasks).toEqual([
			{
				id: "inspect",
				agent: "task",
				role: "security",
				assignment: "Inspect auth paths.",
			},
		]);
	});

	test("normalizes agent to the safe default even if the model invents one", () => {
		// The decomposer LLM has no visibility into which host agent types are
		// actually discoverable in a given project; an invented agent name here
		// previously caused every dispatched attempt to fail with zero output.
		const tasks = parseDecompositionResponse(
			'{"tasks":[{"id":"t1","agent":"reviewer","role":"security","assignment":"Inspect auth paths."}]}',
		);

		expect(tasks[0]?.agent).toBe("task");
	});

	test("falls back to one general task", () => {
		expect(fallbackDecomposition("Review the change")).toEqual([
			{
				id: "task",
				agent: "task",
				role: "generalist",
				assignment: "Review the change",
			},
		]);
	});
});
