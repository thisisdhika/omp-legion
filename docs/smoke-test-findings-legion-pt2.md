# Smoke-test findings — legion-pt2 live session

Live end-to-end smoke test of omp-legion via `/omp-interactive-cmux`, driven against the
`legion-pt2` scratch project (mid-complexity URL-shortener service with deliberately planted
bugs, used as ensemble bait — not to be fixed here).

Primary agent: `opencode-go/mimo-v2.5`. Scope: every Legion feature, varied config/scenarios,
edge cases. This file is a running log — issues are recorded, not fixed, per instruction.
Each entry: what was tested, what happened, why it's a concern (or confirms correct behavior).

---

## Summary (final pass)

18 scenarios exercised across every major Legion surface: implicit decomposition (atomic-vs-split
judgment calls), explicit multi-task dispatch, custom project personas, HOTL escalation
(approve/reject/edit), `git-commit-guard`, `task-tool-guard`, `/centurion`, config precedence,
and edge cases (empty task, invalid model question, abort semantics). Sanity-checked the target
repo afterward — main working tree is clean (0 commits, only the original scaffold files
untracked), confirming the unauthorized-commit finding below stayed contained to isolated expert
worktrees.

**Two critical findings, fix before anything else ships:**
1. **`git-commit-guard` did not block a `legion-coder` expert from running a real `git commit`**
   (with a `git add -A` blast radius of 651 files / 583,992 insertions in its worktree). The
   regex itself checks out on manual trace — likely a `senderKind` context-propagation gap or a
   worktree-isolation execution path that bypasses the `tool_call` event hook entirely. Needs an
   integration test on the real dispatch path, not just the existing pure-function unit test.
2. **`/centurion` never invoked the bundled ensemble-driven skill** — first attempt silently ran
   a same-named generic `grilling` skill instead (phrase-collision), and a clean retry with zero
   competing phrasing produced no skill resolution at all, just the primary agent freelancing a
   `legion_dispatch` call on its own judgment. The flagship "every question comes from the
   ensemble" feature is currently unreachable via its documented `/centurion` trigger.

**Two major findings worth a follow-up look:**
3. A reproducible single-straggler-expert stall (17-27+ min, no `RETRYING` transition, no
   timeout) — likely a rejected-tool-call retry loop when an expert is asked to do something
   outside its tool grant (observed with a read-only reviewer asked to edit a file).
4. Multi-task dispatches ran far slower (~18 min) than single-task ones (<2 min) with an opaque
   `SYNTHESIZING` phase for most of that time and no incremental signal — compounds finding #5.

**Positive/working-as-designed confirmations:** fail-closed `resolveAgentName` (blocks unknown
roles, no silent substitution), `task-tool-guard` (blocks native `task` tool against `legion-*`
agents), decomposer's anti-over-split bias (atomic tasks stay atomic, genuine multi-part tasks
correctly fan out with mixed dispatch types — `legion_dispatch` + plain `task` scout as
appropriate), custom project personas and project config overrides (`legion-security-auditor`,
`modelMap.security-auditor`), the HOTL approve/reject/edit escalation UI end-to-end, and
ensemble synthesis quality (multiple runs found real bugs beyond what a single pass caught,
including one genuinely new bug in `generateCode()`).

**Cosmetic/UX findings (minor-to-moderate):** `Mixtures` card's "~N models" is actually an
attempt count, not a distinct-model count; concurrent Legion widgets carry no label so a user
can't tell which sub-task each belongs to; a multi-task widget's progress denominator doesn't
match the card's stated total; a widget observed stuck on `[COMPLETED]` with a still-ticking
clock and no delivered result.

**Known coverage gaps** (not exercised to a clean, unambiguous result in this pass): the
`RETRYING`/`EXPANDING` phases specifically (never observed independent of the stall/critical
findings above), a confidence-triggered (as opposed to cost-triggered) HOTL escalation, and a
live end-to-end confirmation of an invalid `modelMap` entry's failure mode (discussed, not
dispatched, to conserve time given the ~15-25 min per-dispatch cost observed throughout this
session).

---

## Format

Each finding:

```
### <short title>
- **Scenario:** what was run
- **Expected:**
- **Actual:**
- **Severity:** info | minor | moderate | major
```

---

