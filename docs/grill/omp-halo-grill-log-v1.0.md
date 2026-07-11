# omp-halo v1.0 Grilling Log — Design Decision Record

**Started:** 2026-07-11 · **Method:** `/grilling` interview, one question at a time, recommended answer proposed, user decides. This doc is the running source of truth for what omp-halo is being redesigned to be, replacing the deleted docs (which had drifted from the actual implementation across 4+ planning rounds). Nothing here is final until the whole tree is walked and the user confirms the shared understanding at the end.

**Ground rule this whole redesign exists to enforce:** every claim in the final docs must be true of the code, or explicitly marked as roadmap/not-yet-built. This log records the *decision*, not just the conclusion, so future sessions can see *why* a call was made instead of re-litigating it.

---

## Prior art consulted

- Deep code audit of the pre-existing implementation (2026-07-11, this session) — found the 2026-07-06 audit's fixes were mostly real (DAG scheduler, cross-session persistence, HOTL packet UI, disagreement scoring via Rouge-L, etc.) but the "v1.0 hardening" commit introduced a new P0: resuming an escalated orchestration to completion throws an uncaught `TransitionError` (illegal `escalated → completed` transition) that's silently swallowed with no logging, permanently stranding the orchestration. Also found: dead `halo_override resume` path, provider auth-lockout that never recovers (missing `nextEligibleAt`), auth failures misclassified as timeouts, zero-backoff retry on rate limits, TOCTOU display-ID collision that can silently delete an unrelated orchestration row.
- Web research: 2026 multi-agent orchestration consensus ("always try to buy, don't try to build" — LinkedIn eng; domain logic is the only layer where building beats buying); HOTL escalation research (review the decision not the whole run; escalation volume must stay sustainable or humans stop reading; EU AI Act Article 14, Aug 2026 deadline, requires demonstrable/measurable human oversight — audit trail is the actual product, not overhead).
- Web research: "Mythos" resolved to Anthropic's Claude Mythos (Preview/5) — restricted frontier model (SWE-bench Verified 93.9%), gated to ~50 partner orgs via Project Glasswing, not generally available. Claude Fable 5 is marketed as "Mythos-class" and is generally accessible.
- Codebase research: surveyed `@oh-my-pi/pi-ai`, `pi-agent-core`, `pi-coding-agent` (the host package) surface area — confirmed the host already owns: multi-provider completion with retry/auth-classification (`pi-ai/utils/retry.ts`, `error/auth-classify.ts`), a real embedding subsystem (`pi-coding-agent/mnemopi/*`), per-provider usage/cost tracking (`pi-ai/usage/*.ts`), a native multi-agent spawn system (`task` tool, `task/executor.ts::runSubprocess`), a peer-to-peer agent messaging bus (`irc` tool, `irc/bus.ts`), and a persisted/revivable subagent lifecycle (Agent Hub, cold-revive from JSONL, `session_init`-based capability restoration — hardened over many real changelog bug fixes). Confirmed halo's own dispatcher already calls the *same* low-level `runSubprocess` executor the native `task` tool uses (not a separate hand-rolled subprocess spawner), but bypasses `task`'s higher layer — meaning it also bypasses IRC, Agent Hub, and persisted-revive, and instead built its own parallel `StateManager`/`TransitionService`/checkpoint system for the same "survive a restart and resume" problem — which is exactly where today's P0 bug lives.

---

## Decisions

### Q1 — What does "MoA over MoE Orchestration" concretely mean as the product's job?

**Recommended:** omp-halo takes one task from the host session, decomposes it into specialist sub-tasks, dispatches each to the right expert(s) (possibly more than one per sub-task for redundancy), synthesizes the results into one answer, and escalates to a human when synthesis can't be trusted — returning a single result to the calling session, never leaving the host's own conversation loop. MoE = routing/specialization layer; MoA = redundancy + synthesis layer (per the original Together AI MoA paper: proposer layer + aggregator); HOTL = the safety valve on top.

**Decision:** Confirmed. (User moved directly to the real motivating goal in the next answer, effectively ratifying this framing.)

### Q2 — What is the actual success target, and is "Mythos" a fixed benchmark or a moving target?

