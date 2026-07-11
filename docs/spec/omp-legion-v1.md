# omp-legion v1 — Technical Spec

**Status:** core dispatch, automatic decomposition, synthesis, HOTL governance with an awaited background decision gate, host-native config, extension entrypoint, durable Legion audit persistence, explicit registry-level embeddings, and bundled per-role agent personas (`legion-coder`/`legion-reviewer`/`legion-tester`/`legion-generalist`, with a native-`task` guard preventing them from being reached outside legion_dispatch) are implemented. A live real-model comparison harness is available at `scripts/benchmark.ts`; benchmark results remain user-run and are intentionally not claimed here. Every section below states what v1 does and, where relevant, explicitly what it does not — the project this replaced accumulated four rounds of planning docs that drifted from its actual implementation, and the discipline of this spec is to never repeat that.

**Rule this spec exists to enforce:** every claim below is either true of the code as it's built, or explicitly marked "not yet built." No aspirational claims.

---

## 1. What Legion is

An Oh-My-Pi extension that takes one task from the host session, decomposes it into specialist sub-tasks, dispatches each to expert(s), synthesizes their outputs into one trustworthy answer, and asynchronously escalates to a human when that synthesis can't be trusted — returning a single result to the calling session. It never leaves the host's own conversation loop.
**Implementation status:** The extension entrypoint, caller-supplied task dispatch, automatic LLM decomposition with a single-task fallback, synthesis, governance, and asynchronous notification are implemented. The caller may still provide its own specialist task list.

