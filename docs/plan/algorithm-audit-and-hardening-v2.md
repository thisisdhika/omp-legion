# Algorithm Audit & Hardening Plan — v2 (final)

**Status:** all 6 committed phases implemented and unit-tested; **none live-verified yet**. Supersedes `algorithm-audit-and-hardening-v1.md` (kept for provenance). This pass deepens the v1 audit with additional correctness findings and adds research-grounded algorithmic upgrades aimed specifically at the project's actual goal: making the ensemble's output genuinely competitive with (or exceed) a gated frontier model on coding tasks, not just "orchestrate without crashing."

**Closeout summary (Phases 1-6):**
1. **Isolation** — every attempt runs in its own copy-on-write worktree; only the synthesis-selected winner's branch ever merges onto the real repo.
2. **Execution-grounded consensus** — an optional `verifyCommand` independently re-verifies each code-mutating attempt's isolated branch, promoting a verified-passing attempt over a merely-popular one.
3. **Governance recalibration** — disagreement, failure rate, and cost are now three independent, correctly-scaled signals instead of two redundant ones; a decision-gate timeout that's a genuine race, not just a passed-down signal.
4. **Model-selection smartness** — silent self-consistency/diverse config ambiguities now surface as warnings.
5. **Robustness** — an all-failed task can no longer take its siblings down with it.
6. **Diversity/sampling control** — self-consistency attempts get a real, deliberate temperature ladder instead of riding on provider defaults.

Two items were investigated and explicitly *not* implemented as originally scoped, with reasoning recorded in place: Phase 2 reuses the project's own verify command rather than LLM-synthesizing novel test inputs (a deliberate v1 scope-down); Phase 3's per-task delivery decoupling turned out to need a materially different tool contract (multiple job ids per dispatch) given the host's one-job-one-final-text `AsyncJobManager` model, so a smaller real improvement (answer text in progress reports) shipped instead. Phase 3 item 6 (empirically re-tuning clustering thresholds) and the two "not committed" items (multi-agent debate, adaptive ensemble sizing) remain open — all three need either live model access or a stable foundation this plan just finished building.

**What "not yet live-verified" means concretely:** everything above passed `bun run typecheck && bun run lint && bun test` (80/80 as of this closeout) against hand-written fakes/doubles. None of it has been exercised against a real host session with real models, a real git repo, and a real `verifyCommand` — that is the necessary next step before treating any of this as production-ready, and is intentionally out of scope for this pass per the user's own instruction to hold off on live retesting during this implementation phase.

**Rule this doc follows** (same discipline as the spec): every finding names the exact file/mechanism it's grounded in; every research citation is a real source fetched this session, not a recalled impression.

---

## Part 1 — Deepened correctness audit

### 1.1 Concurrency / isolation (critical — carried from v1, unchanged)

- No file isolation: `HostExpertExecutor.run()` (`src/infrastructure/host-dispatcher.ts`) calls bare `runSubprocess` against the real `cwd`. Concurrent mutating attempts race on real files.
- The host's own `task/isolation-runner.ts` (`ensureIsolation` → `runSubprocess({worktree: isolationDir})` → `commitToBranch` → `mergeTaskBranches`) is the unused fix.
- No concurrency throttling: the host's `task.maxConcurrency` semaphore lives only in `TaskTool` (`task/index.ts`), never in `runSubprocess`. Legion bypasses `TaskTool` entirely (ADR 0002), so it inherits none of that cap.

### 1.2 Governance/HOTL calibration (carried from v1, unchanged)

- `confidenceFloor` (0.6) and `disagreementThreshold` (0.4) are mathematically redundant — `disagreement := 1 - confidence` is a hard identity, and the defaults sum to exactly 1.0, so the two checks always co-fire.
- Clustering thresholds (0.84 embedding / 0.82 Rouge-L) are uncalibrated guesses against real expert-output pairs.
- `costCeiling` (100,000, flat) doesn't scale with `ensembleSize` — confirmed live (both of this session's live tests escalated with reason `"cost"`).
- No timeout on the decision gate — `decisionGate` awaits `ctx.ui.select(...)` indefinitely.
- `Promise.all` batches all tasks' outcomes together, so one escalated task withholds delivery of every other task's already-finished result.
- Causal link: frequent escalation currently functions as an *accidental* safety net against the isolation gap. Fixing governance before isolation would remove that net.

