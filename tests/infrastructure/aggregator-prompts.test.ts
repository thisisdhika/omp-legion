import { describe, expect, test } from "bun:test";

import {
	DECOMPOSER_SYSTEM_PROMPT,
	buildDecomposerPrompt,
	formatAvailableRoles,
} from "../../src/infrastructure/aggregator-prompts";

describe("DECOMPOSER_SYSTEM_PROMPT (fallback)", () => {
	// This is only the safety net when agents/legion-decomposer.md fails to
	// load (see HostLlmDecomposer's systemPrompt option) — it must carry the
	// same two responsibilities as the real bundled prompt: bias against
	// splitting atomic tasks, and enhance a terse assignment into a
	// self-contained brief (experts never see the user's original message).
	const text = DECOMPOSER_SYSTEM_PROMPT.join(" ");

	test("biases against splitting atomic judgment-call tasks", () => {
		expect(text).toContain("Return exactly one task");
	});

	test("instructs enhancing the assignment into a self-contained brief", () => {
		expect(text).toContain("self-contained");
		expect(text).toContain("Never fabricate");
	});

	// Regression test for a live-confirmed regression: after the decomposer
	// gained real read/grep/glob tools, assignments got *shorter*, not
	// longer -- models commonly treat a tool-call investigation as "doing the
	// work" and then write a terse final answer, leaving what they found
	// back in the investigation instead of transcribing it into the one
	// string the expert actually receives. The prompt must explicitly name
	// and forbid this collapse, not just encourage thoroughness in general.
	test("explicitly forbids the investigate-then-write-a-short-answer collapse", () => {
		expect(text).toMatch(
			/short assignment.*(is not|isn't) efficient.*failure/i,
		);
	});
});

describe("buildDecomposerPrompt", () => {
	test("asks for an enhanced brief, not a copy of the raw task text", () => {
		const prompt = buildDecomposerPrompt({ task: "review this" });
		expect(prompt).toContain("review this");
		expect(prompt).toContain("enhanced brief");
	});

	test("instructs transcribing investigated facts into the assignment itself", () => {
		const prompt = buildDecomposerPrompt({ task: "review this" });
		expect(prompt).toMatch(/[Tt]ranscribe/);
	});
});

describe("formatAvailableRoles", () => {
	// Without this, the decomposer only ever saw a hardcoded illustrative
	// example list — a role it invents that doesn't match a loaded persona
	// now gets the whole dispatch rejected (resolveAgentName no longer
	// silently substitutes a generic agent), so this is what actually grounds
	// role choice in what's real.
	test("lists each role with its real description", () => {
		const block = formatAvailableRoles([
			{ role: "coder", description: "Implementation specialist." },
			{ role: "security-auditor", description: "Custom project persona." },
		]);
		expect(block).toContain("- coder: Implementation specialist.");
		expect(block).toContain("- security-auditor: Custom project persona.");
	});

	test("tells the model an unmatched role rejects the dispatch, not substitutes", () => {
		const block = formatAvailableRoles([{ role: "coder", description: "x" }]);
		expect(block).toContain("rejected");
		expect(block).toContain("generalist");
	});

	test("returns an empty string when no roster is available", () => {
		expect(formatAvailableRoles([])).toBe("");
	});
});
