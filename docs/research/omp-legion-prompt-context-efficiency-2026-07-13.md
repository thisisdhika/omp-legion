# omp-legion prompt/context efficiency research

**Date:** 2026-07-13  
**Scope:** Tool descriptions and JSON schemas, system/rule prompt structure, prompt caching, and ways to keep Legion guidance out of sessions that never invoke `legion_dispatch`.  
**Status:** Research only; no production changes are proposed as implemented.

## Executive conclusions

1. **Raw context size and billed input cost are different measurements.** A provider may cache a stable prompt prefix and discount cache reads, but the model still receives the cached content as context. Caching therefore does not make long descriptions free in context-window pressure, attention/salience, or serialization/network terms.
2. **Caching cannot be assumed from source size alone.** The current repository does not expose provider cache controls or cache-read telemetry for the primary session. Whether the host/provider caches system prompts and tool definitions must be measured from provider usage metadata, not inferred from `alwaysApply`.
3. **Stable ordering and byte-identical prefixes matter.** Static system content and stable tool definitions should precede changing user/task content. Any changing content before the cached boundary can invalidate the suffix/prefix relationship. Tool descriptions and schemas are part of the request's tool payload and are candidates for caching only if the host/provider supports it and keeps them stable.
4. **Should-call behavior needs a clear trigger and hard boundaries, not a complete essay.** The highest-value content in `legion_dispatch` is: what the tool does, when to use it, when not to use it, its asynchronous return behavior, and the non-recursive/governance constraint. Historical rationale, repeated explanations, and implementation anecdotes are candidates for removal from the per-turn tool description.
5. **The safest large reduction is conditional delivery, not immediate rule extraction.** Keep the high-salience trigger in the primary tool description, but investigate host support for deferred/tool-search loading or session-time conditional registration. For expert-only guidance, pass rules only to dispatched experts using the existing `loadSubagentRules` path; do not move behavior-critical text without the before/after live test required by the handoff.

## Repository measurements

Measured from the current working tree:

| Payload | Current size | Delivery surface | Cost classification |
|---|---:|---|---|
| `rules/legion-dispatch.md` | 480 whitespace-delimited words / 3,052 chars | Primary-agent always-applied rule; current architecture scopes it away from dispatched experts | Once per relevant session prompt assembly; may recur after compaction/session reinitialization |
| `rules/legion-search-tool-bm25.md` | 338 words / 2,129 chars | Always-applied guidance; forwarded to dispatched experts by `loadSubagentRules` | Primary session plus every expert prompt assembly; not a per-turn tool-list payload |
| `legion_dispatch` tool description | 310 words / ~1,980 chars | Tool definition sent in the primary model's tool list | Recurring on every primary API request that includes the tool list, subject to provider caching |
| Four dispatch schema `.describe()` strings | ~193 words / ~1,260 chars | JSON schema attached to the tool definition | Recurring with the tool definition, subject to provider caching |
| Tool description + schema descriptions | ~503 words | Primary tool list on each request | Main recurring raw-context candidate |

The tool/schema count excludes JSON property names, enum/default metadata, Zod-generated structural schema, and host-added tool metadata. The practical serialized payload is therefore larger than 503 words. Conversely, the 480- and 338-word rule counts are source-text counts, not provider-token counts; actual tokens depend on tokenizer and wrapper formatting.

The current expert path is important:

- `src/index.ts` loads `loadSubagentRules(ctx.cwd)` at `session_start`.
- `src/infrastructure/rule-loader.ts` calls native rule discovery, then removes only `legion-dispatch`.
- `src/infrastructure/host-dispatcher.ts` passes the resulting full rule set explicitly to each expert because `ExecutorOptions.rules` replaces natural discovery rather than merging with it.
- Therefore `legion-search-tool-bm25.md` is intentionally visible to experts today, while the primary-only `legion-dispatch.md` is excluded from experts.

## Tool descriptions and schemas

### What should remain in a tool description

A concise tool description should answer four questions:

1. **Capability:** What does the tool produce or do?
2. **Trigger:** Which user/task situations justify calling it?
3. **Boundary:** Which routine situations should not call it?
4. **Operational contract:** Does it return immediately, require approval, or impose a governance constraint?