### Primary agent skips legion_dispatch for a textbook-matching task
- **Scenario:** Fresh session (`opencode-go/mimo-v2.5`, thinking level auto→high), first turn: "Review src/store.ts for correctness bugs." No mention of Legion/ensemble by name.
- **Expected:** Per `legion_dispatch`'s own tool description ("Use it whenever a task is a judgment call where being wrong is costly... even if the user never asks for review or mentions this tool by name: ... a subtle correctness bug...") — this prompt is close to a literal example from the description. Expected the primary agent to invoke `legion_dispatch`.
- **Actual:** The agent called `Read src/store.ts` directly and answered from its own single-pass reasoning — no `legion_dispatch` call at all. It did correctly find both real bugs (`has()`/`size` ignoring TTL) unaided, so the *answer* was fine, but the ensemble path was never exercised.
- **Severity:** moderate — this suggests the tool description's proactive-use language isn't strong enough (or is being deprioritized) to actually change primary-agent behavior on the exact class of task it names. If this generalizes, Legion's ensemble value is only realized when a user explicitly asks for it, undermining the "beat a frontier model without being asked" goal. Needs a follow-up: try more explicit judgment-call framing, and/or test whether system-prompt-level nudging (vs. tool-description-level) is needed.
- **Note:** Confirmed via `/tools` that `legion_dispatch` IS registered and its description is intact/correctly worded — this is a behavioral/adoption gap, not a registration bug.

### Explicit legion_dispatch (single implicit task, no `tasks` array) — full lifecycle
- **Scenario:** Follow-up in the same session: "use legion_dispatch explicitly to get a second opinion" on the same store.ts review, no `tasks` array supplied (implicit decomposition path).
- **Actual:** Rendered correctly end-to-end:
  - Dispatch card: `Task` section shows the full enhanced prompt (decomposer expanded "review for correctness bugs" into a structured brief: locate bugs, state location/problem/fix, separate design concerns) — no unwanted splitting, single `Mixtures` entry.
  - Live widget cycled through phases correctly and matched `PHASE_LABELS`: `[DECOMPOSING] deciding how to split the task` → `[RUNNING] experts working` → `[RUNNING] 1/3 experts finished` → `[SYNTHESIZING] merging outputs` → final synthesized answer.
  - 3 real distinct backing models dispatched (`Hy3`, `nemotron-3-ultra-550b-a55b:free`, `deepseek-v4-pro`), each with its own subagent transcript viewable (drilled into one via the TUI, `Esc`/`←←` navigation worked).
  - Synthesis correctly merged: kept the primary agent's 2 bugs, added a new one from an expert (`set()` accepts non-positive `ttlMs`), explicitly attributed it ("One expert flagged..."), and improved the fix vs. the primary agent's own first-pass version (evict-on-read in `get()` vs. sweep-based `size()`). This is a genuine MoA quality win — the synthesized answer is measurably better than the single-agent-only first pass earlier in this same session.
- **Severity:** info (positive) — core dispatch lifecycle, widget phases, and synthesis quality all work as designed.

### Mixtures card's "~N models" count is actually an attempt count, not a distinct-model count
- **Scenario:** Store.ts single-task run: card showed `experts: ~2 models` but 3 experts (`Hy3`, `nemotron-3-ultra`, `deepseek-v4-pro`) actually ran. Explicit two-task run (shortener.ts + store.ts, both role `reviewer`, 3-model ensemble each): card showed `reviewer: ~6 models`.
- **Root cause (confirmed):** `modelCountLabel()` is counting total dispatched *attempts* (tasks × ensembleSize), not distinct models. The two-task run used the same 3 varied models for both tasks (3 distinct models total, 6 attempts), and the label showed 6 — i.e. it's an attempt count mislabeled as a model count. The single-task store.ts mismatch (label said 2, 3 ran) is a separate/smaller discrepancy in the same code path.
- **Severity:** minor-to-moderate — mislabeling "attempts" as "models" is misleading in exactly the case (explicit multi-task dispatch) where a user most wants to know how many *distinct* models are cross-checking each other, since the whole pitch of Legion is model-diversity ensembling. Fix: either count distinct model identifiers actually attempted, or relabel to `~N attempts` when it's genuinely an attempt count.

