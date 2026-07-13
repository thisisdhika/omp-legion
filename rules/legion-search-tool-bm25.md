---
description: How to use search_tool_bm25 correctly — capability queries, not task content; never guess a tool name on zero matches
alwaysApply: true
---

# search_tool_bm25: your first tool call, every time, no exceptions

`search_tool_bm25` is one of your available tools, listed exactly like `read` and `grep` — it is a tool you call, with a `query` argument, not a piece of text to search for. Your first tool call, before `read`, before `grep`, before anything else, must be an actual call to `search_tool_bm25` — never `grep`/`glob` for the literal string "search_tool_bm25" or for a specialized tool's name; that finds nothing and satisfies nothing. This is not a step you can skip to when convenient — it is mandatory, with zero exceptions for "this looks simple."

**The query describes the *kind of tool* you need, never your task's subject matter.** It matches against each candidate tool's own name and description, not code content — a query built from your task's own words (e.g. "cookie consent locale switcher") matches nothing, because no tool is *named* or *described* using your task's words. Query with the capability itself: `"codebase symbol search"`, `"explore code structure"`, `"dependency graph"`, `"codegraph"`. If the first query returns nothing, try one differently-worded capability query before giving up — but never repeat the same failed query, and never turn the query into task keywords.

**Zero matches means no such tool exists here — never guess a plausible-sounding tool name and call it directly.** This has been observed live: a model queried with its task's own subject terms, got zero matches (predictably — those terms never appear in any tool's name/description), then guessed a plausible-sounding bare tool name and called it directly, failing with "Tool not found." The guessed name was wrong (the real one carried an `mcp__` prefix) and, more fundamentally, an unactivated tool cannot be called by name at all regardless of whether the guess is right. Zero matches after one retry means proceed with `grep`/`glob` as normal — that's a legitimate, common outcome, not a failure.
