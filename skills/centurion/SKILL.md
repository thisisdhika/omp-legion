---
name: centurion
description: A grilling session where each next question comes from Legion's expert ensemble instead of one model guessing alone — the sharpest unresolved decision, concrete options, and a recommendation, cross-checked before it reaches the human. Invoked explicitly via the "/skill:centurion" slash command (this skill sets disable-model-invocation, so it never fires on trigger-phrase matching alone — asking to "grill" or "interrogate" a plan reaches the plain grilling skill instead unless the user names centurion directly or types the slash command). Slower and costlier per question than a normal grilling session (each question is a real legion_dispatch round-trip) — reserve it for plans where a wrong early decision is expensive, not routine clarification.
disable-model-invocation: true
---

# Centurion

A grilling session — one question at a time, the decisions are the human's, never proceed until confirmed — except the question itself is produced by Legion's ensemble instead of guessed by one model. Picking the sharpest next question is a judgment call like any other; a bad question wastes the human's time, a good one finds the real fork. This dispatches that judgment call to `legion_dispatch`'s `scout` role every single round.

**Invocation:** type `/skill:centurion <topic>` — this is a plain slash command, not something the model infers from wording like "grill" or "interrogate" (this skill intentionally opts out of trigger-phrase auto-invocation; the generic grilling skill handles those instead). A bare `/centurion` is not a recognized command by this host and will not invoke this skill.

**Latency/cost warning:** every question is a full ensemble dispatch (multiple independent experts + synthesis, occasionally a HOTL escalation). This can take minutes per question, not seconds. Tell the user up front that each round will take a while, and default to a hard cap on rounds (see below) rather than grilling indefinitely.

## Setup

Before the first question, gather what's already known:
- The plan, design, or decision under discussion — read whatever the user has already described or pointed you at.
- Explore the codebase for facts relevant to it (existing patterns, related code, prior ADRs/CONTEXT.md if present). Never plan to ask the human something you can find yourself — that's exactly what `legion-scout` is instructed to avoid too, but don't rely on it alone; you already have the same tools.

Track a running **decision log**: every question asked so far and the human's answer. This is what makes each scout assignment self-contained — a scout has zero access to this conversation, only what you put in the assignment.

## The loop (max 8 questions per session)

For each round, up to 8:

1. **Compose the scout assignment.** It must be a complete, self-contained brief — the scout sees nothing else. Include:
   - The destination: what's ultimately being decided/built.
   - The decision log so far (question → human's answer, for every prior round).
   - Relevant facts you've already found in the codebase (so the scout doesn't waste its own turn re-deriving them, though it may still verify).
2. **Dispatch.** Call `legion_dispatch` with an explicit task, skipping auto-decomposition since the role is already known:
   ```
   tasks: [{ id: "scout-<round>", role: "scout", assignment: "<the assignment from step 1>" }]
   ```
3. **Stop talking until the real result arrives.** `legion_dispatch` returns immediately with a job id — the tool call resolving is not the ensemble finishing. At the moment your turn continues after that call, you do not yet have a question, options, or a recommendation; nothing you could write next would be the ensemble's output, only a guess dressed up as one. **This has actually happened — a prior run presented "Question 1" built entirely from the primary agent's own reasoning, with no scout ensemble output anywhere in it, because the turn kept going instead of stopping here.** Your response for this turn is one line, nothing else: tell the human you're consulting the ensemble and this round will take a few minutes. Do not draft a question. Do not draft options. Do not draft a recommendation, even as a placeholder or a "here's my initial read while we wait" — there is no legitimate content to put there yet, and writing something plausible-looking is worse than writing nothing, because it reads as the ensemble's output when it isn't. Then end the turn. The job's actual synthesized text arrives later as its own delivered result — that delivery, not this turn, is where step 4 happens.
4. **When the real result is delivered, present exactly that.** The question, options, and recommendation you show the human must be the ensemble's own synthesized text — quote or closely paraphrase it, don't reconstruct it from memory of what you expected it to say. Attribute it clearly as the ensemble's output, not framed as if you thought of it yourself. Wait for the human's answer before continuing. Asking multiple questions at once, or moving on before they've answered, is exactly the failure mode grilling exists to avoid.
5. **Append to the decision log** and continue to the next round.

Stop early, before round 8, the moment either side reaches shared understanding — the cap is a ceiling, not a target. If nothing genuinely open remains, say so and stop instead of manufacturing a question to fill the round.

## At the cap

If you reach 8 questions and meaningful uncertainty still remains, **do not silently keep going**. Stop and ask the human directly: summarize what's now settled, name what's still open, and ask whether to continue with more ensemble rounds or treat this as enough to proceed on. Let them decide whether the remaining uncertainty is worth the additional latency/cost — don't decide it for them in either direction.

## Closing

Once stopped (by reaching shared understanding, or by the human declining to continue past the cap), summarize the full decision log before doing anything else with it. Do not enact any plan built on these decisions until the human has confirmed the summary is right.
