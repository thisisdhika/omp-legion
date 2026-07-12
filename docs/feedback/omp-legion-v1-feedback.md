# omp-legion v1 feedback

This document records follow-up requirements for the Legion extension. It is a
requirements note, not a claim that these changes are already implemented.

## 1. Runtime model fallback

When a planned expert attempt fails because its model is unavailable, rate
limited, quota-exhausted, times out, or returns another retryable provider
error, Legion MUST consume the next unattempted selector in that role's
`models` array.

Example: with `strategy: "diverse"` and `ensembleSize: 2`, if either planned
attempt using `models[0]` or `models[1]` fails, Legion should schedule
`models[2]` rather than finishing with a short ensemble. The replacement must
be bounded by the configured candidate list and must not duplicate a selector
already attempted for that task.

Fallback behavior MUST:

- distinguish retryable provider failures from task-level or validation errors;
- preserve the failed attempt in the audit record;
- respect concurrency, cancellation, cost, and candidate exhaustion limits;
- work for every dispatch strategy;
- expose the replacement model and reason in progress/audit output; and
- have focused tests for quota errors, ordinary errors, unavailable models,
  candidate exhaustion, and cancellation.

The existing pre-dispatch availability filter is not sufficient: it only
removes selectors that cannot be resolved before execution and does not recover
from a runtime failure.

## 2. One-step adaptive ensemble expansion

If the initial synthesis is escalated for confidence or disagreement, Legion
SHOULD automatically add exactly one expert attempt before invoking HOTL.

For an initial `ensembleSize: 2`, the expansion schedules expert C:

- `diverse`: use the next unattempted model selector;
- `self-consistency`: repeat the configured strongest model with the next
  temperature-ladder value when available.

The additional attempt MUST be included in a fresh synthesis and governance
evaluation. HOTL MUST trigger only when that expanded result still crosses an
escalation threshold. Expansion MUST be bounded to one step per task, respect
failure/cost/concurrency ceilings, and record the initial and expanded
syntheses separately so the decision is auditable.

## 3. IRC interception and expert isolation

Audit and harden the IRC intercept/block path. Expert subagents are currently
still attempting to communicate with one another through IRC.

The guard MUST prevent expert-to-expert communication, including attempts that
spoof peer names or route through aliases. It SHOULD allow only the intended
expert-to-parent reporting path and preserve legitimate parent/system control
messages. The implementation MUST be fail-closed when sender identity or
routing context is unknown, and tests MUST cover direct, spoofed, aliased, and
parallel expert communication.

## 4. Configuration resolution

Legion configuration SHOULD be accepted from all normal OMP configuration
sources:

- global `~/.omp/agent/config.yml` under `config.legion`;
- project `<project>/.omp/config.yml` under `config.legion`;
- the existing project `.omp/plugin-overrides.json` setting; and
- per-request overrides.

The precedence MUST be explicit and documented: per-request values override
project values, project values override global values, and defaults fill
missing fields. Nested Legion objects should merge by field rather than
silently replacing unrelated configuration. Invalid values MUST produce a
clear diagnostic and safe fallback behavior.

## 5. Rules and agent prompt placement

Audit the placement and packaging of Legion rules and agent prompt files.

Confirm that:

- rules are placed where OMP discovers and loads project/package rules;
- agent prompts are placed in the supported agent directory and use the
  expected filename/frontmatter format;
- package metadata ships every required prompt and rule file;
- installed-package behavior matches source-checkout behavior; and
- tests or a packaging smoke check prove the files are discoverable by OMP.

The current package explicitly ships `src/` and `src/agents/`; this must be
verified against OMP's actual discovery rules rather than assumed sufficient.

## 6. Explicit decomposer model policy

Add an explicit `legion.decomposer` policy containing an ordered `models`
array and, optionally, a `temperatureLadder`. It MUST NOT expose or require
`strategy` or `ensembleSize`.

The decomposer always runs exactly one model at a time. If that attempt fails
with a retryable provider error, it advances to the next unattempted selector
in `models`, continuing sequentially until one succeeds, the list is
exhausted, cancellation is requested, or the configured budget is reached.
Decomposer fallback MUST never run models in parallel or duplicate a selector
already attempted for the same decomposition.

The policy MUST be resolved independently from the expert role map, validate
each selector, and record every attempted model and failure in the dispatch
audit. Existing behavior should remain compatible by falling back to the
active session model when no decomposer policy is configured.

The configuration schema, project/global resolution, documentation, and tests
must all cover this field and its sequential fallback behavior.

## Acceptance bar

The follow-up implementation is complete only when each requirement has
behavioral tests, configuration precedence is documented, package discovery is
smoke-tested, and `bun test` plus typechecking pass.
