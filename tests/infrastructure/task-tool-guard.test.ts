import { describe, expect, test } from "bun:test";

import { targetsLegionAgent } from "../../src/infrastructure/task-tool-guard";

describe("targetsLegionAgent", () => {
	test("blocks a single-spawn task call targeting a legion-* agent", () => {
		expect(targetsLegionAgent({ agent: "legion-coder" })).toBe(true);
	});

	test("blocks a batch task call if any entry targets a legion-* agent", () => {
		expect(
			targetsLegionAgent({
				tasks: [{ agent: "explore" }, { agent: "legion-reviewer" }],
			}),
		).toBe(true);
	});

	test("does not block calls to non-legion agents", () => {
		expect(targetsLegionAgent({ agent: "task" })).toBe(false);
		expect(targetsLegionAgent({ tasks: [{ agent: "explore" }] })).toBe(false);
	});

	test("does not block when the agent field is absent or input is malformed", () => {
		expect(targetsLegionAgent({})).toBe(false);
		expect(targetsLegionAgent(null)).toBe(false);
		expect(targetsLegionAgent("not an object")).toBe(false);
	});
});
