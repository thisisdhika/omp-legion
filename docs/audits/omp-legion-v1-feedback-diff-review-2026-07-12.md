# omp-legion v1 — feedback-diff review handoff (2026-07-12)

## Context

`docs/feedback/omp-legion-v1-feedback.md` raised 6 requirements against the v1
implementation (runtime model fallback, one-step adaptive ensemble expansion,
IRC isolation hardening, config resolution from `config.yml`'s `config.legion`,
rules/agent packaging placement audit, explicit sequential decomposer model
policy). Another worker (traced via its own omp session
`019f54ab-5534-7000-bf2a-ff5b1f0e34a8`) implemented a response — **currently
uncommitted**, sitting on top of this session's own prior work at `HEAD`
(commit `6053d30` at time of review; 6 phases of algorithm hardening —
isolation, execution-grounded consensus, governance recalibration,
model-selection warnings, robustness, temperature diversity — all committed
and passing 80/80 tests before this diff landed).

```
git -C /Users/thisisdhika/Projects/kaa.ltd/LAB/omp-legion diff HEAD --stat
# 35 files changed, 2932 insertions(+), 333 deletions(-)
```

That worker's own session closed with: *"Nothing remains to do. The
implementation is complete and verified: 144 tests passing, Typecheck
passing, Lint passing, Packaging/discovery smoke tests passing."* This claim
does **not** hold under adversarial review — see findings below. `bun test`
and `bun run typecheck` both pass clean; none of the bugs found here are
caught by the existing suite.

**This review's scope:** the uncommitted diff only. The diff has **not been
fixed yet** — nothing has been edited since the findings were reported.

## Review method

Ran the `code-review` skill at `max` effort: 10 finder angles (line-by-line,
removed-behavior, cross-file tracer, language pitfalls, wrapper/proxy
correctness, reuse, simplification, efficiency, altitude, conventions) → 1-vote
verify per surviving candidate → gap sweep. 14 findings survived, reported via
`ReportFindings`. Full finder + verifier transcripts are not persisted beyond
this doc — treat the findings below as the source of truth going forward.

## Findings, most severe first

### 1. `verified` flag silently dropped at 3 call sites — CONFIRMED, highest priority
**File:** `src/application/dispatch-service.ts:861, 1028, 885`

`#dispatchTask` computes `verifiedResults` (line ~808, via `#verifyResults`,
which returns **new** objects — it does not mutate `results` in place) but
only ever feeds it to the *first* synthesis call. Three other sites use the
raw, never-verified `results` array instead:

- Line ~861: HOTL "edit" resolution re-synthesizes from raw `results`.
- Line ~1028: `#runExpansion`'s post-expansion synthesis uses raw
  `results`/`params.results` — only the one newly-added expansion attempt has
  a fresh verified flag (via `#verifyOne`); the original ensemble's
  verification is lost.
- Line ~885: `#dispatchTask`'s returned `TaskDispatchOutcome.results` (raw,
  persisted via `repository.complete`/`repository.fail`) permanently loses
  `verified` for every attempt except a manually re-verified expansion one.

**Why it matters:** `preferVerifiedCluster`/`promoteVerifiedCluster`
(`src/domain/synthesis.ts:279`) only promotes a verified-passing attempt's
cluster when it can see `verified: true`. This defeats that guarantee exactly
in the escalation/expansion paths this feedback round added — i.e. exactly
where a human relies on the signal most. No test catches it:
`tests/application/dispatch-service.test.ts` only inspects
`synthesizer.inputs[0]`.

**Fix direction:** thread `verifiedResults` (not `results`) through the edit
path, the expansion path, and the return value. `#runExpansion` needs to
verify-and-merge into the *verified* array, not the raw one.

### 2. IRC isolation guard fails open for isolated experts — CONFIRMED, security-relevant
**File:** `src/infrastructure/agent-execution-context.ts:71`,
`src/infrastructure/irc-tool-guard.ts:66`

