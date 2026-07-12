import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

import { LEGION_AGENT_PREFIX } from "../domain/constants";

export type { AgentDefinition };

/**
 * Legion only ever manages agents whose name is prefixed `legion-` — the same
 * naming-boundary pattern omp-halo used, so a project/user override can only
 * ever replace or extend a Legion role, never accidentally shadow an
 * unrelated agent discovered from the same directories.
 */
export function isLegionAgentName(name: string): boolean {
	return name.startsWith(LEGION_AGENT_PREFIX);
}

const BUNDLED_AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_SRC_DIR = join(BUNDLED_AGENTS_DIR, "..", "..", "agents");
/**
 * Absolute paths of Legion's bundled persona files (agents/*.md, the OMP
 * extension-package agents dir — see task/discovery.ts). Exposed so the
 * packaging smoke test enumerates "all bundled prompts" from the loader's own
 * source-of-truth directory instead of re-globbing.
 */
export function bundledAgentFilePaths(): string[] {
	try {
		return readdirSync(BUNDLED_AGENTS_SRC_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => join(BUNDLED_AGENTS_SRC_DIR, f));
	} catch {
		return [];
	}
}
/**
 * Parses Legion's own bundled agent personas (agents/*.md — the OMP
 * extension-package agents dir) via the host's real parseAgent(). They are
 * read directly from the extension's own tree and never copied out to a
 * project/user directory. Because they live at `<ext>/agents/`, the host's
 * discoverAgents() also surfaces them whenever the package is registered as
 * an OMP extension root (see the packaging smoke test), but reading them here
 * keeps bundled-load deterministic regardless of how the package is wired in.
 */
function loadBundledLegionAgents(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	let files: string[];
	try {
		files = readdirSync(BUNDLED_AGENTS_SRC_DIR).filter((f) =>
			f.endsWith(".md"),
		);
	} catch {
		files = [];
	}
	for (const file of files) {
		const filePath = join(BUNDLED_AGENTS_SRC_DIR, file);
		if (!filePath.startsWith(BUNDLED_AGENTS_SRC_DIR) || !file.endsWith(".md")) {
			continue;
		}
		try {
			const content = readFileSync(filePath, "utf-8");
			const def = parseAgent(filePath, content, "bundled");
			if (isLegionAgentName(def.name)) {
				map.set(def.name, def);
			}
		} catch {
			// Skip unreadable or unparseable files — one bad bundled file must
			// not prevent every other persona (or the extension) from loading.
		}
	}
	return map;
}
/**
 * Loads Legion's full agent roster: bundled defaults (agents/*.md),
 * overridden or extended by any `legion-*.md` files the host's own
 * discoverAgents() finds in the project (`<cwd>/.omp/agents/`) or user
 * (`~/.omp/agent/agents/`) directories — project overrides user, both
 * override the bundled default of the same name.
 *
 * Non-`legion-*` agents discovered in those same directories (a user's own
 * native OMP agents) are deliberately ignored here; they stay reachable only
 * via the host's native `task` tool, never Legion's dispatch.
 */
export async function loadAgentDefinitions(
	cwd: string = process.cwd(),
	home: string = os.homedir(),
): Promise<Map<string, AgentDefinition>> {
	const map = loadBundledLegionAgents();
	try {
		const { agents } = await discoverAgents(cwd, home);
		for (const agent of agents) {
			if (isLegionAgentName(agent.name)) {
				map.set(agent.name, agent);
			}
		}
	} catch {
		// Discovery failure (e.g. malformed override file) — fall back to the
		// bundled-only roster rather than failing extension startup.
	}
	return map;
}

/**
 * The full agent roster dispatch actually needs: every host-discoverable
 * agent (so the DEFAULT_DECOMPOSITION_AGENT="task" fallback resolves) with
 * Legion's own bundled/overridden `legion-*` personas layered on top. Use
 * this map's keys as the available-name set for resolveAgentName(), and the
 * map itself for the executor's agent lookup.
 */
export async function loadDispatchAgents(
	cwd: string = process.cwd(),
	home: string = os.homedir(),
): Promise<Map<string, AgentDefinition>> {
	const map = new Map<string, AgentDefinition>();
	try {
		const { agents } = await discoverAgents(cwd, home);
		for (const agent of agents) map.set(agent.name, agent);
	} catch {
		// Discovery failure — Legion's own bundled personas below still load.
	}
	for (const [name, agent] of await loadAgentDefinitions(cwd, home)) {
		map.set(name, agent);
	}
	return map;
}
