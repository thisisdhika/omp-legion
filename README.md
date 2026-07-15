# omp-legion

MoA-over-MoE orchestration with human-on-the-loop (HOTL) governance for [oh-my-pi](https://github.com/can1357/oh-my-pi).

Legion adds a `legion_dispatch` tool that runs a task through multiple
independent expert model attempts in parallel — either the same model
resampled at different temperatures (self-consistency) or several different
models (a diverse ensemble) — and synthesizes one answer. Results that show
low confidence, high disagreement, high cost, or a high failure rate
escalate to a human instead of shipping silently.

It's an ensemble tool, not a subagent spawner: reach for it on a decision or
change where being wrong is costly and a second opinion helps, not as a
default for every task.

> **Plugin or extension?** Both, at different layers. In omp an *extension*
> is a TS/JS module whose default export is `(api: ExtensionAPI) => void`,
> loaded fresh per session. A *plugin* is an npm-style package installed
> under `~/.omp/plugins` and tracked by `omp plugin install/upgrade/disable`;
> its `"omp"` manifest can ship extensions, agents, rules, skills, and more.
> This repo is a plugin shipping exactly one extension
> (`"omp": { "extensions": ["src/index.ts"] }`) plus the `legion-*` agent
> personas and rules it dispatches to.

## Install

```bash
omp plugin install omp-legion
```

Or straight from GitHub:

```bash
omp plugin install github:thisisdhika/omp-legion
```

Manage it like any other plugin:

```bash
omp plugin upgrade omp-legion
omp plugin disable omp-legion
omp plugin uninstall omp-legion
```

### Manual / development load

```bash
git clone https://github.com/thisisdhika/omp-legion
cd omp-legion && bun install
omp --extension /path/to/omp-legion
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- An [oh-my-pi](https://github.com/can1357/oh-my-pi) host ≥ 16.0.0

## How it works

- **Roles.** Each role (`coder`, `reviewer`, `tester`, `generalist`, `scout`,
  or a custom persona) maps to a model list, a strategy, and an ensemble
  size.
- **Strategies.** `self-consistency` resamples one model across a
  `temperatureLadder` (focused → balanced → creative); `diverse` runs
  several distinct models concurrently.
- **Isolation.** Write-capable roles run each attempt in its own git
  worktree by default so parallel attempts never collide; set
  `worktree: false` for read-only roles to skip that overhead.
- **Step limits.** An optional per-role `maxSteps` caps tool-call
  iterations per attempt, forcing a text-only summary instead of a runaway
  loop, while still letting the attempt submit its final result.
- **Decomposition.** An independent sequential decomposer can split a task
  into sub-tasks before dispatch, with its own model list and temperature
  ladder.
- **HOTL governance.** A dispatch escalates to a human when synthesis
  confidence drops below `confidenceFloor`, disagreement exceeds
  `disagreementThreshold`, mean per-attempt cost exceeds `costCeiling`, or
  the failure rate exceeds `failureRateCeiling` — instead of silently
  returning a low-quality result.
- **Meta-risk guard.** Commits touching Legion's own dispatch/guard/rule
  files are blocked until a real `legion_dispatch` second opinion has run.
- **IRC and `task`-tool guards.** Prevent Legion experts from being reached
  through channels other than `legion_dispatch` itself.

## Configuration

Configure via your oh-my-pi global or project `config.yml` under
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