For Legion, a compact core would preserve the judgment-call trigger, the low-stakes non-use boundary, asynchronous job behavior, and the fact that this is an ensemble/synthesis tool rather than a raw subagent spawn.

### What is likely prose bloat

The current description's likely reduction targets are material that explains the research history behind the design rather than the model-facing decision boundary:

- repeated justification for why a second opinion is useful;
- repeated wording around “even when the user did not ask for review”; and
- implementation/governance detail that is already encoded by the schema or result behavior.

This is a hypothesis for A/B/live verification, not a claim that every sentence is useless. Anthropic's public guidance emphasizes clear tool names/descriptions and precise input schemas; it does not provide a universal word limit or prove that shorter always improves tool selection. The correct acceptance test is should-call accuracy on representative judgment-call and routine-control cases, not word count alone.

### Schema descriptions

Schema descriptions should explain only semantics that the model cannot infer safely from the field name/type. The current high-value fields are:

- `role`: exact role-name convention and fail-closed behavior;
- `assignment`: this is the expert's real instruction, unlike the top-level `task`;
- top-level `task`: auto-decompose input versus secondary context for explicit tasks.

The `description` display-only field explanation is useful but can likely be shortened. The assignment/task asymmetry is load-bearing and should not be removed merely to save tokens; the project has a live-confirmed failure where callers put real content in `task` and left `assignment` as a label.

## First-party framework patterns

These frameworks do not publish a universal “maximum description length.” Their
official contracts instead make the description part of the tool schema and
use it for selection:

- LangChain's tool concept documentation shows tools being defined from a
  function plus schema/description metadata; the description is part of what
  the model receives when tools are bound:
  <https://python.langchain.com/docs/concepts/tools/>
- CrewAI's official tools documentation requires a tool `name` and
  `description`, and its decorator examples use a short purpose-oriented
  docstring:
  <https://docs.crewai.com/en/concepts/tools>

The useful cross-framework pattern is not a magic word limit. It is a compact
purpose/trigger/argument contract, with longer operational explanations moved
to human documentation or the tool result. This supports shortening Legion's
description and schema prose, but does not by itself prove that a shorter
description improves should-call rate; that still needs a behavioral comparison.

## Prompt caching: what it does and does not solve

### Anthropic

Anthropic's prompt-caching documentation describes explicit cache breakpoints and prefix caching. Tool definitions can be included in the cached prefix, and usage metadata exposes cache creation/read input tokens. Cache hits require stable content/prefix structure; changing content before or at the relevant boundary can prevent a hit. The documented cache lifetime and pricing vary by model/account and must be checked against the active host provider.

Sources:

- Anthropic, **Prompt caching**: <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Anthropic, **Tool use / implementing tool use**: <https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use>
- Anthropic, **Tool use overview**: <https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview>

### OpenAI and other providers

OpenAI documents automatic prompt caching for repeated prompt prefixes and exposes cached-token usage in response metadata. The exact threshold, cache lifetime, model eligibility, and discount are provider/model-specific. The general engineering principle is still applicable: put stable instructions and stable tool definitions before dynamic task content, keep ordering and serialization stable, and inspect `cached_tokens` rather than assuming a hit.

Sources:

- OpenAI, **Prompt caching**: <https://platform.openai.com/docs/guides/prompt-caching>
- OpenAI, **Function calling**: <https://platform.openai.com/docs/guides/function-calling>

### Application to omp-legion

The current code does not show a provider-specific `cache_control` marker, cache-key configuration, or cache usage telemetry. Consequently:

- We cannot claim that either always-applied rule is cache-discounted.
- We cannot claim that the 503-word tool/schema payload is billed in full on every turn, or that it is cached.
- We can claim that the payload remains present in the model context whenever supplied; caching does not remove its context/salience cost.
- The primary tool list is more likely to be cacheable than changing task/user content if the host sends stable tool definitions in a stable order, but this must be verified at the provider boundary.
- A long rule injected into a system prompt may be cacheable if it is in a stable prefix, but the handoff's observed compliance regression remains relevant: cached text is still lower-salience than persona-body text and may be less effective even when cheap to bill.

