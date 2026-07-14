---
name: legion-dispatch
description: When and how to use legion_dispatch — the MoA-over-MoE ensemble tool
alwaysApply: true
---

# legion_dispatch

You have access to `legion_dispatch`, a tool that runs a task through multiple independent experts in parallel and returns one synthesized answer — not a subagent spawner, an ensemble.

## When to use it

Reach for `legion_dispatch` instead of doing a costly or risky task solo:
- A decision or judgment call where being wrong is costly and a second opinion would help.
- A subtle correctness, security, or architecture question.
- Work that genuinely benefits from independent attempts.
- When the task naturally decomposes into a few independent pieces.

Prefer delegation when another agent can do a useful independent slice; do not
spend a turn doing work an available task or Legion expert can do better.

Do not use it for:
- Simple, low-stakes tasks where the standard tools are enough.
- Work that needs the native `task` tool's live collaboration features.
- A task that is itself part of an active legion_dispatch job.

## Dispatch concurrency and dependencies

- A dispatched task or `legion_dispatch` result is a real dependency when the
  next line of work relies on it. Wait for that specific result, poll a
  background job when necessary, and incorporate it before continuing that
  dependent line. Do not spawn a planner and then ignore its plan.
- Unrelated inspection or implementation work may continue in parallel.
- Native `task` calls may run concurrently with each other.
- Native `task` and `legion_dispatch` are mutually exclusive while their tool
  calls are pending; a pending call blocks the other dispatch mechanism.
- Up to two `legion_dispatch` calls may run concurrently. Each can already fan
  out to four expert worktrees, so two is the conservative eight-worktree cap.
- The runtime guard enforces admission and emits a dependency reminder for
  detached task results. It does not blanket-block unrelated tools.

## How it works

1. Call `legion_dispatch` with `task` (the full task description). You can omit
   `tasks` for automatic decomposition, or supply explicit tasks when the split
   is known. For explicit tasks, each task's `assignment` is the instruction
   the expert acts on; `task` is shared background. Do not leave the real work
   only in a thin assignment label.
2. The call blocks until decomposition, expert execution, synthesis, and any
   human governance resolve, then returns the synthesized result. Use that
   result on any dependent work before proceeding.
3. Multiple experts work in parallel and a synthesis stage reconciles them.
4. If disagreement, confidence, or cost triggers escalation, the current turn
   remains blocked until the human decision resolves.

## The one thing that matters most

**Never call `legion_dispatch` from inside a task that was itself dispatched by
Legion.** Experts are independent; recursive dispatch can deadlock the queue.


## Meta-risk override: always dispatch for Legion-internal edits

Regardless of diff size or apparent triviality, **always call `legion_dispatch` for a second opinion before finalizing any change to the following paths**. These files govern Legion's own invocation surface, schema contract, and expert-delivery behavior; a small edit can silently shift should-call decisions or introduce contradictory guidance.

- `src/presentation/dispatch-tool.ts` (the `legion_dispatch` tool description)
- `src/domain/dispatch.ts` (the request/task schemas and their `.describe()` strings)
- `rules/legion-*.md` (always-applied and rulebook rules bundled with Legion)
- `agents/legion-*.md` (persona files for Legion expert roles)
- Dispatch and rule-delivery infrastructure: `src/infrastructure/rule-loader.ts`, `src/infrastructure/host-dispatch-service.ts`, `src/application/dispatch-service.ts`, `src/domain/decomposition.ts`, `src/domain/synthesis.ts`

If you are unsure whether a change falls in this category, dispatch anyway — the cost of an unnecessary review is far lower than the cost of a silent contract regression.

