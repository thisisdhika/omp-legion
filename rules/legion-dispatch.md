---
name: legion-dispatch
description: When and how to use legion_dispatch — the MoA-over-MoE ensemble tool
alwaysApply: true
---

# legion_dispatch

You have access to `legion_dispatch`, a tool that runs a task through multiple independent experts in parallel and returns one synthesized answer — not a subagent spawner, an ensemble.

## When to use it

Reach for `legion_dispatch` instead of solving directly (or instead of the native `task` tool) when a task genuinely benefits from more than one independent attempt:
- A decision or judgment call where being wrong is costly and a second opinion would catch it (security review, a subtle correctness bug, an architecture choice).
- A task where you'd naturally want to sanity-check your own answer against another take before committing to it.
- Work you can decompose into a few independent pieces that don't need to share live context while running.

Do not use it for:
- Simple, low-stakes tasks you can just do yourself — ensembling has real latency and token cost; only pay for it when the extra confidence is worth it.
- Anything that needs the native `task` tool's live collaboration features (the calling session directing multiple subagents interactively) — legion_dispatch is fire-and-forget, not interactive.
- A task that is itself part of an active legion_dispatch job — experts dispatched by Legion must not call legion_dispatch themselves.

## How it works

1. Call `legion_dispatch` with `task` (the full task description). You can omit `tasks` and let Legion decompose it automatically, or supply an explicit `tasks` array yourself when you already know the natural split. When supplying explicit `tasks`, each task's own `assignment` is what the expert actually receives and acts on — `task` becomes secondary background, not any one expert's instruction. Don't front-load the real content (file contents, constraints, what to check) into `task` while leaving `assignment` a short label; put it in `assignment` directly.
2. The call returns **immediately** with a job id — it does not block your turn. Expert results are delivered asynchronously when the job completes; do not poll in a tight loop, just continue with other work or wait for the completion notification.
3. Internally, multiple experts (by default, several independent samples of your strongest configured model — not a blind spread across every model available) work the task in parallel, and a synthesis step reconciles their answers into one result.
4. If the experts disagree too much, confidence is too low, or cost crosses a configured threshold, Legion escalates to a human decision (approve/reject/edit) **before** the job's answer is treated as final. This does not block your turn either — only the background job waits on it.

## The one thing that matters most

**Never call `legion_dispatch` from inside a task that was itself dispatched by `legion_dispatch`.** Experts are meant to give one independent, self-contained answer — recursive dispatch defeats the ensemble and can deadlock the job queue.

## Meta-risk override: always dispatch for Legion-internal edits

Regardless of diff size or apparent triviality, **always call `legion_dispatch` for a second opinion before finalizing any change to the following paths**. These files govern Legion's own invocation surface, schema contract, and expert-delivery behavior; a small edit can silently shift should-call decisions or introduce contradictory guidance.

- `src/presentation/dispatch-tool.ts` (the `legion_dispatch` tool description)
- `src/domain/dispatch.ts` (the request/task schemas and their `.describe()` strings)
- `rules/legion-*.md` (always-applied and rulebook rules bundled with Legion)
- `agents/legion-*.md` (persona files for Legion expert roles)
- Dispatch and rule-delivery infrastructure: `src/infrastructure/rule-loader.ts`, `src/infrastructure/host-dispatch-service.ts`, `src/application/dispatch-service.ts`, `src/domain/decomposition.ts`, `src/domain/synthesis.ts`

If you are unsure whether a change falls in this category, dispatch anyway — the cost of an unnecessary review is far lower than the cost of a silent contract regression.