### 1.3 NEW — the confidence formula hides catastrophic partial failure (high severity)

Re-derived this pass by tracing what happens when experts fail, not just disagree.

`answerCandidates(experts)` (`domain/synthesis.ts:71`) filters to **only non-empty outputs** before anything downstream ever sees the expert set. `confidence = majority.size / answerCount` where `answerCount` is the size of *that filtered set* — failed/empty experts are not just weighted low, they vanish from the denominator entirely.

Concretely: dispatch 3 attempts, 2 crash/timeout, 1 succeeds. `answerCandidates` returns exactly 1 candidate. `shouldAggregate` (`synthesis.ts:293`, `candidates.length > 1 || humanNote`) is false, so the lone survivor's raw text is returned verbatim as the answer. Clustering sees one answer → one cluster of size 1 → `confidence = 1/1 = 1.0`. **The worst-case scenario for ensemble reliability — two-thirds of the experts failed — reports maximum possible confidence**, because `GovernanceMetrics` has no failure-rate signal at all (only `confidence`, `disagreement`, `cost`). This directly threatens the project's actual goal: it can silently ship a single unverified attempt with the system's highest-confidence label, in exactly the situation where a human most needs to know the ensemble barely functioned.

### 1.4 NEW — `representativeAttemptId` is fully unused today

`AnswerCluster.representativeAttemptId` is computed (`synthesis.ts:210`, `group[0]` — the lowest-index member of the majority cluster) but grepping the whole source tree shows it is never read anywhere outside its own construction and one test fixture. This matters directly for Phase 2 below (isolation's merge-back needs to know which attempt's branch to merge) — that wiring doesn't exist yet, and the *selection* itself (currently "whichever attempt happened to run at the lowest array index") isn't a quality-driven choice, just an artifact of iteration order.

### 1.5 NEW — self-consistency's "strongest model" is silently array[0]

`modelsForAttempts` (`domain/dispatch.ts`): `const [strongest] = selection.models;` — literally the first entry in the configured `models` array. Nothing validates or documents that config authors must order models strongest-first; nothing consults the host's model registry for any actual capability signal. A `modelMap` entry listing `["cheap-model", "best-model"]` in that order silently self-consistency-samples the *weaker* model three times, with no warning.

### 1.6 NEW — "diverse" strategy can silently drop configured models

Same function, diverse branch: `selection.models[index % selection.models.length]`. If `ensembleSize < models.length` (e.g. `ensembleSize: 2` against `models: [A, B, C]`), only `A` and `B` ever get used — `C` is configured but never dispatched, silently, with no warning that part of the configured diversity was unreachable at this ensemble size.

### 1.6b CORRECTED — temperature/seed control is NOT host-blocked; it's a real, unused hook

Part 2/Phase 6 originally called this "partially host-blocked" based on `ExecutorOptions` having no dedicated `temperature` field. That was too narrow — traced the full path and it's directly usable:

- `ExecutorOptions.settings?: Settings` (`executor.ts:363`) — a full `Settings` object the caller may supply per spawn.
- `runSubprocess` uses it as the base: `const settings = options.settings ?? Settings.isolated();` (`executor.ts:2042`), snapshotted into the subagent's own session settings via `createSubagentSettings`.
- The host settings schema has a real `temperature` key (`config/settings-schema.ts:1129`; `-1` = provider default, `0` = deterministic, up to `1` = max variety).
- That setting is read and passed straight into the model completion call: `temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined` (`sdk.ts:2749`).

So a distinct `Settings.isolated({ temperature: X })` passed as `ExecutorOptions.settings` on one specific `runSubprocess` call reaches that attempt's actual model completion, end to end. **Also found in the same trace:** `HostExpertExecutor.run()` currently passes no `settings` at all, so every dispatched expert already falls back to a blank `Settings.isolated()` — every spawn is silently discarding whatever session-level settings existed, not just missing temperature control specifically.

