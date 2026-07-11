# Contributing to omp-legion

Thanks for your interest in contributing. This is a small, actively-developed
Oh-My-Pi extension — the bar for contributing is low, the bar for what lands
is not.

## Before you open anything

Read [`README.md`](README.md), [`docs/spec/omp-legion-v1.md`](docs/spec/omp-legion-v1.md),
and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. The spec explains
why each decision was made; ARCHITECTURE.md explains how the shipped code
implements it, file by file. Both carry the same discipline: every claim in
them is either true of the code or explicitly marked open — if you're
proposing a change that would make a claim in either false, update that doc
in the same PR.

## Reporting bugs / requesting features

Open an issue. Include:
- what you ran (the `legion_dispatch` call or config, redacted of secrets)
- what you expected vs. what happened
- the relevant section of the spec, if the behavior contradicts it

## Development setup

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun's test runner
bun run lint         # biome check
bun run format       # biome format --write
```

All four must pass clean before a PR is reviewed.

## Design ground rules (read the ADRs before adding a dependency)

- **Don't reinvent the host.** Before adding code that duplicates something
  Oh-My-Pi already provides (subagent lifecycle, retry/auth classification,
  usage/cost tracking, embeddings, config parsing), check
  [`docs/adr/0002-host-native-dispatch.md`](docs/adr/0002-host-native-dispatch.md)
  and the host integration boundary table in the spec (§3). If in doubt, open
  a discussion first.
- **Layering is not optional.** See
  [`docs/adr/0001-ddd-mvvm-layering.md`](docs/adr/0001-ddd-mvvm-layering.md).
  Domain code (`src/domain/`) must not import the host SDK or anything from
  `src/infrastructure/`. If you're not sure which layer something belongs in,
  that's a design question to raise, not a place to guess.
- **No scattered literals.** Thresholds, defaults, and prompt text belong in
  `src/domain/constants.ts` (or a dedicated prompts module), not as local
  consts sprinkled through the file that uses them.
- **Every non-trivial change needs a test.** Domain logic should be testable
  without a host session at all — if your change can't be tested that way, it
  probably belongs in a different layer.

## Pull requests

- Keep PRs scoped to one change. A PR that touches dispatch, synthesis, and
  config in one diff is hard to review and harder to revert.
- Run the full gate (`typecheck && test && lint && format`) before requesting
  review — CI will re-run it, but don't make a reviewer wait on you fixing
  formatting.
- If your change closes an item in the spec's "still open" list, update that
  section in the same PR.
