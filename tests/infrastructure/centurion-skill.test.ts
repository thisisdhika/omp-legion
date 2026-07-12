import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

	// Regression test for a live-confirmed bug: after dispatching the scout
	// round, the primary agent's turn kept going and presented a question
	// built from its own reasoning instead of stopping to wait for the real
	// legion_dispatch result -- "wait for the result" alone wasn't a concrete
	// enough instruction to stop the model from filling the gap with a guess.
	test("explicitly forbids drafting a question/recommendation before the real result is delivered", () => {
		expect(content).toMatch(/[Dd]o not draft a question/);
		expect(content).toMatch(/[Dd]o not draft (a )?recommendation/);
	});

	test("names the actual failure mode this is guarding against", () => {
		expect(content).toContain("This has actually happened");
	});
});
