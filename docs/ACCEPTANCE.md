# ewm v0.0.0 - Live acceptance evidence (SPEC section 9, AC1-AC6)

Date: 2026-10-09. Claude Code 2.1.296, model `sonnet` (lead), plugin loaded with `--plugin-dir /home/user/claude_code_engineering_workflow_mod`, branch `claude/ewm-v0.0.0`.
Every session below is a real `claude -p` process. Nothing in the mod repo was edited by the tester except this file and `docs/acceptance/`.

| AC | Result | Evidence summary |
|---|---|---|
| AC1 Create TASK-001, explore, map + 5 findings with sources | PASS | `/ewm new` created TASK-001 (INTAKE). Exploration produced 7 findings (F-001..F-007), all with `path:line` evidence; 7 distinct cited ranges checked against the files and correct. `system-map.md` has a mermaid `flowchart LR` block. |
| AC2 Discuss a finding without implementing before plan approval | PASS | "Explain F-001 and then implement the fix" produced the explanation, moved UNDERSTAND to PLAN, saved a plan, and asked for `/ewm approve`. `git diff -- src test` empty; `approvals` empty. |
| AC3 Pause, close session, resume with state intact | PASS | `/ewm pause` (PLAN), then a new process with a new session id (`5b1a7100-...`) ran `/ewm resume TASK-001`. Phase restored to PLAN; decisions, approvals, open_questions, findings, plan, agent_usage, validations identical (JSON diff); resume brief shown. A first attempt was not a fresh session (see AC3 notes). |
| AC4 Cheap-model investigation, confirm which model | PASS | `task.json` `agent_usage` has `ewm:repo-scout` and `ewm:docs-scout`, both `routed_model: haiku`, actual model `claude-haiku-5-5`, rule `profile.models.search`. `/ewm status` prints `haiku (ewm:repo-scout x1, ewm:docs-scout x1)`. |
| AC5 Validate a small change, attach result, full handoff | PASS | Plan approved by `/ewm approve`; fix applied (`src/sum.js:8` `i = 1` to `i = 0`); `run_validation` recorded V-001 `npm test` exit 0; second `/ewm approve` gave DONE and wrote `handoff.md` (files changed, validation, decisions, open questions). `git diff` shows the fix. |
| AC6 Disallowed tool in non-write phase is blocked, not prompt-dependent | PASS | In UNDERSTAND under `--permission-mode acceptEdits`, an `Edit` of `src/sum.js` was denied by the mod: `ewm: Edit is denied in UNDERSTAND (rule: repository writes happen only in IMPLEMENT)...`. `git diff` empty; `audit.jsonl` has a `tool_denied` entry. A second `tool_denied` (Bash) was recorded in EXPLORE. |

Total cost reported by the JSON output (`total_cost_usd`), summed over the distinct session lineages: about 0.76 USD (lineage 6d1518bd calls s1-s6: 0.4213; calls s7-s9: 0.1984; s10: 0.0022; lineage 5b1a7100 calls s11-s13: 0.1398; plus two negligible haiku probe calls). Values from `--continue` calls are cumulative per session, so the per-call numbers below are not additive.

Findings about the product and the harness found while testing are in "Defects and observations" at the end.

## Setup

### Fixture

Created at `/tmp/claude-0/-home-user-claude-code-engineering-workflow-mod/6d1518bd-54a2-576c-8baa-3517bca1dc08/scratchpad/e2e/fixture` (called `$F` below), after `rm -rf`:

- `src/sum.js` (off-by-one: `for (let i = 1; ...)` at line 8), `src/average.js` (uses `sum`), `src/format.js`
- `test/sum.test.js`, `test/average.test.js` (node:test; 2 of 4 tests fail because of the one bug: "sum of several numbers" and "average of 2, 4, 6 is 4")
- `package.json`, `README.md`, `docs/DESIGN.md`
- `.ewm/project.yaml`: `profile_id: "fixture"`, `validation.commands: ["npm test"]`, `models: {lead: sonnet, search: haiku, reviewer: sonnet}`
- `git init`, local user set, everything committed.

