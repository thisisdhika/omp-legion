---
description: How to use search_tool_bm25 — a capability-lookup tool, queried by function not task content
alwaysApply: true
---

# search_tool_bm25

Call `search_tool_bm25` once, as your first tool call this session, before `read`/`grep`/anything else — not optional, not conditional on whether you think you'll need it. Query with the capability you might want (e.g. `"dependency graph"`, `"codebase symbol search"`), never your task's own words — it matches tool names/descriptions, not code content. Zero matches = no such tool exists here; proceed with grep/glob, don't guess a tool name.
