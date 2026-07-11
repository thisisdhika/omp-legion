# Algorithm Audit & Hardening Plan — v1 (initial pass)

**Status:** v1 snapshot, captured before the deeper audit + research pass. Superseded by `algorithm-audit-and-hardening-v2.md` once that lands — kept for provenance, not as the live plan.

**Context:** the project's goal is to close the gap to (or beat) a gated frontier model (Claude Mythos) via ensembling of accessible models. This doc audits whether the current dispatch/synthesis/governance algorithms actually hold up under that goal, prompted by two concrete user concerns: (1) whether concurrent experts working on the same task corrupt each other's file edits (git worktree/isolation), and (2) why `approve`/`reject`/`edit` escalations feel like Human-**in**-the-Loop rather than Human-**on**-the-Loop in practice.

---

## Findings

### 1. Concurrency / isolation (critical)

- **No file isolation.** `HostExpertExecutor.run()` (`src/infrastructure/host-dispatcher.ts`) calls the bare host `runSubprocess` against the real project `cwd` — no `worktree` field is ever passed. Every concurrent mutating attempt (self-consistency samples of `legion-coder`/`legion-tester`/`legion-generalist`, or concurrent multi-task dispatch) races on the same real files: lost writes, interleaved edits, a final file state that matches none of the attempts' reported outputs.
- **The host already has the fix, unused.** `task/isolation-runner.ts` (host package) wraps the *same* `runSubprocess` Legion calls: `ensureIsolation(repoRoot, agentId)` materializes a copy-on-write view per spawn (APFS/btrfs/zfs/reflink/overlayfs/rcopy, whichever the host resolves), `runSubprocess({..., worktree: isolationDir})` runs the subagent against its own isolated copy, `commitToBranch(...)` captures that copy's changes as a branch (`omp/task/<taskId>`), and `mergeTaskBranches(...)` later cherry-picks branches onto the real repo sequentially, stopping cleanly on the first conflict.
- **Isolation alone doesn't answer "which expert's changes land."** Synthesis reconciles *text answers*, not file diffs. The clean design: merge only the branch belonging to the synthesis-selected attempt (`AnswerCluster.representativeAttemptId` is already computed) — sibling attempts contributed to the vote/synthesis text but their file edits never touch the real repo.
- **No concurrency throttling either.** The host's `task.maxConcurrency` semaphore lives only inside `TaskTool` (`task/index.ts`), never inside `runSubprocess` itself. Since Legion bypasses `TaskTool` (ADR 0002, needed for per-call `modelOverride`), Legion gets zero concurrency cap — a 5-task decomposition × ensembleSize 5 fires 25 concurrent subagent spawns with no limit anywhere.

### 2. Governance/HOTL calibration — explains the HITL-feeling complaint

- **`confidenceFloor` and `disagreementThreshold` are mathematically redundant at current defaults.** `disagreement := 1 - confidence` (`domain/synthesis.ts`) is a hard identity. With `confidenceFloor: 0.6` and `disagreementThreshold: 0.4` (summing to exactly 1.0), the two checks always fire together — one signal double-counted as two, not two corroborating signals.
- **Clustering thresholds (`DEFAULT_EMBEDDING_THRESHOLD = 0.84`, `DEFAULT_ROUGE_L_THRESHOLD = 0.82`) are uncalibrated guesses** — nothing in the codebase validates them against real expert-output pairs. Free-text code/review outputs rarely match word-for-word even when substantively identical; under-merging drags confidence down for reasons unrelated to genuine disagreement. With the default ensembleSize of 3, confidence only clears the 0.6 floor if at least 2 of 3 attempts cluster together — any 3-way split yields 0.33, always below floor.
- **Cost ceiling is flat and unscaled — confirmed live, not theoretical.** Both of this session's live tests escalated with reason `"cost"`. `costCeiling: 100_000` never scales with `ensembleSize`; three real coding subagents (read/edit/verify) easily sum to 90k+ tokens before any quality issue enters the picture.
- **No timeout on the decision gate.** `decisionGate` awaits `ctx.ui.select(...)` indefinitely — no auto-resolve, no fallback after N minutes.
- **A single escalated task blocks delivery of the whole dispatch.** `#run()` does `await Promise.all([...taskOutcomes])` — one escalated task holds the other tasks' already-finished results hostage before anything is delivered.
- **Causal link to isolation:** frequent escalation currently acts as an *accidental* safety net against the isolation gap — a human reviewing almost every dispatch naturally throttles unsupervised concurrent mutation. Recalibrating governance to escalate less **before** fixing isolation would remove that accidental protection. Isolation must land first.

### 3. Expert selection / diversity (high)

- **No temperature/seed control for self-consistency sampling.** Confirmed absent from both Legion and the host's `ExecutorOptions`. Diversity across N identical-model samples is entirely incidental, riding on undocumented provider defaults — a real gap against the Self-MoA thesis (arXiv 2502.00674) the design cites.

### 4. Robustness gap (medium)

- **All-experts-failed-for-one-task is an uncaught throw, not a handled state.** `clusterExpertAnswers` throws when every expert for a task returns empty/failed output. Nothing in `#run()`'s per-task mapper catches it (only `executor.run()` errors are caught via `failedResult`). The throw propagates through `Promise.all`, killing the entire multi-task dispatch and silently discarding any sibling tasks that succeeded.

### 5. Checked and found sound
Decomposition's anti-over-decomposition instruction, the aggregator prompt's cross-check framing (majority clusters as signal, not blind-vote instruction), config defaults/merge, agent persona prompt quality, the embedding fallback chain, persistence/audit-trail correctness.

---

## Plan (v1)

**Phase 1 — Isolation (blocks everything else; do first)**
1. Add an infrastructure module wrapping the host's `task/isolation-runner.ts` (`prepareIsolationContext`, `ensureIsolation`, `commitToBranch`) — one isolated view per attempt.
2. Change `HostExpertExecutor.run()` to run each attempt through isolation instead of bare `runSubprocess`; capture each attempt's branch/patch instead of mutating the real repo directly.
3. After synthesis picks a winner (`AnswerCluster.representativeAttemptId`), merge only that attempt's branch (`mergeTaskBranches`); discard sibling attempts' isolated changes.
4. Guarantee cleanup (`cleanupIsolation`) on every exit path: success, HOTL rejection, abort, thrown error.
5. Add a concurrency cap on Legion's own dispatch (a semaphore in `DispatchService`, configurable) since the host's cap doesn't cover Legion's direct-executor calls.

**Phase 2 — Governance recalibration (only after Phase 1 lands)**
1. Replace the redundant confidence/disagreement pair with one real signal, or explicitly decouple them.
2. Scale `costCeiling` by `ensembleSize` instead of one flat global number.
3. Add a decision-gate timeout with a documented fail-safe default (reject).
4. Decouple per-task delivery from `Promise.all` batching.
5. Empirically re-tune clustering thresholds against real expert-output pairs (extend `scripts/benchmark.ts`).

**Phase 3 — Diversity (lower priority, partially host-blocked)**
1. Investigate whether any per-call sampling control is reachable at all through the host's completion path; if genuinely blocked, document as a known limitation.

**Phase 4 — Robustness**
1. Wrap `synthesizer.synthesize(...)` per-task so an all-experts-failed task produces a per-task failure result instead of an uncaught throw that kills sibling tasks.