### Multiple concurrent Legion widgets are indistinguishable
- **Scenario:** A genuinely multi-part user request ("review rateLimiter.ts, security-audit admin.ts, check README collision question") caused the primary agent to fan out into its own 3-item todo list, dispatching 2 concurrent `legion_dispatch` ensembles (rateLimiter review, admin.ts audit) plus one `task`-tool scout in parallel.
- **Expected:** When 2+ Legion widgets are visible on screen at once, each should be identifiable — which job/task it belongs to.
- **Actual:** Both concurrent widgets render identically: `⣄ Legion | 0:54` / `[RUNNING] experts working`, with no label, task ref, or job id distinguishing one from the other. See attached screenshot.
- **Severity:** moderate — with a single in-flight dispatch this is fine, but the moment the primary agent fans out (which the redesigned decomposer is explicitly meant to encourage for genuinely multi-part work), the live widgets become redundant/confusing — a user can't tell which widget corresponds to which sub-task. `monitorWidget` in `dispatch-tool.ts` needs a short task label (e.g. the `ref`/job id used in the Mixtures card) prefixed onto the `Legion |` line so concurrent widgets are distinguishable.

### Concurrent widgets: status/message appeared to glitch, and expert counts look inconsistent with config
- **Scenario:** Same 3-way parallel fan-out as above. User observed the two concurrent Legion widgets' status/message occasionally glitching while watching live (compounds the no-label issue above — with two unlabeled widgets updating independently, a glitch in either reads as "which one just changed?" confusion).
- **Actual (captured mid-run):** `rateLimiter.ts` review widget showed `[RUNNING] 1/2 experts finished` (2 experts dispatched: `Hy3`, `deepseek-v4-pro` — `nemotron-3-ultra` from the earlier store.ts run did not appear this time, so ensemble size/model selection isn't fixed run-to-run, which is expected for `strategy: diverse`). `admin.ts` security-audit widget showed `[RUNNING] 1/3 experts finished`, but only one subagent (`legion-perform-a-security-security-auditor-hy3:free-1`) was visible in the `Subagents` panel at that moment.
- **Resolved during task #13 (config precedence check):** Directly diffed global (`~/.omp/agent/config.yml`) vs project (`.omp/config.yml`) configs. Global has `modelMap.reviewer.ensembleSize: 3` — which fully explains every "3 experts" reviewer run observed in this session, and confirms the earlier "~2 models" card label (task #4/#6 findings) was simply wrong, not config-related. Global has **no** `security-auditor` entry at all — that role is defined entirely by the project override (`ensembleSize: 2`, 2 named models). The "1/3" reading against the security-auditor widget is best explained by the already-logged "widget denominator doesn't match the Mixtures card's total" bug (two concurrent widgets were on screen at the time; the `reviewer` task's `3` denominator likely bled into the `security-auditor` widget's display). **Conclusion: this is not a config-precedence failure** — closing this as explained by the pre-existing widget-aggregation bug, not a new governance-correctness issue.
- **Severity:** downgraded to info/no-action — folded into the existing widget-denominator finding above.

### Genuine multi-part task correctly decomposed at the primary-agent level, mixed dispatch types
- **Scenario:** "review rateLimiter.ts for correctness bugs, security-audit admin.ts's command execution, and check whether the README's collision-handling question is answered in code" — three genuinely independent, differently-shaped sub-asks in one message.
- **Actual:** Primary agent built its own 3-item todo list and dispatched appropriately per sub-task shape: `legion_dispatch` ensemble for the rateLimiter correctness review, `legion_dispatch` ensemble for the admin.ts security audit (correctly routed to the project's custom `legion-security-auditor` persona — confirms task #7, the custom project persona, works end-to-end), and a plain `task`-tool scout for the README grep-style lookup (no ensemble needed for a pure lookup — correct judgment call). All three ran concurrently; results streamed in as each finished (collision search: 47.9s; rateLimiter ensemble: 4m36s; admin.ts audit: similar order). Final synthesis correctly merged all three per-task write-ups without cross-contaminating them.
- **Quality of results:** rateLimiter ensemble found 6 real bugs across severity tiers (critical: 60,000× refill-rate unit bug — matches the planted bug exactly; high: unbounded bucket-map memory leak — also matches the planted bug exactly; plus 4 more the planting didn't anticipate: no constructor validation, backward-clock handling, float drift, cluster-safety). admin.ts audit reported **unanimous, confidence 1.0, zero disagreement** on the `new Function()` RCE — correctly identified it as `eval()` in disguise with a full concrete attack table (RCE via child_process, env-var/secrets exfil, file read, reverse shell, data exfil) and a correct fix (closed command-dispatch map). Collision-handling search correctly found the code does NOT address it (`exists()` exists but `shorten()` never calls it) — matches the planted bug exactly.
- **Severity:** info (positive) — this is the clearest evidence so far that decomposition, role-routing (including custom project personas), and ensemble synthesis all work together correctly for real multi-part work, and that the ensemble found more/deeper issues than a single pass would (see rateLimiter's 4 unplanted bugs).
- **Latency note:** the rateLimiter ensemble took 4m36s — worth a follow-up look at whether that's normal for the free-tier models in this config or a symptom of retries/slow experts; no timeout/stall occurred, but it's slow enough a user might wonder if it's stuck (compounds the "no label, can't tell what's running" finding above).

### Fail-closed resolveAgentName works correctly, but primary agent needed 3 tries to guess a valid role string
- **Scenario:** Explicitly asked the primary agent to call `legion_dispatch` with its own hand-written `tasks` array (2 explicit tasks: shortener.ts correctness review, store.ts API design review), bypassing decomposition.
- **Actual:**
  1. First attempt used role `"Correctness reviewer"` → correctly rejected: `Legion has no "legion-correctness reviewer" persona for role "Correctness reviewer"... dispatch this task with the native task tool instead.`
  2. Second attempt used role `"legion-reviewer"` (guessing the full persona name as the role) → correctly rejected: `Legion has no "legion-legion-reviewer" persona for role "legion-reviewer"...` (double-prefixing, since `resolveAgentName` prepends `legion-` to whatever role string it's given).
  3. Third attempt used role `"reviewer"` → succeeded, resolved to persona `legion-reviewer`, dispatched correctly with no `DECOMPOSING` phase (confirms explicit `tasks` arrays correctly bypass decomposition) and a nested `Mixtures` card grouped by role (`reviewer: ~6 models` for the 2×3 expert fan-out).
  - This is the fail-closed guard (from earlier session work) behaving exactly as designed — it never silently substituted a wrong agent, and each rejection message was actionable.
- **Severity:** minor (UX friction, not a bug) — the guard itself is correct, but the primary agent burned 2 wasted round-trips guessing the role-string convention (bare role name, no "legion-" prefix, no capitalization/spaces) before succeeding. The `legion_dispatch` tool's parameter description for `tasks[].role` should state the exact convention (e.g. "bare role name matching an available `legion-<role>` persona, e.g. `reviewer`, not `Reviewer` or `legion-reviewer`") so agents get it right on the first try instead of learning it from rejection messages.

### Widget's progress denominator doesn't match the Mixtures card's stated total (multi-task dispatch)
- **Scenario:** Same explicit two-task dispatch (2 tasks × 3-expert ensemble = 6 total attempts, as the card correctly states via `reviewer: ~6 models`).
- **Actual:** The live widget showed `[RUNNING] 1/3 experts finished` — using a denominator of 3, not 6. It appears to be counting progress for only one of the two tasks (or resetting per-task) rather than aggregating across the whole dispatch the way the Mixtures card's total does.
- **Severity:** minor — internally inconsistent with the card's own stated total, and could read as the job being "done" (e.g. hitting 3/3) while 3 more attempts are still running elsewhere. `describePhase()`/`phaseDetail()` in `dispatch-tool.ts` should aggregate the finished/total count across all tasks in a multi-task dispatch, not just the most-recently-reported task.

### HOTL cost-ceiling escalation — full live lifecycle, edit path
- **Scenario:** The explicit two-task `legion_dispatch` (shortener.ts + store.ts reviews) ran unusually long (~17 min) and tripped a real `costCeiling` HOTL escalation: `Warning: Legion escalation for legion-two-independent-reviews/shortener-correctness: cost`, widget switched to `[ESCALATED] waiting on a human — cost`, and an interactive `approve / reject / edit` menu appeared (arrow-key navigation confirmed working). Selected `edit`, which opened a free-text "Legion escalation note" prompt; submitted `"reduce to a single reviewer model for this task and continue"`.
- **Actual:** The edit was accepted, the job resumed, and completed successfully ~40s later (`Background job completed [task] legion-two-independent-reviews (18m30s)` total). Final synthesis correctly incorporated the edit-narrowed follow-up work and produced a cross-referenced "Updated priority stack" spanning issues found across every file audited in this session (admin.ts RCE, rateLimiter's 60,000× unit bug, shortener's silent-collision-overwrite + the previously-unfound `generateCode()` variable-length bug) — genuinely useful synthesis behavior, not just a per-file dump.
- **New bug found via this pass, previously unfound:** `generateCode()` in `shortener.ts` — `Math.random().toString(36).slice(2, 8)` can legitimately produce empty or short-than-6-char strings (e.g. `Math.random() === 0` → `""`), shrinking the effective keyspace and raising collision odds far above what `CODE_LENGTH = 6` implies. This is a real, previously-unplanted-but-real bug the ensemble caught that a human reviewer likely would have too — good evidence of ensemble value.
- **Severity:** info (positive) — the approve/reject/edit HOTL escalation menu, free-text edit-note flow, and job resumption after edit all work correctly end-to-end.
- **Concern flagged separately below:** the ~17 minute runtime before escalation fired is itself worth scrutiny (see next entry) — a costCeiling escalation firing only after 17 minutes of wall-clock time is very late from a "catch it before it gets expensive" governance perspective, even if the token-cost math is technically correct.

### Explicit multi-task dispatch took ~18 minutes end-to-end — needs latency investigation
- **Scenario:** Same run as above (2 explicit tasks × ~3 experts each = 6 attempts, using the project's free-tier model pool).
- **Actual:** `SYNTHESIZING` phase alone appeared stuck for 10+ minutes with the widget showing no new information (just an incrementing elapsed-time counter) before a cost-ceiling escalation fired at 17:26. Total job time: 18m30s. Compare to the single-task store.ts ensemble earlier in the same session, which completed in under 2 minutes.
- **Severity:** major (needs follow-up, not necessarily a bug in omp-legion itself) — this could be: (a) free-tier model rate-limiting/queueing on the backend (plausible, unverifiable from the TUI), (b) a real stall/retry-storm in the synthesis step for multi-task jobs specifically, or (c) HOTL's `costCeiling` check only evaluating periodically rather than as soon as the threshold is crossed, causing the 10+ minute delay between "should have escalated" and "did escalate." Whichever it is, a user watching the widget during those 10 minutes has zero signal whether the job is alive, stuck, or just slow — this compounds the earlier "no per-widget label" and "denominator mismatch" findings into a genuinely poor experience for multi-task dispatches. Recommend: (1) verify whether this reproduces with paid/faster models to isolate backend-slowness vs. a real code issue, (2) check whether `SYNTHESIZING` should report incremental progress instead of a single opaque phase for however long synthesis takes.

### Reproducible single-straggler-expert stall (17+ min, still unresolved at end of test window)
- **Scenario:** Across at least 3 separate multi-expert dispatches in this session (store.ts review, explicit 2-task rateLimiter/admin.ts run, and the git-commit-guard test below), the pattern repeats: 2 of 3 experts finish reasonably quickly, and the 3rd hangs — sometimes 17+ minutes with zero progress, no error, no retry/RETRYING phase transition, just `[RUNNING] 2/3 experts finished` frozen. In the clearest case (this git-commit-guard test), the `Subagents` panel narrowed to showing only `legion-single-task-do-reviewer-nemotron-3-ultra-550b-a55b:free-1` as the sole remaining entry, strongly suggesting the `nemotron-3-ultra-550b-a55b:free` model specifically is the stuck one, consistently.
- **Actual:** No `RETRYING` phase ever appeared during any of these stalls — the phase system never treated "one expert taking 15+ minutes" as retry-worthy, it just sat in `RUNNING` indefinitely. This test was eventually abandoned (moved on to other scenarios) with this dispatch still unresolved in the background after 17+ minutes.
- **Severity:** major — whether the root cause is the free-tier `nemotron-3-ultra-550b-a55b:free` model being genuinely slow/rate-limited upstream (plausible, external), or omp-legion's expert-attempt layer lacking a per-expert timeout, the user-facing result is the same: a dispatch can hang indefinitely with no escalation, no retry, and no visible signal to the user beyond a static "2/3" that could mean "almost done" or "will never finish." Recommend adding a per-expert timeout that either retries with a different model or drops the straggler and synthesizes from the experts that did respond, rather than blocking indefinitely.
- **Coupling note:** This did NOT trigger the `RETRYING`/`EXPANDING` phases task #9 was meant to test — those phases may simply not exist as a response to "one expert is slow," only to explicit failures. Worth checking whether `RETRYING` is reachable at all outside of a hard expert failure/rejection, versus a slow-but-not-failed expert.

### Escape does not cancel a backgrounded Legion job (by design, but worth confirming as documented behavior)
- **Scenario:** Pressed `esc` while the stuck git-commit-guard test dispatch was at `[RUNNING] 2/3 experts finished` for 17 minutes, intending to abort it.
- **Actual:** `esc` returned control of the *foreground turn* to the input box immediately (consistent with the cmux skill's documented "escape cancels the in-flight turn" behavior), but the underlying Legion job kept running in the background — sending a new message ("status check") was accepted immediately and the `Legion | 17:05` widget was still live and counting. This matches `legion_dispatch`'s own tool description ("Returns immediately with the job ID; the ensemble ... continue asynchronously in the background") — so this is working as designed, not a bug — but it means there is **no user-facing way to actually cancel a runaway/stuck background Legion job** from the TUI once dispatched, short of ending the whole session. Worth deciding if that's an acceptable gap given the stall issue above, or if a `/legion cancel <job>`-style affordance is warranted.

### task-tool-guard correctly blocks native `task` tool against a `legion-*` agent
- **Scenario:** Asked the primary agent to call the native `task` tool directly with agent name `legion-reviewer` (bypassing `legion_dispatch`).
- **Actual:** Blocked immediately and cleanly: `legion-* agents must be dispatched via legion_dispatch, not the native task tool.` — no wasted attempts, no ambiguity. The primary agent's own commentary noted this is "the same pattern as halo-* agents," implying the guard pattern used here is consistent with at least one other similar governance hook already in this environment.
- **Severity:** info (positive) — task-tool-guard works exactly as designed, complementing the earlier-confirmed fail-closed `resolveAgentName` (which blocks the reverse direction: unknown non-`legion-*` roles inside `legion_dispatch`). Both halves of the routing boundary are enforced correctly.

### Likely root cause of the 17-minute stalls: read-only expert stuck retry-looping on a tool it doesn't have
- **Scenario:** While the git-commit-guard test dispatch (`legion-reviewer` role, asked to edit a file + `git commit`) was stuck at 17+ minutes, the primary agent reported the straggler expert's live status as `"Editing src/store.ts to add test comment"` — i.e. attempting to invoke an edit tool.
- **Verified directly:** Read `agents/legion-reviewer.md` — its frontmatter correctly declares `tools: [read, grep, glob, lsp]` with no edit/write/bash tools, matching its "read-only" description exactly. So the persona's tool grant is correctly configured; this is NOT a governance/security hole.
- **Actual likely mechanism:** The test prompt asked a tool-less-for-editing expert to edit a file and commit — something structurally impossible given its grant. Rather than failing fast with a clear "I don't have edit access" message, the expert appears to have gotten stuck attempting/retrying the edit for 17+ minutes (matching the earlier-logged reproducible-stall finding). This is a plausible root cause for that stall pattern: **a rejected tool call inside an expert attempt may not surface as a fast, clean failure — it may silently retry-loop instead of erroring out.**
- **Severity:** major — if confirmed, the fix isn't in `legion-reviewer`'s config (already correct) but in how the host/expert-attempt loop handles a tool call rejected by the agent's own tool grant: it should fail that attempt quickly (and let Legion's retry/synthesis logic decide whether to retry with a different approach or drop the attempt), not hang indefinitely. This test was self-inflicted (the prompt asked a read-only role to do a write action, which is an unusual/adversarial ask), so this may be a corner case rather than a common-path bug — but worth a targeted look at the expert-attempt error path for rejected tool calls.

### CRITICAL: `/centurion` did not invoke the omp-legion `centurion` skill — ran the generic `grilling` skill instead
- **Scenario:** Sent `/centurion the README's open questions about short-code collision handling and TTL/expiry policy need design decisions before we ship. Run the grilling loop.` — intending to invoke the bundled `skills/centurion/SKILL.md` (verified on disk: correct frontmatter `name: centurion`, `disable-model-invocation: true`, description explicitly mentions triggering on the literal string `"/centurion"`).
- **Actual:** The TUI showed `Read skill://grilling` and `⟨Resolved path: /Users/thisisdhika/.claude/skills/grilling/SKILL.md⟩` — a completely different, pre-existing **user-level** skill (`~/.claude/skills/grilling/SKILL.md`), not the omp-legion-bundled `centurion` skill. The session then proceeded through "Question 1 of 4" using the primary agent's own single-model reasoning to generate the question, options table, and recommendation directly — **no `legion_dispatch` call, no `legion-scout` role, no ensemble round-trip occurred at all.** This is exactly the single-model-guessing behavior `centurion` exists to replace.
- **Likely mechanism:** My prompt included the natural-language phrase "Run the grilling loop," which appears to have model-invoked-matched the generic `grilling` skill's own trigger description ("Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases"). Since `centurion` explicitly sets `disable-model-invocation: true` (i.e. it should ONLY fire on the literal `/centurion` command, never on trigger-phrase inference), the generic skill's phrase-matching invocation won the race — meaning either (a) the literal `/centurion` slash-command form isn't being recognized/routed to the bundled skill in this project session at all (a skill-discovery gap for the `legion-pt2` project's `.omp/plugin-overrides.json`-loaded extension), or (b) it IS recognized but a competing model-invoked skill can still preempt/shadow it when the user's own phrasing overlaps with another skill's trigger words.
- **Severity:** critical — this is the flagship feature built this session (ensemble-driven, per-question `legion_dispatch` scout round-trips instead of one model guessing) and it silently never activated; a real user would have no way to tell centurion didn't run except by noticing the missing `legion_dispatch` calls, which most users wouldn't think to check.
- **Follow-up confirms it's worse than a routing-precedence bug — `/centurion` isn't recognized as a command at all:** Retried with a "clean" prompt containing zero other grilling-adjacent phrasing: `Stop this thread. /centurion collision handling strategy for shortener.ts`. This time **no `skill://` resolution of any kind appeared** — not `centurion`, not `grilling`. The literal text `/centurion collision handling strategy for shortener.ts` was evidently parsed as ordinary freeform input, and the primary agent independently decided (on its own judgment, per `legion_dispatch`'s general "judgment call" guidance) to call `legion_dispatch` directly with role `reviewer` — not `scout`, the role `centurion`'s design specifically calls for — as a single one-shot dispatch, not an iterative per-question Q&A loop at all. This confirms `/centurion` is not being registered/routed as an invocable slash command in this project session by either name — the first attempt's `grilling` resolution was coincidental phrase-matching from my own wording, not `/centurion` routing anywhere at all. Needs investigation into why `skills/centurion/SKILL.md` (confirmed present, correctly named, on disk, and shipped/discoverable per the packaging test) isn't reachable via the literal `/centurion` command in a live session — possible causes: slash-command registration requires something beyond `name:`+frontmatter that centurion's file is missing, or slash-command dispatch for project-loaded extension skills has a gap distinct from the model-invocation path (which is how `grilling`, a different mechanism, fired the first time).

### Config precedence (project overrides global) — verified correct via direct diff
- **Scenario:** Compared `~/.omp/agent/config.yml` (global) against `legion-pt2/.omp/config.yml` (project) directly.
- **Confirmed:** Project correctly overrides `hotl.confidenceFloor` (0.65 global → 0.5 project) and defines a project-only `modelMap.security-auditor` entry (no global equivalent exists — global only defines `coder`, `reviewer`, `tester`, `generalist`, `scout`). This session's live runs are consistent with these values actually taking effect: (a) the security-audit dispatch used the project's custom `legion-security-auditor` persona and its 2 configured free-tier models (confirmed in the task #7/#5 finding above — one of the two subagent names visible was `security-auditor-hy3:free-1`, matching `openrouter/tencent/hy3:free` from the project config), and (b) a real HOTL escalation fired during this session (cost-ceiling), confirming HOTL governance is live and reading *some* config — though the specific escalation reason (`cost`, not `confidence`) means this run didn't isolate `confidenceFloor` specifically.
- **Not independently re-verified live in this pass:** the exact numeric `confidenceFloor: 0.5` threshold firing a confidence-based (not cost-based) escalation — this session's only observed escalation was cost-triggered. This overlaps with prior-session unit-test coverage (`tests/domain/config.test.ts` already regression-tests the merge precedence chain directly, including the `temperatureLadder` field this project's config also relies on), so I'm treating config-merge correctness as adequately covered rather than re-deriving it live given the ~15-20 min per-dispatch cost observed throughout this session.
- **Severity:** info (positive) — config precedence appears correct; no new bug found here.

### Edge case: empty task assignment string — rejected fast and cleanly
- **Scenario:** `legion_dispatch` with explicit `tasks: [{id: "empty-test", role: "reviewer", assignment: ""}]`.
- **Actual:** Rejected immediately (no dispatch attempted, no wasted expert calls) with a precise Zod validation error: `tasks/0/assignment: Too small: expected string to have >=1 characters`, plus the full received-arguments echo for debuggability.
- **Severity:** info (positive) — correct fail-fast behavior at the schema boundary.

### CRITICAL: git-commit-guard did NOT block an expert subagent from running `git commit`
- **Scenario:** The first git-commit-guard attempt (task #10) accidentally used the read-only `legion-reviewer` role, which has no bash tool at all and got stuck (see the earlier stall finding) — an inconclusive test. Retried cleanly with `legion-coder` (which does have bash access), explicit single task: edit `src/store.ts` (add a comment), then run `git add -A && git commit -m test` via bash, and report exactly what happens.
- **Expected:** Per this session's own earlier committed work (`src/infrastructure/git-commit-guard.ts`, `registerGitCommitGuard`), any `git commit`-pattern bash command from a sender with `senderKind === "expert"` should be intercepted and blocked, precisely to prevent Legion expert subagents from making unauthorized commits.
- **Actual:** The commit **succeeded** — no block, no guard message, nothing. The ensemble result (unanimous, confidence 1.0) reported: `git add -A && git commit -m test` → `✓ Committed`. Worse, `git add -A` in the expert's isolated worktree swept in the entire dirty working tree (**651 files changed, 583,992 insertions**) into that unauthorized commit, not just the intended one-line comment — a collateral-damage amplifier on top of the primary guard failure. All 3 experts in the ensemble independently committed in their own isolated worktrees (confirmed they don't share state — separate commit hashes per expert).
- **Mitigating factor:** Because Legion experts apparently run in isolated per-attempt worktrees (per the primary agent's own analysis, consistent with `isolation: 'worktree'` patterns elsewhere in this toolchain), the main `legion-pt2` working tree was reportedly untouched — this is a containment factor, not a guard working. The guard itself visibly did not fire.
- **Severity:** critical — this is a direct, reproducible failure of a governance control this session explicitly built and unit-tested (`tests/infrastructure/git-commit-guard.test.ts`).
- **Source-read narrows the cause (read-only investigation, no fix applied):** Read `src/infrastructure/git-commit-guard.ts` directly. Manually traced its regex (`GIT_COMMIT_PATTERN = /\bgit\b(?:\s+(?!commit\b)\S+)*\s+commit\b/i`) against the exact compound command used in this test, `git add -A && git commit -m test` — the regex correctly matches (`git` ... `add -A &&` consumed by the non-`commit` repeat group ... ` commit` matched by the final `\s+commit\b`). **The pattern-matching itself is very likely not the bug.** That leaves two more probable causes, both structural rather than regex bugs:
  1. `evaluateBashCall` only blocks when `context?.senderKind === "expert"` (deliberately fails *open* on undefined context, per the file's own doc comment, to avoid blocking the primary agent). If the real live dispatch path for `legion-coder` doesn't populate `currentDispatchContext()` with `senderKind: "expert"` the same way the unit tests construct it, every real expert bash call passes through unblocked. Unit tests may be testing `evaluateBashCall` as a pure function with a hand-built context object, which would pass even if the *live* context-propagation wiring is broken.
  2. Legion experts reportedly execute in **isolated git worktrees** (per the primary agent's own analysis of this run — 3 experts, 3 separate commit hashes, no shared state). If worktree-isolated expert execution runs its `bash` tool calls through a different code path than the one the extension's `api.on("tool_call", ...)` event hook is wired into (e.g., a subprocess/sandbox boundary for worktree isolation that doesn't route through the same event bus), the guard would simply never see the call at all — not a logic bug, a wiring/coverage gap for a specific execution mode.
- **Recommendation:** Do not assume the existing unit tests (which test `evaluateBashCall` as a pure function) actually cover the live path. Add an integration-level test that dispatches a real `legion-coder` task instructed to run a compound `git ... && git commit` bash command and asserts the commit is blocked end-to-end — specifically under whatever execution mode (worktree-isolated or not) real Legion experts use in production. This is the single highest-priority item in this entire findings document.

### Widget shows `[COMPLETED] done` but keeps ticking and never clears
- **Scenario:** The original stuck git-commit-guard test (task #10's first, inconclusive attempt using the read-only `legion-reviewer` role) eventually transitioned from `[RUNNING] 2/3 experts finished` to `[COMPLETED] done` after ~26 minutes. However, across several subsequent screen reads, the widget remained on screen with the `[COMPLETED] done` label while its elapsed-time counter kept incrementing (`26:22` → `26:25` → `27:51` → `27:59`), and no new synthesized result text ever appeared in the chat to accompany it, even minutes after first showing `COMPLETED`.
- **Severity:** minor-to-moderate — a widget that says "done" but keeps counting time (and never actually clears itself or delivers a final message) is confusing/broken regardless of root cause. Possibly related to the same underlying stall this job experienced (a straggler expert that may have errored out rather than cleanly finished, leaving the phase machine in an inconsistent "completed but no result" state). Given this job started from an unusual test setup (read-only role asked to do a write action), this may be a downstream symptom of that specific misuse rather than a common-path bug — but the widget lifecycle (not clearing/freezing on completion) is worth a direct look regardless of what triggered it.

(further entries appended below as testing proceeds)