**Design:** add `temperature` to `DispatchAttempt` (`domain/dispatch.ts`), computed in `modelsForAttempts` alongside `model`. For **self-consistency** attempts, apply a small default ladder (e.g. `[0.2, 0.6, 1.0]`, cycling by attempt index) — this is exactly the sampling diversity the Self-MoA thesis (arXiv 2502.00674, already cited in the spec) assumes exists; today it's whatever the provider defaults to, unverified. For **diverse** strategy, leave provider-default (model diversity already provides decorrelation there) unless explicitly configured. Expose an optional `temperatureLadder: number[]` on `RoleModelPolicy` for explicit control, falling back to the smart default ladder otherwise. Thread through `HostExpertExecutor.run()` as `Settings.isolated({ temperature: execution.attempt.temperature })`.

This upgrades former Phase 6 from "investigate, possibly blocked" to a confirmed, scoped, implementable phase — see Part 3 below.

### 1.7 NEW — all-experts-failed is an uncaught throw (carried/confirmed from v1)

`clusterExpertAnswers` throws `"Cannot cluster expert results without output"` when every expert for a task fails. Nothing in `DispatchService.#run`'s per-task mapper catches this (only `executor.run()` errors are caught, via `failedResult` — not `synthesizer.synthesize`). The throw propagates through the outer `Promise.all`, failing the *entire* multi-task dispatch and discarding any sibling tasks that succeeded.

### 1.8 Checked and found sound (unchanged from v1)
Decomposition's anti-over-decomposition instruction, the aggregator prompt's cross-check framing, config defaults/merge, agent persona prompt quality, the embedding fallback chain, persistence/audit-trail correctness.

---

## Part 2 — Research: what "ultra-smart" actually means for this goal

Sources fetched and read this session (not recalled from training data):

