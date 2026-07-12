import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	buildRuleFromMarkdown,
	createSourceMeta,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

import { bundledAgentFilePaths } from "../../src/infrastructure/agent-loader";

/**
 * Audited OMP discovery conventions (from @oh-my-pi/pi-coding-agent):
 *  - extension-package agents are discovered from `<ext>/agents/*.md`
 *    (task/discovery.ts) and rules from `<ext>/rules/*` (discovery/omp-plugins.ts).
 * Legion ships its personas at the extension-package `agents/` root (the OMP
 * convention) and its usage rule at `rules/`, so the host loader finds both
 * when the package is registered as an OMP extension. The smoke test below
 * packs the package, extracts it, and proves the rule + every bundled persona
 * (1) ship in the tarball, (2) match the source checkout byte-for-byte, and
 * (3) are discoverable by the host loader — via discoverAgents() over an
 * injected extension root for agents, and via the rule builder for the rule.
 */
const REPO_ROOT = join(import.meta.dir, "../..");

const tempDirs: string[] = [];
let packed: { root: string; tarball: string };
let tmpHome: string;

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function spawn(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	const out = await new Response(proc.stdout).text();
	if (code !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`${cmd.join(" ")} exited ${code}: ${err}`);
	}
	return out;
}

async function packAndExtract(): Promise<{ root: string; tarball: string }> {
	const packDir = mkdtempSync(join(tmpdir(), "legion-pack-"));
	tempDirs.push(packDir);
	await spawn(
		["bun", "pm", "pack", "--destination", packDir, "--quiet"],
		REPO_ROOT,
	);
	const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
	if (!tgz) throw new Error(`bun pm pack produced no tarball in ${packDir}`);
	const tarball = join(packDir, tgz);
	const extractDir = mkdtempSync(join(tmpdir(), "legion-extract-"));
	tempDirs.push(extractDir);
	await spawn(["tar", "-xzf", tarball, "-C", extractDir], REPO_ROOT);
	return { root: join(extractDir, "package"), tarball };
}

beforeAll(async () => {
	packed = await packAndExtract();
	tmpHome = mkdtempSync(join(tmpdir(), "legion-home-"));
	tempDirs.push(tmpHome);
});

describe("packaging — installed-package discovery matches source checkout", () => {
	test("rules/legion-dispatch.md and every bundled persona ship in the tarball", () => {
		expect(() =>
			readFileSync(join(packed.root, "rules/legion-dispatch.md"), "utf-8"),
		).not.toThrow();

		const personas = bundledAgentFilePaths();
		expect(personas.length).toBeGreaterThan(0);
		for (const src of personas) {
			const rel = `agents/${basename(src)}`;
			expect(() => readFileSync(join(packed.root, rel), "utf-8")).not.toThrow();
		}
	});

	test("packed files are byte-identical to the source checkout", () => {
		const ruleSrc = join(REPO_ROOT, "rules/legion-dispatch.md");
		const rulePacked = join(packed.root, "rules/legion-dispatch.md");
		expect(readFileSync(rulePacked, "utf-8")).toBe(
			readFileSync(ruleSrc, "utf-8"),
		);

		for (const src of bundledAgentFilePaths()) {
			const rel = `agents/${basename(src)}`;
			expect(readFileSync(join(packed.root, rel), "utf-8")).toBe(
				readFileSync(src, "utf-8"),
			);
		}
	});

	test("packed rule is discoverable by the host rule loader", () => {
		const rulePacked = join(packed.root, "rules/legion-dispatch.md");
		const content = readFileSync(rulePacked, "utf-8");
		const source = createSourceMeta(
			"legion-packaging-smoke",
			rulePacked,
			"project",
		);
		const rule = buildRuleFromMarkdown(
			basename(rulePacked),
			content,
			rulePacked,
			source,
			{ stripNamePattern: /\.md$/ },
		);
		expect(rule.name).toBe("legion-dispatch");
		expect(rule.alwaysApply).toBe(true);
	});

	test("packed personas are discovered by the host over an OMP extension root", async () => {
		// Wire the extracted package in as an OMP extension root, exactly as
		// `listOmpExtensionRoots` would when the package is installed, then ask
		// the host's own discoverAgents() to find Legion's personas.
		injectOmpExtensionCliRoots([packed.root], tmpHome, packed.root);
		try {
			const { agents } = await discoverAgents(packed.root, tmpHome);
			const names = new Set(agents.map((a) => a.name));
			for (const expected of [
				"legion-coder",
				"legion-reviewer",
				"legion-tester",
				"legion-generalist",
			]) {
				expect(names.has(expected)).toBe(true);
			}
		} finally {
			clearOmpExtensionCliRoots();
		}
	});

	test("packed personas parse via the host agent loader (parseAgent)", () => {
		const dir = join(packed.root, "agents");
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const filePath = join(dir, file);
			const content = readFileSync(filePath, "utf-8");
			const def = parseAgent(filePath, content, "bundled");
			expect(def.name.startsWith("legion-")).toBe(true);
		}
	});
});
