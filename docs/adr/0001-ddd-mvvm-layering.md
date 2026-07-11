# ADR 0001 — Adopt DDD + MVVM four-layer structure

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

omp-legion is a rebuild of an earlier project (omp-halo) that grew into a
flat structure where domain logic, infrastructure, and presentation sat as
untyped siblings — six-plus dependency-direction violations, tool handlers
mixing schema definition with orchestration and rendering, and domain logic
that could not be exercised without the real host session. That project was
abandoned specifically because of the accumulated cost of not having this
boundary from day one.

The `ddd-mvvm` skill maps MVVM's View/ViewModel/Model onto DDD's
Presentation/Application/Domain layers plus an Infrastructure layer, with
explicit rules: the Domain owns repository/policy ports; Infrastructure
implements them; Presentation talks only to Application Services.

## Decision

omp-legion is structured as four layers with a one-way dependency rule:

```
src/
├── presentation/    # View: the legion_dispatch tool definition. Zero business logic.
├── application/     # Application Service: DispatchService — one orchestration flow.
├── domain/          # Model: dispatch planning, governance, synthesis contracts,
│                     # config schema, constants — pure, no host imports.
└── infrastructure/  # Adapters: host runSubprocess, AsyncJobManager, completeSimple,
                      # embedding providers, orchestration repositories.
```

**Dependency rule:** Presentation → Application → Domain ← Infrastructure. The
Domain layer imports nothing from Infrastructure or the host SDK. Infrastructure
depends inward on Domain-owned interfaces (`ExpertExecutor`, `JobScheduler`,
`OrchestrationRepository`, `Aggregator`, `EmbeddingProvider`, etc.) —
dependency inversion, not dependency duplication.

**Layer responsibilities:**
- **Presentation** (`presentation/dispatch-tool.ts`): registers the tool with
  the host, resolves `ExtensionContext` into constructor arguments, returns
  the immediate async-accepted result. No policy decisions.
- **Application** (`application/dispatch-service.ts`): the one orchestration
  script — decompose, plan, dispatch, synthesize, govern, persist. Reads as a
  sequence of Domain calls; any rule found here that isn't sequencing belongs
  in Domain.
- **Domain** (`domain/*.ts`): dispatch planning (self-consistency/diversity
  selection), governance threshold evaluation, synthesis contracts, config
  schema, and the centralized constants module. Pure functions and types —
  testable with zero host dependencies, and the single source of truth this
  whole layering exists to protect.
- **Infrastructure** (`infrastructure/*.ts`): every place this project touches
  the host SDK — `runSubprocess`, `AsyncJobManager`, `completeSimple`,
  `ModelRegistry`, embedding providers, orchestration persistence.

## Consequences

- A change to how the host executes subagents is isolated to
  `infrastructure/host-dispatcher.ts` and does not ripple into `domain/dispatch.ts`'s
  selection policy.
- Domain logic (self-consistency selection, governance thresholds, synthesis
  clustering) is unit-testable without spinning up a host session.
- Any future contributor adding a new capability has one obvious question to
  answer first: does this belong in Domain (a policy/rule), Application (a step
  in the one orchestration flow), or Infrastructure (a host adapter)?
