# Prompt/hook redundancy & token-efficiency audit — handoff (2026-07-13)

> **Correction / supersession (2026-07-13):** Fact #5 below is superseded. `rules/legion-dispatch.md` was restored and properly scoped in commits `c78bb56` and `bf90b7d`; the historical deletion claim is retained below for audit provenance and should not be treated as current state.
>
> **Audit status:** The audit scope described here (Phases I–III) is complete. The persona Security boundary consolidation recommended for Phase III landed in `027ca1d`; the persona Run blind and other scoped-file review items were covered in the earlier audit pass. Treat the remaining “not yet started” wording below as historical handoff context, not outstanding work.

## Context

This session chased a live bug (`search_tool_bm25` misuse — subagents querying with task-subject
terms instead of tool-capability terms, then guessing a wrong bare tool name on zero matches) through
several rounds of fixes, landing on a real finding: Legion had **no working mechanism for sharing
guidance across personas** without hand-duplicating prose into every `agents/*.md` file. Fixing that
one case surfaced the actual pattern worth auditing everywhere else. The user asked for a **deep audit
of hooks/prompts/etc. for redundancy, duplication, and token efficiency** — this doc scopes that work
for a future session; it has not been started beyond the one case below.

Commits from this session, in order: `77354ef` (MCP manager reuse), `3364e3c` (earlier fixes),
`44c052a` (the search_tool_bm25 fix + rule mechanism this doc is about). Read `44c052a`'s commit
message and the matching `CHANGELOG.md` `[Unreleased]` entries for the full story before starting —
they contain load-bearing detail not repeated here.

## Load-bearing facts from this session (don't re-derive these)

1. **Two separate native rule mechanisms exist, easy to conflate:**
   - `RULES.md` (capital, single file): `.omp/RULES.md` (project) / `~/.omp/agent/RULES.md` (user) —
     a *sticky, always-injected* file, documented at `docs/context-files.md` in the
     `can1357/oh-my-pi` repo.
   - `.omp/rules/*.md` / `~/.omp/agent/rules/*.md` (directory, many files) — discovered via
     `discovery/builtin.ts`'s `loadRules`, each file individually bucketed into `alwaysApply` or
     `rulebook` (description-triggered) rules.
   - **Extension packages get a third path, easy to miss:** `discovery/omp-plugins.ts` scans every
     registered extension's own `<ext>/rules/*.md` (and `skills/`, `hooks/`, `tools/`, `commands/`,
     `.mcp.json`) automatically — this is what makes Legion's own `rules/*.md` discoverable without
     any manual code, exactly like `agents/*.md` already was. **Verified live** by calling
     `loadCapability(ruleCapability.id, {cwd})` directly and confirming Legion's bundled rule appeared
     with zero custom plumbing.
2. **Passing `ExecutorOptions.rules` explicitly to a subagent REPLACES its own discovery, it does not
   merge with it.** Never pass a partial list (e.g. "just Legion's own rules") unless you've also
   included whatever the subagent would have discovered on its own — omitting `rules` entirely and
   letting the subagent discover naturally is almost always correct, and is what Legion does today.
3. **`alwaysApply` rules land in one long concatenated block, position varies, and can end up deep in
   the prompt** (observed: ~37% in, immediately after an unrelated `omp-halo` rules block) — measurably
   weaker compliance than a persona's own body text, which sits first. **Moving a "mandatory first
   action" instruction fully into a rule file, with nothing left in the persona body, caused a live,
   measured regression** (verified via real dispatch transcripts: 0/2 attempts called the tool,
   vs. 2/2 before). The fix that worked: a **one-line high-salience pointer** at the top of the
   persona's own body (right after the role statement) + the full mechanics living once in the rule
   file. Any future "extract into a rule" refactor needs the same before/after live check — this isn't
   a one-time gotcha, it's a structural property of how rules render.
4. **`buildRuleFromMarkdown`'s `name` comes from the filename, not the frontmatter `name:` field** —
   confirmed by testing; a `name:` key in a rule file's frontmatter is silently inert. Don't rely on it
   for anything; the file's own basename (minus `.md`) is the rule's real identity for dedup/disable.
