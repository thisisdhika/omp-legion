# omp-legion Architecture

A file-by-file, call-by-call reference for how Legion actually works. The
[README](../README.md) explains *why* Legion exists; the
[spec](spec/omp-legion-v1.md) records *why each design decision was made*.
This document explains *how the shipped code implements those decisions* —
every claim here is checked against the source at the paths cited, not
aspirational.

For the plain-language usage contract the primary agent reads at runtime, see
[`rules/legion-dispatch.md`](../rules/legion-dispatch.md) — auto-discovered
via the host's extension-package rule scanning
(`discovery/omp-plugins.ts`, verified live this session, see §11) —
alongside the `legion_dispatch` tool description itself in
[`src/presentation/dispatch-tool.ts`](../src/presentation/dispatch-tool.ts).
The rule is intended for the primary agent (awareness of when/how to reach
for the tool); there is no native mechanism to scope a bundled `alwaysApply`
rule to the top-level session only, so it is also visible to any subagent's
own natural rule discovery — harmless in practice since `legion_dispatch`
is never in a dispatched expert's own `tools:` grant, but worth knowing if
this file grows to carry primary-only-relevant detail.

---

## 1. Mental model

One tool, `legion_dispatch`, replaces "do this task yourself" with "run this
task past several independent experts, reconcile their answers into one, and
tell a human if the reconciliation can't be trusted." Everything else in this
document is either:

- **decomposition** — splitting one task into role-tagged sub-tasks,
- **dispatch** — fanning each sub-task out to N expert attempts,
- **synthesis** — merging N expert outputs into one answer per sub-task,
- **governance** — deciding whether that merged answer needs a human to look
  at it before it's treated as final,
- or **plumbing** — the host integration that makes the above possible
  without Legion re-implementing anything Oh-My-Pi already does well.

The call returns a job id immediately. Nothing above blocks the calling
session — including the human-decision step in governance.

## 2. Layering and file map

```
src/
├── presentation/     dispatch-tool.ts     the legion_dispatch ToolDefinition + live widget
│                     dispatch-card.ts     custom TUI render (framedBlock sections)
│                     spinner.ts           spinner frames + elapsed/progress text helpers
├── application/       dispatch-service.ts  the one orchestration flow
├── domain/            dispatch.ts          plan/attempt/agent-resolution types + pure logic
│                      decomposition.ts     LLM decomposition contract + fallback
│                      synthesis.ts         clustering + synthesis contracts
│                      governance.ts        HOTL threshold evaluation
│                      concurrency.ts       Semaphore bounding total in-flight expert attempts
│                      config.ts            LegionConfig schema + merge
│                      constants.ts         every literal, threshold, and prompt-adjacent string
└── infrastructure/    host-dispatcher.ts        runSubprocess + AsyncJobManager adapters
                       host-dispatch-service.ts  wires one DispatchService per session
                       host-config.ts            plugin-settings → LegionConfig
                       agent-loader.ts           bundled + discovered legion-* agents (loadAgentDefinitions)
                       agent-execution-context.ts  globalThis-anchored AsyncLocalStorage tagging each expert's call chain
                       task-tool-guard.ts        blocks native task → legion-* agents
                       irc-tool-guard.ts         blocks legion-* experts from IRC coordination outside their parent route
                       git-commit-guard.ts       blocks legion-* experts from `git commit`
                       branch-merger.ts          winner-only isolation branch merge-back
                       verifier.ts               execution-grounded verifyCommand runner
                       embedding-provider.ts     registry → Mnemopi → Ollama fallback chain
                       llm-aggregator.ts         Aggregator over completeHostLlm
                       llm-decomposer.ts         TaskDecomposer over runSubprocess (a real, read-only, tool-using run)
                       host-llm.ts               shared completeSimple wrapper
                       aggregator-prompts.ts     decomposer/aggregator system+user prompts
                       host-orchestration-repository.ts   durable audit persistence
                       in-memory-orchestration-repository.ts  test/fallback double
                       orchestration-record.ts   clone/type-guard helpers for DispatchRecord

agents/               legion-coder.md, legion-reviewer.md (read-only), legion-tester.md,
                      legion-generalist.md, legion-scout.md (powers /skill:centurion),
                      legion-decomposer.md (internal planning-only — never itself dispatchable,
                      excluded from both legion_dispatch's role resolution and the native task tool)
skills/centurion/SKILL.md  ensemble-driven clarifying-question loop, invoked via /skill:centurion
rules/legion-dispatch.md   primary agent's plain-language legion_dispatch usage contract
rules/legion-search-tool-bm25.md  shared MCP tool-discovery guidance for expert personas
```

**Dependency rule (ADR 0001):** Presentation → Application → Domain ←
Infrastructure. `src/domain/*` imports nothing from `infrastructure/` or any
`@oh-my-pi/*` host package — every type in Domain is plain TypeScript/Zod, and
every Domain function is unit-testable with no host session. Infrastructure
depends *inward* on Domain-owned interfaces (`ExpertExecutor`, `JobScheduler`,
`OrchestrationRepository`, `Aggregator`, `TaskDecomposer`, `EmbeddingProvider`)
— dependency inversion, not duplication.

## 3. End-to-end request lifecycle

Concrete walkthrough of one `legion_dispatch` call with two explicit tasks.

### 3.1 Session start (`src/index.ts`)

On the host's `session_start` event, `legionExtension`:

1. Loads `LegionConfig` (`loadLegionConfig(ctx.cwd)`) and the full agent
   roster (`loadAgentDefinitions(ctx.cwd)`) **in parallel**.
2. Builds one `DispatchService` via `createHostDispatchService(ctx, config,
   agents, api.events)` and stashes it in a closure variable.
3. Registers `registerTaskToolGuard(api)`, `registerIrcToolGuard(api)`,
   `registerGitCommitGuard(api)`, and the tool itself
   (`api.registerTool(createDispatchTool(() => service))`) — these four calls
   happen once, outside `session_start`, since guard registration and tool
   registration don't depend on session state.

`api.events` (the `EventBus`) is only reachable here, at registration time —
`ExtensionContext` (the `ctx` passed to `session_start`) does not expose it.
This is threaded all the way into `runSubprocess` so expert spawns appear in
the host's interactive "Subagents" HUD (see §6.2).

The tool resolver is a closure returning `service`, which starts `undefined`
and is set once config/agents finish loading — a call arriving before that
resolves gets a graceful "not ready" text response, never a crash.

### 3.2 The tool call (`src/presentation/dispatch-tool.ts`)

`legion_dispatch`'s `execute()`:

1. Checks the abort signal — a pre-aborted call returns immediately.
2. Resolves the service; if unset, returns a "not ready" message.
3. Calls `service.dispatch(params, toolCallId)` — **synchronous**, returns a
   `DispatchAccepted` (job id, record id, attempt count/models, per-task
   breakdown) without awaiting any expert.
4. Wraps that into an `AgentToolResult<LegionDispatchDetails>`, calls
   `onUpdate?.(result)` (a live-render hint) and returns it.

**`task` vs `tasks[].assignment` — a live-confirmed asymmetry that needs to
be documented, not assumed obvious.** `dispatch.ts:567`
(`buildDispatchPlan`) sets `assignment: task.assignment` on every attempt;
`host-dispatcher.ts` then sends that value as **both** `ExecutorOptions.task`
and `.assignment`, and `task` is what the host's `session.prompt(task, ...)`
sends as the expert's literal, primary user-turn message. The request-level
`task` field, by contrast, only ever becomes `ExecutorOptions.context` —
documented as background rendered into the *system* prompt, secondary to the
turn itself. For auto-decompose these are the same text, so the asymmetry is
invisible. For an explicit `tasks` call they are not: a caller that puts the
real content (file contents, constraints, what to check) only in the
top-level `task` field and writes a short `assignment` gets exactly what it
wrote — a thin primary prompt, with the real content relegated to secondary
background a model may or may not weight as heavily. Live-confirmed: a
caller did exactly this (pasted a full file into `task`, left `assignment`
as a one-line label), reasoning `task` was the primary content and
`assignment` a display label — backwards. `dispatchTaskSchema.assignment`/
`.description` and `dispatchRequestSchema.task` now carry explicit
`.describe()` text stating the real relationship, the tool's own top-level
description states it under an "IMPORTANT" clause, and `rules/legion-dispatch.md`
repeats it in the always-loaded usage rule.

### 3.3 Immediate planning (`DispatchService.dispatch`, `src/application/dispatch-service.ts`)

```
dispatch(rawRequest, parentToolCallId) {
  request = applyConfigDefaults(dispatchRequestSchema.parse(rawRequest), config)
  preview = buildDispatchPlan(request, defaultModel, isModelAvailable, "preview-<taskId>-<n>", resolveAgent)
  jobId   = scheduler.schedule(LABEL, run, humanReadableJobId(request.task))
  return { jobId, recordId: jobId, attemptCount, attemptModels, taskBreakdown }
}
```