The next measurement should capture provider response usage for two repeated no-dispatch turns and two repeated dispatch turns, comparing prompt-token, cache-read-token, and cache-creation-token fields where available. Without that, raw source word counts should be treated as an upper-bound context estimate, not a billing statement.

## Always-on versus conditional delivery

The host's rule buckets are not interchangeable:

- `alwaysApply: true` rules have their full content injected into the rendered
  system prompt (`system-prompt.d.ts` documents this as
  `alwaysApplyRules`).
- Rules with a `description` but without `alwaysApply` are placed in the
  rulebook bucket. The system-prompt contract describes these as pre-loaded
  descriptions; the agent can request the full rule through the rule/read
  mechanism. A description is not, by itself, a semantic trigger that
  automatically injects the full body whenever the user mentions a matching
  topic.
- Rules with `condition`/`astCondition` belong to TTSR and are a different
  mechanism: they can trigger stream/tool-edit interruption based on matching
  text or code. They are not a general-purpose relevance router for arbitrary
  system guidance.

This yields a three-way tradeoff:

| Delivery | Guaranteed visibility | Baseline context | Main failure |
|---|---|---|---|
| Always-on full body | Highest | Pays full body on every rendered prompt | Context competition and lower salience as unrelated rules accumulate |
| Rulebook description + agent request | Medium/low | Pays a small index/description; full body only after request | The model may never request it, request too late, or fail to recognize relevance |
| TTSR/trigger condition | High only for a narrow matching event | Low outside matching events | Conditions are brittle and operate at tool/edit/text-stream boundaries, not general task intent |

The handoff supplies a concrete Legion example of the visibility tradeoff:
moving the mandatory `search_tool_bm25` first-call instruction entirely into an
always-applied rule left the text present but reduced observed compliance to
0/2 attempts; restoring a one-line pointer in the persona body returned it to
2/2. This means “guaranteed in the prompt” is not equivalent to “reliably
followed.”

### How modern systems split baseline and conditional context

Anthropic's Tool Search/deferred-loading pattern keeps a small searchable
capability surface available and loads detailed tool definitions only after the
model searches for a relevant capability. This is a tool-definition retrieval
pattern, not a generic instruction-retrieval guarantee. Sources:

- Anthropic, **Advanced tool use: Tool Search Tool**:
  <https://www.anthropic.com/engineering/advanced-tool-use>
- Anthropic, **Contextual Retrieval**:
  <https://www.anthropic.com/news/contextual-retrieval>

The design principle is to pay always for constraints that must govern every
action, while retrieving task-specific detail when the task supplies a
relevance signal. Retrieval introduces false negatives, extra latency, and
another prompt-injection boundary: retrieved text must be treated as untrusted
data and kept distinct from authority-bearing system instructions. A missed
retrieval is worse than a slightly overlong always-on rule when the guidance is
security-critical or controls the first action.

### Implications for Legion

- `legion-dispatch.md` is a primary-agent “when should I call this?” document.
  Its trigger must remain visible somewhere in the primary tool decision
  surface; hiding the only trigger behind retrieval risks eliminating Legion
  from consideration.
- `legion-search-tool-bm25.md` is expert-execution guidance with a measured
  first-action requirement. It is a better candidate for expert-only delivery
  than for semantic retrieval, but only if the high-salience persona pointer
  remains and live behavior is rechecked.
- A description-triggered rule is not currently a native automatic relevance
  mechanism. Changing `alwaysApply` to a description alone would trade full
  context cost for a manual/requested retrieval path, not a guaranteed
  conditional injection.
- RAG-style retrieval is appropriate for large, task-specific reference
  material, not for a mandatory invariant whose absence can cause a wrong
  first tool call.

## Expert-only delivery without changing verified behavior

Current behavior already separates one primary-only rule:

- `rule-loader.ts` removes `legion-dispatch` before forwarding rules to experts.
- `legion-search-tool-bm25` remains in the expert rule set because its first-call behavior was live-verified.

Possible future mechanisms, ranked by safety:

