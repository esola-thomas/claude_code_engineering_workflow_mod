---
name: understand
description: EWM UNDERSTAND stage. Explains the affected area step by step with the system map, contrasts hypotheses, answers the person's questions and records the assumptions they confirm. Use when an EWM task is in UNDERSTAND, before planning.
---

# EWM stage: UNDERSTAND

Make the person understand the system, not just hold a pile of findings. This is a conversation, not an exam: the person decides when they have enough clarity.

## Output contract

An interactive explanation, a diagram, and assumptions validated by the person. Nothing is implemented here.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__record_finding,mcp__ewm__question,mcp__ewm__decision,mcp__ewm__write_map,mcp__ewm__set_intake,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | At the start, after a resume. | Active task. |
| mcp__ewm__record_finding | For each new fact you verify while answering. Same evidence rules as EXPLORE (repo-relative existing path, lines in range). | Active task. |
| mcp__ewm__question | `{action:'add', text}` for a new unknown; `{action:'resolve', id, answer}` when the person or evidence answers one. | Active task. |
| mcp__ewm__decision | For each decision or assumption the person states or confirms. `{title, choice, rationale}`. | Active task. |
| mcp__ewm__write_map | When the explanation changes the map. `{mermaid, text_map, components[]}`. | `mermaid` is 1-20000 characters. |
| mcp__ewm__set_intake | When the person changes the goal, criteria or constraints. Send the complete lists. | Phase INTAKE through PLAN. |
| mcp__ewm__advance | `{to:'EXPLORE', reason}` when data is missing. | Phase UNDERSTAND. Moving to PLAN is refused for you: only the person starts planning, with `/ewm plan`. |

## Steps

1. Call mcp__ewm__status. After a resume, Read `.ewm/tasks/<id>/exploration.md`, `system-map.md` and `questions.md` to reload the evidence. Treat findings marked STALE as unverified until you re-read their lines.
2. Open with the map: show the Mermaid diagram in a fenced mermaid code block, plus the text map, so the person can see the area.
3. Explain step by step, from entry point to effect: three to seven steps, each citing `path:lines` and the finding id (F-001). Give one step at a time, then check: "Does this match what you expected?" Go deeper where the person asks (deep dive on request).
4. Contrast hypotheses. For each: what it predicts, which findings support or refute it, and what observation would tell them apart. Say plainly which is best supported and how sure you are. Optionally ask `ewm:reviewer` to challenge them: give it the hypotheses, the finding evidence and N.
5. Answer questions from recorded evidence. For a small lookup use Read, Grep or Glob. For a larger one delegate to a scout. Record each new fact with mcp__ewm__record_finding. If you cannot back an answer with evidence, say it is unverified.
6. Validate assumptions. List the assumptions the plan will rely on and ask the person to confirm or correct each one. Record each confirmed assumption and each stated decision with mcp__ewm__decision. Resolve answered questions with mcp__ewm__question.

## Shape of a good explanation

- Lead with the answer to "what happens and why", then the steps that show it.
- Name each component once, with the same name as on the map.
- Mark every statement as evidenced (cite a finding) or assumed (say so and ask).
- Give the best-supported hypothesis, the runner-up, and the check that separates them.
- End each turn with one question for the person, not three.

Go back to EXPLORE when a step of the explanation has no evidence, when two findings contradict and neither side can be resolved with a quick Read, or when the person asks about an area the map does not cover.

## Delegation rules

- At most the profile's `budgets.max_parallel_researchers` scouts at once (default 3). Use "ewm:repo-scout" or "ewm:docs-scout" via the Agent tool, and "ewm:reviewer" to challenge hypotheses.
- Each ask is bounded: a question, a scope (files or area) and N findings (profile `budgets.max_findings_per_scout`, default 8).
- The Agent tool may run them in the background. Wait for every result before you synthesize. Dedupe results.
- Read the cited lines yourself before recording a finding. Never record a finding without evidence.

## What the mod enforces in code

- Before IMPLEMENT only read tools, read-only Bash and the mcp__ewm__* tools work. Edit and Write are denied.
- Never edit `.ewm/` files directly. Use the tools.
- Network tools are denied by default.
- Gates need a human. You have no approve tool; do not run /ewm commands or invoke the `ewm` skill. Ask the person to run `/ewm approve` or `/ewm reject <reason>`.
- Follow any "ewm: " denial message instead of working around it.

## Updating the person

After at most `max_research_rounds_without_user_update` research rounds (default 2) with no message to the person, stop and post a short update.

## Exit

- Data is missing: call mcp__ewm__advance with `{to:'EXPLORE', reason:'<what to find>'}` and tell the person what you will look for.
- The person is the one who decides they are ready to plan, by running `/ewm plan`. When the explanation is complete and the assumptions are confirmed, ask "Ready to plan? Run `/ewm plan` when you are." and wait.
- mcp__ewm__advance to PLAN is refused for you (the mod only accepts it from the person). Do not retry it: the mod starts the plan stage itself when they run /ewm plan.