- `applyConfigDefaults` merges the caller's `modelMap`/`defaultEnsembleSize`
  with the session's `LegionConfig`, caller values winning per-role.
- `buildDispatchPlan` (domain/dispatch.ts) is called **twice** — once here as
  a `"preview"` (to compute the immediate response's attempt counts before
  any async work happens), once again inside `#run` with the job's real id
  as the attempt-id prefix. Both calls are pure and deterministic given the
  same request, so the preview's counts are accurate *only when the caller
  supplied explicit `tasks`* — see §3.6 for the auto-decompose case, where
  the preview necessarily sees zero tasks (they don't exist yet).
- `humanReadableJobId("Review and implement the change")` →
  `"LegionReviewAndImplement"` — a PascalCase id built from the first 6
  alphanumeric words of the task text (`domain/dispatch.ts`), replacing the
  host's bare `bg_1`-style counter so a live IRC/HUD transcript is legible.
  Falls back to `"LegionDispatch"` if the task text has no usable words.
- `scheduler.schedule` is `HostJobScheduler.schedule` (infrastructure), which
  calls `AsyncJobManager.instance().register("task", label, run, { id })` —
  the id becomes the job's actual identity in the host's async-job system.

At this point the tool call **returns**. Everything below runs inside the
scheduled background job's own callback.

### 3.4 Background job body (`DispatchService.#run`)

1. `#resolveRequest` — if `request.tasks` is already populated (explicit
   tasks), pass through unchanged. Otherwise call the configured
   `TaskDecomposer.decompose()`; on success, use its tasks; on decomposer
   failure (model unavailable, invalid JSON, etc.), report progress and fall
   back to `fallbackDecomposition(request.task)` — one task, role
   `DEFAULT_DECOMPOSITION_ROLE` (`"generalist"`). The `agent` field on the
   fallback task (`DEFAULT_DECOMPOSITION_AGENT`, also `"generalist"`) is
   never actually trusted — `resolveAgentName` always re-resolves the real
   agent from `role`, so this is only a placeholder value on the type.
2. `#buildPlan(resolvedRequest, context.jobId)` — the *real* plan, attempt ids
   now prefixed with the actual job id (e.g. `LegionReviewAndImplement-t1-0`).
3. `repository.create(...)` persists the initial `"running"` record, then
   `reportProgress("Legion dispatch {jobId} is running.", ...)`.
4. Attempts are grouped by `taskId` (`attemptsByTask` map) and every task's
   group of attempts runs **in parallel with every other task's group**
   (`Promise.all` over `attemptsByTask.entries()`); within one task's group,
   every attempt also runs in parallel (`Promise.all` over `attempts.map`).
5. Per task: run every attempt through `executor.run(execution)` (a
   `HostExpertExecutor`, §4), catching any throw into a synthetic failed
   `ExpertResult` (`failedResult`) rather than losing the attempt — one
   expert crashing must never kill sibling attempts.
6. Synthesize that task's results (`synthesizer.synthesize(...)`, §5), then
   `evaluateGovernance(...)` (§7) against the confidence/disagreement/cost
   of that synthesis.
7. If governance says escalate: fire `notifyEscalation` (best-effort, never
   blocks — `notifyWithoutBlocking`), then **await** `decisionGate` inside
   this same background callback. `edit` triggers a second synthesis call
   with the human's note attached (`humanNote`); `approve`/`reject` do not.
8. `reportProgress` again with the task's synthesis metrics.
9. After every task settles: if any task was rejected by a human, the whole
   job fails (`repository.fail(...)`, throws) — union of results/syntheses/
   governance/resolutions across *all* tasks is still persisted as audit
   data even on this failure path. Otherwise `repository.complete(...)`.
10. Returns `summarizeResults(jobId, outcomes)` — the markdown string the
    calling session ultimately sees as the tool's delivered result.

### 3.5 Delivered outcome text (`summarizeResults`, `dispatch-service.ts`)

```
## Legion Dispatch — {jobId}

**{completed}/{total} expert attempts completed**

---

### {taskId}
**Confidence:** 0.667 · **Disagreement:** 0.333 · **Clustering:** embedding

**Escalated** (confidence) → **approved** by human decision — "looks fine, ship it".

{synthesis.answer}

- ✓ `model/a` (4.2s, 812 tok)
- ✓ `model/b` (3.9s, 790 tok)
- ✗ `model/c` (1.1s, 0 tok) — timeout

---

### {nextTaskId}
...
```

`formatGovernance` is the line that used to be silently computed and never
surfaced — it now always states what triggered escalation and what a human
decided, or that it's still awaiting one.

### 3.6 The auto-decompose gap in the immediate response

Because `dispatch()`'s preview plan is built from the raw, not-yet-decomposed
request, a call that omits `tasks` entirely gets `attemptCount: 0` and an
empty `taskBreakdown` in its *immediate* tool response — the real attempt
count only exists once the background job's decomposer runs. The rendered
card (§6) handles this by falling back to a flat `"tasks: auto-decompose"`
line with no nested attempt/model detail, rather than showing a misleading
zero.

## 4. Dispatch mechanism (`infrastructure/host-dispatcher.ts`)

`HostExpertExecutor.run(execution)` looks up `execution.attempt.agent` in the
pre-loaded agent map (§4.1) and runs it through `runIsolatedSubprocess(...)`
(`@oh-my-pi/pi-coding-agent/task/isolation-runner`) — a thin wrapper the host
itself uses for both `TaskTool` and its eval `agent()` bridge, built around
`runSubprocess(...)`, **the same low-level executor the native `task` tool
calls internally** — never the natural-language `task` tool schema. Calling
the executor directly (rather than through `runSubprocess` bare) is
deliberate (ADR 0002): the `task` tool's own wrapper resolves `modelOverride`
once per agent name from session settings (`task.agentModelOverrides`), a
per-session mapping that cannot vary per call. Legion's actual requirement —
one persona, sampled against several different models within the same
dispatch — needs a per-call `modelOverride`, which `ExecutorOptions` exposes
and the `task` tool's wrapper does not.

Passed straight through to the executor (via `runIsolatedSubprocess`'s
`baseOptions`): `agent`, `task`/`assignment`, `context` (the parent task
text), `description`, `role`, `index`, `id`, `parentToolCallId`,
`detached: true`, `modelOverride`, `parentActiveModelPattern`, `sessionFile`,
`persistArtifacts`, `artifactsDir`, `parentArtifactManager`,
`modelRegistry`, `eventBus`, `signal`.

Because this calls the shared executor directly, Legion's experts are
registered in the host's `AgentRegistry` (IRC roster, Agent Hub visibility)
*for free* — that registration happens unconditionally inside
`runSubprocess` itself, not bolted on by the `task` tool's wrapper.

`HostJobScheduler.schedule` wraps `AsyncJobManager.instance().register("task",
label, run, { id })` — Legion's background job is registered as the same
`"task"` job type the host's own async task runs use, so it shows up
alongside them in whatever job-listing UI the host provides.

### 4.0 Isolation and merge-back (`infrastructure/host-dispatcher.ts`, `infrastructure/branch-merger.ts`)

**The gap this closes:** until this landed, every attempt ran directly
against the real project `cwd` with no isolation — concurrent mutating
attempts (self-consistency samples of `legion-coder`/`legion-tester`, or
concurrent multi-task dispatch) raced on the same real files. See
`docs/plan/algorithm-audit-and-hardening-v2.md` §1.1 for the full finding.

**Mechanism:** `ExpertExecutor.prepareJob()` (called once per dispatch job,
before any attempt runs — see `application/dispatch-service.ts`'s `#run()`)
calls `prepareIsolationContext(cwd)`, resolving the git repo root and
capturing a baseline (`WorktreeBaseline`) every concurrent attempt in this
job diffs against. That opaque context threads through as each
`ExpertExecution.jobContext`. `HostExpertExecutor.run()` then calls
`runIsolatedSubprocess({ baseOptions, context, mergeMode: "branch", agentId: execution.attempt.id, ... })`
per attempt: the host's own PAL backend resolver materializes a
copy-on-write view (APFS/btrfs/zfs/reflink/overlayfs/rcopy, whichever is
available), runs the subagent against that isolated copy, and — on success —
commits its changes onto a not-yet-merged branch (`omp/task/<attemptId>`).
The isolation mount is torn down immediately after (`runIsolatedSubprocess`'s
own `finally`); the branch itself, if any, lives on independently in the
real repo's refs until merged or discarded. The resulting `branchName`/
`baseSha` are carried on `ExpertResult` (domain/dispatch.ts).

**Winner-only merge-back:** synthesis (§5) already computes
`AnswerCluster.representativeAttemptId` — the majority cluster's
representative attempt — but until this phase, nothing consumed it. Now,
once every task's synthesis and governance resolution settle (`#run()`,
after the outcomes `Promise.all`), Legion walks each task's outcome: the
representative attempt's branch (if any) goes into a `mergeWinners(...)`
call; every sibling attempt's branch goes into `discardBranches(...)`. If
the job as a whole was rejected by a human, **nothing is merged at all** —
every branch across every task is discarded instead (`BranchMerger`,
`application/dispatch-service.ts`). `HostBranchMerger`
(`infrastructure/branch-merger.ts`) implements this by calling the host's
own `mergeTaskBranches`/`cleanupTaskBranches`
(`@oh-my-pi/pi-coding-agent/task/worktree`) — the same cherry-pick +
conflict-stop + stash-safe machinery `TaskTool` itself uses, not a
reinvented merge. A merge conflict throws, failing the whole dispatch job
rather than silently landing a partial result.

**Concurrency cap:** since the host's own `task.maxConcurrency` semaphore
lives only inside `TaskTool` (never inside `runSubprocess` itself), Legion
inherited no concurrency cap by calling the executor directly. A small pure
`Semaphore` (`domain/concurrency.ts`) now bounds total concurrent expert
attempts across one dispatch (all tasks combined, not per-task) —
configurable via `maxConcurrentExperts` (default
`DEFAULT_MAX_CONCURRENT_EXPERTS = 4`), wired into `DispatchService`'s
constructor and wrapped around every `executor.run()` call.

**Implementation status:** unit-tested (winner-only merge, full-discard on
rejection, and concurrency-cap enforcement are all directly asserted in
`tests/application/dispatch-service.test.ts`) and **live-verified**: a real
`legion-coder` expert's edit + `git commit` attempt (blocked by §4.4) ran
inside its own per-attempt isolated worktree with concurrent sibling
attempts, and the edit itself was confirmed discarded — the real project
directory's working tree stayed completely untouched.

### 4.1 Agent resolution — one persona, many models (`domain/dispatch.ts`, `infrastructure/agent-loader.ts`)

The gap Legion fills: the host's `modelRoles` and the `task` tool's per-agent
model resolution are both 1:1 (one agent name → one model). Legion needs N:1
— one prompt file, run against several models.

- **`resolveAgentName(role, availableAgentNames)`** (pure, domain layer): for
  role `"coder"`, checks whether `"legion-coder"` is in the resolvable set;
  if so, dispatches use that persona. **Fails closed** on a miss — returns
  `undefined` rather than substituting any fallback agent. `buildDispatchPlan`
  turns an `undefined` resolution into a thrown, actionable error naming the
  exact role and task id (`Legion has no "legion-<role>" persona for role
  "<role>" (task "<id>"); dispatch this task with the native \`task\` tool
  instead.`) — rejecting the whole dispatch rather than silently routing to
  something the caller didn't ask for. There is no non-Legion fallback agent
  of any kind; every resolvable name starts with `legion-`.
- **`loadAgentDefinitions(cwd)`** (`infrastructure/agent-loader.ts`, the only
  loader — there is no separate "full unfiltered" variant) builds the
  resolvable set: Legion's own bundled personas (`agents/*.md`, parsed via
  the host's `parseAgent`), overridden or extended by any `legion-*.md` files
  the host's own `discoverAgents()` finds in the project (`<cwd>/.omp/agents/`)
  or user (`~/.omp/agent/agents/`) directories — project overrides user, both
  override the bundled default of the same name. Non-`legion-*` agents found
  in those same directories (a user's own native OMP agents) are deliberately
  ignored; they stay reachable only via the host's native `task` tool, never
  Legion's dispatch. `LEGION_DECOMPOSER_AGENT_NAME` (`legion-decomposer`) is
  excluded from the resolvable set `host-dispatch-service.ts` builds for
  dispatch, and from the roster surfaced to the decomposer itself — it is a
  planning-only persona, never an ensemble attempt.

**Never trusted:** `dispatchTaskSchema.agent` is optional and read by
nothing — the actual dispatched agent is always `resolveAgent(task.role)`,
never a caller- or LLM-supplied `agent` string. This closed a real bug: the
LLM decomposer used to be asked to invent an `agent` field and would produce
unresolvable names, causing "Cannot cluster expert results without output."
`decomposition.ts`'s LLM contract now excludes `agent` entirely; the
decomposer instead sees the real loaded roster (role + description for every
resolvable persona, `formatAvailableRoles` in `aggregator-prompts.ts`) and is
instructed to pick an exact match or fall back to `"generalist"` — inventing
a role outside that list now rejects the dispatch (via `resolveAgentName`
above) rather than silently substituting something. (That same "Cannot
cluster expert results without output" error string can still occur today if
every expert for a task genuinely crashes — see §4.1a — but it no longer
takes the whole dispatch down when it does.)

### 4.1a Model-selection warnings and the temperature ladder (`domain/dispatch.ts`, Phase 4/6)

Two silent config ambiguities `buildDispatchPlan` used to trust without
comment, now surfaced via `DispatchPlan.warnings` (reported once per job via
`context.reportProgress`, deduplicated per role):

- **Self-consistency with multiple models configured.** `modelsForAttempts`
  has always used `selection.models[0]` as "the strongest" — nothing
  validated that a `modelMap` entry actually lists its models
  strongest-first, or warned that every model after the first is simply
  never sampled under this strategy. `selectionWarning` now flags a role
  with `strategy: "self-consistency"` and more than one configured model.
- **Diverse strategy with `ensembleSize` smaller than the model list.**
  `modelsForAttempts`'s diverse branch cycles `models[index %
  models.length]` — if `ensembleSize < models.length`, the trailing models
  are configured but mathematically unreachable at that ensemble size,
  silently. `selectionWarning` flags this too, naming exactly which
  configured models are unreachable.

**Temperature ladder** (`temperatureForAttempts`): self-consistency sampling
previously had no explicit temperature/seed control anywhere — N identical
-model attempts rode entirely on whatever the provider happened to default
to, undocumented and unverified (a real gap against the Self-MoA thesis,
arXiv 2502.00674, the design already cited). Traced the actual host
mechanism: `ExecutorOptions.settings?: Settings` (a full settings object a
caller may supply per spawn) flows into `createSubagentSettings`'s snapshot,
and `sdk.ts` reads `settings.get("temperature")` straight into the model
completion call. `HostExpertExecutor.run()` now constructs
`Settings.isolated({ temperature: execution.attempt.temperature })` per
attempt — `DEFAULT_TEMPERATURE_LADDER = [0.2, 0.6, 1.0]` (focused → balanced
→ creative), cycled by attempt index, overridable per role via
`RoleModelPolicy.temperatureLadder`. Left at the provider default (`
undefined` → omitted from the constructed settings) for "diverse" strategy
unless a ladder is explicitly configured, since model diversity already
provides decorrelation there. Incidentally fixed a second bug found while
tracing this: `HostExpertExecutor` previously passed no `settings` field at
all, meaning every spawn silently discarded whatever session-level settings
existed (`runSubprocess` falls back to a blank `Settings.isolated()` when
given none) — not just missing temperature control specifically.

### 4.1b Decomposer execution — a real, tool-using run, not a bare completion (`infrastructure/llm-decomposer.ts`)

**The gap this closes:** `HostLlmDecomposer` used to call `completeHostLlm` — a bare one-shot text completion (system prompt + `buildDecomposerPrompt(input)` as the user message, nothing else). `DecompositionInput` carried only `task: string`; the decomposer had no tools and no codebase context beyond the literal task string the primary agent passed to `legion_dispatch`. A short or terse task (`"review this file"`) produced a short, narrow, context-free enhanced assignment no matter how the prompt was worded — the decomposer structurally could not add real facts it was never given, and no amount of prompt tuning could fix that (live-confirmed: user-reported thin assignments were the direct, unavoidable symptom of this gap).

**The fix:** `HostLlmDecomposer` now runs the decomposer as a real subagent via the host's own `runSubprocess` (`@oh-my-pi/pi-coding-agent/task/executor`) — the same primitive `HostExpertExecutor` uses for ensemble attempts (§4.0), just **not** isolated: a read-only agent (`tools: [read, grep, glob]`, `agents/legion-decomposer.md`) has nothing to isolate against, so it runs directly against the real project at `cwd`. This lets it actually open the file(s)/symbol(s) a task names before writing an assignment, instead of enhancing from guesswork. Mechanics:

- `agent: AgentDefinition` (the bundled/overridable `legion-decomposer` persona, or a built-in fallback with the same tool grant when that failed to load) replaces the old plain `systemPrompt: string` option — `runSubprocess` needs the full definition (system prompt *and* tools), not just prompt text.
- The available-roles roster (`formatAvailableRoles`, §4.1) is threaded through `ExecutorOptions.context` — the field the host documents as "rendered into the subagent's system prompt" — rather than spliced into the agent's own `systemPrompt` string by hand.
- The sequential multi-model retry ladder (one selector at a time, `DecomposerPolicy.models`, unchanged from before) now drives `modelOverride` on each `runSubprocess` call instead of the `model` field of a bare completion; a subprocess id is derived per attempt as `${jobId}-decomposer-${index}` (`DecompositionInput.jobId`, threaded from `JobRunContext.jobId` in `dispatch-service.ts`'s `#resolveRequest`).
- `result.output` (the run's final text, same extraction `HostExpertExecutor` already relies on for expert answers) feeds the same `parseDecompositionResponse` JSON-tolerant parser as before — tool calls made along the way don't change the output contract, only what informs it.
- Empty output, a nonzero exit code, or `result.error`/`result.aborted` are treated as a retryable failure (advance to the next selector) the same way a thrown completion error was before.

**Unaffected by this change:** the decomposer's own persona instructions (`agents/legion-decomposer.md` — atomic-by-default bias, the JSON output contract) and `resolveAgentName`'s fail-closed role validation (§4.1) — a role the decomposer picks still has to exactly match the real roster regardless of how it got there.

**Investigation scope — corrected after a second live-confirmed regression.** The first version of this fix pushed the decomposer to investigate *deeply* and transcribe everything it found into a rich, detailed assignment (explicit dimensions to check, a per-finding report structure). That produced a different, sharper failure: every `legion-coder`/`legion-reviewer`/`legion-tester` expert already carries its own `read`/`grep`/`glob`/`lsp` grant and reads the target code independently anyway — a decomposer that pre-analyzes doesn't help the expert, it **correlates every expert's blind spots to the decomposer's single read of the code**, and pre-forms the judgment work an independent ensemble exists specifically to decorrelate. (Research backing this: [Diversity Collapse in LLMs](https://arxiv.org/pdf/2505.18949) — a shared *structural* template alone, independent of content, is sufficient to collapse generative diversity; [Mixture of Complementary Agents](https://arxiv.org/abs/2605.24048) — an ensemble member's value is its complementarity with the others, not its individual thoroughness; [The Homogenization Problem in LLMs](https://arxiv.org/abs/2601.06116) — ensembles don't automatically cancel bias, shared upstream framing can make them amplify it instead.)

The corrected scope: the decomposer's tool use is narrowed to **resolving what the task refers to** — confirming a named file/function/symbol is real and getting its exact path/name right, catching a typo or a nonexistent reference before an ensemble gets dispatched at it — and explicitly forbidden from reading further to analyze behavior, pre-identify issues, or prescribe *how* the expert should analyze (a checklist of dimensions, a report-structure template). `agents/legion-decomposer.md`'s "Ground the reference, don't pre-analyze" section and the equivalent `DECOMPOSER_SYSTEM_PROMPT`/`buildDecomposerPrompt` fallback text both state this explicitly, including the two concrete costs (correlated blind spots; duplicated, non-decorrelated work) rather than just asserting a rule.

### 4.2 Native `task` tool guard (`infrastructure/task-tool-guard.ts`)

`registerTaskToolGuard(api)` listens for the host's `tool_call` event. If the
tool is `"task"` and `targetsLegionAgent(event.input)` is true (the call's
`agent` field, or any `tasks[].agent`, starts with `legion-`), it returns
`{ block: true, reason: "..." }`. Every other native `task` call — the
generic `"task"` agent, `explore`, or any of the user's own agents — passes
through untouched.

**Why:** Legion's HOTL governance, synthesis, and audit trail only apply on
the `legion_dispatch` path. A native `task` call that happened to target
`legion-coder` directly would run that persona with none of that governance
— defeating the entire point of the naming boundary. Unlike the predecessor
project's equivalent guard, there is no config toggle to disable this: there
is no legitimate reason to want a `legion-*` persona reachable ungoverned.

### 4.3 `irc` tool guard (`infrastructure/irc-tool-guard.ts`, `infrastructure/agent-execution-context.ts`)

**Why this exists:** the ensemble design depends on experts staying
independent — each persona is told "you will never see their output... do
not try to guess what another expert might produce" (§10). That's currently
only a prompt instruction. The host force-adds `irc` to every subagent's
tool whitelist unconditionally (`task/executor.ts`: "IRC is always
available... a restricted whitelist must still carry `irc`"), regardless of
what a persona's own `tools:` list says — there is no `AgentDefinition`-level
way to opt out. So nothing currently code-enforces that two sibling experts
in the same self-consistency ensemble can't use `irc` to coordinate
mid-generation, which would correlate their errors and undermine the reason
ensembling can beat a single model at all (§2, arXiv 2606.27288).

**Why it isn't the same pattern as §4.2:** blocking `task` calls that
*target* a `legion-*` agent only needs the call's own input (`event.input`).
Blocking `irc` calls made *by* a running `legion-*` agent needs to know
which agent is currently executing — and neither the host's `tool_call`
event nor the reachable `ExtensionContext`/`AgentToolContext` exposes that
anywhere. There is no host-native field to read.

**Mechanism:** `agent-execution-context.ts` holds a single
`AsyncLocalStorage<DispatchContext>`, anchored on `globalThis` via a
`Symbol.for` key rather than a plain module-scoped `const`. `HostExpertExecutor.run()`
(`host-dispatcher.ts`) wraps its `runSubprocess(...)` call in
`runAsDispatchedAgent(execution.attempt.agent, () => runSubprocess({...}))`.
The stored `DispatchContext` carries the sender kind (`expert` | `parent` |
`host` | `system`), the parent route, and the single destination the sender
may address. `registerIrcToolGuard(api)` calls
`evaluateIrcCall(currentDispatchContext(), event.input)`: an isolated expert
may only address its authenticated parent route (blocks direct
expert-to-expert, spoofed/aliased peer names, and `to: "all"` parallel
messaging); any other sender is the trusted control plane and is allowed.

**Why `globalThis`, not a plain module-scoped variable — a real bug this
fixed:** subagents re-bind their extensions against a new `ExtensionAPI`
inside the same OS process (`task/executor.ts`: "the subagent then re-binds
each extension against its own ExtensionAPI"), which re-imports this
extension's source and can hand it a second, freshly-evaluated module
instance. A plain `const store = new AsyncLocalStorage(...)` at module scope
is then a *different object* on each side: the parent's `store.run()` and the
subagent's own `store.getStore()` never agree, and the subagent's guard
silently sees `undefined` context for a real expert. This was live-confirmed
as a genuine bypass in `git-commit-guard` (§4.4) — a `legion-coder` expert's
`git commit` went straight through with no block — before the fix. Anchoring
the `AsyncLocalStorage` instance on `globalThis` makes every module instance
share the one real store regardless of how many times the module is
re-evaluated in-process, while its per-async-context isolation guarantee
(concurrent attempts never see each other's context) is unaffected.

**Fails closed:** an expert whose context has no authenticated
`allowedDestination`, or that sends to an empty/unknown target, is blocked —
a detection gap must never let an expert coordinate with siblings. A caller
with no authenticated expert context (the control plane: parent, host,
system) is allowed, preserving legitimate expert→parent reporting and
host/system control.

**Implementation status:** implemented and unit-tested (including a
concurrent-attempts test asserting no cross-attempt leakage, and a
module-duplication regression test — `tests/infrastructure/agent-execution-context.test.ts`
— that reproduces the exact re-bound-extension scenario above via a
genuinely separate file copy). **Live-verified**: a live smoke test session
first caught the module-scoped-store bug via `git-commit-guard` (§4.4)
failing to block a real expert's commit; after the `globalThis` fix, the
same live scenario was re-run and the commit was correctly blocked.

### 4.4 `git commit` guard (`infrastructure/git-commit-guard.ts`)

**Why this exists:** motivated by a real incident — a dispatched expert ran
`git commit` mid-ensemble during manual testing and it landed on `main` with
no synthesis, no governance, and no human in the loop. A dispatched expert's
job is to produce one candidate answer for synthesis/HOTL governance to
evaluate, never to land changes on its own; committing is a primary-agent
action, made only when a human has prompted for one.

**Mechanism:** scoped to the `bash` tool's `command` field — the only path a
`legion-*` expert has to run `git commit` (personas that don't grant `bash`,
like `legion-reviewer`, can't reach this at all). `isGitCommitCommand()`
pattern-matches `git commit` (and commit-creating plumbing like
`commit-tree`) as an actual subcommand, tolerating leading flags
(`git -C dir commit`) and command chaining (`&&`, `;`, `|`) — deliberately
loose, not a shell parser, since a false positive on a command that merely
mentions "commit" costs far less than a missed commit escaping ensemble
review. `evaluateBashCall(context, command)` blocks only when
`context?.senderKind === "expert"` (via `currentDispatchContext()`, §4.3);
every other sender — including an *undefined* context — passes through
unblocked, unlike `irc-tool-guard`'s fail-closed posture. This is
deliberate: `bash` is a normal tool the primary agent (which never runs
inside a dispatch wrapper) uses constantly for legitimate commits, so an
undefined context here is the *expected* normal case, not a detection gap to
close defensively.

**Live-verified:** a `legion-coder` expert instructed to edit a file and run
`git add -A && git commit` was blocked with the guard's message across all 3
ensemble attempts; the file edit itself was also cleanly discarded (isolated
per-attempt worktree, §4.0), leaving the real working tree untouched.

## 5. Synthesis — the MoA layer (`domain/synthesis.ts`)

`SynthesisService.synthesize(input)`:

1. `clusterExpertAnswers(experts, embeddingProvider, signal)` — extracts
   non-empty expert outputs as `Answer[]`, tries `embeddingProvider.embed()`.
   If every returned vector is finite and same-dimensioned
   (`validVectors`), clusters by cosine similarity with a union-find
   structure at threshold `DEFAULT_EMBEDDING_THRESHOLD` (0.84), method
   `"embedding"`, quality `"real"`.
2. **Degraded fallback:** if embedding fails or returns invalid vectors,
   clusters instead by **Rouge-L** (`rougeL`, a standard LCS-based F-measure
   over lowercased alphanumeric tokens, capped at `MAX_ROUGE_L_TOKEN_COUNT`
   = 512 tokens) at threshold `DEFAULT_ROUGE_L_THRESHOLD` (0.82), method
   `"rouge-l-fallback"`, quality `"degraded"`. This tier is never used
   silently — `HostEmbeddingProvider` logs a one-time warning
   (`logger.warn(...)`) the first time it has to fall all the way through to
   returning `null`.
3. **Why clustering exists at all:** naive majority voting over raw
   free-text answers is vote-split-prone — two experts can produce the same
   correct answer worded differently and count as a disagreement. Clustering
   groups semantically-equivalent answers before voting.
4. `confidence = majority.size / totalAnswers`, `disagreement = 1 -
   confidence`. Both are the actual governance-facing metrics (§7).
5. **Aggregation is skipped, not faked, when unnecessary:** if there's only
   one non-empty candidate answer and no human edit note,
   `shouldAggregate` is false and the synthesis answer is that one candidate
   verbatim — no LLM call spent reconciling a field of one.
6. Otherwise `aggregator.synthesize(...)` (`HostLlmAggregator`) is called
   with the original task, every expert's full output (including
   role/model/attemptId), and the cluster breakdown as cross-check signal —
   explicitly *not* an instruction to blindly trust the majority
   (`aggregator-prompts.ts`'s `AGGREGATOR_SYSTEM_PROMPT`).

**Aggregator bias caution (documented, not solved):** LLM-as-judge/aggregator
setups carry known self-preference bias. Legion's mitigation is structural —
majority-cluster signal feeds into the aggregator's input rather than the
aggregator picking one expert's answer as "the" answer unchecked — not a
claim that bias is eliminated.

### 5.1 Embedding provider chain (`infrastructure/embedding-provider.ts`)

`HostEmbeddingProvider.embed()` tries, **in order, per call**:

1. `HostModelRegistryEmbeddingAdapter` — resolves the configured
   `embedding.model` selector against the host's `ModelRegistry`, calls its
   OpenAI-compatible `/v1/embeddings` endpoint directly with the registry's
   own auth header resolution.
2. Host **Mnemopi** (`@oh-my-pi/pi-mnemopi`), if `mnemopiAvailable()`.
3. Local **Ollama** (`baseUrl`/`model` from config, default
   `http://127.0.0.1:11434` / `nomic-embed-text`) — tries the newer batch
   `/api/embed` endpoint first, then falls back to the older per-text
   `/api/embeddings` endpoint if the batch call fails.

Every tier validates vectors (`validVectors` — finite numbers, consistent
non-zero dimension, exact count match) before accepting them; a malformed
response from any tier is treated as that tier failing, not as a crash.
Returning `null` from `embed()` is what triggers `synthesis.ts`'s Rouge-L
degraded path.

### 5.2 Execution-grounded consensus (`application/dispatch-service.ts`'s `#verifyResults`, `domain/synthesis.ts`'s `preferVerifiedCluster`, `infrastructure/verifier.ts`)

**Why this exists:** §5's clustering groups experts by *text* similarity —
but code is executable, and two research papers this project cites
(arXiv 2604.15618, 2605.08680) show execution-based consensus beats
output-pattern majority voting by 19-52 percentage points on code
specifically, because free-text descriptions of code rarely match even when
the code itself is functionally identical (or, the reverse: similar-sounding
text can describe subtly different, wrong code).

**Deliberate v1 scope-down from the cited research:** the papers generate
*novel LLM-synthesized test inputs* per candidate. Legion does not — that's
a much larger subsystem (test-case generation, execution-fingerprint
hashing) than this phase's scope. Instead, Legion re-runs the **project's
own existing verify command** (`verifyCommand` config, e.g. `"bun test"`)
against each candidate's isolated branch and uses pass/fail as the signal.
Still execution-grounded, still independent of the attempt's own self-report
— just scoped to "does this patch pass what the project already checks"
rather than "synthesize new tests to discriminate between candidates." Off
by default; nothing changes for a project that never sets `verifyCommand`.

**Flow:** after a task's attempts finish (`DispatchService.#run`, right
before `synthesizer.synthesize`), `#verifyResults` re-verifies every result
that produced a branch (read-only roles like `legion-reviewer` never do, so
they're untouched) — bounded by the same concurrency semaphore as expert
dispatch (§4.0), since a verify run is a comparable-cost operation.
`HostVerifier.verify()` checks the candidate's branch out into a throwaway
git worktree (`utils/git`'s `worktree.add`/`tryRemove` — the same
primitives `task/worktree.ts` uses internally, not reinvented) and runs the
configured command via `Bun.spawn`; exit code `0` → `verified: true`. A
failed checkout or a thrown spawn is treated as `verified: false`, never a
crash — an unverifiable attempt just falls back to the text-clustering
signal for that attempt.

**Synthesis integration:** `preferVerifiedCluster` is a small, additive
post-processing step over the existing text/embedding clusters — it does
not touch the clustering algorithm, confidence, or disagreement math (that
recalibration is explicitly deferred to Phase 3, so this signal can be
calibrated against real data once it exists — see
`docs/plan/algorithm-audit-and-hardening-v2.md`). If any attempt has
`verified === true`, the cluster containing it is promoted to position 0
(the "majority"/answer position) even if a larger unverified cluster
exists, and the verified attempt itself becomes that cluster's
`representativeAttemptId` — which is exactly the field the isolation
merge-back (§4.0) reads to decide whose code lands on the real repo. A task
with no verified attempts (nothing configured, or every candidate failed
verification) behaves exactly as before this phase existed.

**Implementation status:** unit-tested (`preferVerifiedCluster`'s promotion/
no-op cases, an end-to-end `SynthesisService` test proving the real
clustering+verification interaction, and a `DispatchService` test proving
every branched attempt gets independently re-verified before synthesis) but
**not yet live-verified** against a real project's test suite.

## 6. Presentation — the tool and its render (`presentation/`)

### 6.1 Tool definition (`dispatch-tool.ts`)

`ToolDefinition` fields worth noting:

- `label: "Legion"` — not `"Legion Dispatch"`. Since this extension only ever
  ships one tool, the extra word was redundant noise in every render.
- **`renderCall` is a deliberate no-op** (`EMPTY_COMPONENT`, `render: () =>
  []`), not omitted. Without *any* `renderCall`, the host falls back to a
  plain `theme.bold(label)` line above every render (`tool-execution.ts`) —
  a redundant "Legion" heading floating above the card's own header, since
  the card already draws one via `renderStatusLine` (§6.2). Every native
  tool (`task` included) avoids this the same way: define `renderCall` at
  all, even a no-op one, so the fallback never fires. (An earlier version of
  this doc said "no `renderCall`" for a similar-sounding but different
  reason — double-headed stacking from defining *both* hooks — which was
  never actually the mechanism here; this is the corrected story.)
  Everything `renderCall` would have shown (the request args) is available
  inside `renderResult`'s 4th `args` parameter instead, so the whole card
  is still built in one place.
- **Live progress widget** (`monitorWidget`, same file): while the job runs
  in the background, a two-line widget renders above the editor via
  `context.ui.setWidget` — `⠋ Legion (<job-label>) | 0:12` then `[RUNNING]
  2/3 experts finished`. `<job-label>` is the job's own short slug
  (`shortAgentName(accepted.jobId)`, `legion-` prefix stripped) so two or
  more concurrent dispatches (a multi-part request fanning out into several
  `legion_dispatch` calls) render as distinguishable widgets rather than
  identical ones. The bracketed label/detail pair comes from
  `describePhase(job.lastProgressDetails)`, which reads the structured
  `phase` tag every `reportProgress` call attaches (`LegionDispatchPhase`:
  `decomposing | running | retrying | expanding | synthesizing | escalated
  | rejected | completed | failed`, `PHASE_LABELS` uppercases each for
  display) instead of guessing from prose substrings. `phaseDetail()`
  fills in the live specifics per phase — e.g. `running` shows
  `${completed}/${total} experts finished` once both counts are reported
  (aggregated job-wide across every task in a multi-task dispatch, not
  per-task — see §4.0/§3.4's `jobProgress` note), `escalated` names the
  governance reasons that triggered it. Two independent signals can close
  the widget: the spinner tick itself recognizing a terminal
  `PHASE_LABELS` value, or the separate loop polling `job.status` — closing
  on *either* avoids a widget that lingers on `[COMPLETED]` with a still-
  ticking clock if the two signals briefly disagree (live-confirmed
  failure mode before this was added).
- `approval: "exec"` — the call itself goes through the host's normal tool
  approval flow; HOTL governance (§7) is a separate, later gate entirely
  unrelated to this approval.
- **`description` carries the "when," not just the "what."** A tool's
  description is in the model's active tool list on every turn it considers
  what to do — higher salience than static injected guidance competing with
  everything else in a growing context window. Per Anthropic's own tool-use
  guidance ("be prescriptive about when to call it, not just what it does...
  trigger conditions in the description give measurable lift in should-call
  rate"), the description explicitly states when to reach for it (judgment
  calls, security-sensitive changes, subtle correctness bugs, architecture
  decisions — *even when the user's own request never mentions review or this
  tool by name*), when not to (routine low-stakes work — ensembling has real
  latency/token cost), its async/non-blocking behavior, and the no-recursive-
  dispatch constraint. `rules/legion-dispatch.md` (§1) restates the same
  contract for the primary agent as an always-loaded rule — belt and
  suspenders, not the sole channel; the tool description alone already
  carries the load-bearing "when."

### 6.2 The framed card (`dispatch-card.ts`)

`renderDispatchResult(result, options, theme, args)` builds on the same
`framedBlock`/`renderStatusLine` primitives the built-in `task` tool uses —
a bordered, state-colored, titled block with named sections — instead of a
bespoke widget, replacing an earlier `Container`+single-`Text`-node tree
render. Four render paths, chosen by `options.isPartial`/`details.state`:

- **`options.isPartial`** (live progress, mid-turn): a single `framedBlock`
  with a `running`-state `renderStatusLine` header and no sections —
  `buildProgressText()`'s own spinner/ellipsis are stripped since
  `renderStatusLine` draws its own render-time-accurate spinner frame.
- **`details.state === "running"`** (accepted, job dispatched): header +
  an optional `Task` section (the enhanced assignment text, rendered as
  markdown via `markdownSection`) + a `Mixtures` section.
- **Error** (`result.isError` or missing `details`): header (`error` state)
  + `Task` section + an `Error` section showing whatever request info is
  available (`requestNodes(args)`, no per-task breakdown yet) plus the
  error message as the tree's final leaf.
- **Final result**: header (`success` state, "synthesis complete") + `Task`
  + `Mixtures` + a `Result` section (the synthesized answer, markdown).

**The `Mixtures` section** (`MIXTURES_SECTION_LABEL`) is still a genuine
recursive tree (`renderTree(nodes, prefix)` over `TreeNode[]` — `├─`/`└─`
per sibling, `│  `/`   ` continuation prefix for children), built by
`metadataNodes(args, details, theme)`:

```
├─ ref: legion-two-independent-reviews
└─ experts:
   ├─ coder: ~2 models
   └─ reviewer: ~1 model
```

`ref` is the job id, muted-styled, matching what escalation/completion
messages elsewhere in the transcript reference for cross-referencing — kept
as "ref" rather than "job" so it doesn't read as a peer of `Task`. The
`experts:` breakdown groups attempts by dispatched **agent**
(`expertsByAgentNodes`, sourced from `DispatchAccepted.taskBreakdown` —
`TaskAttemptSummary[]`, computed in `dispatch-service.ts`'s
`summarizeAttemptsByTask`), not by internal task id: two tasks that happen
to resolve to the same agent merge into one line with a combined, deduped
model count. `modelCountLabel()` reports **distinct model identifiers**
(`new Set(models).size`), not raw attempt counts — summing attempt counts
instead of deduping previously showed "~6 models" for two tasks sharing the
same 3-model ensemble (live-confirmed bug), overstating the ensemble's
actual model diversity. The `~` prefix is deliberate: adaptive
expansion/fallback can add more attempts (and swap in a different model)
after this snapshot was taken, so the count shown is a floor, not a final
tally. When the caller didn't supply explicit `tasks` (the auto-decompose
gap, §3.6) there's no per-task breakdown yet, so the section falls back to
a single flat `experts: ~N models` line using `details.attemptModels`.
Model names themselves are never listed — which model backs a given attempt
can change out from under this snapshot via the same expansion that grows
the count, so naming them here would read as more settled than it is.

**No title/header line duplicated inside the card body.** `renderStatusLine`
already draws the "Legion" title as part of the frame's own header — a
second title inside a section would duplicate it.

## 7. HOTL governance — async, never blocking (`domain/governance.ts`, `host-dispatch-service.ts`)

`evaluateGovernance({ metrics, thresholds })` is pure: it checks
`confidence < confidenceFloor`, `disagreement > disagreementThreshold`,
`cost > costCeiling`, and `failureRate > failureRateCeiling`, producing a
`GovernanceDecision` with every threshold crossed listed in `reasons` (not
just the first).

### 7.0 Four independent metrics, not two redundant ones (Phase 3 recalibration)

An earlier version of this section (and the code) had `disagreement := 1 -
confidence` — a hard mathematical identity, not a second measurement. At the
original default thresholds (`confidenceFloor: 0.6`, `disagreementThreshold:
0.4`, summing to exactly 1.0) the two checks always co-fired: one weak
signal double-counted as two, not two corroborating ones (see
`docs/plan/algorithm-audit-and-hardening-v2.md` §1.2). Recalibrated:

- **`disagreement`** (`domain/synthesis.ts`'s `fragmentationDisagreement`) is
  now `(clusterCount - 1) / (answerCount - 1)` — how many distinct answers
  emerged, not how dominant the top one is. A lone dissenter at the default
  ensemble size of 3 measures 0.5 (comfortably under the new
  `DEFAULT_DISAGREEMENT_THRESHOLD = 0.75`); a full 3-way split measures 1.0.
  `confidence` still measures the top cluster's dominance — the two are now
  genuinely different lenses (one asks "how strong is the majority," the
  other "how many competing answers exist") rather than restatements of the
  same number.
- **`failureRate`** (`GovernanceThresholds.failureRateCeiling`, default 0.5)
  is the audit's headline fix (§1.3 of the plan doc): `confidence` is
  computed only over experts that produced an answer — failed/aborted
  attempts are filtered out *before* clustering, so a task where 2 of 3
  experts crashed and 1 survived reports **confidence 1.0**, the single
  worst-case outcome for an ensemble reading as maximum confidence.
  `attemptFailureRate` (`application/dispatch-service.ts`) computes this
  directly from the raw attempt results, independent of what synthesis saw,
  so that scenario can no longer hide.
- **`cost`** (`expertCost`) is now the **mean** tokens per attempt, not a
  dispatch-wide sum. A flat sum scaled mechanically with `ensembleSize` — 3
  real coding subagents at ~20-30k tokens each (live-tested this session)
  already sit near the old 100k sum ceiling regardless of whether anything
  was actually wrong, and a larger ensemble would only make that worse. The
  mean is scale-invariant; `DEFAULT_COST_CEILING` was recalibrated from
  `100_000` (a sum-shaped number) to `50_000` (a per-attempt one).
- **Decision-gate timeout**: `decisionGate` used to await indefinitely — no
  auto-resolve, ever. `#resolveEscalation` now *races* the decision against
  `AbortSignal.any([signal, AbortSignal.timeout(decisionTimeoutMs)])`
  (default 30 minutes, `decisionTimeoutMs` config) at its own level, not
  merely passing the combined signal down and trusting the callee to honor
  it — a `decisionGate` that ignores its signal entirely (a bug, or a test
  double) would otherwise hang the job, and every other job queued behind
  the same concurrency slot, forever. A timeout resolves to reject with
  `HOTL_DECISION_TIMEOUT_MESSAGE`, distinct from the existing headless
  `HOTL_NO_DECISION_PROVIDER_MESSAGE` fail-safe.

**Known, accepted limitation — per-task delivery is still all-or-nothing.**
The plan flagged "decouple per-task delivery from `Promise.all` batching" as
a goal; investigating the host's `AsyncJobManager` (`async/job-manager.ts`)
confirmed its delivery model is genuinely one-job-one-final-text
(`onJobComplete(jobId, text)`, delivered exactly once) — `reportProgress` is
a separate, non-final live-update channel, not a per-unit "deliver this
now" mechanism. Decoupling delivery for real would mean registering a
separate async job per task instead of one per dispatch — a materially
different tool contract (multiple job ids returned from one
`legion_dispatch` call, a different rendered card shape) that ADR 0002's
"don't reinvent the host" principle argues against forcing through for one
phase. Instead: the per-task `reportProgress` call now carries the actual
synthesis `answer` text, not just metadata — a human watching progress
already sees a finished, non-escalated task's real answer immediately, even
while a sibling task in the same dispatch is still waiting on a human
decision. The tool's final "job complete" delivery remains all-or-nothing.

**This is Human-**on**-the-Loop, not Human-in-the-Loop, by construction:**
`legion_dispatch` already returned its job id before any governance check
runs (§3.3-3.4) — governance evaluation happens entirely inside the already
-scheduled background job. When `shouldEscalate` is true:

1. `notifyEscalation` fires **without being awaited**
   (`notifyWithoutBlocking` — wrapped in try/catch, failures swallowed) —
   in the host wiring, this calls `ctx.ui.notify(...)` with a `"warning"`
   severity.
2. `decisionGate` **is** awaited, but from *inside* the background job's own
   callback — never on the tool's synchronous return path. In the host
   wiring (`host-dispatch-service.ts`): if `!ctx.hasUI` (headless mode),
   returns a fail-safe `reject` immediately. Otherwise `ctx.ui.select(...)`
   presents `approve` / `reject` / `edit`; choosing `edit` further prompts
   `ctx.ui.input(...)` for a note, and an empty note is treated as a reject
   (`HOTL_EMPTY_EDIT_MESSAGE`).
3. `approve` keeps the existing synthesis untouched. `edit` re-runs
   `synthesizer.synthesize(...)` with `humanNote` attached, producing a new
   `SynthesisResult` that supersedes the first. `reject` fails that task; if
   any task in the whole dispatch was rejected, the entire job fails
   (§3.4 step 9) — but every task's audit data (results, syntheses,
   governance, resolutions) is still persisted, rejected or not.

No `ctx.ui.select()`/`confirm()` call ever sits on the tool's synchronous
return path — an earlier draft of this design proposed exactly that and was
corrected during the grilling session before any code was written (see the
grill log, and ADR 0002's consequences section).

**Live-verified:** a real dispatch tripped a genuine `costCeiling` escalation
mid-run (`[ESCALATED] waiting on a human — cost`), the interactive
approve/reject/edit menu rendered and responded correctly to arrow-key
navigation, selecting `edit` opened the free-text note prompt, and the
submitted note correctly resumed the job to completion with the edit
incorporated into the final synthesis.

## 8. Config surface

Legion resolves configuration through one explicit precedence chain, from
lowest to highest:

1. Built-in defaults from `domain/constants.ts`.
2. Global `~/.omp/agent/config.yml` or `config.yaml`, under `config.legion`.
3. Project `<project>/.omp/config.yml` or `config.yaml`, under `config.legion`.
4. The project's/global plugin override settings delivered by OMP
   (`.omp/plugin-overrides.json` and the host's global plugin settings).
5. Per-request values supplied to `legion_dispatch`.

Each layer is deep-merged by field. A partial `hotl`, `embedding`, `modelMap`,
or `decomposer` object therefore preserves unrelated values from lower layers.
Invalid YAML, JSON, or Legion values produce a diagnostic and fall back safely
without preventing the extension from loading. `loadLegionConfig()` reads the
two normal OMP config locations with Bun's YAML parser, then merges the host
plugin settings through `resolveLegionConfig()`.

The decomposer is intentionally independent from expert role policies:

- `decomposer.models` is an ordered, non-empty selector list.
- `decomposer.temperatureLadder` is optional.
- `strategy` and `ensembleSize` are rejected for the decomposer.
- Exactly one model runs at a time; retryable provider failures advance to the
  next unattempted selector, while validation/task errors stop the sequence.
- When no decomposer policy exists, the active session model remains the
  compatibility fallback.

**Config keys** (see `config.example.json` for a worked example):

| Key | Shape | Meaning |
|---|---|---|
| `modelMap.<role>.models` | `string[]` | Ordered role model candidates. |
| `modelMap.<role>.strategy` | `"self-consistency" \| "diverse"` | Expert selection strategy. |
| `modelMap.<role>.ensembleSize` | `1`–`16` | Attempts for that role. |
| `modelMap.<role>.temperatureLadder` | `number[]` | Optional role sampling ladder. |
| `decomposer.models` | `string[]` | Sequential decomposer candidates. |
| `decomposer.temperatureLadder` | `number[]` | Decomposer sampling ladder. |
| `hotl.confidenceFloor` | `0`–`1` | Confidence escalation threshold. |
| `hotl.disagreementThreshold` | `0`–`1` | Disagreement escalation threshold. |
| `hotl.costCeiling` | tokens | Mean per-attempt cost ceiling. |
| `hotl.failureRateCeiling` | `0`–`1` | Failed-attempt escalation threshold. |
| `defaultEnsembleSize` | `1`–`16` | Default role ensemble size. |
| `embedding.baseUrl`/`model`/`apiKey` | strings | Embedding provider settings. |
| `maxConcurrentExperts` | `≥1` | Total in-flight expert cap. |
| `verifyCommand` | string | Optional branch verification command. |
| `decisionTimeoutMs` | ms | HOTL decision timeout (default 30 min, `DEFAULT_DECISION_TIMEOUT_MS`). |
| `expertTimeoutMs` | ms | Wall-clock cap per expert attempt, forwarded to the host's `ExecutorOptions.maxRuntimeMs` (default 5 min, `DEFAULT_EXPERT_TIMEOUT_MS`). Without this, an expert stuck retrying a tool call outside its grant can hang the whole ensemble indefinitely — no error, no retry, no escalation (live-confirmed failure mode). A capped attempt fails cleanly instead, and synthesis proceeds with whichever experts did respond. |

`mergeLegionConfig()` applies defaults and validates every field. The
`resolveLegionConfig()` helper is pure and is used by tests to prove nested
sibling preservation and source precedence; the host adapter uses the same
function for runtime configuration.


## 9. Persistence (`infrastructure/host-orchestration-repository.ts`)

`HostOrchestrationRepository` stores each `DispatchRecord` as a host session
**custom journal entry** (`journal.appendCustomEntry(LEGION_ORCHESTRATION_ENTRY_TYPE,
snapshot)`) — excluded from model context, restored automatically by the
host's `SessionManager` when the session reopens. On construction, it
replays the journal's existing entries (`isDispatchRecord` type-guards each
one) to rebuild its in-memory record map, so a resumed session sees prior
dispatch history without Legion maintaining a second, separate store.

`InMemoryOrchestrationRepository` is the fallback used when the passed-in
journal doesn't satisfy `HostSessionJournal`'s shape (`isHostSessionJournal`)
— this is also what tests use, since no real host journal exists in a unit
test.

**Deliberately not persisted:** subagent process/session lifecycle (the
host's own persisted-revive already owns "is this subagent alive, can it
resume"), any parallel quota/rate-limit ledger, or per-provider cost-rate
tables. What Legion persists is scoped to genuinely Legion-owned composite
data: the orchestration record, HOTL packets, and confidence/disagreement/
synthesis results — the actual audit trail a human-oversight product needs
to produce, not process-lifecycle bookkeeping the host already solves.

## 10. Agent personas (`agents/*.md`)

Six bundled personas, each a real Oh-My-Pi `AgentDefinition` (frontmatter +
system prompt), loaded via `parseAgent` (§4.1). Five are real ensemble
attempts, dispatchable via `legion_dispatch`; one is planning-only and
excluded from dispatch entirely:

| Persona | Tools | Notes |
|---|---|---|
| `legion-coder` | read, edit, write, grep, glob, lsp, bash | Implementation specialist — makes the change directly, verifies its own work before finishing. Live-confirmed it can and will run `bash` including `git`, gated only by `git-commit-guard` (§4.4), not by its own tool grant. |
| `legion-reviewer` | read, grep, glob, lsp *(no edit/write/bash)* | Read-only by design — a reviewer that can silently edit the thing it's reviewing isn't an independent check. Live-confirmed the tool grant is correctly enforced (a prompt asking it to edit a file structurally cannot succeed). |
| `legion-tester` | read, edit, write, grep, glob, lsp, bash | Writes/runs tests for the assignment. |
| `legion-generalist` | full toolset | Fallback persona for `fallbackDecomposition`'s single-task path and any role with no dedicated persona. |
| `legion-scout` | read, grep, glob, lsp | Investigates a design/plan discussion and proposes the single sharpest next clarifying question, with options and a recommendation. Powers `/skill:centurion` (§12) — never dispatched any other way. |
| `legion-decomposer` | — (no `tools:`; a planning-only prompt, not an ensemble attempt) | **Not dispatchable.** Excluded from `legion_dispatch`'s role resolution (`host-dispatch-service.ts` filters `LEGION_DECOMPOSER_AGENT_NAME` out of the resolvable set) and from the native `task` tool (`task-tool-guard.ts` blocks any `legion-*` name by prefix, this one included). Decides whether/how to split a task and enhances terse assignments into self-contained briefs before Legion dispatches them — it never itself produces an ensemble answer. |

Every dispatchable persona's system prompt includes two sections worth knowing about:

- **"You are one of several independent attempts"** — explicitly tells the
  model it will never see sibling experts' output and they'll never see
  its own; instructs it to give its own honest best answer rather than
  hedge on the assumption "someone else will really decide," since a
  separate synthesis step (§5) reconciles all attempts afterward.
- **Security boundary** — the assignment text is framed as *untrusted input*
  the persona must treat as work to perform, not as instructions that can
  override its own system prompt. This matters because assignment text can
  originate from an LLM decomposer's output or a human-edited note, not
  only from a fully-trusted caller.

Project/user overrides: any `legion-*.md` file in `.omp/agents/` (project)
or `~/.omp/agent/agents/` (user) replaces the bundled persona of the same
name — same discovery mechanism the host uses for every other agent
(§4.1), no Legion-specific override system to maintain.

## 11. Testing strategy

- **Domain** (`tests/domain/*.test.ts`: `concurrency`, `config`,
  `decomposition`, `dispatch`, `governance`): every pure function
  (`buildDispatchPlan`, `resolveAgentName`, `humanReadableJobId`,
  `evaluateGovernance`, config merging including `expertTimeoutMs`/
  `decisionTimeoutMs`, decomposition parsing/fallback, the `Semaphore`
  concurrency primitive) is tested with zero host dependencies — this is the
  whole point of the DDD layering (ADR 0001).
- **Application** (`tests/application/*.test.ts`: `dispatch-service`,
  `synthesis-service`): `DispatchService` exercised against hand-written
  `ExpertExecutor`/`JobScheduler`/`OrchestrationRepository`/
  `SynthesisRunner`/`BranchMerger` doubles — covers the full
  dispatch→decompose→synthesize→govern→persist flow including escalation,
  human decisions, rejection-fails-the-job behavior, the concurrency cap
  actually bounding overlap, winner-only branch merge-back, and
  job-wide progress aggregation across every task in a multi-task dispatch
  (a shared `jobProgress` counter, not a per-task total — see §4.0/§3.4),
  without any real host SDK import.
- **Infrastructure** (`tests/infrastructure/*.test.ts`): `agent-loader`,
  `agent-execution-context` (including a module-duplication regression test
  that reproduces the re-bound-extension scenario behind §4.3's `globalThis`
  fix via a genuinely separate file copy), `aggregator-prompts`,
  `centurion-skill` (a content regression test guarding the
  `/skill:centurion` invocation-syntax fix, §12), `embedding-provider`'s
  fallback ordering, `git-commit-guard`, `host-config`, `host-dispatcher`,
  `host-orchestration-repository`'s journal replay, `irc-tool-guard`,
  `llm-decomposer`, `packaging` (pack-and-extract smoke test proving every
  bundled agent/rule/skill file — including `skills/centurion/`— actually
  ships and is discoverable), `task-tool-guard`.
- **Presentation** (`tests/presentation/*.test.ts`: `dispatch-card`,
  `dispatch-tool`): `dispatch-card.test.ts` renders the card against a real
  built-in theme (`getThemeByName("dark")`) and asserts on the rendered,
  ANSI-stripped text for the auto-decompose, explicit-tasks-with-per-task-
  nesting, distinct-model-dedup, and error cases. `dispatch-tool.test.ts`
  checks the tool wires the service resolver correctly, `describePhase()`'s
  phase→label/detail mapping, the tool description's documented role-string
  convention, the live widget's per-job label, and that the widget clears
  as soon as either the spinner tick or the status-poll loop observes a
  terminal phase (not only when both agree).
- **`tests/smoke.test.ts`** — confirms the Bun test runner itself is wired
  (intentionally trivial; a canary, not a feature test).
- **`scripts/benchmark.ts`** — a live, real-model comparison harness (not
  part of `bun test`, requires an actual `omp` binary and configured
  models). Runs a small fixed task set through Legion vs. a single model
  and reports the diff; benchmark results are a manual validation step, not
  a CI-enforced claim.
- **Live smoke testing** — beyond `bun test`, this project has been driven
  end-to-end through a real interactive `omp` session (every dispatch
  scenario, both guards, `/skill:centurion`, config precedence, HOTL
  escalation, and a real `SIGINT` mid-dispatch), not just unit-tested in
  isolation. See `docs/smoke-test-findings-legion-pt2.md` for the findings
  log this surfaced, and this document's guard/widget sections above for
  which claims are now live-verified versus unit-tested-only.

## 12. `/skill:centurion` — ensemble-driven clarifying questions (`skills/centurion/SKILL.md`, `agents/legion-scout.md`)

A grilling-style session — one question at a time, decisions are the
human's, never proceed until confirmed — except the question itself is
produced by a real `legion_dispatch` round to the `scout` role every time,
instead of one model guessing alone. Reserved for design decisions where a
wrong early call is expensive, not routine clarification: each question is
a full ensemble round-trip (multiple independent experts + synthesis,
occasionally a HOTL escalation), so a session can take minutes per question,
capped at 8 questions with an explicit human check-in if the cap is
reached before the discussion settles.

**Invocation — a real fixed bug, not a design note:** the skill sets
`disable-model-invocation: true` (deliberately — a slow/costly skill like
this should never fire on loose trigger-phrase matching the way the
platform's generic `grilling` skill does) and must be invoked explicitly via
the literal `/skill:centurion <topic>` slash command
(`@oh-my-pi/pi-coding-agent`'s `parseSkillInvocation` only recognizes the
`/skill:<name>` form — a bare `/centurion` is never parsed as a command at
all and silently falls through as ordinary chat text). The skill's own
`SKILL.md` previously advertised triggering on the literal string
`"/centurion"` in its description, which this host has never recognized;
combined with `disable-model-invocation` hiding the skill from the system
prompt (so the model couldn't fall back to noticing the phrase on its own),
the skill was live-confirmed completely unreachable before this was fixed —
two separate live attempts (one that accidentally phrase-matched a
different, generic skill instead, one that matched nothing at all and had
the primary agent freelance a one-shot `legion_dispatch` call on its own
judgment) both failed to invoke `centurion` at all. `tests/infrastructure/centurion-skill.test.ts`
guards the corrected invocation text against regressing.

Each round: compose a self-contained scout assignment (the destination,
the decision log so far, relevant codebase facts already found — a scout
has zero access to the surrounding conversation), dispatch it via
`legion_dispatch` with an explicit `tasks: [{ role: "scout", ... }]`
(skipping auto-decomposition since the role is already known), **await**
the result (the one legitimate case where blocking on `legion_dispatch` is
correct, per the skill's own instructions), present the synthesized
question/options/recommendation to the human clearly attributed as the
ensemble's output, and append to the running decision log before continuing.

Full gate before any change lands: `bun run typecheck && bun run lint &&
bun test`.

## 13. What Legion deliberately does not build

See ADR 0002 and spec §3/§10 for the full reasoning; in one line each: no
parallel subagent lifecycle or resume system (the host's persisted-revive
already solves it), no bespoke retry/auth-classification (the host's
`completeSimple`/`retry.ts` already handles it correctly), no per-provider
cost-rate tables (the host's usage tracking owns this), no hand-rolled config
parser, no reinvented per-expert progress UI (the host's task-block rendering
already covers it), and no config toggle for the task-tool guard (§4.2) —
there's no legitimate reason to want it off.
