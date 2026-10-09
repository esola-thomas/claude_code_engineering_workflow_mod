---
name: implement
description: EWM IMPLEMENT stage. Carries out the approved plan in small increments, shows diffs, tracks each step and records deviations as decisions. Use when an EWM task is in IMPLEMENT, after the person approved the plan.
---

# EWM stage: IMPLEMENT

Execute the approved plan, and only that plan. Repository edits are allowed from here on, within the person's Claude Code permissions.

## Output contract

Bounded diffs, plus a record of decisions and deviations. Every plan step ends as done or skipped.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__update_step,mcp__ewm__decision,mcp__ewm__question,mcp__ewm__record_finding,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | At the start and after a resume; it lists the plan step ids. | Active task. |
| mcp__ewm__update_step | `{id, status}` with status todo, doing, done or skipped. Set "doing" when you start a step and "done" when it is finished and shown. | Only in IMPLEMENT or VALIDATE. |
| mcp__ewm__decision | For every deviation and every choice the plan left open. `{title, choice, rationale}`. | Active task. |
| mcp__ewm__question | For something you need the person to answer. | Active task. |
| mcp__ewm__record_finding | For a new verified fact, for example a reviewer issue worth keeping. | Evidence rules as in EXPLORE. |
| mcp__ewm__advance | `{to:'VALIDATE', reason}` when the steps are done. | Phase IMPLEMENT. |

## Steps

1. Call mcp__ewm__status and Read `.ewm/tasks/<id>/plan.md`. Work through the steps in order unless a dependency says otherwise.
2. For each step: mark it "doing", make the smallest change that satisfies it, then show the diff (`git diff` and `git diff --stat`, or the Edit result) and say what changed and why. Add or update the tests the plan lists. Mark the step "done".
3. Stay inside the plan's files and scope. A different helper name, an extra file inside the scope or a small reordering is a deviation: record it with mcp__ewm__decision (title starting "Deviation:") and tell the person in one line.
4. If the work needs more than that, for example a changed approach, new files outside the scope, or a wrong assumption, stop editing and ask the person. Record their answer with mcp__ewm__decision. A design change returns to PLAN, and from IMPLEMENT the only way is through VALIDATE: call mcp__ewm__advance to VALIDATE, then to PLAN, with the reason. The new plan needs a new approval.
5. Skip a step only with a recorded decision that says why, then mark it "skipped".
6. Do not commit or push unless the person asks. git push is denied anyway.
7. Before leaving IMPLEMENT, optionally ask `ewm:reviewer` to review the diff. Give it the base commit (`repo.base_commit` in `.ewm/tasks/<id>/task.json`), the plan summary and N. Fix the blockers and majors it finds, re-show the diff, and record anything you decide not to fix as a decision.

## Stop and ask when

- a step needs a file outside the plan's scope or an interface the plan does not mention;
- a finding or assumption turns out to be wrong;
- tests fail for a reason the plan did not predict;
- the change is growing beyond the step's size, so the diff would no longer be easy to review.

A good deviation record: title "Deviation: S-2 uses the existing parser", choice "Reused parse() instead of adding a new one", rationale "The helper already covers the case; it avoids duplicating logic".

## Before leaving IMPLEMENT

- Every plan step is "done" or "skipped", and each skip has a decision.
- Every deviation is recorded and the person has seen it.
- The diff contains only what the plan and the recorded decisions allow: no stray debug code, no unrelated formatting.
- The tests the plan lists exist. Running them is VALIDATE's job; do not run them here.

## Delegation rules

- The implementer is you, in the main conversation. Scouts and the reviewer are read-only and never edit.
- At most the profile's `budgets.max_parallel_researchers` agents at once (default 3). Use bounded asks: a scope (files or diff range) and N (default 8).
- The Agent tool may run agents in the background. Wait for their results before you act on them. Dedupe.
- Read the cited lines yourself before relying on a reviewer's issue or recording it. Never record a finding without evidence.

## What the mod enforces in code

- In IMPLEMENT, Edit and Write work on the repository, subject to Claude Code's own permissions. Writes under `.ewm/` are denied in every phase. Use the tools for task state; never edit `.ewm/` files, including plan.md.
- Destructive commands (git push, git reset --hard, git clean -f, rm -rf, find -delete, sudo) are denied. Network tools and programs (WebFetch, WebSearch, curl, git fetch and pull) are denied by default.
- Gates need a human. You have no approve tool; do not run /ewm commands or invoke the `ewm` skill. The plan cannot be changed in IMPLEMENT (set_plan works only in PLAN), and closure is the person's call later: they accept it with `/ewm approve`.
- Follow any "ewm: " denial message instead of working around it.

## Updating the person

Report after each step: what changed, the diff, what is next. After at most `max_research_rounds_without_user_update` research rounds (default 2) with no message, post an update.

## Exit

When every step is done or skipped, summarize the full diff and the deviations, then call mcp__ewm__advance with `{to:'VALIDATE', reason:'steps complete'}`. If the person wants to stop, tell them to run /ewm pause.
