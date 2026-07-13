# Model Fallback System Audit — 2026-07-13

## Executive Summary

This audit examines the complete model fallback system across three layers in omp-legion:
1. **HostLlmAggregator** (synthesis/aggregation step) — `src/infrastructure/llm-aggregator.ts`
2. **HostLlmDecomposer** (task decomposition step) — `src/infrastructure/llm-decomposer.ts`
3. **DispatchService runtime fallback** (per-expert-attempt during dispatch) — `src/application/dispatch-service.ts`

All three layers have fallback mechanisms implemented with **excellent test coverage** (9, 14, and 11 tests respectively). No bugs were found in the fallback logic itself.

**Critical Gap**: The **primary interactive omp session** (the top-level agent driving this very worker) has **no automatic model fallback** — it relies solely on the provider's own server-side fallback (Anthropic's `server-side-fallback-2026-06-01` beta, opt-in only) and manual `/model` switching.

---

## 1. HostLlmAggregator Fallback (Synthesis Step)

**File**: `src/infrastructure/llm-aggregator.ts`  
**Tests**: `tests/infrastructure/llm-aggregator.test.ts` (9 tests, all passing)

### Implementation
```typescript
async synthesize(input: AggregatorInput, signal?: AbortSignal): Promise<string> {
  try {
    return await this.#complete(this.#options, systemPrompt, prompt, signal);
  } catch (primaryError) {
    let lastError = primaryError;
    for (const selector of this.#options.fallbackModels ?? []) {
      const model = this.#resolveModel(selector);
      if (!model) continue;  // skip unresolvable selectors
      try {
        return await this.#complete(
          { ...this.#options, model },
          systemPrompt,
          prompt,
          signal,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
```

### Behavior
- Primary model (captured at session_start) runs first
- On **any** error, iterates through `fallbackModels` array (configured via `config.decomposer.models`)
- Skips selectors that fail to resolve to a real `Model`
- Re-throws the **last error** if all fallbacks exhausted
- No retry classification — **all errors trigger fallback**

### Test Coverage (9 tests)
| Test | Coverage |
|------|----------|
| Primary succeeds, no fallback touched | ✅ |
| Primary fails → tries fallback-1 → fallback-2 succeeds | ✅ |
| Unresolvable fallback selector skipped | ✅ |
| All fail → rethrows last error | ✅ |
| No fallbackModels configured → rethrows primary error | ✅ |
| Preserves original error when primary fails, no fallbacks | ✅ |
| Tries all fallbacks in order before throwing last error | ✅ |
| Aborts while fallback request is still in flight | ✅ |
| Aborts after fallback settles late | ✅ |
| Fallback model receives same prompt/system prompt as primary | ✅ |

### Gap Analysis
- **No fatal vs retryable error distinction** — unlike the Decomposer, the Aggregator retries on ALL errors (including 401/403 auth failures, context length exceeded). This could waste fallback capacity on non-retryable errors.
- **Uses decomposer's model list** — `fallbackModels` comes from `config.decomposer.models` (see `host-dispatch-service.ts`), not a separate aggregator-specific config. Intentional per code comment.

---

## 2. HostLlmDecomposer Fallback (Decomposition Step)

**File**: `src/infrastructure/llm-decomposer.ts`  
**Tests**: `tests/infrastructure/llm-decomposer.test.ts` (14 tests, all passing)

### Implementation
```typescript
async decompose(input: DecompositionInput): Promise<readonly DispatchTask[]> {
  const selectors = policy?.models ?? [activeSessionModel];
  for (const selector of selectors) {
    const model = this.#resolveModel(selector);
    if (!model) { record("unavailable"); continue; }
    
    try {
      output = await this.#runOnce(input, selector, index, temperature);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!isRetryableDecomposerError(error)) {
        record("fatal-failure");  // 401, 403, context length → STOP
        throw error;
      }
      record("retryable-failure");  // 429, 5xx, network → NEXT MODEL
      continue;
    }
    
    // Parse/validation failure = task-level error, DON'T advance to next model
    try { return parseDecompositionResponse(output); }
    catch { record("validation-failure"); throw; }
  }
  throw new Error("exhausted all candidates");
}
```

