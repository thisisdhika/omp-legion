import { describe, expect, test } from "bun:test";

import {
	fallbackDecomposition,
	parseDecompositionResponse,
} from "../../src/domain/decomposition";

describe("task decomposition", () => {
	test("parses role-tagged tasks from the host model JSON", () => {
		const tasks = parseDecompositionResponse(`\n\`\`\`json
{"tasks":[{"id":"inspect","agent":"reviewer","role":"security","assignment":"Inspect auth paths."}]}
\`\`\`
`);

		expect(tasks).toEqual([
			{
				id: "inspect",
				agent: "reviewer",
				role: "security",
				assignment: "Inspect auth paths.",
			},
		]);
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