`runIsolatedSubprocess` runs in-process (no OS subprocess/IPC — confirmed, no
spawn/fork/Worker in the host's executor.ts) but clears preloaded
extension/tool paths so the isolated worktree re-discovers and re-imports the
extension from its own mounted copy of the repo — a distinct absolute path.
Node/Bun's module cache is keyed by resolved path, so this re-import
instantiates a **second**, uninitialized `AsyncLocalStorage` whose `.run()` is
never called for that expert. `currentDispatchContext()` then returns
`undefined`, and `evaluateIrcCall` treats a missing context as trusted
control-plane (`if (!context || context.senderKind !== "expert") return {
block: false }`) — every `send`/`wait` is allowed unconditionally.

**Why it matters:** this is the primary execution path Legion always uses for
real dispatch (isolated worktree per attempt), not an edge case. The entire
IRC isolation policy (feedback item 3) is defeated for its main use case.

**Fix direction:** the isolation context needs to be re-derived or
re-propagated inside the isolated run itself (e.g. read from an env var / a
value passed through `runIsolatedSubprocess`'s own args, not a
process-local `AsyncLocalStorage` that can't survive a module-cache split), or
`evaluateIrcCall` needs to fail closed on missing context for anything that
*could* be an isolated expert rather than defaulting to trusted.

### 3. `#verifyOne` uncaught rejection cascades across the whole batch — CONFIRMED
**File:** `src/application/dispatch-service.ts:1085-1101`

No `catch` around `verifier.verify(...)` (same gap in sibling `#verifyResults`,
lines 558-579). A verify-command failure during one task's adaptive expansion
propagates through `#runExpansion` → `#dispatchTask` → the outer
`Promise.all` in `#run` (line ~627), which rejects the *whole* batch. `#run`'s
catch (line ~614-740) treats this as whole-job failure and calls
`repository.fail(...)` with empty `results`/`syntheses`/`governance`,
discarding every other task's already-completed work. Every other failure
path in the file (`runAttempt`, `#synthesize`, `fallbackSynthesis`) is
deliberately wrapped to avoid exactly this.

**Fix direction:** wrap `verifier.verify(...)` in try/catch inside
`#verifyOne` and `#verifyResults`, falling back to `verified: false` (or
omitted) on error rather than propagating.

### 4. Cost ceiling never trips for runtime fallback — CONFIRMED
**File:** `src/application/dispatch-service.ts:919` (gate), `:293-297`
(`expertCost`)

`expertCost` is a **mean** of tokens per attempt, not a sum. Chained
zero-token instant failures (e.g. immediate 429s before any tokens are
consumed) pull the mean toward zero, so `expertCost(...) >= costCeiling` never
trips — the fallback loop is bounded only by candidate exhaustion, not cost,
contradicting the feedback doc's explicit cost-ceiling requirement.

**Fix direction:** either sum tokens for the ceiling check specifically (keep
the mean for whatever else it's used for), or gate additionally on attempt
count / wall-clock time.

### 5. Quota misclassified as retryable — CONFIRMED
**File:** `src/domain/dispatch.ts:337-352`

`RETRYABLE_FAILURE_PATTERNS` includes `/quota/i`. The host's own
`isProviderRetryableError` (`@oh-my-pi/pi-ai/src/error/retryable.ts:40-59`)
explicitly treats quota/usage-limit errors as **non**-retryable, owned by the
credential-rotation layer. Legion's classifier inverts this deliberate
boundary, burning a fallback attempt on a model swap that can't fix an
account-level limit.

### 6. Missing retryable patterns for plain transport errors — CONFIRMED
**File:** `src/domain/dispatch.ts:337-352`

No pattern matches `"fetch failed"`, `ECONNRESET`, DNS failures, etc. — the
host's own `TRANSIENT_TRANSPORT_PATTERN`
(`@oh-my-pi/pi-ai/src/error/flags.ts:90-91`) explicitly lists these as
transient. Legion classifies them `"fatal"` and skips fallback for a
genuinely recoverable network blip.

**Findings 5 and 6 share a root enabler:** see finding #11 below
(`host-dispatcher.ts` drops the host's own `retryFailure` signal, forcing
Legion to re-derive classification via regex instead of trusting the host).
Fixing #11 would make both #5 and #6 structurally impossible instead of
requiring an ever-expanding pattern list.

### 7. Hardcoded global config path bypasses `getAgentDir()` — CONFIRMED
**File:** `src/infrastructure/host-config.ts:182`

`loadLegionConfig` builds the global config dir as
`homedir()+"/.omp/agent"` instead of calling the host's `getAgentDir()`
(`@oh-my-pi/pi-utils/src/dirs.ts`), which resolves profile-scoped and
XDG-redirected paths. Silently reads the wrong (or no) file for any user on a
non-default profile or with `XDG_CONFIG_HOME` set, with no diagnostic.

### 8. `parentAgentId` hardcoded to `"Main"` — CONFIRMED, self-acknowledged gap
**File:** `src/infrastructure/host-dispatch-service.ts:65`

Wrong routing whenever `legion_dispatch` is called from a non-top-level agent
— every spawned expert's `allowedDestination` is still `"Main"`, so reports
never reach the actual caller. The codebase's own doc comment
(`agent-execution-context.ts:40-51`) already documents this as known, unfixed
— the real fix needs the spawning session's live IRC peer id plumbed through,
which isn't wired yet. Also duplicates the host's `MAIN_AGENT_ID` constant as
a bare string literal instead of importing it.

### 9. `list`/`inbox` ops leak sibling ensemble info — CONFIRMED
**File:** `src/infrastructure/irc-tool-guard.ts:62`

The guard exempts `list`/`inbox` unconditionally ("read-only"). The host's
`list` op returns every other peer's id, status, parentId, and current
activity — an isolated expert can passively learn ensemble composition and
sibling progress without ever sending a blocked message, which is exactly the
correlation the isolation design's own stated threat model says it prevents.

### 10. Decomposer fallback ignores shared `classifyFailure` — CONFIRMED
**File:** `src/infrastructure/llm-decomposer.ts:117-138`

Catch block treats any non-abort exception as retryable, unconditionally
advancing to the next configured model — no error-message inspection, no use
of the shared `classifyFailure` the expert-fallback path uses. Masks a
genuinely fatal provider error (auth failure, 400, context-length) behind
"exhausted all N models." Lower stakes (short model lists) but a real
inconsistency between two fallback mechanisms in the same codebase.

### 11. `host-dispatcher.ts` drops the host's own `retryFailure` signal — PLAUSIBLE
**File:** `src/infrastructure/host-dispatcher.ts:174-191`

`HostExpertExecutor.run` never copies the host's own authoritative
`result.retryFailure` into the `ExpertResult` it builds, forcing
`classifyFailure` to re-derive retryability from regex on the raw error
string. Root cause enabling #5 and #6.

### 12. Fallback/expansion reads unfiltered `candidates`, not `isAvailable`-filtered `models` — PLAUSIBLE
**File:** `src/domain/dispatch.ts:394` (`nextReplacement`)

`nextReplacement` walks the raw `candidates` list with no `isAvailable`
re-check. An existing test (`tests/domain/dispatch.test.ts`, "retains
unavailable configured candidates for runtime fallback") asserts this is
intentional — presumably so a transiently-unavailable model can be retried
later. Whether that's actually sound depends on whether `isAvailable` encodes
transient vs. permanent unavailability, which isn't documented anywhere.
Worth confirming intent before treating as closed.

### 13. Adaptive expansion dead-on-arrival for self-consistency under default config — PLAUSIBLE / design gap
**File:** `src/domain/dispatch.ts:411`

With zero custom config (ensemble size 3, ladder length 3, self-consistency
default), all 3 ladder temperatures are already consumed by the initial plan.
`nextReplacement`'s exhaustion check is mathematically correct — there is no
unused temperature — but the practical effect is that feedback item #2's
flagship feature (adaptive expansion) silently can't fire at all for the most
common configuration, with no warning surfaced to the user.

### 14. `#verifyOne` duplicates `#verifyResults` — PLAUSIBLE / cleanup
**File:** `src/application/dispatch-service.ts:1085`

Both independently acquire concurrency, call `verifier.verify(...)`, and
build a verified `ExpertResult` copy. Any fix to verification semantics (e.g.
#1 or #3 above) has to be applied in two places — exactly the kind of drift
that produced #1.

## What's NOT done yet

- **None of the 14 findings have been fixed.** The diff is exactly as the
  other worker left it.
- Live smoke-testing (Scenarios 1-10, the 10 pending tasks in this session —
  natural-language trigger, auto-decomposition, self-consistency merge-back,
  diverse-reviewer, diverse-tester, HOTL approve/reject/edit, decision-gate
  timeout, native-task guard, config-warning surfacing, Subagents HUD) was
  explicitly **paused, not cancelled**, to do this review. It should resume
  only after the critical findings (#1-#3 at minimum) are fixed, since #1
  directly undermines what Scenario 3/5 (self-consistency/diverse merge-back)
  are meant to verify, and #2 undermines what the isolation-focused scenarios
  would be testing.

## Recommended next steps

1. Fix #1-#3 first (correctness + security-relevant; everything else is
   lower blast-radius).
2. Fix #4-#10 (concrete, reproducible, contradicts host's own policy or the
   feedback doc's explicit requirements).
3. Decide on #11-#14 (lower-confidence or design-level; #11 is worth doing
   since it structurally prevents #5/#6 from recurring).
4. Re-run `bun test` + `bun run typecheck` + `biome check` after fixes —
   note the existing suite did **not** catch any of #1-#10, so passing tests
   post-fix isn't sufficient proof; consider adding regression tests for at
   least #1, #2, and #4 given how silent their failure mode is.
5. Resume the paused live smoke-testing scenarios once the above is done.

## Reference

Other worker's own session transcript (its stated reasoning, if useful):
`/Users/thisisdhika/.omp/agent/sessions/-Projects-kaa.ltd-LAB-omp-legion/2026-07-12T04-52-22-453Z_019f54ab-5534-7000-bf2a-ff5b1f0e34a8.jsonl`
