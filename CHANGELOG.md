# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Automatic LLM-based task decomposition with a heuristic single-task fallback (spec §1); caller-supplied task lists remain supported.
- Host-native dispatch (`runSubprocess` + `AsyncJobManager`): async by default, one job ID returned immediately, never blocking the calling session (spec §4).
- Self-consistency-first expert selection with per-call `modelOverride` fan-out — one persona, many models, no file duplication (spec §5).
- MoA synthesis: real LLM aggregator over semantic-clustering-aware majority voting, with an honest degraded-mode Rouge-L fallback when no embedding provider is reachable (spec §6).
- HOTL governance: confidence/disagreement/cost threshold evaluation, non-blocking escalation notification, and an approve/reject/edit decision gate awaited from inside the background job (never blocking the calling session) (spec §7).
- Host model-registry embedding tier, ahead of the Mnemopi/Ollama fallback chain.
- Durable Legion audit persistence for the orchestration record, including human resolutions.
- Host-native config surface: per-role `modelMap`, HOTL thresholds, default ensemble size, embedding provider settings — centralized in `src/domain/constants.ts`.
- `config.example.yml` documenting the full config surface.
- ADRs for the DDD/MVVM layering and the host-native dispatch decision.

### Known open items
See the spec status table in [`docs/spec/omp-legion-v1.md`](docs/spec/omp-legion-v1.md) for the authoritative, currently-true list. As of this entry: empirical quality benchmarking against a reachable frontier model remains a manual validation step, not code.
