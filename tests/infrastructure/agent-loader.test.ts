import { describe, expect, test } from "bun:test";

import {
	bundledAgentFilePaths,
	isLegionAgentName,
	loadAgentDefinitions,
} from "../../src/infrastructure/agent-loader";

describe("isLegionAgentName", () => {
	test("matches the legion- prefix", () => {
		expect(isLegionAgentName("legion-coder")).toBe(true);
		expect(isLegionAgentName("task")).toBe(false);
		expect(isLegionAgentName("halo-coder")).toBe(false);
	});
});

describe("loadAgentDefinitions", () => {
	test("discovers Legion's bundled personas from its own package source", async () => {
		// No project/user .omp/agents dir exists at this cwd, so this exercises
		// the bundled-only path — the one discoverAgents() alone cannot reach.
		const agents = await loadAgentDefinitions(
			process.cwd(),
			"/nonexistent-home-for-tests",
		);

		expect(agents.has("legion-coder")).toBe(true);
		expect(agents.has("legion-reviewer")).toBe(true);
		expect(agents.has("legion-tester")).toBe(true);
		expect(agents.has("legion-generalist")).toBe(true);

		const coder = agents.get("legion-coder");
		expect(coder?.systemPrompt).toContain("independent attempts");
		expect(coder?.name).toBe("legion-coder");
	});

	test("never includes a non-legion-prefixed agent", async () => {
		const agents = await loadAgentDefinitions(
			process.cwd(),
			"/nonexistent-home-for-tests",
		);
		for (const name of agents.keys()) {
			expect(isLegionAgentName(name)).toBe(true);
		}
	});
});

describe("bundledAgentFilePaths", () => {
	test("enumerates every bundled persona .md the packaging smoke test must ship", () => {
		const paths = bundledAgentFilePaths();
		for (const p of paths) {
			expect(p).toMatch(/agents\/legion-.*\.md$/);
		}
	});
});
