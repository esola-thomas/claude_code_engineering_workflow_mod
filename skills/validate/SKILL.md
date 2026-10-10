---
name: validate
description: EWM VALIDATE stage. Runs the allowlisted validation commands through run_validation, reports results against the success criteria, names the gaps, and asks the person to accept closure. Use when an EWM task is in VALIDATE, after implementation.
---

# EWM stage: VALIDATE

Show, with recorded evidence, whether the change meets the success criteria. Report failures and gaps plainly; do not round up.

## Output contract

Tests executed, their results, the gaps, and evidence that each success criterion is met. Closure needs the person's acceptance.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__run_validation,mcp__ewm__update_step,mcp__ewm__record_finding,mcp__ewm__question,mcp__ewm__decision,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | At the start; it lists the success criteria and plan steps. | Active task. |
| mcp__ewm__run_validation | To run a check. `{command}`. The mod runs it itself, without a shell, in the repository root, with the profile timeout, and records exit code, duration, commit and the output tail. | Only in VALIDATE. The command must equal one of the profile's `validation.commands` exactly (whitespace aside): extra arguments are refused, so `npm test --help` is not `npm test`. No pipes, redirects, quotes, `&&`, `$` or backticks; put a compound command in a package script and list that. |
| mcp__ewm__update_step | To fix a plan step's status. `{id, status}`. | Only in IMPLEMENT or VALIDATE. |
| mcp__ewm__record_finding | For a verified fact, such as a failure cause. Evidence rules as in EXPLORE. | Active task. |
| mcp__ewm__question / mcp__ewm__decision | For open items and for choices the person makes. | Active task. |
| mcp__ewm__advance | `{to:'IMPLEMENT', reason}` for a local fix, `{to:'PLAN', reason}` for a design change. | Phase VALIDATE. |

## Steps

1. Call mcp__ewm__status. Read `.ewm/project.yaml` for `validation.commands`. If the list is empty, tell the person that nothing can be validated until they add commands there and run /ewm resume.
2. Review the change first: `git diff --stat` and `git diff <base_commit>`. IMPLEMENT should already have shown the diff to the person and had `ewm:reviewer` review it. If it did not (check decisions.md and the status models line), say so to the person and ask the reviewer now (give the base commit, the plan summary and N). State in your report whether a diff review happened; handoff.md records it.
3. Run every relevant command with mcp__ewm__run_validation, one at a time. Only these runs count toward closure, and only a run that passed since the task last entered VALIDATE: a failed run, or a pass from before you went back to IMPLEMENT, does not let the person accept. A command you run through Bash is not recorded. Re-run after any code change; an old result does not vouch for new code.
4. Report in a table: command, exit code, ok or failed, duration. Quote the relevant output tail for failures.
5. Map each success criterion to its evidence: a validation run (V-001), a test, a diff hunk or a finding. State which criteria are met, which are not, and the gaps: checks not run, behavior not covered by tests, environment limits, flaky results.
6. Set the plan step statuses with mcp__ewm__update_step so they match reality.
7. Handle failures:
   - A local, correctable failure: call mcp__ewm__advance with `{to:'IMPLEMENT', reason}`, fix it there, then return to VALIDATE and re-run.
   - A design problem: call mcp__ewm__advance with `{to:'PLAN', reason}` and explain. The revised plan needs a new approval.
   - Edit and Write are denied in VALIDATE, so do not try to fix here.

## Report shape

```
Validation, TASK-NNN
| Command | Exit | Result | Time |
| npm test | 0 | ok | 12.4 s |

Criteria
- C1 <criterion>: met (V-001; src/a.ts:10-20)
- C2 <criterion>: not met, <why>

Gaps
- <check not run, behavior without a test, environment limit>
```

Never call a criterion met without a recorded run or a cited line behind it. A passing suite that does not exercise the change is a gap, so name it.

## Delegation rules

- Validation is not delegated: only run_validation records results. Use "ewm:reviewer" for the diff and, if a failure's cause is unclear, "ewm:repo-scout" with a bounded ask (a scope and N findings, default 8).
- At most the profile's `budgets.max_parallel_researchers` agents at once (default 3). The Agent tool may run them in the background; wait for their results before you synthesize. Dedupe.
- Read the cited lines yourself before recording a finding. Never record a finding without evidence.

## What the mod enforces in code

- In VALIDATE only read tools, read-only Bash, validation commands and the mcp__ewm__* tools work. Edit and Write are denied.
- Never edit `.ewm/` files directly, including validation.md. mcp__ewm__run_validation writes it.
- Destructive commands and, by default, network tools are denied.
- Gates need a human. You have no approve tool; do not run /ewm commands or invoke the `ewm` skill. Do not call mcp__ewm__advance with `to:'DONE'`; it fails without the person's acceptance, which also needs at least one passing validation run recorded since the task entered VALIDATE.
- Follow any "ewm: " denial message instead of working around it.

## Updating the person

Report after each batch of runs: results, gaps, what you recommend. After at most `max_research_rounds_without_user_update` research rounds (default 2) with no message, post an update.

## Exit

When the success criteria are met and the gaps are disclosed, ask the person to accept closure: "Run `/ewm approve` to accept and write handoff.md, or `/ewm reject <reason>` to keep working." The approval moves the task to DONE and writes `.ewm/tasks/<id>/handoff.md`; point the person to it. If they reject, follow the failure handling above.