**MoE layer** — routing/decomposition: which expert(s) handle which piece of the task.
**MoA layer** — redundancy/synthesis: multiple independent attempts merged by a real aggregator, not just picked by a heuristic score (per the original [Mixture-of-Agents paper](https://arxiv.org/pdf/2406.04692)).
**HOTL layer** — the governance layer on top: async escalation when the MoA layer's output can't be trusted.

## 2. Why (the actual target)

Claude Mythos (Preview/5) is Anthropic's highest-scoring model on record (SWE-bench Verified 93.9%) but is gated to ~50 partner orgs via Project Glasswing and not generally available. Claude Fable 5 is marketed as "Mythos-class" and is broadly accessible. Legion's success criterion: **ensemble output on real coding tasks approaches or exceeds single-frontier-model quality**, judged empirically against whatever frontier model is reachable in a given session — not a fixed named benchmark.

**Honest boundary, not a universal claim** (per [arXiv 2606.27288](https://arxiv.org/abs/2606.27288), a 67-frontier-model study): *"for any policy whose output is one member model's answer, accuracy cannot exceed one minus β, where β is the rate at which every model is wrong on the same query."* Combining models only beats the single best model when failures are **decorrelated**. Legion cannot and does not claim to manufacture a capability none of its constituent models have.

## 3. Host integration boundary — what Legion reuses vs. owns

Legion runs on top of `@oh-my-pi/pi-ai`, `pi-agent-core`, and `pi-coding-agent`. Confirmed by direct inspection of the host package:

| Capability | Owner | Why |
|---|---|---|
| Model completion, retry, auth-classification (single call) | **Host** (`pi-ai/utils/retry.ts`, `error/auth-classify.ts`, `completeSimple`) | Already correct and hardened; re-deriving it duplicates work and (per the prior project's audit) reintroduces the exact bug class the host already fixed. |
| Subagent process execution | **Host** (`task/executor.ts::runSubprocess`) | Legion calls this directly — the same low-level function the native `task` tool calls internally. |
| Peer-to-peer agent coordination | **Host** (`irc` tool / `irc/bus.ts`) | Fire-and-forget messaging, peer wake, roster — already hardened over many real bug fixes. |
| Subagent lifecycle / cold-revive after restart | **Host** (Agent Hub, `session_init`-based capability restoration) | Per-subagent "is this alive, can it resume" is solved; Legion does not maintain a second copy. |
| Agent-registry / IRC-roster visibility | **Host**, registered *inside* `runSubprocess` itself | Legion gets this for free by calling the executor directly — it was never actually missing. |
| Per-expert progress UI | **Host** (task-block header + per-agent status rows) | No reinvented "watch the expert work" rendering in Legion. |
| Per-provider usage/cost tracking | **Host** (`pi-ai/usage/*.ts`) | No hardcoded cost-rate tables in Legion. |
| Real embedding subsystem (registry → mnemopi → Ollama fallback chain) | **Host**, wrapped by Legion | Legion's embedding client tries host registry, then host mnemopi, then local Ollama, before any local fallback — see §6. |
| Model-role→model mapping (single model per role) | Host has `modelRoles` (flat 1:1) | Insufficient for Legion's needs (see §5) — this is the one place Legion's own config is deliberately richer, not duplicative. |
| Per-provider quota/rate-limit ledgers | **Host**'s own retry/health classification | No parallel quota ledger in Legion. |
| YAML/config parsing | **Host** conventions (`gray-matter`/js-yaml) | No hand-rolled parser. |

**What Legion owns:** per-role model-diversity policy, expert-selection policy, the MoA aggregator, semantic-clustering-aware majority voting, HOTL threshold policy + async escalation, and the orchestration record/audit trail (§7).

## 4. Dispatch mechanism

Legion calls the host's `runSubprocess` executor directly (`ExecutorOptions` — same function `task/index.ts` calls internally), not the natural-language-facing `task` tool schema. This is a deliberate, confirmed choice: the `task` tool's own wrapper resolves `modelOverride` once per agent name from session settings (`task.agentModelOverrides`), which cannot vary per call — and Legion needs exactly that, per call, to fan one persona out across multiple models (§5).

Dispatch is **async by default**, mirroring the host's own `task` async mode: a job/correlation ID returns immediately; the calling session is never blocked waiting on an ensemble to finish or a human to answer an escalation (§7).

## 5. Expert selection: one persona, many models

**The gap Legion fills:** the host's `modelRoles` setting and `task`'s per-agent-name model resolution are both fundamentally 1:1 (one name → one model). Legion needs N:1 — one persona/prompt file, authored once, run against multiple models per the user's own config.

**Mechanism:** `ExecutorOptions.modelOverride?: string | string[]` is a field independent of `agent: AgentDefinition` — Legion calls the executor once per model in a role's configured list, passing the *same* `AgentDefinition` each time with a different `modelOverride`. No file duplication, no dynamically synthesized fake agent definitions.

**Default policy — self-consistency, not blanket diversity:** per [arXiv 2502.00674](https://arxiv.org/abs/2502.00674) (Princeton), mixing *different* LLMs "often lowers the average quality" — their Self-MoA (multiple samples from one top-performing model) beat standard multi-model MoA by 6.6% on AlpacaEval 2.0. Legion's default expert-selection policy is therefore:

- **Default:** N independent samples from the single strongest accessible model (temperature/seed-varied), for most sub-tasks.
- **Deliberate exception:** true multi-model diversity only where a role is explicitly configured for it (e.g. a "reviewer" role sampling both a security-focused model and a general one) — never a blanket "spread across every free model available."

## 6. Synthesis (the MoA layer)

A real LLM aggregator — not a heuristic self-graded score — reads the original task plus every expert output and produces the merged final answer. Heuristic confidence still exists only as a cheap pre-filter (skip synthesis entirely when there's one unambiguous expert answer), never as the thing deciding output quality.

**Semantic-clustering-aware majority voting is in v1 scope, not deferred.** This was a real correction during design: naive majority voting over free-text answers is vulnerable to vote-splitting — semantically-equivalent-but-differently-worded answers split the vote, and per [arXiv 2503.15838](https://arxiv.org/abs/2503.15838), unclustered voting made accuracy *worse* as sample count increased (83.3%→80.1%, N=1→N=32) until semantic dedup was applied, after which it improved substantially, in one case 84.8%→94.9%. Legion must reliably obtain real embedding vectors (via the host registry → mnemopi → Ollama fallback chain) for the vote-clustering step; a degraded mock-hash-vector fallback (if no real embedding provider is reachable) must be surfaced with a startup warning, never silently used.

**Implementation status:** Semantic clustering, the host model-registry embedding adapter, host Mnemopi/Ollama fallback attempts, and degraded Rouge-L fallback are implemented.
**Aggregator bias caution:** LLM-as-judge/aggregator setups carry documented self-preference bias (favoring outputs resembling their own style — [arXiv 2410.21819](https://arxiv.org/pdf/2410.21819)). Where practical, prefer majority-voting/cross-check signals feeding the aggregator's input over trusting one aggregator's unchecked judgment alone.

## 7. HOTL: async escalation, not a blocking gate

**This was corrected once during design and the correction matters.** An earlier draft of this spec proposed a synchronous inline `ctx.ui.select()`/`confirm()` call blocking the whole session until a human answered — that is architecturally **Human-in-the-Loop** ("the workflow stops at a decision gate until a human provides a required signal"), not Human-on-the-Loop ("human involvement is not required for every decision... the agent continues its work while waiting for a response... should not idle while waiting for a human" — see sources in the grill log). A product named for HOTL governance cannot ship a HITL blocking gate; that would be the same claim-vs-code gap this whole rebuild exists to fix.

**Correct design:** `legion_dispatch` is async-by-default (§4). When confidence/disagreement/cost crosses a threshold, Legion delivers a **non-blocking notification** and then awaits the host UI's decision inside the already-scheduled background job. The calling tool has already returned its job ID; the decision gate does not block tool invocation. Approve keeps the synthesis, reject fails the job, and edit captures a human note and re-runs synthesis. In headless modes, the host no-op UI produces a fail-safe rejection.

**Implementation status:** `ctx.ui.select()` and `ctx.ui.input()` are awaited from the `AsyncJobManager` callback through the session-scoped host service closure. No bespoke persisted-resume system or actual host ask-tool invocation is used; the public extension UI API is sufficient.

## 8. Persistence scope

Legion persists only genuinely Legion-owned composite data, keyed against the host's own job/task IDs — never a second copy of subagent process/session lifecycle (the host's persisted-revive already owns that):

- The orchestration record: decomposition plan, which sub-task maps to which subagent/job ID, current phase.
- HOTL packets: what triggered escalation, options, cost, resolution.
- Confidence/disagreement scores + synthesis result — the actual audit trail. (Per the EU AI Act Article 14, Aug-2026-deadline research, a demonstrable/measurable human-oversight trail is the real deliverable of a HOTL product, not overhead.)
**Implementation status:** `DispatchRecord` stores the orchestration, synthesis, governance, and human-resolution audit data in host session custom entries, restored when the session is reopened; `HostOrchestrationRepository` is the durable implementation and `InMemoryOrchestrationRepository` remains the fallback/test double.

**The concrete bug debt this design resolves by construction:** the prior codebase's P0 (an uncaught `TransitionError` permanently stranding a resumed escalated orchestration), a dead `halo_override resume` path, and a TOCTOU display-ID collision all lived in a bespoke `StateManager`/`TransitionService`/checkpoint system built to solve "does this survive a restart and resume" — a problem the host already solves per-subagent. Async escalation (§7) removes most of the reason that system needed to exist at all.

## 9. Config surface (v1, deliberately small)

- **Per-role `modelMap`** — list of models per role, driving self-consistency sampling (§5) and any deliberate multi-model diversity.
- **HOTL thresholds** — confidence floor, disagreement threshold, cost ceiling. The actual governance knobs behind §7's async notification.
- **Ensemble size N** per role — small default (e.g. 3), not "maximize free-tier usage."
- **Embedding provider settings** (`embed.baseUrl`/`apiKey`/`model`) — the Ollama fallback tier, now load-bearing per §6, not just a nicety.
**Implementation status:** These settings are loaded once per session through the host plugin-settings API, merged with centralized Legion defaults, and injected into the session-scoped dispatch service. The embedding provider uses the configured model selector for the registry tier before Mnemopi and Ollama fallback. `modelMap` also accepts a JSON string for host settings UI compatibility.

**Explicitly not reintroduced:** the old `escalationMode`/mode-preset toggle system. Escalation is always async-notification (§7) — a mode toggle over one behavior is an option with nothing behind it.

## 10. Non-goals for v1

- Cost/USD estimation — token counts are the honest unit; USD requires user-supplied rates and isn't core to the quality thesis.
- Cross-restart resume for an *in-flight, unescalated* dispatch — §7 already makes escalation non-blocking/async; a mid-flight non-escalated dispatch surviving a full process restart is a separate, harder guarantee not needed for v1.
- Any per-provider quota/rate-limit ledger beyond the host's own retry/health classification.
- Reinvented per-expert progress UI (host's native task-block rendering already covers this).

## Sources consulted

- [When Does Combining Language Models Help? A Co-Failure Ceiling — arXiv 2606.27288](https://arxiv.org/abs/2606.27288)
- [Rethinking Mixture-of-Agents: Is Mixing Different LLMs Beneficial? — arXiv 2502.00674](https://arxiv.org/abs/2502.00674)
- [Mixture-of-Agents Enhances LLM Capabilities (original MoA paper) — arXiv 2406.04692](https://arxiv.org/pdf/2406.04692)
- [Enhancing LLM Code Generation with Ensembles: A Similarity-Based Selection Approach — arXiv 2503.15838](https://arxiv.org/abs/2503.15838)
- [Semantic Self-Consistency: Enhancing Language Model Reasoning via Semantic Weighting — arXiv 2410.07839](https://arxiv.org/html/2410.07839v2)
- [Self-Preference Bias in LLM-as-a-Judge — arXiv 2410.21819](https://arxiv.org/pdf/2410.21819)
- [Human-in-the-Loop vs Human-on-the-Loop in Agentic AI — TekLeaders](https://tekleaders.com/human-in-the-loop-vs-human-on-the-loop-agentic-ai/)
- [Human-in-the-Loop vs. Human-on-the-Loop: Key Differences — n8n Blog](https://blog.n8n.io/human-in-the-loop-vs-human-on-the-loop/)
- [Claude Mythos Preview Benchmarks, Pricing & Context Window — llm-stats.com](https://llm-stats.com/models/claude-mythos-preview)
- [New Anthropic Fable 5 Is a "Mythos-Class" LLM Available to All — Infosecurity Magazine](https://www.infosecurity-magazine.com/news/fable-5-mythos-class-anthropic/)

Full decision-by-decision record (including the two corrections made during design and why): `omp-halo-grill-log-v1.0.md` (carried over from this project's prior codebase/name for provenance).
