# ADR 0002 — Dispatch on host-native primitives, not a parallel lifecycle system

- **Status:** Accepted
- **Date:** 2026-07-11
- **Full rationale:** `docs/grill/omp-halo-grill-log-v1.0.md`, Q4/Q5/Q8

## Context

Oh-My-Pi already ships a hardened multi-agent execution stack: `runSubprocess`
(the shared low-level executor the native `task` tool itself calls), an
`AsyncJobManager` for fire-and-forget background work, an `irc` peer-messaging
bus, and a persisted/revivable subagent lifecycle (Agent Hub, cold-revive from
JSONL after a restart) — hardened over many real bug fixes documented in the
host's own changelog.

The predecessor project (omp-halo) built its own parallel `StateManager` /
`TransitionService` / SQLite checkpoint system to answer the same question the
host already answers: "is this background unit of work alive, and can it
resume?" A deep audit of that codebase found this was not a theoretical risk —
it was exactly where the worst bug in that project lived: an uncaught
`TransitionError` could permanently strand a resumed, escalated orchestration,
because the bespoke resume path could reach an illegal state the host's own
subagent lifecycle would never have allowed.

Separately, the host's `task` tool wrapper resolves `modelOverride` once per
agent name from session settings (`task.agentModelOverrides`) — a per-session,
per-name setting, not a per-call parameter. Legion's actual requirement (one
persona, sampled across several different models in the same dispatch call)
cannot be expressed through that wrapper at all.

## Decision

1. Legion calls `runSubprocess` directly, passing an explicit `modelOverride`
   per call — the same shared executor the native `task` tool uses, just
   invoked with a capability (per-call model override) the tool's own
   higher-level wrapper doesn't expose. This means Legion's experts are
   registered in the host's `AgentRegistry` (IRC roster, Agent Hub visibility)
   automatically, since that registration happens inside `runSubprocess`
   itself, not bolted on by the `task` tool wrapper.
2. Legion schedules dispatch as a background job through the host's
   `AsyncJobManager`, returning a job ID immediately rather than blocking the
   calling session. HOTL escalation is delivered as a non-blocking notification
   and the human's approve/reject/edit decision is awaited *inside* that
   background job's own callback — never on the tool's synchronous return
   path, so the calling session is never frozen waiting on a person.
3. Legion does **not** build its own subagent lifecycle, resume system, or
   quota/rate-limit ledger. What Legion persists is scoped to genuinely
   Legion-owned data only: the orchestration record (decomposition plan,
   per-task synthesis, governance decisions, human resolutions) — never a
   second copy of "is this subagent alive."

## Consequences

- Legion inherits the host's hardened lifecycle/coordination machinery for
  free, and inherits its bug fixes for free too — there is no parallel system
  to drift out of sync with it.
- The one thing Legion had to build that the host doesn't provide — running
  one persona across several models per call — is a small, well-isolated
  adapter (`infrastructure/host-dispatcher.ts`), not a parallel execution
  engine.
- A human-in-the-loop-shaped mistake (a synchronous blocking dialog) was
  caught during design specifically because this ADR's boundary made the
  question "what does the host already give us here" the default first move —
  see the grill log's Q8 correction for the full account.
