---
name: intake
description: EWM INTAKE stage. Confirms the problem, goal, success criteria and constraints with the person and records them on the task. Use right after /ewm new, or whenever the task definition must be refined, before EXPLORE.
---

# EWM stage: INTAKE

Turn the person's request into a shared, recorded definition of the task. Do not research the codebase yet; that is EXPLORE.

## Output contract

INTAKE is complete when the task records the problem, the goal, success criteria, the repository and profile, and the constraints, and the person has confirmed them.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__set_intake,mcp__ewm__decision,mcp__ewm__question,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | First, to read the task id, title, goal, repo and profile. | Active task. |
| mcp__ewm__set_intake | After the person confirms. Input `{goal?, success_criteria[], constraints[]}`. | Phase INTAKE through PLAN. Replaces both lists, so send the complete lists every time. 1-20 criteria, 0-20 constraints. |
| mcp__ewm__decision | For each decision the person states ("do not touch module X", "keep the public API"). Input `{title, choice, rationale}`. | Active task. |
| mcp__ewm__question | For anything unknown that EXPLORE should answer. Input `{action:'add', text}`. | Active task. |
| mcp__ewm__advance | Last. Input `{to:'EXPLORE', reason}`. | Phase INTAKE. |

## Steps

1. Call mcp__ewm__status. Read the title and goal the person gave, and the repo and profile name.
2. Draft the intake yourself, then ask the person to correct it. Do not interrogate; one round of focused questions is usually enough (AskUserQuestion is fine). Cover:
   - Problem: what is wrong or missing, and how it shows up.
   - Goal: the outcome the person wants. Put problem and goal into the `goal` field as one or two sentences.
   - Success criteria: observable and checkable, so VALIDATE can test each one. Reject vague ones ("works well") and propose a concrete version.
   - Repository and profile: confirm they are the right ones. If the profile is the default and the person expects a project profile, tell them to edit `.ewm/project.yaml` and run /ewm resume.
   - Constraints: scope limits, files or modules off limits, compatibility, deadlines, no network.
3. Record: mcp__ewm__set_intake with the confirmed goal, criteria and constraints. Record each stated decision with mcp__ewm__decision. Record each unknown with mcp__ewm__question.
4. Read the result back to the person in four lines (goal, criteria, constraints, decisions) and ask whether it is right. Fix with another mcp__ewm__set_intake if not.

## Writing the intake

Each success criterion must be something VALIDATE can check with a command, a test or a diff.

- Weak: "Performance is acceptable." Better: "`parse()` handles the 10 MB fixture in under 2 s with `npm test`."
- Weak: "Fix the coverage problem." Better: "The cause of the unhit bin is identified with path and line evidence, and the bin is hit by the regression run."

Keep the difference clear. A constraint is a standing limit ("do not change the public API"). A decision is a choice between options ("use the existing retry helper"). A question is something nobody knows yet.

```
mcp__ewm__set_intake {
  "goal": "Problem: <what is wrong>. Goal: <the outcome wanted>.",
  "success_criteria": ["<checkable criterion>"],
  "constraints": ["<standing limit>"]
}
```

If the task was resumed and the intake is already recorded, confirm only what changed and skip the rest.

## Delegation

Do not delegate in INTAKE. Scouts start in EXPLORE. When you do delegate later: at most the profile's `budgets.max_parallel_researchers` scouts at once (default 3), each with a bounded ask (a scope and a maximum number of findings), and the Agent tool may run them in the background, so wait for their results before synthesizing. Read the cited lines yourself before recording anything. Never record a finding without evidence.

## What the mod enforces in code

- Before IMPLEMENT only read tools, read-only Bash and the mcp__ewm__* tools work. Edit and Write are denied.
- Never edit `.ewm/` files directly, not even with Bash. Use the tools.
- Network tools (WebFetch, WebSearch, curl, git fetch) are denied by default. Destructive commands (git push, rm -rf) are denied in every phase.
- Gates need a human. You have no approve tool, and you must not run /ewm commands or invoke the `ewm` skill. Ask the person to run `/ewm approve` or `/ewm reject <reason>`.
- A denial starts with "ewm: " and says how to proceed. Follow it. Do not try another tool to get around it.

## Updating the person

INTAKE is a conversation, so the person sees every step. If a question blocks you, ask it and wait. Do not go more than `max_research_rounds_without_user_update` rounds (default 2) without speaking to the person.

## Exit

When the person has confirmed the intake and at least one success criterion is recorded, call mcp__ewm__advance with `{to:'EXPLORE', reason:'intake confirmed'}`. If the person wants to stop first, tell them to run /ewm pause.
