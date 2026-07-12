import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

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
		expect(agents.has("legion-decomposer")).toBe(true);
		expect(agents.has("legion-scout")).toBe(true);

		const coder = agents.get("legion-coder");
		expect(coder?.systemPrompt).toContain("independent attempts");
		expect(coder?.name).toBe("legion-coder");

		// legion-decomposer is loaded the same way as every other persona
		// (bundled + overridable) but is not itself an ensemble attempt — see
		// host-dispatch-service.ts, which excludes it from the agent-name set
		// resolveAgentName resolves task roles against.
		const decomposer = agents.get("legion-decomposer");
		expect(decomposer?.systemPrompt).toContain("split");
		// It must also enhance terse task text into a self-contained brief —
		// experts never see the user's original message, only "assignment".
		expect(decomposer?.systemPrompt).toContain("self-contained");
		expect(decomposer?.systemPrompt).toContain("Never fabricate");

		// legion-scout IS a normal dispatchable ensemble persona (unlike
		// legion-decomposer) — used by the /centurion skill to propose the
		// next grilling question via legion_dispatch's "scout" role.
		const scout = agents.get("legion-scout");
		expect(scout?.systemPrompt).toContain("independent attempts");
		expect(scout?.systemPrompt).toContain("recommendation");
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

	describe("project overrides — .omp/agents/legion-*.md", () => {
		let projectDir: string | undefined;

		afterEach(() => {
			if (projectDir) rmSync(projectDir, { recursive: true, force: true });
			projectDir = undefined;
		});

		function writeProjectAgent(name: string, systemPrompt: string): string {
			if (!projectDir) {
				projectDir = mkdtempSync(join(os.tmpdir(), "legion-agent-loader-"));
			}
			const agentsDir = join(projectDir, ".omp", "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, `${name}.md`),
				`---\nname: ${name}\ndescription: test persona\n---\n\n${systemPrompt}\n`,
			);
			return projectDir;
		}

		test("a user-authored legion-*.md introduces a brand new persona", async () => {
			const dir = writeProjectAgent(
				"legion-security-auditor",
				"You are a security auditor.",
			);

			const agents = await loadAgentDefinitions(
				dir,
				"/nonexistent-home-for-tests",
			);

			expect(agents.has("legion-security-auditor")).toBe(true);
			expect(agents.get("legion-security-auditor")?.systemPrompt).toContain(
				"security auditor",
			);
		});

		test("a user-authored legion-*.md overrides the bundled persona of the same name", async () => {
			const dir = writeProjectAgent(
				"legion-coder",
				"Custom project-specific coder instructions.",
			);

			const agents = await loadAgentDefinitions(
				dir,
				"/nonexistent-home-for-tests",
			);

			const coder = agents.get("legion-coder");
			expect(coder?.systemPrompt).toContain(
				"Custom project-specific coder instructions.",
			);
			expect(coder?.systemPrompt).not.toContain("independent attempts");
		});
	});

	describe("global overrides — ~/.omp/agent/agents/legion-*.md", () => {
		// The host's discoverAgents() ignores the `home` *argument* for this
		// particular scan — it resolves the user agents dir via
		// getConfigDirs(), which calls os.homedir() directly (only
		// extension/plugin discovery inside discoverAgents honors the `home`
		// param). And in this Bun runtime, os.homedir() only reads $HOME at
		// process start, not on a later in-process env var change — confirmed
		// by a direct check, not assumed — so exercising the real global
		// directory requires a fresh subprocess launched with the fixture
		// directory as HOME, not just poking process.env in this process.
		let homeDir: string | undefined;

		afterEach(() => {
			if (homeDir) rmSync(homeDir, { recursive: true, force: true });
			homeDir = undefined;
		});

		function writeGlobalAgent(name: string, systemPrompt: string): string {
			if (!homeDir) {
				homeDir = mkdtempSync(join(os.tmpdir(), "legion-agent-loader-home-"));
			}
			// Matches @oh-my-pi/pi-utils getConfigAgentDirName(): "<home>/.omp/agent/agents".
			const agentsDir = join(homeDir, ".omp", "agent", "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, `${name}.md`),
				`---\nname: ${name}\ndescription: test persona\n---\n\n${systemPrompt}\n`,
			);
			return homeDir;
		}

		/** Runs loadAgentDefinitions(projectDir) in a fresh `bun` subprocess with HOME pinned to `home`, returning `{name: systemPrompt}` for every discovered agent. */
		function loadAgentsWithHome(
			projectDir: string,
			home: string,
		): Record<string, string> {
			const script = `
				import { loadAgentDefinitions } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "src", "infrastructure", "agent-loader.ts"))};
				const agents = await loadAgentDefinitions(${JSON.stringify(projectDir)});
				const out = {};
				for (const [name, def] of agents) out[name] = def.systemPrompt;
				process.stdout.write(JSON.stringify(out));
			`;
			const stdout = execFileSync("bun", ["-e", script], {
				env: { ...process.env, HOME: home },
				encoding: "utf-8",
			});
			return JSON.parse(stdout);
		}

		test("a global legion-*.md introduces a brand new persona with no project dir involved", () => {
			const home = writeGlobalAgent(
				"legion-security-auditor",
				"You are a global security auditor.",
			);

			const agents = loadAgentsWithHome("/nonexistent-project-for-tests", home);

			expect(agents["legion-security-auditor"]).toContain(
				"global security auditor",
			);
		});

		test("a global legion-*.md overrides the bundled persona of the same name", () => {
			const home = writeGlobalAgent(
				"legion-coder",
				"Custom global coder instructions.",
			);

			const agents = loadAgentsWithHome("/nonexistent-project-for-tests", home);

			expect(agents["legion-coder"]).toContain(
				"Custom global coder instructions.",
			);
			expect(agents["legion-coder"]).not.toContain("independent attempts");
		});

		test("a project-level override wins over a global override of the same name", () => {
			const home = writeGlobalAgent(
				"legion-coder",
				"Global coder instructions.",
			);
			const projectDir = mkdtempSync(
				join(os.tmpdir(), "legion-agent-loader-project-"),
			);
			const agentsDir = join(projectDir, ".omp", "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "legion-coder.md"),
				"---\nname: legion-coder\ndescription: test persona\n---\n\nProject-level coder instructions.\n",
			);

			try {
				const agents = loadAgentsWithHome(projectDir, home);
				expect(agents["legion-coder"]).toContain(
					"Project-level coder instructions.",
				);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
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