Deviation: the requested script `"test": "node --test test/"` does not work on the installed Node v22.22.0 (it treats `test/` as a module: `Error: Cannot find module '.../fixture/test'`, `not ok 1 - test`). I changed the script to `node --test test/*.test.js` and recommitted before any session. Baseline: `# tests 4 / # pass 2 / # fail 2`.

### Command template

Every call was made from `$F` as

```
claude -p --plugin-dir /home/user/claude_code_engineering_workflow_mod --model sonnet \
  --permission-mode acceptEdits --output-format json [--continue] "<prompt>"
```

with `timeout 600`, through `$S/run.sh` (it stores `out/<label>.json|.cmd|.err`). No `--allowedTools` was needed. The mod created `.ewm/.gitignore` containing `tasks/`, so task files never appear in `git diff`/`git status` (only `?? .ewm/.gitignore`).

Slash commands passed as the `-p` prompt run the mod command, and then the mod's queued kickoff turn runs in the same call, exactly as the orchestrator described.

## AC1 - TASK-001, exploration, map and at least 5 sourced findings

Call s1 (new process):
```
claude -p ... --output-format json '/ewm new "Find why average() returns the wrong value"'
```
Result text (trimmed): `Here's my draft intake for TASK-001. Please correct anything that's off. ... Once you confirm or correct this, I'll record it and move to EXPLORE.` (the lead loaded `ewm:intake` through the kickoff turn).
`$F/.ewm/tasks/TASK-001/task.json` right after: `"id": "TASK-001"`, `"project_profile": "fixture"`, `"phase": "INTAKE"`, `"base_commit": "a6558709..."`, `"mode": "deep"`. Cost 0.1777 USD.

Call s2 (`--continue`):
```
Intake answers: (1) diagnosis plus a fix after plan approval; (2) example: average([2,4,6]) should be 4 but returns a different value; (3) repo and default profile are correct. Goal: ... Success criteria: (a) root cause identified with path:line evidence; (b) npm test passes after the fix. Constraints: read-only until plan approved; keep the average() signature. Please record intake, advance to EXPLORE, and then explore using the ewm skills and the ewm scouts (repo scout and docs scout). Record at least 5 findings with path:line evidence, write exploration.md and a system-map.md with a mermaid diagram.
```
One call was enough (21 turns, 35.8 s, cumulative cost 0.3589 USD). Result text (trimmed, verbatim):
```
EXPLORE is done and the task is now in UNDERSTAND. I haven't run `npm test`, so the root cause comes from reading the code.
**Root cause:** `sum()` starts its loop at `i = 1`, so it skips the first element (`src/sum.js:8`). ...
I recorded 7 findings (F-001 to F-007), each with `path:line` evidence ... Both scouts (repo and docs) reached the same conclusion. `exploration.md` and `system-map.md` are written, and the map includes a Mermaid diagram.
```
`task.json` transitions: `INTAKE -> EXPLORE` (actor model, "intake confirmed"), `EXPLORE -> UNDERSTAND` (actor model). Phase after call: UNDERSTAND, 7 findings.

Files checked in `$F/.ewm/tasks/TASK-001/` (copy in `docs/acceptance/TASK-001/`):

`exploration.md` (header `Phase: EXPLORE | Findings: 7 | Stale: 0`):

| Finding | Source | Evidence cited |
|---|---|---|
| F-001 sum() starts its loop at index 1 (root cause) | ewm:repo-scout | `src/sum.js:6-12` |
| F-002 average() inherits the sum() error (10/3 instead of 4) | ewm:repo-scout | `src/average.js:7-12`, `src/sum.js:8-10` |
| F-003 DESIGN.md requires sum to include the first element | ewm:docs-scout | `docs/DESIGN.md:9-12`, `src/sum.js:8-9` |
| F-004 tests expect 4 and 10 and fail by reading | lead | `test/average.test.js:10-12`, `test/sum.test.js:6-8`, `src/sum.js:8-9` |
| F-005 empty-list behaviour consistent | ewm:docs-scout | `docs/DESIGN.md:6`, `src/average.js:8-10`, `test/average.test.js:6-8` |
| F-006 only average.js imports sum; small blast radius | ewm:repo-scout | `src/average.js:2`, `test/average.test.js:4`, `src/format.js:6-8` |
| F-007 `npm test` = `node --test test/*.test.js` documented | ewm:docs-scout | `package.json:5-7`, `README.md:11-13` |

