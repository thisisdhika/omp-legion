# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Per-attempt isolation and winner-only merge-back** (`infrastructure/host-dispatcher.ts`, `infrastructure/branch-merger.ts`, `docs/plan/algorithm-audit-and-hardening-v2.md` Phase 1): every expert attempt now runs inside the host's own copy-on-write isolation (`runIsolatedSubprocess`) instead of directly against the real project directory — closes a real correctness gap where concurrent mutating attempts (self-consistency samples, or concurrent multi-task dispatch) raced on the same files. Once synthesis picks a winner per task (`AnswerCluster.representativeAttemptId`, wired to a real consumer for the first time), only that attempt's isolated branch merges onto the real repo (`mergeTaskBranches`); every sibling attempt's branch is discarded. A rejected task discards every branch and merges nothing. Unit-tested; **not yet live-verified**.
- **Legion's own concurrency cap** (`domain/concurrency.ts`, `maxConcurrentExperts` config key): the host's `task.maxConcurrency` semaphore lives only inside `TaskTool`, never inside the shared `runSubprocess` executor Legion calls directly — Legion previously inherited no cap at all. A small pure `Semaphore` now bounds total concurrent expert attempts per dispatch (default 4), configurable via `.omp/plugin-overrides.json`.
- Automatic LLM-based task decomposition with a heuristic single-task fallback (spec §1); caller-supplied task lists remain supported.
- Host-native dispatch (`runSubprocess` + `AsyncJobManager`): async by default, one job ID returned immediately, never blocking the calling session (spec §4).
- Self-consistency-first expert selection with per-call `modelOverride` fan-out — one persona, many models, no file duplication (spec §5).
- MoA synthesis: real LLM aggregator over semantic-clustering-aware majority voting, with an honest degraded-mode Rouge-L fallback when no embedding provider is reachable (spec §6).
- HOTL governance: confidence/disagreement/cost threshold evaluation, non-blocking escalation notification, and an approve/reject/edit decision gate awaited from inside the background job (never blocking the calling session) (spec §7).
- Host model-registry embedding tier, ahead of the Mnemopi/Ollama fallback chain.
- Durable Legion audit persistence for the orchestration record, including human resolutions.
- Host-native config surface: per-role `modelMap`, HOTL thresholds, default ensemble size, embedding provider settings — centralized in `src/domain/constants.ts`.
- `config.example.json` documenting the full config surface (matches the host's real `.omp/plugin-overrides.json` JSON format — corrected from an initial, inaccurate YAML draft).
- ADRs for the DDD/MVVM layering and the host-native dispatch decision.
- Bundled per-role agent personas (`legion-coder`, `legion-reviewer` — read-only, `legion-tester`, `legion-generalist`), loaded via `infrastructure/agent-loader.ts`, overridable per-project/user via the host's standard agent discovery.
- Native `task` tool guard (`infrastructure/task-tool-guard.ts`) blocking any call that targets a `legion-*` agent directly, so those personas are only ever reached through the governed `legion_dispatch` path.
- Auto-discovered usage rule (`rules/legion-dispatch.md`) teaching the primary agent when and how to reach for `legion_dispatch`.
- Custom tree-style `renderResult` card (`presentation/dispatch-card.ts`) replacing the host's generic tool-call display, with genuine recursive `├─`/`└─`/`│  ` nesting and each task's own `attempts`/`models` nested under it rather than shown as flat, detached top-level lines.
- Human-readable, PascalCase job IDs (`humanReadableJobId`, e.g. `LegionReviewAndImplement`) replacing the host's bare `bg_1`-style counter in IRC/HUD transcripts.
- `docs/ARCHITECTURE.md` — a detailed, file-by-file implementation reference covering every layer, the full request lifecycle, and the config/persistence/testing surface.
- `irc` tool guard for `legion-*` agents (`infrastructure/irc-tool-guard.ts`, `infrastructure/agent-execution-context.ts`): the host force-adds `irc` to every subagent's tool whitelist regardless of its own `tools:` list, so nothing previously stopped sibling experts in the same ensemble from coordinating mid-generation — undermining the independence the self-consistency/majority-vote design depends on. An `AsyncLocalStorage`-based execution-context tag (set around each attempt's `runSubprocess` call) lets the guard identify the currently-running agent, since neither the host's `tool_call` event nor `ExtensionContext` exposes that. **Unit-tested, not yet live-verified.**

### Changed
- `legion_dispatch`'s tool `description` rewritten to state explicit trigger conditions (judgment calls, security-sensitive changes, subtle bugs, architecture decisions) rather than only mechanical behavior — per Anthropic's tool-use guidance, this is the highest-salience surface for getting a model to reach for a tool unprompted, more so than the always-apply rule file, since it's in the active tool list every turn rather than a static system-prompt block.

### Fixed
- Double tool-header render (`renderCall` + `renderResult` rendering as two separately-headed blocks) — resolved by dropping `renderCall` and doing everything in `renderResult` using its `args` parameter.
- Subagent spawns not appearing in the interactive "Subagents" HUD — root cause was a missing `eventBus` (only reachable via `ExtensionAPI.events` at `session_start` registration time, not `ExtensionContext`), now threaded through the full executor call chain.
- LLM decomposer occasionally inventing unresolvable `agent` names, causing dispatch failures — the decomposer's LLM contract no longer includes `agent` at all; it's always resolved from `role` via `resolveAgentName`, never trusted from caller or LLM output.
- Zod `.default()` silently not applying to a present-but-`undefined` config field — fixed with a `withoutUndefined()` merge helper.
- Tool label shortened from "Legion Dispatch" to "Legion" — redundant given this extension ships exactly one tool.

### Known open items
See the spec status table in [`docs/spec/omp-legion-v1.md`](docs/spec/omp-legion-v1.md) for the authoritative, currently-true list. As of this entry: empirical quality benchmarking against a reachable frontier model remains a manual validation step, not code.
