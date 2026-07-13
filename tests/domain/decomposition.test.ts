import { describe, expect, test } from "bun:test";

import { mergeLegionConfig } from "../../src/domain/config";
import {
	fallbackDecomposition,
	parseDecompositionResponse,
	resolveDecomposerPolicy,
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
				role: "security",
				assignment: "Inspect auth paths.",
			},
		]);
	});

	test("ignores a model-supplied agent field", () => {
		const tasks = parseDecompositionResponse(
			'{"tasks":[{"id":"t1","agent":"reviewer","role":"security","assignment":"Inspect auth paths."}]}',
		);

		expect(tasks[0]).toEqual({
			id: "t1",
			role: "security",
			assignment: "Inspect auth paths.",
		});
	});

	test("falls back to one general task", () => {
		expect(fallbackDecomposition("Review the change")).toEqual([
			{
				id: "generalist",
				role: "generalist",
				assignment: "Review the change",
			},
		]);
	});
});

describe("resolveDecomposerPolicy", () => {
	test("returns the configured decomposer policy", () => {
		const config = mergeLegionConfig({
			decomposer: { models: ["provider/a", "provider/b"] },
		});
		expect(resolveDecomposerPolicy(config)).toEqual({
			models: ["provider/a", "provider/b"],
			temperatureLadder: [0.2, 0.6, 1.0],
		});
	});

	test("returns undefined when no decomposer policy is configured (legacy fallback)", () => {
		const config = mergeLegionConfig({});
		expect(resolveDecomposerPolicy(config)).toBeUndefined();
	});
});
