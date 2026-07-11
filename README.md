# omp-legion

**MoA-over-MoE orchestration for Oh-My-Pi.** Many humble models, ensembled and governed, to reach or beat what a gated frontier model does alone.

## Why this exists

The best model available today, Claude Mythos, isn't generally available — it's gated to a small partner program and priced for enterprise security work. Most people's real model access is a mix of free tiers, cheap providers, and maybe one or two accessible frontier models like Fable 5. Legion's job is to close that gap through orchestration: decompose a task, run it past multiple experts, synthesize their answers into one you can trust, and escalate to you when it can't.

This is not a universal claim. Independent research on multi-model ensembling ("[When Does Combining Language Models Help?](https://arxiv.org/abs/2606.27288)") shows combining models only beats a single strong model on tasks where the models' *failures are decorrelated* — where different models get different subtasks right. It cannot manufacture a capability none of them have. Legion is built around that honest boundary, not around the fantasy that stacking free models always wins.

## What it does

1. **Decompose** — one task from your Oh-My-Pi session is split into specialist sub-tasks.
2. **Dispatch** — each sub-task goes to one or more experts, run through Oh-My-Pi's own `task` execution engine (not a separate spawner). By default, an expert is sampled multiple times from your single strongest accessible model (self-consistency); true multi-model diversity is a deliberate per-role choice, not a blanket default, because [naively mixing different LLMs can lower ensemble quality](https://arxiv.org/abs/2502.00674) rather than improve it.
3. **Synthesize** — a real LLM aggregator reads every expert's output and produces one merged answer, using semantic-similarity-aware clustering (not plain string matching) so that paraphrased-but-equivalent answers don't split votes and quietly wreck majority-vote accuracy.
4. **Govern** — when confidence is low, experts disagree, or cost/time crosses a threshold, Legion doesn't stop and wait on you. It notifies you asynchronously and keeps the background job alive — genuinely **human-on-the-loop**, not a blocking gate dressed up with that name.

## What it deliberately does not rebuild

Oh-My-Pi already owns: subagent process lifecycle, peer-to-peer agent messaging (`irc`), persisted/revivable subagent sessions (cold-revive after a restart), Agent Hub visibility, per-expert progress UI, single-call retry/auth classification, per-provider usage and cost accounting, and quota/rate-limit handling. Legion calls into all of it rather than maintaining a parallel copy. The one time an earlier version of this idea tried to reinvent that lifecycle layer, it shipped a bug that could permanently strand an escalated task — that mistake is the reason this rule exists.

## What Legion owns

- Per-role model-diversity configuration and expert-selection policy.
- The MoA synthesis/aggregation step.
- Semantic-clustering-aware majority voting.
- HOTL threshold policy and the async escalation notification.
- The orchestration record and audit trail — confidence scores, disagreement, what triggered escalation, how it resolved. This is the actual deliverable of a human-on-the-loop tool, not paperwork bolted on after the fact.

Full design rationale and the decision record behind every choice above: [`docs/spec/omp-legion-v1.md`](docs/spec/omp-legion-v1.md).

## Status

Core implementation is in place: host-native project config, automatic LLM task decomposition with single-task fallback, async expert dispatch, semantic synthesis, an awaited HOTL decision gate in the background job (approve, reject, or edit-and-resynthesize), durable session-backed audit persistence, and a host model-registry → Mnemopi → Ollama embedding chain. The live benchmark harness is `scripts/benchmark.ts`; run it against your configured models for manual ensemble versus single-model comparison.
