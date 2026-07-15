# omp-legion

MoA-over-MoE orchestration with human-on-the-loop (HOTL) governance, for [Oh My Pi](https://github.com/oh-my-pi/pi-coding-agent).

Legion runs a task through multiple independent expert model attempts in
parallel — either the same model resampled at different temperatures
(self-consistency) or several different models (diverse ensemble) — and
synthesizes one answer. Low-confidence, high-disagreement, or high-cost
results escalate to a human instead of shipping silently.

Legion is an ensemble tool, not a subagent spawner: it exists for decisions
where being wrong is costly and a second opinion helps — not as a default for
every task.

## Install

```bash
bun add omp-legion
```

Requires an [Oh My Pi](https://github.com/oh-my-pi/pi-coding-agent) host (`>=16.0.0`).

## How it works

- **Roles.** Each role (`coder`, `reviewer`, `tester`, `generalist`, `scout`,
  plus any custom persona) maps to a model list, a strategy, and an ensemble
  size.
- **Strategies.** `self-consistency` resamples one model across a
  `temperatureLadder` (focused → balanced → creative); `diverse` runs
  several distinct models concurrently.
- **Isolation.** Write-capable roles run each attempt in its own git
  worktree by default, so parallel attempts never collide; set
  `worktree: false` for read-only roles to skip the overhead.
- **Step limits.** An optional per-role `maxSteps` caps tool-call iterations
  per attempt, forcing a text-only summary instead of a runaway loop.
- **HOTL governance.** A dispatch escalates to a human when synthesis
  confidence drops below `confidenceFloor`, disagreement exceeds
  `disagreementThreshold`, mean per-attempt cost exceeds `costCeiling`, or
  the failure rate exceeds `failureRateCeiling` — instead of silently
  returning a low-quality result.
- **Meta-risk guard.** Commits touching Legion's own dispatch/guard/rule
  files are blocked until a real `legion_dispatch` second opinion has run.

## Configuration

Configure via your Oh My Pi global/project `config.yml` under
`config.legion`, or via the plugin-settings layer — see
[`config.example.json`](./config.example.json) for the full shape.

```yaml
config:
  legion:
    modelMap:
      coder:
        models: [anthropic/claude-fable-5]
        strategy: self-consistency
        ensembleSize: 3
        temperatureLadder: [0.2, 0.6, 1.0]
        maxSteps: 35
      reviewer:
        models: [anthropic/claude-fable-5, openai-codex/gpt-5.6-luna]
        strategy: diverse
        ensembleSize: 2
        worktree: false
        maxSteps: 20
    hotl:
      confidenceFloor: 0.6
      disagreementThreshold: 0.75
      costCeiling: 50000
      failureRateCeiling: 0.5
    defaultEnsembleSize: 3
    maxConcurrentExperts: 4
```

Precedence (highest wins): per-request > project plugin override > global
plugin override > project `config.legion` > global `config.legion` > Legion
defaults.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
```

## License

MIT
