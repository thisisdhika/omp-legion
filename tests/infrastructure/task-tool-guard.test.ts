import { describe, expect, test } from "bun:test";

import { targetsLegionAgent } from "../../src/infrastructure/task-tool-guard";

describe("targetsLegionAgent", () => {
	test("blocks a single-spawn task call targeting a legion-* agent", () => {
		expect(targetsLegionAgent({ agent: "legion-coder" })).toBe(true);
	});

	// legion-decomposer is a planning-only persona (see agents/legion-decomposer.md)
	// — it must be exactly as unreachable via the native task tool as any
	// other legion-* persona, even though it's never dispatched as an
	// ensemble attempt either (see host-dispatch-service.ts's exclusion from
	// resolveAgentName's agent-name set).
	test("blocks the decomposer persona specifically, same as any other legion-* agent", () => {
		expect(targetsLegionAgent({ agent: "legion-decomposer" })).toBe(true);
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