**Context that reframed the whole session:** the user's actual goal is ensemble-quality-arbitrage — they have access to many free/cheap models plus some frontier ones, and want orchestration to (a) make cheap/free models collectively approximate a top-tier frontier model's output quality, and (b) make an ensemble of frontier models (e.g. Fable 5) exceed what a single frontier model achieves alone.

**Research finding:** "Mythos" = Claude Mythos (Preview/5), Anthropic's restricted, non-generally-available frontier model (SWE-bench Verified 93.9%, GPQA Diamond 94.6%), gated to ~50 partner orgs, $25/$125 per M tokens. Fable 5 is marketed as "Mythos-class" and is broadly accessible. This makes the target concrete and motivated: **omp-halo exists because the actual best model is deliberately unreachable, so orchestration is the lever to close that gap using models the user can actually get.** Coding-agent domain (SWE-bench Verified is Mythos's headline metric) aligns exactly with oh-my-pi's own use case.

**Decision:** Confirmed. Success = ensemble output quality on real coding tasks approaches or exceeds single-frontier-model quality, judged empirically by the user against whatever frontier model is reachable in a given session — not a fixed named benchmark target.

### Q3 — Should synthesis be a real LLM aggregator or heuristic confidence-scoring?

**Recommended:** A real LLM-based aggregator (a strong model reads all expert outputs + the original task, produces the synthesized final answer) as a required, first-class pipeline stage — per the original MoA paper's actual mechanism. Heuristic confidence still exists only as a cheap pre-filter (e.g. skip synthesis when there's just one unambiguous expert answer), never as the thing that decides final output quality.

**Decision:** **A — confirmed.** Since the entire product thesis (Q2) is "beat frontier-model quality through ensembling," the aggregation step is where that gain is actually won or lost. Heuristic self-grading (code-fence/length rewards) cannot do what a real aggregator does: cross-reference disagreements, merge the best fragment from each expert, catch one expert's error that another caught.

### Q4 — Should halo rebuild its dispatch layer on the host's native `task`/`irc` primitives instead of its own subprocess/resume/state-manager system?

**User's concern that triggered this:** Oh-My-Pi already has a stable multi-agent dispatch system and IRC — is halo about to duplicate load-bearing host infrastructure?

**Research finding:** Yes, partially, and it's exactly where the worst current bug lives. Halo's dispatcher already shares the host's real low-level executor (`runSubprocess`, same function `task/index.ts` calls) — the actual model-invocation path isn't reinvented. But halo bypasses the `task` tool's higher layer (role-tagged spawning, IRC peer coordination, Agent Hub visibility, persisted/revivable subagent lifecycle with cold-revive from JSONL after restart — a system hardened over many real changelog bug fixes) and instead built its own parallel `StateManager` + `TransitionService` + SQLite checkpoint system to solve the identical problem: "work must survive a restart and resume cleanly." Today's audit found the P0 bug (uncaught `TransitionError` permanently stranding a resumed escalated orchestration) and a P1 TOCTOU display-ID collision bug living inside that homegrown layer.

**Decision:** **A — confirmed.** Halo's dispatch is rebuilt as a policy layer over `task` + `irc`: decompose → issue role-tagged `task` spawns (one per expert, potentially the same subtask spawned redundantly across experts for ensembling) → let the host's IRC/Agent-Hub/persisted-revive machinery own subagent lifecycle and cross-restart resume → collect results → MoA-synthesize (Q3) → confidence/HOTL-gate → return. Halo's own persistence is scoped down to *only* its genuinely domain-specific data (HOTL packets, confidence/disagreement scores, audit trail, synthesis results), keyed against host task/job IDs — not a second copy of "is this thing alive or resumable."

**Open follow-up, now resolved:** checked `task`'s actual schema (`task/index.ts`) — each spawn's `agent` field selects an agent-*type* (a persona, e.g. `halo-coder`), and that persona's model is pinned in the persona's own definition (`agentModel: effectiveAgent.model`, "per-agent model override from settings, highest priority"). There is no ad-hoc `model` param on an individual spawn. So ensembling the same subtask across N experts is just a `tasks[]` batch with N entries carrying identical `assignment` text and N different `agent` values — native batch usage, no wrapper needed at the spawn level. Halo's own code only needs to: pick which N expert personas get a given subtask, build that batch, collect the N results, and hand them to the aggregator (Q3).

