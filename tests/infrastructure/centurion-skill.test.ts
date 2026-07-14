import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dispatchTaskSchema } from "../../src/domain/dispatch";
const SKILL_PATH = join(import.meta.dir, "../../skills/centurion/SKILL.md");

// Regression test for a live-confirmed bug: this host only recognizes the
// literal `/skill:<name>` slash-command form (see
// @oh-my-pi/pi-coding-agent's parseSkillInvocation) — a bare `/<name>` is
// never parsed as a command at all and falls through as ordinary chat text.
// centurion's own frontmatter description used to instruct users/the model
// to trigger on the literal string "/centurion", which this host never
// recognizes; combined with `disable-model-invocation: true` (which hides
// the skill from the system prompt entirely, so the model can't fall back to
// noticing the phrase on its own), the skill was completely unreachable in a
// live session — confirmed by two separate failed live invocation attempts.
describe("centurion skill documentation", () => {
	const content = readFileSync(SKILL_PATH, "utf-8");

	test("does not advertise the unrecognized bare /centurion command as a trigger", () => {
		expect(content).not.toContain('"/centurion"');
	});

	test("documents the real /skill:centurion invocation form", () => {
		expect(content).toContain("/skill:centurion");
	});

	test("still opts out of model-invocation (deliberate: latency/cost warrants an explicit command)", () => {
		expect(content).toMatch(/disable-model-invocation:\s*true/);
	});
	test("documents the blocking legion_dispatch contract", () => {
		expect(content).toContain(
			"legion_dispatch` blocks until decomposition, expert execution, synthesis",
		);
		expect(content).not.toContain("returns immediately with a job id");
		expect(content).not.toContain("Go dark until the real result arrives");
	});

	test("documents schema-valid task metadata in the example", () => {
		expect(content).toContain(
			'description: "Choose the sharpest unresolved question."',
		);
	});
	test("parses the documented scout task example against the dispatch schema", () => {
		expect(
			dispatchTaskSchema.parse({
				id: "scout-<round>",
				role: "scout",
				description: "Choose the sharpest unresolved question.",
				assignment: "<the assignment from step 1>",
			}),
		).toMatchObject({ role: "scout", description: expect.any(String) });
	});

	test("does not describe a detached async handoff", () => {
		expect(content).not.toContain("returns immediately with a job id");
		expect(content).not.toContain("The job's synthesized text arrives later");
	});
});