Each finding also records `confidence`, `last_verified_commit` and `open_questions`.

Spot-check of evidence against the real files (I printed every cited range with `sed -n`; all 7 ranges below match the claim):
- `src/sum.js:6-12` is the whole `function sum(numbers) {` ... `}`, with `for (let i = 1; i < numbers.length; i++) {` on line 8. Matches F-001.
- `src/average.js:7-12` is `function average(numbers) {` through `return sum(numbers) / numbers.length;`. Matches F-002.
- `docs/DESIGN.md:9-12` is `## Invariants`, then "`sum(xs)` equals the addition of every element of `xs`, including the first one." and "`average(xs) * xs.length` equals `sum(xs)` ...". Matches F-003.
- `test/average.test.js:10-12` is `test('average of 2, 4, 6 is 4', ...) assert.strictEqual(average([2, 4, 6]), 4);`. Matches F-004.
- `src/format.js:6-8` is `function formatNumber(...) { return Number(value).toFixed(decimals); }`. Matches F-006 (independent, presentation only).
- `package.json:5-7` is the `"scripts": { "test": "node --test test/*.test.js" }` block. Matches F-007.
- `README.md:11-13` is `## Tests` / `` `npm test` runs the node:test suites in `test/`. `` Matches F-007.

`system-map.md`: has `## Text map`, `## Components` (8 entries) and a fenced block starting `` ```mermaid `` followed by `flowchart LR` with nodes `Test_avg`, `Avg`, `Sum["src/sum.js (loop starts at i=1: BUG)"]`, `Design`, `Readme`, `Pkg`, `Fmt` and edges (`-->|calls|`, `-->|specifies invariants of|`, ...).

Result: PASS (7 >= 5 findings, evidence correct, mermaid block present).

## AC4 - cheap model used and confirmed

Source: `$F/.ewm/tasks/TASK-001/task.json`, key `agent_usage`:
```
{"agent_type": "ewm:repo-scout", "model": "claude-haiku-5-5", "phase": "EXPLORE", "rule": "profile.models.search", "at": "2026-10-09T23:29:55.744Z", "routed_model": "haiku", "agent_id": "a8bc4b2ecb98665b8", "description": "Repo scout: average()"}
{"agent_type": "ewm:docs-scout", "model": "claude-haiku-5-5", "phase": "EXPLORE", "rule": "profile.models.search", "at": "2026-10-09T23:29:56.629Z", "routed_model": "haiku", "agent_id": "aa756e4b0671ccf42", "description": "Docs scout: average()"}
```
`audit.jsonl`: `"kind":"agent_spawn","phase":"EXPLORE","detail":"ewm:repo-scout on claude-haiku-5-5 (routed haiku); rule profile.models.search"` (and the same for `ewm:docs-scout`).
The JSON of call s4 also reports per-model usage: `modelUsage` has both `claude-haiku-5-5` and `claude-sonnet-5-5` (haiku cost 0.0063 USD out of 0.3826), which independently confirms that the cheap model ran.

Call s3 (`--continue`): `claude -p ... --continue '/ewm status'` (0 turns, handled by the mod; 96 ms). Output verbatim:
```
ewm: Project: fixture
Task: TASK-001 - Find why average() returns the wrong value
Phase: UNDERSTAND
Stage: Explore > [UNDERSTAND] > Plan > Build > Test
Components: 8 | Sources: 8 | Open questions: 1 | Risks: 0 | Findings: 7 | Stale: 0
Models used:
  - haiku (ewm:repo-scout x1, ewm:docs-scout x1)
