# omp-legion Architecture

A file-by-file, call-by-call reference for how Legion actually works. The
[README](../README.md) explains *why* Legion exists; the
[spec](spec/omp-legion-v1.md) records *why each design decision was made*.
This document explains *how the shipped code implements those decisions* —
every claim here is checked against the source at the paths cited, not
aspirational.

For the plain-language usage contract the primary agent reads at runtime, see
[`rules/legion-dispatch.md`](../rules/legion-dispatch.md).

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
├── presentation/     dispatch-tool.ts     the legion_dispatch ToolDefinition
│                     dispatch-card.ts     custom TUI render (tree)
├── application/       dispatch-service.ts  the one orchestration flow
├── domain/            dispatch.ts          plan/attempt/agent-resolution types + pure logic
│                      decomposition.ts     LLM decomposition contract + fallback
│                      synthesis.ts         clustering + synthesis contracts
│                      governance.ts        HOTL threshold evaluation
│                      config.ts            LegionConfig schema + merge
│                      constants.ts         every literal, threshold, and prompt-adjacent string
└── infrastructure/    host-dispatcher.ts        runSubprocess + AsyncJobManager adapters
                       host-dispatch-service.ts  wires one DispatchService per session
                       host-config.ts            plugin-settings → LegionConfig
                       agent-loader.ts           bundled + discovered legion-* agents
                       task-tool-guard.ts        blocks native task → legion-* agents
                       embedding-provider.ts     registry → Mnemopi → Ollama fallback chain
                       llm-aggregator.ts         Aggregator over completeHostLlm
                       llm-decomposer.ts         TaskDecomposer over completeHostLlm
                       host-llm.ts               shared completeSimple wrapper
                       aggregator-prompts.ts     decomposer/aggregator system+user prompts
                       host-orchestration-repository.ts   durable audit persistence
                       in-memory-orchestration-repository.ts  test/fallback double
                       orchestration-record.ts   clone/type-guard helpers for DispatchRecord

src/agents/            legion-coder.md, legion-reviewer.md, legion-tester.md, legion-generalist.md
rules/legion-dispatch.md   auto-discovered usage rule for the primary agent
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
   roster (`loadDispatchAgents(ctx.cwd)`) **in parallel**.
2. Builds one `DispatchService` via `createHostDispatchService(ctx, config,
   agents, api.events)` and stashes it in a closure variable.
3. Registers `registerTaskToolGuard(api)` and the tool itself
   (`api.registerTool(createDispatchTool(() => service))`) — these two calls
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
   `"generalist"`, agent forced to `DEFAULT_DECOMPOSITION_AGENT` (`"task"`).
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
`tests/application/dispatch-service.test.ts`), but **not yet live-verified**
against a real host session with actual concurrent mutating attempts.

### 4.1 Agent resolution — one persona, many models (`domain/dispatch.ts`, `infrastructure/agent-loader.ts`)

The gap Legion fills: the host's `modelRoles` and the `task` tool's per-agent
model resolution are both 1:1 (one agent name → one model). Legion needs N:1
— one prompt file, run against several models.