- [Semantic Voting: Execution-Grounded Consensus for LLM Code Generation — arXiv 2605.08680](https://arxiv.org/pdf/2605.08680)
- [Majority Voting for Code Generation — arXiv 2604.15618](https://arxiv.org/pdf/2604.15618)
- [Enhancing LLM Code Generation with Ensembles: A Similarity-Based Selection Approach — arXiv 2503.15838](https://arxiv.org/pdf/2503.15838) (already in the spec's sources — the *predecessor* of the two above)
- [Mining Intrinsic Rewards from LLM Hidden States for Efficient Best-of-N Sampling (SWIFT) — arXiv 2505.12225](https://arxiv.org/html/2505.12225v3)
- [On the Effect of Sampling Diversity in Scaling LLM Inference — arXiv 2502.11027](https://arxiv.org/pdf/2502.11027)
- Multi-agent debate research (via search): "Multi-Agent Debate for LLM Judges with Adaptive Stability Detection" (OpenReview) and related 2026 surveys — "debate amplifies correctness compared to static ensembles."

### 2.1 The single biggest lever: execution-grounded consensus, not text-similarity clustering

Legion's synthesis layer (`domain/synthesis.ts`) currently clusters expert answers by **semantic similarity of their prose output** (embedding cosine similarity, degrading to Rouge-L). Both 2604.15618 and 2605.08680 (2026) show this is the *weaker* signal for code specifically, precisely because code is executable: **functionally equivalent code produces identical outputs; text describing that code rarely matches even when the code is identical.** SemanticVote's pipeline: generate diverse test inputs (LLM-synthesized, not just fixed benchmarks) → execute every candidate against them → fingerprint each candidate's output sequence → cluster by fingerprint equality → majority cluster wins. The paper reports the best execution-based selector beats output-pattern majority voting by **19-52 percentage points** across every configuration tested.

**Why this is gated on Phase 1 (isolation):** you cannot safely execute N candidate patches' test/build commands against the same real repo concurrently any more than you can let them *edit* it concurrently — execution-grounded consensus needs exactly the same per-attempt isolated worktree Phase 1 already has to build for file-safety reasons. This means Phase 1 isn't just a safety fix — it's the prerequisite infrastructure for the highest-leverage quality upgrade this research surfaced.

**Scope of applicability:** this applies to code-mutating roles (`legion-coder`, `legion-tester`) where an isolated worktree + patch + a run command (existing test suite, or a scoped build/typecheck) exists. It does not apply to `legion-reviewer` (produces prose findings, not executable code) — that role stays on today's text/embedding clustering.

### 2.2 Multi-agent debate / critique round

Cited research: debate frameworks where independent attempts are followed by a bounded critique/revise round consistently outperform static (no-cross-talk) ensembles on reasoning tasks — "debate amplifies correctness compared to static ensembles." This corroborates the recommendation already discussed earlier in this project's design conversation (reveal peer answers *after* independent generation, allow one critique-and-revise pass, keep it bounded to avoid the anchoring/decorrelation cost of live bidirectional chat during generation). Not yet in the plan as a committed phase — flagged as a genuine, evidenced option once the more foundational phases land.

### 2.3 Considered, not applicable: hidden-state intrinsic rewards (SWIFT)

SWIFT (arXiv 2505.12225) extracts a correctness signal from a model's internal hidden states as a lightweight alternative to a full reward-model or aggregator call. **Not implementable for Legion**: every expert model is called through a provider API (`completeSimple`/host model registry), never with access to raw activations. Noted so this isn't silently missed, not proposed for the plan.

### 2.4 Adaptive ensemble sizing

Cited research on adaptive Best-of-N (scaling sample count to task difficulty rather than a fixed N) suggests Legion's flat `defaultEnsembleSize: 3` for every dispatch is itself a blunt instrument. A natural extension once governance is recalibrated (Part 3, Phase 3): if a first round of N=3 comes back inconclusive by the *corrected* confidence signal, run a second round with additional samples before escalating to a human, rather than escalating immediately at fixed N. Flagged as a future refinement, not part of the committed phases below (depends on Phase 3 landing first and having real calibration data to know when "inconclusive" actually means "more samples would help" versus "genuinely ambiguous").

---

## Part 3 — Remastered plan

Phases are in dependency order — each assumes the previous has landed.

### Phase 1 — Isolation (blocks everything below; do first)
**Status: implemented, unit-tested, not yet live-verified.**
1. Add an infrastructure module wrapping the host's `task/isolation-runner.ts` (`prepareIsolationContext`, `ensureIsolation`, `commitToBranch`) — one isolated view per attempt.
2. Change `HostExpertExecutor.run()` to run each attempt through isolation instead of bare `runSubprocess`; capture each attempt's branch/patch instead of mutating the real repo directly.
3. Wire `AnswerCluster.representativeAttemptId` through to an actual consumer: after synthesis picks a winner, merge only that attempt's branch (`mergeTaskBranches`); discard sibling attempts' isolated changes.
4. Guarantee cleanup (`cleanupIsolation`) on every exit path: success, HOTL rejection, abort, thrown error.
5. Add a concurrency cap on Legion's own dispatch (a semaphore in `DispatchService`, configurable) — the host's cap doesn't cover Legion's direct-executor calls.

### Phase 2 — Execution-grounded consensus for code-mutating roles (the biggest quality lever)
**Status: implemented (v1-scoped), unit-tested, not yet live-verified.** Shipped as: an optional `verifyCommand` config re-runs the project's own existing verify command against each branched attempt (`infrastructure/verifier.ts`'s `HostVerifier`, checked out via a throwaway git worktree), rather than the full research's LLM-synthesized-test-input approach — a deliberate, disclosed scope-down (see `docs/ARCHITECTURE.md` §5.2). `preferVerifiedCluster` (`domain/synthesis.ts`) promotes a verified-passing attempt's cluster over a larger unverified one and feeds `representativeAttemptId`, which Phase 1's merge-back already reads. Confidence/disagreement math is untouched, exactly as planned below (Phase 3's job).
1. ~~For `legion-coder`/`legion-tester` attempts, after isolation lands: generate (or reuse existing) test/build commands per task, run each candidate's isolated patch against them.~~ Shipped as: reuse an explicitly-configured project verify command (not LLM-generated tests — see status note above).
2. ~~Fingerprint each candidate's execution result...~~ Shipped as: binary pass/fail (exit code), not a richer fingerprint — sufficient for "did this patch pass what the project already checks."
3. Feed the execution-grounded cluster into `representativeAttemptId` selection for mutating roles — pick a verified-passing attempt over a merely textually-popular one when they disagree. **Done.**
4. `legion-reviewer` (prose-only, no patch to execute) stays on the existing embedding/Rouge-L clustering — no change there. **Confirmed: read-only roles never produce a branch, so verification naturally never applies to them.**

### Phase 3 — Governance recalibration (redo against the stronger signal from Phase 2 where applicable)
**Status: implemented (items 1-4), item 5 investigated and documented as a known host constraint rather than forced through, item 6 deferred to live verification. Unit-tested, not yet live-verified.**
1. ~~Replace the redundant confidence/disagreement pair with one real signal, or explicitly decouple them.~~ **Done**: `disagreement` is now `fragmentationDisagreement` (distinct-cluster-count based), genuinely independent of `confidence`. See `docs/ARCHITECTURE.md` §7.0.
2. ~~Add a genuine failure-rate metric...~~ **Done**: `GovernanceThresholds.failureRateCeiling` + `attemptFailureRate`, computed directly from raw attempt results, independent of what synthesis/clustering saw.
3. ~~Scale `costCeiling` by `ensembleSize`...~~ **Done, via a different mechanism than originally proposed**: rather than scaling the ceiling by ensembleSize, `expertCost` now computes the **mean** tokens per attempt instead of a sum — scale-invariant by construction, no scaling factor needed. `DEFAULT_COST_CEILING` recalibrated 100k → 50k accordingly.
4. ~~Add a decision-gate timeout...~~ **Done**: `decisionTimeoutMs` config (default 30min), enforced via a genuine `Promise.race` in `#resolveEscalation` — not just an abort signal passed down and trusted, since a non-cooperative `decisionGate` could otherwise hang the job forever (caught this exact bug via a hanging test during implementation).
5. ~~Decouple per-task delivery from `Promise.all` batching.~~ **Investigated, not implemented as originally scoped.** The host's `AsyncJobManager` delivery model is genuinely one-job-one-final-text (`onJobComplete(jobId, text)`, delivered exactly once) — true decoupling would mean registering a separate async job per task instead of one per dispatch, a materially different tool contract (multiple job ids from one `legion_dispatch` call). Shipped instead: per-task `reportProgress` now carries the actual synthesis answer text, so a human watching progress sees a finished task's real answer immediately even while a sibling task is still escalated — final job delivery remains all-or-nothing, documented as an accepted limitation.
6. Empirically re-tune clustering thresholds against real expert-output pairs (extend `scripts/benchmark.ts` to log cluster-merge decisions for both the text-based and execution-based paths). **Deferred** — needs a real live session with real models; not something achievable without live verification.

### Phase 4 — Model-selection smartness (independent, can slot in anytime after Phase 1)
**Status: implemented, unit-tested, not yet live-verified.**
1. ~~Warn (at minimum) or resolve via host model-registry metadata (at best)...~~ **Done, warn-only**: `selectionWarning` (`domain/dispatch.ts`), surfaced via `DispatchPlan.warnings` → `reportProgress`. Resolving via host model-registry metadata was not pursued — the host has no notion of "model strength ranking" to resolve against.
2. ~~Warn when a "diverse" role's `ensembleSize` is smaller...~~ **Done**: same `selectionWarning` function, naming exactly which configured models are unreachable.

### Phase 5 — Robustness (independent, low-effort, can land anytime)
**Status: implemented, unit-tested, not yet live-verified.**
1. ~~Wrap `synthesizer.synthesize(...)` per-task...~~ **Done**: `fallbackSynthesis` (`application/dispatch-service.ts`) catches any throw from the first synthesis call and produces a synthetic zero-confidence, `failureRate: 1.0` outcome instead — which the existing Phase 3 `failureRateCeiling` check already escalates correctly.

### Phase 6 — Diversity / sampling control (confirmed implementable — see §1.6b)
**Status: implemented, unit-tested, not yet live-verified.**
1. ~~Add `temperature` (and optionally `temperatureLadder` override on `RoleModelPolicy`)...~~ **Done**: `temperatureForAttempts` (`domain/dispatch.ts`), `DEFAULT_TEMPERATURE_LADDER = [0.2, 0.6, 1.0]`.
2. ~~Thread it through `HostExpertExecutor.run()`...~~ **Done**, exactly as scoped.
3. ~~Stop discarding session settings entirely on every spawn...~~ **Done** — the constructed `Settings.isolated(...)` object is now always passed, not omitted.

### Not committed — flagged for later consideration
- Multi-agent debate / critique round (§2.2) — evidenced, but should follow Phases 1-3 so there's a stable foundation (isolation + a trustworthy confidence signal) to layer it on.
- Adaptive ensemble sizing (§2.4) — depends on Phase 3's recalibrated confidence signal to know when "inconclusive" genuinely means "sample more."