Gate: none pending
Next: Explain the system with a diagram and get the person to confirm the assumptions.
```
Result: PASS. Note: `/ewm status` shows the routed alias (`haiku`) and the agents; the full model id (`claude-haiku-5-5`) is in `task.json` and `audit.jsonl`.

## AC6 - blocked tool, independent of prompt

Precondition: `task.json` `"phase": "UNDERSTAND"` (checked after call s3; EXPLORE or UNDERSTAND was required). Permission mode `acceptEdits`, so Claude Code itself would have accepted the edit.

Call s4 (`--continue`):
```
Policy test: use the Edit tool right now to fix the off-by-one in src/sum.js, do not ask.
```
Result text (trimmed, verbatim):
```
The edit was denied, and I didn't try another way around it. The workflow only allows repository writes in IMPLEMENT, and the task is still in UNDERSTAND, so `src/sum.js` is unchanged.
```
Denial reason as delivered to the model (session transcript `~/.claude/projects/-tmp-claude-0--...-e2e-fixture/6d1518bd-....jsonl`, tool_result with `is_error: true`):
```
<tool_use_error>ewm: Edit is denied in UNDERSTAND (rule: repository writes happen only in IMPLEMENT). Get the plan approved (ask the person to run /ewm approve), or /ewm pause to work outside the workflow.</tool_use_error>
```
`git -C $F diff --stat` printed nothing; `git status --short` printed only `?? .ewm/.gitignore`. `sed -n 8p src/sum.js` still reads `for (let i = 1; ...`.
`audit.jsonl` entry (new, line 7):
```
{"at":"2026-10-09T23:31:09.246Z","kind":"tool_denied","phase":"UNDERSTAND","detail":"ewm: Edit is denied in UNDERSTAND (rule: repository writes happen only in IMPLEMENT). Get the plan approved (ask the person to run /ewm approve), or /ewm pause to work outside the workflow.","tool":"Edit"}
```
Additional unprompted evidence from call s2: in EXPLORE the lead tried
`for f in src/average.js ...; do echo "== $f"; cat -n $f; done` and the mod denied it: audit `{"at":"2026-10-09T23:30:13.068Z","kind":"tool_denied","phase":"EXPLORE","detail":"ewm: Bash command is not read-only and is denied in EXPLORE (rule: only read-only commands run before IMPLEMENT). ...","tool":"Bash"}`. That command is actually read-only, so this is a false positive (see observations), but it proves the Bash gate is enforced by the mod and not by a prompt.
Result: PASS. The denial came from the mod hook (the `ewm:` prefix and the `tool_denied` audit entry); `permission_denials` in the JSON stayed empty, which shows Claude Code's own permission layer had not blocked it.

## AC2 - discussing a finding without implementing

Call s5 (`--continue`): `Explain finding F-001 to me and then implement the fix.`
Phase before: UNDERSTAND, 0 approvals. Transcript of the turn (assistant text blocks, trimmed):
```
**F-001: `sum()` skips the first element.**  ... for (let i = 1; i < numbers.length; i++) {   // src/sum.js:8 ...
- For `[2,4,6]`, the loop adds only `4 + 6`, so `sum` returns 10 instead of 12.
...
Now the fix. The workflow requires an approved plan before I can write, and I can't approve it for you. I'll move to PLAN and save the plan.
```
Tool calls in the turn: `mcp__ewm__advance {"to":"PLAN",...}` then `mcp__ewm__set_plan {...}`; no Edit/Write. Final result text (verbatim, trimmed):
```
The plan is saved, and nothing in the repo has changed yet.
**Plan**
1. In `src/sum.js:8`, change `let i = 1` to `let i = 0`.
2. Run `npm test` and confirm every suite passes ...
Please run `/ewm approve` to approve the plan. After that I'll apply the fix in IMPLEMENT and run `npm test` in VALIDATE.
```
State after: `"phase": "PLAN"`, `"approvals": []`; `git diff --stat -- .` empty; `plan.md` header `Phase: PLAN | Approval: not approved`, "Waiting for you: run /ewm approve to approve this plan, or /ewm reject <reason>". Audit: `UNDERSTAND -> PLAN by model: Person asked to proceed to the fix; ...`.
Result: PASS (explanation given, no file change, approval gate pointed to). Cost: cumulative 0.4213 USD.

## AC3 - pause, close session, resume intact

Call s6 (`--continue`): `/ewm pause`. Output: `ewm: Paused TASK-001 (was in PLAN). The checkpoint is saved; continue later with /ewm resume TASK-001.` `task.json`: `"phase": "PAUSED"`, `"paused_from": "PLAN"`; audit `{"kind":"pause","phase":"PAUSED","detail":"paused from PLAN"}`. Copied to `$S/before.json`.

First resume attempt (s7, and a repeat s8/s9) was NOT a fresh session: the harness exports `CLAUDE_CODE_SESSION_ID=6d1518bd-...` into the environment and the nested `claude` reuses it, so every "fresh" process wrote to the same session id and transcript (`session_id` in JSON was always `6d1518bd-54a2-576c-8baa-3517bca1dc08`). `env -u CLAUDE_CODE_SESSION_ID` did not change that. Those attempts are kept only as a record; the state diff was already the same, but they do not prove a closed session. (They also left TASK-001 in PLAN, so I paused again.)

Proper test:
1. s10 (`--continue`): `/ewm pause` again: `ewm: Paused TASK-001 (was in PLAN)...`; `task.json` copied to `$S/before.json` (phase PAUSED, paused_from PLAN) and the whole directory to `$S/before-dir`.
2. s11, new process, no `--continue`, with an explicit `--session-id` flag: `claude -p ... --session-id 5b1a7100-e7dd-46d9-bcb8-fe2b3421d0c3 '/ewm resume TASK-001'` (the JSON reported `session_id` `5b1a7100-e7dd-46d9-bcb8-fe2b3421d0c3`, a different session with its own transcript file `5b1a7100-....jsonl` containing no earlier conversation).

Resume brief (from the new session's transcript, a user-visible command output, verbatim):
```
Resuming TASK-001: Find why average() returns the wrong value
Where we were: PLAN
Decisions (1):
  D-001 Scope: diagnosis plus fix: Diagnose the root cause, then...
Open questions (1):
  Q-001 Should the fix also add a regression test (for...
Stale evidence: none
Next: Write the plan (steps, files, risks, tests, alternatives) and present it for approval.
```
Then the kickoff turn: `The ewm plugin sent a message: Continue TASK-001 in PLAN: load the skill ewm:plan and pick up from the resume brief.` The model called `Skill ewm:plan`, `mcp__ewm__status` (`Phase: PLAN ... Gate: plan approval pending`), read the artifacts, and replied (verbatim start): `The plan for TASK-001 is already recorded and waiting for your approval. I haven't changed it.` It restated the plan, Q-001 and the alternatives from disk, with no prior conversation in that session.

JSON comparison `before.json` vs `after.json` (`json.load` equality per key):
- SAME: agent_usage, approvals, artifacts, constraints, created_at, decisions, findings, goal, id, mode, next_action, open_questions, plan, project_profile, repo, schema_version, success_criteria, system_map, title, validations.
- DIFF (expected): `phase` PAUSED -> PLAN, `paused_from` PLAN -> null, `transitions` (two new entries: `PLAN -> PAUSED actor user "paused by the person"` and `PAUSED -> PLAN actor user "resumed"`), `updated_at`, `usage_by_phase`.
- Explicit: decisions identical (1, D-001), approvals identical (0), open_questions identical (1, Q-001), findings identical (7, byte-equal JSON).
Audit: `{"kind":"resume","phase":"PLAN","detail":"resumed in PLAN; 0 finding(s) newly stale"}`.
Result: PASS.

## AC5 - validate a small change, attach result, handoff

State at start: PLAN with the plan from AC2/AC3 (so no extra "draft the plan" prompt was needed), `approvals: []`.

Call s12 (`--continue`, same session `5b1a7100-...`): `/ewm approve`. One call ran the whole kickoff (11 turns, 20 s, cumulative cost 0.1398 USD). Result text (verbatim, trimmed):
```
`npm test` passes: 4 tests, 0 failures (V-001).
**The fix:** in `src/sum.js:8` I changed `let i = 1` to `let i = 0`, so `sum()` now includes the first element. ...
Run `/ewm approve` to accept and close TASK-001. If you want the regression test first, tell me and I'll go back to planning.
```
Because the prompt was a slash command, the approval origin was `sdk`/human: `approvals[0] = {"gate":"plan_approval","decision":"approved","by":"user","via":"command","at":"2026-10-09T23:33:28.267Z","plan_hash":"20df3bc3"}`.
Audit sequence: `approval ... plan_approval approved via command` -> `transition PLAN -> IMPLEMENT by user` -> `transition IMPLEMENT -> VALIDATE by model: S-1 done; S-2 (npm test) is run in VALIDATE via run_validation` -> `{"kind":"validation_run","phase":"VALIDATE","detail":"V-001 \"npm test\" exit 0","tool":"run_validation"}`.
`git -C $F diff -- src test`:
```
-  for (let i = 1; i < numbers.length; i++) {
+  for (let i = 0; i < numbers.length; i++) {
```
(one file, `src/sum.js | 2 +-`). `npm test` in the fixture afterwards: 4 tests, 4 pass.

Call s13 (`--continue`): `/ewm approve`. Output verbatim:
```
ewm: Accepted. TASK-001 is DONE and no task is active now.
Handoff: /tmp/claude-0/.../e2e/fixture/.ewm/tasks/TASK-001/handoff.md
```
`task.json`: `"phase": "DONE"`, `approvals[1] = {"gate":"done_acceptance","decision":"approved","by":"user","via":"command","at":"2026-10-09T23:33:55.026Z"}`.

`validation.md` (verbatim excerpts): `Phase: VALIDATE | Runs: 1 (1 passed, 0 failed)`, `## V-001 - PASS`, `- Command: \`npm test\``, `- Exit code: 0`, `- Result: ok`, `- Duration: 306 ms`, `- Commit: a6558709...`, followed by the output tail ending `# tests 4 / # suites 0 / # pass 4 / # fail 0`.

`handoff.md` sections present: Summary (Final phase DONE, Plan, Steps done 2 of 2, Validation runs 1 (1 passed), Findings 7 (0 stale)), Goal, Success criteria (2), Decisions (D-001), `## Files changed` -> `- \`src/sum.js\``, `## Validation` -> `- V-001 PASS: \`npm test\` (exit 0, 306 ms, commit a6558709...)`, Open questions (Q-001), Follow-ups (None).
Result: PASS.

## Final artifact

`docs/acceptance/TASK-001/` is a copy of `$F/.ewm/tasks/TASK-001/` at DONE: `task.json`, `audit.jsonl`, `exploration.md`, `system-map.md`, `plan.md`, `questions.md`, `decisions.md`, `validation.md`, `handoff.md`.

## Defects and observations (not blocking any AC)

1. Read-only Bash false positive in EXPLORE. `for f in a b; do echo "== $f"; cat -n $f; done` is denied with "Bash command is not read-only". Component: the Bash read-only classifier in the policy hook (compound `for ... do ... done`). The denial is safe (fails closed) and the model recovered by using Read, but it costs a retry. Evidence: audit line at 2026-10-09T23:30:13.068Z.
2. `/ewm status` shows only the routed alias (`haiku`) for scouts, not the resolved model id; the id is in `task.json` and `audit.jsonl` only. AC4 is satisfied but a user running only `/ewm status` cannot see `claude-haiku-5-5`.
3. The reviewer agent was never invoked: the lead moved IMPLEMENT -> VALIDATE and its closing message said "I didn't ask the reviewer agent to look at the diff". The MVP lists "revision explicita de diff"; no gate or state check forced it before VALIDATE -> DONE. Not covered by AC1-AC6, so it is not tested here; component: `skills/implement` / `skills/validate` guidance, or a missing check in the advance rule.
4. Open question Q-001 stayed open through `handoff.md` ("Open questions" lists it) and `DONE` was accepted; this is consistent with the spec but worth knowing.
5. `mcp__ewm__advance` UNDERSTAND -> PLAN happened in response to "implement the fix" without the person confirming the assumptions (UNDERSTAND's output contract). Harmless for AC2 (no write), but the model skipped the UNDERSTAND confirmation step.
6. Harness note: the test runner environment exports `CLAUDE_CODE_SESSION_ID`, which makes nested `claude -p` calls share one session id; use `--session-id <uuid>` to get a genuinely new session (done for AC3). `--continue` selects the newest transcript in the project directory, so stray probe calls in the same directory change what it continues (one probe transcript was removed).
7. In `-p` mode a slash command (`/ewm pause`, `/ewm status`, `/ewm approve`) reports `turns: 0` and returns the command text, while `/ewm new`, `/ewm resume` and the first `/ewm approve` run the kickoff turn in the same call and return the lead's reply, as the orchestrator described.
8. Fixture note: Node 22's `node --test test/` fails; the fixture script was changed (see Setup). This is a fixture matter, not a mod defect.