1. **Keep the current expert rule delivery and reduce only non-load-bearing prose inside the rule after a live before/after test.** This preserves the audience and delivery path, but still leaves the rule in the primary session if native discovery applies it there.
2. **Add an explicit expert-only rule category/filter.** Keep the search rule out of the primary session while passing it to experts through `loadSubagentRules`. This is architecturally attractive but must account for native discovery replacement semantics, user/project rules, packaging, and the already-verified first-tool behavior.
3. **Use a deferred/tool-search mechanism for the primary-only Legion usage guidance.** The primary model would discover/load detailed guidance only when considering Legion. This can reduce no-dispatch sessions substantially, but only if the host's tool-discovery contract makes the tool discoverable without placing the full rule in every tool list.
4. **Register the Legion tool conditionally after an explicit trigger.** This has the largest potential no-dispatch reduction but risks making the tool unavailable precisely when the model should have considered it; it also changes host/session lifecycle behavior.

Do not pass a partial `rules` list to experts. The current host contract replaces discovery, so any explicit expert list must preserve all project/user/native rules that experts should receive.

## Ranked reduction options

Estimates are approximate source-word reductions, not tokenizer or billing guarantees.

| Rank | Option | No-dispatch primary impact | Recurring per-turn impact | One-time/session impact | Risk |
|---:|---|---:|---:|---:|---|
| 1 | Shorten `legion_dispatch` description while retaining capability/trigger/boundary/async contract | None unless tool is also deferred | ~100–200 words from the tool list on every request | None | Medium: should-call rate can regress; requires live A/B smoke test |
| 2 | Shorten non-load-bearing schema descriptions, preserving role and task/assignment semantics | None | ~50–120 words per tool-list request | None | Low–medium: malformed calls or task/assignment confusion if over-compressed |
| 3 | Measure and enable provider-native prompt/tool caching where the host supports it | None in raw context | Little/no raw reduction; potentially most of the repeated input becomes cache-read priced | Initial cache write per stable prefix | Low code risk, high provider/host dependency; must verify usage metadata |
| 4 | Remove or defer the 480-word primary-only `legion-dispatch` always-applied rule, relying on the concise tool description for “when” | ~480 words from sessions that never need the rule | None after removal from primary rule assembly | ~480 words saved at primary session prompt construction | Medium–high: primary should-call salience and rule-discovery behavior must be live-tested |
| 5 | Make `legion-search-tool-bm25` expert-only while preserving its current expert delivery and top-of-body pointers | Potentially ~338 words in primary sessions | None for primary tool list; experts still pay it when dispatched | ~338 words saved in no-dispatch primary sessions | High: rule discovery/replacement and first-tool compliance must be re-verified |
| 6 | Deferred/tool-search loading for the full Legion capability/rule set | Potentially removes all Legion-specific payload from no-dispatch turns | Avoids the tool/rule payload until discovery | Discovery request/load cost when needed | High: depends on host support and can hide the tool from should-call decisions |
| 7 | Conditional registration of `legion_dispatch` only after an explicit user/session signal | Potentially removes the full tool/schema payload | Removes ~503 words per primary request while inactive | Registration/discovery cost when activated | Very high: changes availability and likely should-call behavior |

## Recommended next measurement, before implementation

1. Instrument or capture provider usage for repeated primary requests with no Legion invocation: total prompt tokens, cached input tokens, and cache creation tokens.
2. Capture the same fields for repeated turns after one Legion invocation.
3. Record whether the host serializes the tool list byte-identically and in stable order.
4. Establish a live should-call baseline with judgment-call, security-sensitive, architecture, and routine low-stakes prompts.
5. Only then test description/schema shortening, one change at a time, with the same transcript-level compliance checks used by the handoff.

## Bottom line

The CTO's raw counts identify two different optimization surfaces:

- **One-time/session or rule-assembly cost:** the 480-word primary rule and 338-word search rule.
- **Recurring per-turn tool-list cost:** approximately 503 words of Legion description/schema guidance.

Prompt caching may make repeated billing cheaper, but it does not make the content absent from context and cannot be assumed in omp-legion without provider telemetry. The safest first optimization experiment is to measure cache hits, then trim only redundant tool/schema prose while preserving the trigger and the load-bearing task/assignment semantics. The primary-only rule and expert search rule should remain untouched until their delivery can be changed and live-verified without repeating the documented compliance regression.
