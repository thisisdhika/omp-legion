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
const BUNDLED_AGENTS_SRC_DIR = join(BUNDLED_AGENTS_DIR, "..", "agents");

/**
 * Parses Legion's own bundled agent personas (src/agents/*.md) via the host's
 * real parseAgent() — these are read directly from the extension's own source
 * tree and never copied out to a project/user directory. discoverAgents()
 * alone does not see them; it only merges project/user/plugin agent dirs
 * plus the HOST's own bundled set, not a third-party extension's bundle.
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
 * Loads Legion's full agent roster: bundled defaults (src/agents/*.md),
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
