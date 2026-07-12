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
});

describe("buildDecomposerPrompt", () => {
	test("asks for an enhanced brief, not a copy of the raw task text", () => {
		const prompt = buildDecomposerPrompt({ task: "review this" });
		expect(prompt).toContain("review this");
		expect(prompt).toContain("enhanced brief");
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