- **`resolveAgentName(role, availableAgentNames)`** (pure, domain layer): for
  role `"coder"`, checks whether `"legion-coder"` is in the resolvable set;
  if so, dispatches use that persona; if not, falls back to
  `DEFAULT_DECOMPOSITION_AGENT` (`"task"`, the host's own generic agent) —
  never an unresolvable, made-up name.
- **`loadDispatchAgents(cwd, home)`** (infrastructure): builds the resolvable
  set the executor needs. It merges, in this order: (1) every agent the
  host's own `discoverAgents(cwd, home)` finds (project `.omp/agents` > user
  `~/.omp/agent/agents` > plugin dirs > host-bundled) — this is what makes
  the `"task"` fallback resolvable — then (2) Legion's own bundled personas
  (`src/agents/*.md`, parsed via the host's `parseAgent`) layered on top,
  and any `legion-*` project/user override files discovered by the same
  `discoverAgents` call replacing the bundled default of the same name.
- **`isLegionAgentName(name)`** — any agent name starting with `legion-`.
  Non-`legion-*` agents discovered in the same directories (a user's own
  native OMP agents) are ignored by `loadAgentDefinitions` (the
  Legion-scoped-only variant) but *are* included by `loadDispatchAgents`
  (the full unfiltered variant actually used for dispatch), specifically so
  the `"task"` fallback and any user-authored role name still resolve.

**Never trusted:** `dispatchTaskSchema.agent` is optional and read by
nothing — the actual dispatched agent is always `resolveAgent(task.role)`,
never a caller- or LLM-supplied `agent` string. This closed a real bug: the
LLM decomposer used to be asked to invent an `agent` field and would produce
unresolvable names, causing "Cannot cluster expert results without output."
`decomposition.ts`'s LLM contract now excludes `agent` entirely and
force-normalizes every parsed task's `agent` to `DEFAULT_DECOMPOSITION_AGENT`
regardless of what the LLM output.

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

**Mechanism:** `agent-execution-context.ts` holds a module-scoped
`AsyncLocalStorage<string>`. `HostExpertExecutor.run()` (`host-dispatcher.ts`)
wraps its `runSubprocess(...)` call in `runAsDispatchedAgent(execution.attempt.agent,
() => runSubprocess({...}))`. This works because subagents re-bind their
extensions against a new `ExtensionAPI` **within the same process** rather
than a separate one (`task/executor.ts`: "the subagent then re-binds each
extension against its own ExtensionAPI") — so the store set around one
attempt's `runSubprocess` call stays correctly scoped to that attempt's own
later `tool_call` events, without leaking into concurrent sibling attempts
(`AsyncLocalStorage` isolates each call's context even when several attempts
run concurrently via `Promise.all`). `registerIrcToolGuard(api)` then checks
`shouldBlockIrc(currentDispatchAgentName())` — `isLegionAgentName` on
whatever the store currently holds — and blocks only when true.

**Fails open, deliberately:** if the store is ever unset (a non-Legion
subagent, or any code path outside a Legion dispatch), the call is never
blocked. A detection gap here must not silently break IRC for unrelated
subagents.

**Implementation status:** implemented and unit-tested (including a
concurrent-attempts test asserting no cross-attempt leakage), but **not yet
live-verified** against a real host session — the mechanism relies on the
host's internal turn loop staying within one continuous async chain from
the `runSubprocess` call, which unit tests with hand-written async
gaps can approximate but not prove against the actual host runtime.

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
- **No `renderCall`.** `renderCall` + `renderResult` on the same tool render
  as two separately-headed blocks stacked on top of each other, not one
  merged card — a platform quirk. Everything renderCall would have shown
  (the request args) is available inside `renderResult`'s optional 4th
  `args` parameter instead, so the whole card is built in one place.
- `approval: "exec"` — the call itself goes through the host's normal tool
  approval flow; HOTL governance (§7) is a separate, later gate entirely
  unrelated to this approval.
- **`description` carries the "when," not just the "what."** A tool's
  description is in the model's active tool list on every turn it considers
  what to do — far higher salience than `rules/legion-dispatch.md`, which is
  a static block injected once at session start and competes with everything
  else in a growing context window. Per Anthropic's own tool-use guidance
  ("be prescriptive about when to call it, not just what it does... trigger
  conditions in the description give measurable lift in should-call rate"),
  the description explicitly states when to reach for it (judgment calls,
  security-sensitive changes, subtle correctness bugs, architecture
  decisions — *even when the user's own request never mentions review or
  this tool by name*), when not to (routine low-stakes work — ensembling has
  real latency/token cost), its async/non-blocking behavior, and the
  no-recursive-dispatch constraint. The rule file remains the deeper
  explanation for when the model does look at it; the description is what
  makes it look in the first place.

### 6.2 The tree card (`dispatch-card.ts`)

`renderDispatchResult(result, theme, args)` builds one `Container` with a
single `Text` node — a genuine recursive tree, not a flat indented list:

```
├─ task: "Execute two tasks: t1 (reviewer) reviews sample-bug.js for b…"
├─ tasks: 2 explicit
│  ├─ t1 (reviewer)
│  │  ├─ attempts: 3
│  │  └─ models: zai/glm-4.5-flash, google-antigravity/gemini-2.5-flash, ...
│  └─ t2 (coder)
│     ├─ attempts: 3
│     └─ models: commandcode/xiaomi/mimo-v2.5-pro
├─ job: LegionExecuteTwoTasksT1ReviewerReviews
└─ results deliver asynchronously
```

`renderTree(nodes, prefix)` recurses over a `TreeNode[]` (`{ label,
children? }`), computing `├─`/`└─` per sibling and a `│  `/`   ` continuation
prefix for each node's children — real parent-child connector continuation,
not extra leading spaces on an otherwise-flat line (the first attempt at
this card got that wrong and was corrected after live feedback).

**Per-task nesting, not flat aggregate lines:** `attempts`/`models` are
per-task quantities — for an explicit-tasks call, each task's own node gets
its own `attempts`/`models` children, sourced from
`DispatchAccepted.taskBreakdown` (`TaskAttemptSummary[]`, computed in
`dispatch-service.ts`'s `summarizeAttemptsByTask` by grouping the preview
plan's attempts by `taskId`). `job` stays a top-level sibling — it identifies
the *whole* async dispatch, not any single task, so it doesn't belong nested
under one. When `taskBreakdown` is empty (the auto-decompose gap, §3.6), the
card falls back to the old flat aggregate `attempts`/`models` lines at the
top level, since there's no per-task detail to nest yet.

**No title/header line inside the card.** The host already renders one
generic header above every tool block from the tool's own `label`
("Legion") — a second title inside the card duplicated it. This card is
body-only, matching the same pattern used for the host's own built-in tool
result cards.

**Error path:** if `result.isError` or `details` is missing, the card shows
whatever request info is available (`requestNodes(args)`, no breakdown) plus
the error message as the tree's final leaf, styled via `theme.fg?.("error",
...)`.

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

## 8. Config surface

Full resolution chain, in order, for one session:

1. **Bundled defaults** (`domain/constants.ts`): `DEFAULT_MODEL_MAP = {}`
   (no role has a model until configured), `DEFAULT_HOTL_THRESHOLDS`
   (`confidenceFloor: 0.6`, `disagreementThreshold: 0.4`, `costCeiling:
   100_000`), `DEFAULT_ENSEMBLE_SIZE: 3`, `DEFAULT_EMBEDDING_SETTINGS`
   (`baseUrl: http://127.0.0.1:11434`, `model: nomic-embed-text`),
   `DEFAULT_MAX_CONCURRENT_EXPERTS: 4` (§4.0).
2. **Project/user settings** (`infrastructure/host-config.ts`):
   `loadLegionConfig(cwd)` calls the host's `getPluginSettings("omp-legion",
   cwd)` — reads `.omp/plugin-overrides.json`'s `settings["omp-legion"]`
   object (this is JSON, not YAML — `config.yml` is the host's own fixed,
   non-extensible settings schema and cannot carry third-party plugin
   config). Each setting may arrive as a real object or a JSON-encoded
   string (host settings UIs sometimes only support flat string fields) —
   `parseJsonSetting` handles both.
3. **Per-request overrides** (`dispatch-service.ts`'s `applyConfigDefaults`):
   the caller's `modelMap`/`defaultEnsembleSize` in the actual
   `legion_dispatch` call merge on top of session config, per-role.

**Config keys** (see `config.example.json` for a full worked example):

| Key | Shape | Meaning |
|---|---|---|
| `modelMap.<role>.models` | `string[]` | Models available to that role, e.g. `["anthropic/claude-fable-5"]`. |
| `modelMap.<role>.strategy` | `"self-consistency" \| "diverse"` | `self-consistency` (default): every attempt samples the *first* listed model N times. `diverse`: attempts cycle round-robin through the full model list. |
| `modelMap.<role>.ensembleSize` | `1`–`16` | Attempts for that role; falls back to `defaultEnsembleSize`. |
| `hotl.confidenceFloor` | `0`–`1` | Escalate if synthesis confidence (top cluster's dominance) falls below this. |
| `hotl.disagreementThreshold` | `0`–`1` | Escalate if fragmentation (§7.0 — distinct-answer count, not `1 - confidence`) exceeds this. |
| `hotl.costCeiling` | tokens | Escalate if a task's **mean** tokens per attempt exceeds this (§7.0 — not a sum). |
| `hotl.failureRateCeiling` | `0`–`1` | Escalate if the fraction of attempts that failed/aborted outright exceeds this, independent of confidence (§7.0). |
| `defaultEnsembleSize` | `1`–`16` | Ensemble size for any role without its own `ensembleSize`. |
| `embedding.baseUrl`/`model`/`apiKey` | strings | Ollama fallback tier settings (registry/Mnemopi tiers use the host's own model resolution instead). |
| `maxConcurrentExperts` | `≥1` | Caps total concurrent expert attempts per dispatch, all tasks combined (§4.0) — the host's own concurrency cap doesn't cover Legion's direct-executor calls. |
| `verifyCommand` | string | Shell command re-run against each code-mutating attempt's isolated branch for execution-grounded consensus (§5.2), e.g. `"bun test"`. Off by default. |
| `decisionTimeoutMs` | ms | How long a HOTL escalation waits for a human before auto-resolving to reject (§7.0). Default 30 minutes. |

`mergeLegionConfig` (`domain/config.ts`) is where every default actually
applies. One real bug lived here: Zod's `.default()` only fires when a key
is **absent**, not when it's present holding `undefined` — an object spread
of a partial input (`{ ...raw.hotl, confidenceFloor: settings[...] ??
raw.hotl.confidenceFloor }`) can produce exactly that. `withoutUndefined()`
strips such keys before the final `legionConfigSchema.parse(...)` merge so a
present-but-`undefined` field genuinely falls back to the default instead of
silently overriding it with `undefined`.

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

## 10. Agent personas (`src/agents/*.md`)

Four bundled personas, each a real Oh-My-Pi `AgentDefinition` (frontmatter +
system prompt), loaded via `parseAgent` (§4.1):

| Persona | Tools | Notes |
|---|---|---|
| `legion-coder` | read, edit, write, grep, glob, lsp, bash | Implementation specialist — makes the change directly, verifies its own work before finishing. |
| `legion-reviewer` | read, grep, glob, lsp *(no edit/write/bash)* | Read-only by design — a reviewer that can silently edit the thing it's reviewing isn't an independent check. |
| `legion-tester` | read, edit, write, grep, glob, lsp, bash | Writes/runs tests for the assignment. |
| `legion-generalist` | full toolset | Fallback persona for `fallbackDecomposition`'s single-task path and any role with no dedicated persona. |

Every persona's system prompt includes two sections worth knowing about:

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

- **Domain** (`tests/domain/*.test.ts`): every pure function
  (`buildDispatchPlan`, `resolveAgentName`, `humanReadableJobId`,
  `evaluateGovernance`, `clusterExpertAnswers`, config merging,
  decomposition parsing/fallback, the `Semaphore` concurrency primitive) is
  tested with zero host dependencies — this is the whole point of the DDD
  layering (ADR 0001).
- **Application** (`tests/application/*.test.ts`): `DispatchService`
  exercised against hand-written `ExpertExecutor`/`JobScheduler`/
  `OrchestrationRepository`/`SynthesisRunner`/`BranchMerger` doubles — covers
  the full dispatch→decompose→synthesize→govern→persist flow including
  escalation, human decisions, rejection-fails-the-job behavior, the
  concurrency cap actually bounding overlap, and winner-only branch
  merge-back (only the synthesis-selected attempt's branch merges; every
  sibling is discarded; a rejected job discards everything), without any
  real host SDK import.
- **Infrastructure** (`tests/infrastructure/*.test.ts`): adapters tested
  against minimal fakes of the host surfaces they wrap (`agent-loader`,
  `task-tool-guard`, `embedding-provider`'s fallback ordering,
  `host-dispatcher`, `host-config`, `host-orchestration-repository`'s
  journal replay).
- **Presentation** (`tests/presentation/*.test.ts`): `dispatch-tool.test.ts`
  checks the tool wires the service resolver correctly; `dispatch-card.test.ts`
  inspects the rendered `Container`/`Text` tree directly (`Container.children`,
  `Text.getText()`) for both the auto-decompose and explicit-tasks-with-
  per-task-nesting cases, plus the error path.
- **`tests/smoke.test.ts`** — confirms the Bun test runner itself is wired
  (intentionally trivial; a canary, not a feature test).
- **`scripts/benchmark.ts`** — a live, real-model comparison harness (not
  part of `bun test`, requires an actual `omp` binary and configured
  models). Runs a small fixed task set through Legion vs. a single model
  and reports the diff; benchmark results are a manual validation step, not
  a CI-enforced claim.

Full gate before any change lands: `bun run typecheck && bun run lint &&
bun test`.

## 12. What Legion deliberately does not build

See ADR 0002 and spec §3/§10 for the full reasoning; in one line each: no
parallel subagent lifecycle or resume system (the host's persisted-revive
already solves it), no bespoke retry/auth-classification (the host's
`completeSimple`/`retry.ts` already handles it correctly), no per-provider
cost-rate tables (the host's usage tracking owns this), no hand-rolled config
parser, no reinvented per-expert progress UI (the host's task-block rendering
already covers it), and no config toggle for the task-tool guard (§4.2) —
there's no legitimate reason to want it off.