### Retry Classification (`isRetryableDecomposerError`)
```typescript
const FATAL_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /context[_ ]?length/i,
  /maximum context/i,
];
return !FATAL_PATTERNS.some(p => p.test(errorMessage));
```

### Behavior
- Sequential retry through `policy.models` (or active session model if no policy)
- **Fatal errors stop the chain** (auth, context length)
- **Retryable errors advance** (rate limit, unavailable, network)
- **Parse/validation failures never retry** — they're task logic errors
- Respects `budget.maxAttempts` and `signal.aborted`
- Temperature ladder cycled per attempt

### Test Coverage (14 tests)
| Scenario | Coverage |
|----------|----------|
| Retryable failure → next model | ✅ |
| No parallel/duplicate attempts | ✅ |
| Exhaust all candidates | ✅ |
| Attempt budget respected | ✅ |
| Cancelled signal | ✅ |
| Validation failure → no retry | ✅ |
| No output → retryable | ✅ |
| Unresolvable selector → skip | ✅ |
| No policy → active session model | ✅ |
| Agent/roster wiring | ✅ (5 tests) |

---

## 3. DispatchService Runtime Fallback (Per-Expert-Attempt)

**File**: `src/application/dispatch-service.ts` — `#runFallback()` method (lines ~1052-1117)  
**Tests**: `tests/application/dispatch-service.test.ts` (11 fallback/expansion tests, all passing)

### Implementation Flow
```
1. Run ALL planned attempts concurrently (bounded by maxConcurrentExperts)
2. Collect initialResults
3. #runFallback(initialResults):
   For each result with retryable failure:
     While candidates remain AND cost ceiling not hit:
       nextReplacement() → build replacement attempt
       runAttempt(replacement)
       If replacement succeeds or fails non-retryable → break
       If replacement fails retryable → continue loop (try next candidate)
4. Synthesis sees: original failed attempts + any replacements
```

### Retry Classification (`classifyFailure`)
```typescript
function classifyFailure(result: ExpertResult): "retryable" | "fatal" | "success" {
  if (!result.error || result.exitCode === 0) return "success";
  const msg = result.error.toLowerCase();
  // Retryable patterns
  if (msg.includes("429") || msg.includes("quota") || msg.includes("rate limit")) return "retryable";
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return "retryable";
  if (msg.includes("model") && msg.includes("unavailable")) return "retryable";
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("etimedout")) return "retryable";
  // Fatal: everything else (crashes, validation errors, etc.)
  return "fatal";
}
```

