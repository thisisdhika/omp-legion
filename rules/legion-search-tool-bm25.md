---
description: How to use search_tool_bm25 — a capability-lookup tool, queried by function not task content
alwaysApply: true
---

# search_tool_bm25

At the start of a session, if you need a tool beyond your built-ins, call `search_tool_bm25` once with a capability query (e.g. `"dependency graph"`, `"codebase symbol search"`) — not your task's own words; it matches tool names/descriptions, not code content. Zero matches = no such tool exists; fall back to grep/glob rather than guessing a tool name.
