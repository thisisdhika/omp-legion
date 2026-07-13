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

	// Regression test for a second live-confirmed problem, discovered right
	// after fixing the first: giving the decomposer tools and pushing it to
	// write "richer" assignments made it pre-analyze the code and hand every
	// expert the same pre-formed findings/checklist/report structure. Every
	// expert already has its own read/grep/glob/lsp tools and reads the code
	// independently -- a decomposer that pre-analyzes correlates every
	// expert's blind spots to its own single read, defeating the reason
	// ensembling beats a single model in the first place (see research:
	// arXiv 2505.18949 "structural homogeneity... sufficient to constrain
	// generative behavior"; arXiv 2601.06116 on ensembles amplifying rather
	// than cancelling shared bias). Investigation must stay scoped to
	// resolving *what* the task refers to, never *what's wrong with it*.
	test("scopes tool use to resolving the reference, not analyzing behavior", () => {
		expect(text).toMatch(/resolve what the task actually refers to/i);
		expect(text).toMatch(/never to analyze the code's behavior/i);
	});

	test("explains why pre-analysis correlates the ensemble instead of helping it", () => {
		expect(text).toMatch(/correlates every expert's blind spots/i);
	});

	test("forbids prescribing analysis dimensions, checklists, or report structure", () => {
		expect(text).toMatch(/never prescribe the dimensions to check/i);
	});
});

describe("buildDecomposerPrompt", () => {
	test("asks for an enhanced brief, not a copy of the raw task text", () => {
		const prompt = buildDecomposerPrompt({ task: "review this" });
		expect(prompt).toContain("review this");
		expect(prompt).toContain("enhanced brief");
	});

	test("scopes investigation to confirming the reference is real, not analyzing it", () => {
		const prompt = buildDecomposerPrompt({ task: "review this" });
		expect(prompt).toMatch(/confirm it's real/i);
		expect(prompt).toMatch(/do not read further to analyze behavior/i);
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