### Key Behaviors
- **Replacement attempts are NEW attempts** — failed original preserved in results with `replacementReason` metadata
- **`nextReplacement()`** walks the role's `modelMap` candidates (strategy-aware: diverse/self-consistency)
- **Cost ceiling** gates total fallback attempts (`governanceThresholds.costCeiling`)
- **Attempt count gate** bounds fallback loop (`fallbackAttempts > candidates.length`)
- **Cancellation respected** at loop boundaries
- **Worktree setting preserved** on replacements (fixes #11)
- **Self-consistency** falls back through `temperatureLadder` instead of model list

### Test Coverage (11 tests in "runtime model fallback and adaptive expansion" suite)
| Test | Coverage |
|------|----------|
| Quota/rate-limit fallback (diverse) | ✅ |
| worktree:false preserved on fallback | ✅ |
| Non-retryable error → no fallback | ✅ |
| Unavailable model fallback | ✅ |
| Exhaust candidates, no duplicate | ✅ |
| Cancellation stops fallbacks | ✅ |
| Self-consistency temp ladder fallback | ✅ |
| Self-consistency bounded by temp ladder | ✅ |
| Adaptive expansion resolves confidence | ✅ |
| Expansion skipped when cost ceiling hit | ✅ |

---

## 4. Primary Interactive Session — CRITICAL GAP

### The Problem
The **primary omp session** (the top-level agent driving this worker) has **no automatic model fallback chain**. When its configured model fails (provider block, rate limit, auth issue), the session **halts completely** — a human must manually run `/model` to switch.

### Evidence from CTO Report
> "tonight, the PRIMARY interactive omp session itself hit a hard provider block on its own model and had no automatic fallback — a human had to manually switch models via /model three times to recover"

### What Exists in OMP Host
| Mechanism | Scope | Auto? |
|-----------|-------|-------|
| `providers.anthropic.serverSideFallback: false` (config.yml) | Anthropic provider only | ❌ Opt-in beta |
| Model roles (`modelRoles.default`, `modelRoles.smol`, etc.) | UI/role selection | ❌ Manual `/model` |
| `modelMap` in legion config | Legion-dispatched experts ONLY | ✅ But only for Legion |
| `config.decomposer.models` | Aggregator/Decomposer only | ✅ But only for Legion internals |

### Anthropic Server-Side Fallback (pi-ai)
**File**: `node_modules/@oh-my-pi/pi-ai/src/providers/anthropic.ts`
- Controlled by `options.fallbacks: FallbackParam[]` passed to `streamSimple()`
- Enables `server-side-fallback-2026-06-01` beta header
- **NOT automatically configured** — must be explicitly passed per-request
- **Anthropic-only** — other providers (OpenAI, Google, OpenRouter, etc.) have no equivalent

### No Hook/Extension Point for Legion
- Legion runs as an **extension** (dispatch tool), not inside the primary session's model call path
- The primary session's model calls go through `pi-agent-core` → `pi-ai` → provider
- No event hook, middleware, or config exists for "primary model failed → try next"
- The `/model` slash command is the **only** recovery mechanism

### Could Legion Plug In?
**No.** Legion's `modelMap` config applies only to **dispatched expert attempts** (which run as isolated subagents with their own model overrides). The primary session's model is resolved once at startup from `modelRoles.default` and never re-resolved on failure.

---

## Summary Matrix

| Layer | Fallback Exists? | Retry Classification | Test Coverage | Config Source |
|-------|------------------|---------------------|---------------|---------------|
| **HostLlmAggregator** | ✅ | ❌ (all errors) | 9/9 ✅ | `config.decomposer.models` |
| **HostLlmDecomposer** | ✅ | ✅ (fatal vs retryable) | 14/14 ✅ | `config.decomposer.models` |
| **DispatchService** (per-expert) | ✅ | ✅ (retryable/fatal/success) | 11/11 ✅ | `config.legion.modelMap.<role>.models` |
| **Primary OMP Session** | ❌ | N/A | N/A | `modelRoles.default` only |

---

## Recommendations

### 1. Fix Aggregator Error Classification (Low Risk)
Add `isRetryableAggregatorError` matching Decomposer's logic to avoid burning fallbacks on 401/403/context-length errors.

### 2. Document Primary Session Gap (Required)
Add to README/ARCHITECTURE.md: **Legion's model fallback only protects dispatched experts. The primary session has no automatic fallback — configure Anthropic server-side fallback if using Anthropic, or accept manual `/model` recovery.**

### 3. Feature Request to OMP Host (Out of Scope)
Request a `primaryModelFallbacks` config array in omp settings that the host's agent-loop would walk on retryable failures. This is a host-level feature, not something Legion can implement.

---

## Appendix: Test Execution Proof

```bash
$ bun test tests/infrastructure/llm-aggregator.test.ts
 9 pass, 0 fail

$ bun test tests/infrastructure/llm-decomposer.test.ts
 14 pass, 0 fail

$ bun test tests/application/dispatch-service.test.ts
 30 pass, 0 fail  (includes 11 fallback/expansion tests)
```