---

### Q5 — The real gap: one persona/prompt, many models

**User's correction of the direction:** the host's own multi-agent orchestrator already has `modelRoles` — but that's a flat 1:1 mapping (one role name → one model). The user's actual second concern: they want *one* agent prompt file (e.g. `reviewer`/`task`) runnable against *varied* models per their own preference, without hand-duplicating the prompt file per model. That's the specific gap omp-halo should fill.

**Research finding:** confirmed via `node_modules/@oh-my-pi/pi-coding-agent/dist/types/task/executor.d.ts` — `ExecutorOptions` (the input to `runSubprocess`, the same low-level executor `task/index.ts` calls internally and halo's dispatcher already calls directly) has `agent: AgentDefinition` (the persona/prompt) as one field and a **separate** `modelOverride?: string | string[]` field. So the host's own execution primitive already supports "run this one persona against an explicit model chosen per call," fully decoupled from whatever model is in the persona's own frontmatter. Halo does not need to hand-duplicate `.md` files per model variant, nor dynamically synthesize N fake `AgentDefinition` entries — it just needs to call the existing executor once per model in a role's configured model list, passing the same `AgentDefinition` each time with a different `modelOverride`.

**Decision:** Confirmed as the mechanism. **This is the concrete shape of omp-halo's "MoE" layer**: one persona = one role's expertise/prompt (authored once); the *model* dimension is a purely halo-owned config axis (halo's existing per-role `modelMap`, richer than the host's flat `modelRoles`, is the right place for this — not a duplication, since the host has no multi-model-per-role concept at all). Ensembling the same subtask across N models (for MoA synthesis, Q3) = N calls to the same persona with N different `modelOverride` values.

**Follow-up resolved — and it corrects Q4:** traced `task/index.ts`'s internal spawn path. Its `modelOverride` is resolved *once per agent name per session* from `session.settings.get("task.agentModelOverrides")[agentName]` — not a per-call parameter a caller can vary. So N-different-models-per-call (Q5's actual requirement) is only reachable by calling the shared `runSubprocess` executor directly and setting `modelOverride` explicitly per call — exactly what halo's dispatcher already does today. Separately, checked where `AgentRegistry.global()` (IRC roster / Agent Hub visibility) gets registered: **inside `executor.ts`, i.e. inside `runSubprocess` itself** — not bolted on by `task/index.ts`'s wrapper. So halo's existing direct-executor calls were already getting IRC-roster/Agent-Hub registration for free; that was never actually missing.