5. Deleted `rules/legion-dispatch.md` this session — it was misplaced (bare `rules/`, missing the
   `.omp/` prefix a project/user rule would need) *and* fully redundant with `legion_dispatch`'s own
   tool description (`src/presentation/dispatch-tool.ts`), which already covered everything it said,
   more accurately. Confirm nothing else in the repo assumed that file still existed before extending
   this pattern further.

## What's already fixed (don't redo)

- `search_tool_bm25` guidance: previously 6 near-identical long paragraphs duplicated across
  `agents/legion-{coder,generalist,reviewer,scout,tester}.md`. Now one canonical explanation in
  `rules/legion-search-tool-bm25.md` (auto-discovered per fact #1 above), plus a one-line pointer in
  each of those 5 persona files. `legion-decomposer.md` intentionally left with its own softer,
  narrower framing (no mandatory-first-call pointer) — see its "Ground the reference" section.

## Audit scope — not yet started

Go file by file. For each, check: (a) is this content duplicated elsewhere (verbatim or
near-verbatim), (b) does it reach its intended audience at all (dead/misplaced like
`legion-dispatch.md` was), (c) is it positioned for actual compliance (see fact #3), (d) is it longer
than the behavior it's trying to produce warrants (token cost vs. value).

**Persona files** (`agents/legion-{coder,generalist,reviewer,scout,tester,decomposer}.md`):
- `## Run blind` section is near-identical prose across all 6 — worth comparing word-for-word; if it's
  truly identical modulo one noun, it's a rules-mechanism candidate like search_tool_bm25 was (apply
  fact #3's before/after live-check discipline if you extract it).
- `## Security boundary` section: same question — near-identical across all 6.
- Check for other guidance that duplicates what a *rule* file could hold once, vs. what's genuinely
  persona-specific voice/scope (the lesson from `search_tool_bm25`: not everything belongs in a shared
  rule — decomposer's narrower framing was deliberately kept out of the shared mechanism).

**`skills/centurion/SKILL.md`**: written and iterated on heavily earlier this session (escalation
handling, "go dark" instructions). Not reviewed for overlap with the persona files or `rules/` — check
whether any of its content duplicates general dispatch guidance that belongs in a rule instead.

**`src/infrastructure/aggregator-prompts.ts`** (`DECOMPOSER_SYSTEM_PROMPT`, `AGGREGATOR_SYSTEM_PROMPT`,
`buildDecomposerPrompt`, `buildAggregatorPrompt`): these are TypeScript string constants, not
discoverable rule files — the rules mechanism doesn't apply to them (they're not attached to a
persona's `tools:`-driven subagent spawn the same way). Still worth checking for internal duplication
between the two prompts, and whether either restates something `agents/legion-decomposer.md` already
says (the decomposer's *fallback* `AgentDefinition` uses `DECOMPOSER_SYSTEM_PROMPT` directly per
earlier work this session — check it hasn't drifted out of sync with the bundled persona file's actual
current content).

**`src/presentation/dispatch-tool.ts`**: the `legion_dispatch` tool description string is long and has
been edited piecemeal across many sessions (role-name convention, assignment/task asymmetry, etc.) —
worth a read for internal redundancy and whether it still reads as one coherent brief rather than a
patchwork of appended clauses.

**Hooks** (`src/infrastructure/{git-commit-guard,irc-tool-guard,task-tool-guard}.ts`): not prompts, but
check their user-facing error/rejection message strings for duplicated phrasing or logic that could be
factored into one shared helper (e.g. a common "this action is blocked for legion-* experts because…"
formatter) rather than each hook composing its own similar message inline.

**`docs/ARCHITECTURE.md`**: large, has been updated incrementally across many sessions (config
resolution, decomposer mechanism, etc.) — worth checking for sections that now describe removed/changed
behavior (e.g. anything still referencing `rules/legion-dispatch.md` or the pre-fix `search_tool_bm25`
framing) rather than auditing for prose duplication specifically.

## Suggested method

Given the fact-#3 gotcha (moving text into a rule can silently regress compliance), any consolidation
found here needs the same discipline used for `search_tool_bm25`: implement, then **live-verify via
`/omp-interactive-cmux` against the scratch project** (`~/Projects/kaa.ltd/LAB/experiments/legion-pt2`)
with a real dispatch before and after, reading the actual subagent transcript's tool-call sequence —
not just confirming the text is present in the system prompt (that alone was insufficient evidence
last time; presence and compliance are different questions).
