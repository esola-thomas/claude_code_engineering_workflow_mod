---
name: plan
description: EWM PLAN stage. Co-designs the implementation plan with the person (steps, likely files, risks, tests, alternatives and trade-offs), records it with set_plan, and asks for approval. Use when an EWM task is in PLAN. Nothing is implemented before the person approves.
---

# EWM stage: PLAN

Design the change together with the person, write it down, and get it approved. The plan is the contract for IMPLEMENT.

## Output contract

Steps, likely files, risks, tests, alternatives and trade-offs, plus the person's approval.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__set_plan,mcp__ewm__decision,mcp__ewm__question,mcp__ewm__set_intake,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | At the start; it lists success criteria and open questions. | Active task. |
| mcp__ewm__set_plan | When the draft is agreed. `{summary, steps[{text, files[]}], risks[], tests[], alternatives[]}`. | Only in PLAN. 1-30 steps. Step ids become S-1, S-2... Calling it again replaces the plan. |
| mcp__ewm__decision | For each design choice the person makes. `{title, choice, rationale}`. | Active task. |
| mcp__ewm__question | For a new unknown, or to resolve one. | Active task. |
| mcp__ewm__set_intake | If the person changes criteria or constraints. Send the complete lists. | Phase INTAKE through PLAN. |
| mcp__ewm__advance | `{to:'UNDERSTAND', reason}` when an assumption turns out wrong. | Phase PLAN. Moving to IMPLEMENT needs the approval below. |

## Steps

1. Call mcp__ewm__status. Re-read the success criteria, the decisions and the exploration artifacts (`.ewm/tasks/<id>/exploration.md`, `system-map.md`) with Read.
2. Draft the plan in the conversation first and iterate with the person:
   - Approach and at least one alternative, with the trade-off and why you lean one way.
   - Steps: each one a small, reviewable increment with its probable files. Mark new files as new. Check with Glob or Read that the other files exist.
   - Risks, each with a mitigation or a way to detect it.
   - Tests: which existing checks cover the change, which tests to add, and the exact validation commands. VALIDATE runs only commands from the profile's `validation.commands` (see `.ewm/project.yaml`). If the list is empty, tell the person VALIDATE can run nothing until they add commands there and run /ewm resume.
   - Coverage: every success criterion maps to a step or a test.
3. Record each choice the person makes with mcp__ewm__decision.
4. When the draft is agreed, call mcp__ewm__set_plan. Summarize the recorded plan for the person; they can also run /ewm plan to read it in full.
5. Stop and ask for approval: "Review the plan. Run `/ewm approve` to start implementing, or `/ewm reject <reason>` to ask for changes." Do not start implementing. Do not call mcp__ewm__advance to IMPLEMENT; it fails without a recorded approval.
6. After a rejection, revise with the person and call mcp__ewm__set_plan again, then ask for approval again. Any change to the plan after an approval, even a small one, invalidates that approval and needs a new /ewm approve.

## Shape of the plan

```
mcp__ewm__set_plan {
  "summary": "<approach in two sentences>",
  "steps": [
    {"text": "<one reviewable increment>", "files": ["src/net/retry.ts", "new: tests/retry.test.ts"]}
  ],
  "risks": ["<risk and how it is mitigated or detected>"],
  "tests": ["<validation command from the profile>", "<test to add>"],
  "alternatives": ["<option considered, its trade-off, why it lost>"]
}
```

A good step changes one thing and can be shown as one diff. A good plan names what it will not do. Order steps so that each one leaves the repository in a working state.

## Delegation rules

- Plan with the person; do not delegate the design. For fact checks use Read, Grep and Glob, or a scout ("ewm:repo-scout", "ewm:docs-scout") with a bounded ask (a scope and N findings).
- At most the profile's `budgets.max_parallel_researchers` scouts at once (default 3). The Agent tool may run them in the background; wait for their results before you synthesize. Dedupe.
- Optionally ask "ewm:reviewer" to challenge the draft's risks and ordering.
- Read cited lines yourself before relying on or recording a finding. Never record a finding without evidence.

## What the mod enforces in code

- Before IMPLEMENT only read tools, read-only Bash and the mcp__ewm__* tools work. Edit and Write are denied.
- Never edit `.ewm/` files directly, including plan.md. mcp__ewm__set_plan writes it.
- Network tools are denied by default.
- Gates need a human. You have no approve tool; do not run /ewm commands or invoke the `ewm` skill. The person runs `/ewm approve` or `/ewm reject <reason>`. Approval is bound to the plan content, so a changed plan needs a new approval.
- If the profile sets `require_plan_approval: false`, mcp__ewm__advance to IMPLEMENT works without it. Still show the plan and get the person's explicit go-ahead first.
- Follow any "ewm: " denial message instead of working around it.

## Updating the person

After at most `max_research_rounds_without_user_update` research rounds (default 2) with no message to the person, post a short update.

## Exit

The person runs /ewm approve. The mod then moves the task to IMPLEMENT and starts the implement stage. If a plan assumption is wrong, call mcp__ewm__advance with `{to:'UNDERSTAND', reason}` and say why.