**Q4 correction:** the fix is *not* "stop calling `runSubprocess` directly, go through the `task` tool instead" — those are the same shared engine, and halo already sits on it correctly for execution. The actual, narrower fix is: **stop reimplementing persistence/resume/health-tracking in a bespoke layer on top of that shared executor** (halo's own `StateManager`/`TransitionService`/checkpoint system, where the P0/P1 bugs live), and lean on the host's already-hardened persisted-revive/Agent-Hub lifecycle for "is this subagent alive, can it resume" — while keeping halo's own direct executor calls (needed anyway for per-call `modelOverride` fan-out) and keeping halo-owned storage scoped to genuinely halo-only data: HOTL packets, confidence/disagreement scores, audit trail, synthesis results.

### Q6 — What does halo still need its own persistence for, given host persisted-revive covers per-subagent lifecycle?

**Recommended:** halo persists only genuinely halo-owned composite/domain data: the orchestration record (decomposition plan, which subtask maps to which subagent/job ID, current phase), HOTL packets (trigger, options, cost, resolution), and confidence/disagreement scores + synthesis result (the actual audit trail — the real deliverable of a HOTL product per the EU AI Act Article 14 research). Explicitly NOT: subagent process/session lifecycle itself, which is a lookup into the host's own registry/persisted-revive, not a second copy.

**Decision:** Not explicitly objected to; conversation moved on to stress-test the core premise instead (Q7 below) before returning to confirm. **Provisionally accepted, flagged for final confirmation at session wrap-up.**

### Q7 — Reality check: can this literally beat Mythos-class output, per independent research?

**User's challenge:** stress-test the whole premise against top research voices, not just the optimistic Together AI framing from Q1/Q3.

**Research findings (see Sources below in this doc's companion chat log; key citations):**
- **Co-failure ceiling** (arXiv 2606.27288, 2026, 67-frontier-model study): *"for any policy whose output is one member model's answer, accuracy cannot exceed one minus β, where β is the rate at which every model is wrong on the same query."* Combining models only beats the single best model when failures are **decorrelated** across models — gains come from models failing on *different* questions, not from adding more models. If cheap models and Mythos fail on the *same* hard cases (likely for problems requiring capability none of the cheap models have), ensembling cannot manufacture that missing capability.
- **Rethinking Mixture-of-Agents** (arXiv 2502.00674, Princeton): mixing *different* LLMs "often lowers the average quality" — MoA is sensitive to constituent model quality. **Self-MoA** (multiple samples from one single top-performing model) beat standard multi-model MoA by 6.6% on AlpacaEval 2.0.
- **Self-preference bias** (arXiv 2410.21819): LLM-as-judge/aggregator setups favor outputs resembling their own style; majority-voting across multiple judges (including smaller ones, less self-biased) mitigates this better than one strong aggregator alone.

**Honest conclusion:** the architecture can plausibly close some gap and can plausibly exceed a single frontier model **specifically on tasks where cheap models' errors are decorrelated** — not universally, and not by manufacturing capability the ensemble doesn't have. Naively mixing many weak models can underperform just resampling one strong model.

**Decision:** **A — confirmed.** Halo's default expert-selection policy is **self-consistency** (N independent samples from the single strongest accessible model, varied by temperature/seed) for most subtasks. True multi-model diversity is an explicit, deliberate per-role choice (e.g. "reviewer" role samples both a security-focused model and a general one) — never a blanket "spread across every free model available" default. This also directly informs Q3's aggregator design: prefer majority-voting/cross-check among multiple judges over trusting one aggregator's self-graded judgment, per the self-preference-bias finding.

### Q8 — Should HOTL escalation be a synchronous inline block instead of a persisted escalate-then-separately-resume flow?

**Research finding:** `ExtensionContext.ui` (`extensibility/extensions/types.ts:175-274`) exposes `select(title, options, dialogOptions): Promise<string|undefined>`, `confirm(title, message): Promise<boolean>`, and `input(...)` — directly awaitable by an extension's own tool-handler code, mid-execution, with `timeout`/`onTimeout` support. The type comment is explicit: *"extensions expose a strictly larger UI surface... and may be invoked from event handlers that have already taken the agent loop's lock — hooks intentionally cannot."* This is the same block-inline-get-an-answer-continue pattern as the model-facing `ask` tool, but callable directly by halo's own code.

**What this changes:** today's architecture treats escalation as "return from the tool call with status `escalated`, persist state, and require a *separate* later `halo_override resume` call to continue" — which is exactly the architecture that produced this session's P0 bug (`escalated → completed` is an illegal transition; the resume path can crash and permanently strand the orchestration) and the reason halo built its own `StateManager`/`TransitionService`/checkpoint system in the first place (Q4/Q6). If escalation is instead a **synchronous inline call to `ctx.ui.select()`/`confirm()` from within the same `halo_dispatch` tool execution**, the entire "pause, persist, resume via a second entrypoint" architecture is unnecessary: the tool call blocks briefly, gets a human decision, and either continues to synthesis or aborts — all in one continuous call, one state transition path, no cross-call resume bug surface at all.

**Trade-off to weigh:** this blocks the whole agent loop while waiting (synchronous), and a human who's away for hours (not just seconds) would time out rather than resume later after a restart — the old A-1 cross-session-resume feature existed specifically for that "away for a while" case. Given oh-my-pi is an interactive CLI the user is presumably at the keyboard for, and given the HOTL research finding (Q_prior sources) that escalations should be rare and reviewed promptly, not queued indefinitely, a graceful timeout-and-abort (with a clear "re-run to retry" message) may be the right trade-off rather than building persistence for an infrequent edge case.

**User's correction that fixed the design:** researched HITL vs HOTL directly. **HITL** = "the workflow stops at a decision gate until a human provides a required signal" (control-first, blocking). **HOTL** = "a human is monitoring the system... human involvement is not required for every decision... the agent continues its work while waiting for a response... should not idle while waiting for a human" (async authorization, agent keeps going). The original Q8 proposal (synchronous `ctx.ui.select()` freezing the whole session) is architecturally HITL, not HOTL — it would have made halo violate its own product name exactly the way the deleted docs violated reality.

**Corrected design:** `halo_dispatch` is async-by-default, mirroring the host's own `task` tool async mode ("Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish" — `task.md`). HOTL escalation is delivered as a **non-blocking notification** — the calling session stays free to do other work; the human is alerted and can respond whenever; the background job resumes itself (via the host's job-completion/IRC-wake mechanism) when the answer arrives. This is not a bespoke persisted-state resume system (where the P0 bug lived) — the job is still literally running/suspended in the background on the host's own async substrate; halo just needs to route the human's answer back into it.

**Decision:** **A — confirmed.** Async dispatch + non-blocking escalation notification. Genuinely "on-the-loop," consistent with Q4 (host-native async lifecycle) and Q6 (halo persists only its own domain data, keyed against the host's job/task IDs).

Sources for this correction: [Human-in-the-Loop vs Human-on-the-Loop in Agentic AI — TekLeaders](https://tekleaders.com/human-in-the-loop-vs-human-on-the-loop-agentic-ai/), [Human-in-the-Loop vs. Human-on-the-Loop: Key Differences — n8n Blog](https://blog.n8n.io/human-in-the-loop-vs-human-on-the-loop/), [How to add human-in-the-loop controls to AI agents that actually run in production — Agno](https://www.agno.com/blog/how-to-add-human-in-the-loop-controls-to-ai-agents-that-actually-run-in-production).

### Q9 — Non-goals / explicit out-of-scope for v1.0

**First draft (revised twice during discussion):**
1. Initial draft included "no custom live-progress-tree UI." **User correctly challenged this as stale** — it was carried over from the deleted docs' old Part D plan, written before this session decided to route dispatch through `task`/`irc` (Q4). Since halo shares the host's `runSubprocess` executor, the native per-agent progress UI (task-block header glyph + per-agent status-dot rows, confirmed in the host changelog) already exists for free. **Corrected non-goal:** no reinvented per-expert progress tracking — halo's only genuinely new rendering surface is the synthesis result and the HOTL escalation notification (Q8), since the host has no concept of either.
2. Initial draft deferred "real embedding-based similarity/dedup" to post-v1.0. **User correctly challenged this** — research shows semantic deduplication is load-bearing for the self-consistency + majority-vote mechanism already committed to in Q7, not a quality nicety: without it, vote-splitting among semantically-equivalent-but-differently-worded answers can make accuracy get *worse* as more ensemble samples are added (one study: 83.3%→80.1% accuracy from N=1→N=32 purely from unclustered vote-splitting; normalizes and improves substantially once semantic dedup is applied). **Corrected:** real embedding-based clustering for majority voting is IN v1.0 scope — halo must reliably obtain real vectors via the existing host registry/mnemopi/Ollama chain (`embeddings.ts`) for the vote-clustering step, and should surface (not silently fall back to) the mock-hash-tier degraded mode with a startup warning when no real embedding provider is available.

**Final non-goals for v1.0 (locked):**
- Cost/USD estimation — token counts are the honest unit; USD requires user-supplied rates and isn't core to the quality thesis.
- Cross-restart resume for an *in-flight, unescalated* dispatch — Q8 already makes escalation itself non-blocking/async; a mid-flight (non-escalated) dispatch surviving a full process restart is a separate, harder guarantee not needed for v1.0.
- Any per-provider quota/rate-limit ledger beyond what the host's own retry/health classification already gives (per the Q2 "don't reinvent" research finding).
- Reinvented per-expert progress UI (host's native task-block rendering already covers this for free).

**In-scope, not deferred (corrected from initial draft):**
- Real embedding-based semantic clustering for majority-vote aggregation (Q7's mechanism depends on it).

**Decision:** Confirmed with the two corrections above folded in.

### Q6 (final confirmation)

Revisited after several more branches were resolved without objection to the persistence-scope boundary (orchestration record + HOTL packets + confidence/audit trail only; no copy of subagent lifecycle). **Confirmed as final**, now additionally keyed against the host's async job/task IDs per Q8's corrected design rather than halo's own resumable-checkpoint IDs.

---

## Still to walk

- ~~How experts are selected per sub-task~~ — resolved Q5/Q7 (per-role `modelMap`, self-consistency default, deliberate multi-model diversity only where decorrelated failure is expected).
- ~~Per-expert model pinning mechanism~~ — resolved Q5 (`modelOverride` on the shared executor, no file duplication needed).
- ~~HOTL escalation mechanics~~ — resolved Q8 (async dispatch, non-blocking notification, corrected from an initial HITL-shaped proposal).
- ~~What halo still needs its own persistence for~~ — resolved Q6 (orchestration record, HOTL packets, confidence/audit trail only, keyed against host job/task IDs).
- ~~Non-goals / out-of-scope~~ — resolved Q9.
- ~~Config surface~~ — resolved Q10.

### Q10 — Final v1.0 config surface

**Recommended and confirmed:** a deliberately small surface — per-role `modelMap` (list of models per role, for self-consistency sampling and deliberate multi-model diversity), HOTL thresholds (confidence floor, disagreement threshold, cost ceiling — the actual governance knobs behind Q8's async notification), ensemble size N per role (small default, e.g. 3, not "maximize free-tier usage"), and the existing embedding-provider fallback settings (`embed.baseUrl`/`apiKey`/`model`, now load-bearing per Q9's correction, not just a nicety). Explicitly not reintroducing the old `escalationMode`/mode-preset toggle system, since Q8 fixed escalation to always be async-notification — a mode toggle over a single behavior is a config option with nothing behind it.

**Decision:** Confirmed.

---

## Shared understanding reached — summary

**What omp-halo v1.0 is:** an Oh-My-Pi extension that takes one task from the host session, decomposes it into specialist sub-tasks, dispatches each to the right expert(s) via the host's own `task`/`runSubprocess` execution primitive (never a parallel spawn/lifecycle system), runs a real LLM-based aggregator over redundant expert attempts to synthesize one trustworthy answer, and asynchronously (never blocking) notifies a human when the ensemble's confidence/disagreement/cost crosses a threshold — returning one result to the calling session. The product exists because the actual best available model (Mythos-class) is deliberately gated/expensive; orchestration is the lever that lets accessible models (free, cheap, or merely "Mythos-class" like Fable 5) close or exceed that gap **on tasks where model failures are decorrelated** — not universally, and not by manufacturing capability no constituent model has (the co-failure ceiling).

**What it deliberately does NOT rebuild:** subagent process lifecycle, IRC peer coordination, persisted-revive/cold-restart of a subagent, Agent Hub visibility, per-expert progress UI, single-call retry/auth classification, per-provider usage/cost accounting, per-provider quota ledgers, YAML parsing — all host-owned, all reused as-is.

**What it owns:** per-role model-diversity policy (`modelMap` + `modelOverride` fan-out over one persona file), self-consistency-first expert-selection policy, the MoA synthesis/aggregation step, semantic-clustering-aware majority voting (real embeddings, not just Rouge-L), HOTL threshold policy and async escalation notification, and the composite orchestration record + audit trail that is this product's actual regulatory/trust deliverable (EU AI Act Article 14 framing).

**The concrete bug debt this design resolves by construction:** the P0 (uncaught `TransitionError` stranding a resumed escalated orchestration), the dead `halo_override resume` path, and the TOCTOU display-ID collision all lived in the bespoke `StateManager`/`TransitionService`/checkpoint system built to solve "does this survive a restart and resume" — a problem the host already solves per-subagent, and which Q8's async-notification redesign mostly sidesteps rather than needing a fix.

**Still genuinely open (implementation-level, not product-level):** the exact mechanics of routing the human's async answer back into a still-running background dispatch (job-completion callback vs. IRC wake vs. something else) — flagged in Q5/Q8 as "resolve during build," not blocking this design.
