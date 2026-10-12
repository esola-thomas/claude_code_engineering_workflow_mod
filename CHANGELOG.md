# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- System map drawn without Mermaid: `src/graph.ts` parses a strict subset of Mermaid flowcharts and lays it out (layers, crossing reduction, orthogonal edges). The pane's Map section draws it as SVG (themed for light and dark, node tooltips) in the desktop app, VS Code and mobile, and as box-drawing text sized to the pane in the terminal. Graphs too wide or over 80 nodes fall back to the list of links.
- `/ewm map` draws the diagram for the terminal width instead of printing the Mermaid source, and switches the pane to Map. `/ewm questions` switches the pane to Questions.
- `/ewm map --html` writes `system-map.html`: the diagram, the evidence each node cites, the links, notes, components and the Mermaid source on one page that needs no network and runs no script (a CSP forbids both). The reply carries its `file://` link.
- Pane sections Plan and Findings, and Plan, Questions and Findings drawn as markdown; a ```mermaid fence in any section is drawn as a diagram.
- Stale evidence on the map: a node whose label names a path cited by a stale finding is outlined (red in SVG, heavy box in text); its tooltip lists the findings that cite it.
- `system-map.md` lists the diagram's links.
- `policies.allowed_commands` in the project profile ([#3](https://github.com/esola-thomas/claude_code_engineering_workflow_mod/issues/3)): command prefixes such as `gh issue list`, `git fetch` or `git push` that the guard lets through. `read_only` entries run in every active phase, `implement` entries in IMPLEMENT and `validate` entries in VALIDATE. Only a plain simple command matches (no pipes, redirections, expansions, globs, assignments or wrappers), network entries need `external_network: allow`, and read-only agents never get them. `/ewm status` shows the active entries, and `/ewm new` and `/ewm resume` warn about entries that can never apply.

### Changed

- `mcp__ewm__write_map` parses the Mermaid source and refuses a syntax error or a non-flowchart diagram with its line and column. `text_map` and `components` are optional: the links are derived from the diagram and the components default to its node labels.

### Security

- Force, delete, mirror and prune pushes, `+refspec` and `:ref` pushes, `gh api` write requests and git's `--upload-pack`, `--receive-pack`, `--exec` and `--output` never run, whatever `allowed_commands` lists.

### Fixed

- The README said `external_network: allow` lifts the network rules; for Bash commands that held only in IMPLEMENT. It now says which phases it covers.

## [0.0.0] - 2026-10-10

### Added

- `/ewm` command with `new`, `resume`, `status`, `map`, `questions`, `plan`, `pause`, `approve`, `reject`, `reset`, `list` and `help`.
- `/ewm reset` (human origins only): saves the gate ledger to `.ewm/ledger-backup-<time>.json` and starts an empty one, the way out of a malformed ledger. A task without a ledger entry then resumes with no approvals or validation runs, at PLAN at most, with the transition reason "ledger reset: gates must be approved again"; a DONE task is not resumed.
- While a gate waits for you, status, the pane and the resume brief show "Review the plan and run /ewm approve ..." or "Review the validation results and run /ewm approve to accept closure ..." as the next action.
- `/ewm status` explains an active task whose files are gone and the two ways out (`/ewm list`, `/ewm new`).
- Task workflow: INTAKE, EXPLORE, UNDERSTAND, PLAN, IMPLEMENT, VALIDATE and DONE, plus PAUSED, which resumes in the phase it was paused from.
- Two human gates: plan approval (PLAN to IMPLEMENT) and acceptance (VALIDATE to DONE). The approval of a plan is bound to the plan's hash.
- Model tools `mcp__ewm__status`, `set_intake`, `advance`, `record_finding`, `question`, `decision`, `set_plan`, `update_step`, `write_map` and `run_validation`.
- Sourced findings: each finding needs at least one evidence item whose path exists in the repository and whose lines are in range. Each finding records the commit it was verified at.
- Staleness check on resume: findings whose cited files changed since they were recorded are marked stale. Resume does not re-run validations.
- Resume brief of at most 180 words, and `handoff.md` written when a task reaches DONE.
- Subagents `ewm:repo-scout` and `ewm:docs-scout` (read-only, `haiku` by default) and `ewm:reviewer` (read-only, `sonnet` by default), with the model set from the project profile and recorded for each spawn.
- Stage skills `intake`, `explore`, `understand`, `plan`, `implement` and `validate`.
- Project profile `.ewm/project.yaml` (or `project.json`) with defaults, type checks and warnings. Includes `examples/project.yaml`, `schemas/project.schema.json` and `schemas/task.schema.json`.
- `run_validation` runs the profile's validation commands exactly as listed, without a shell, with a timeout, and records the exit code and output tail.
- Diff review by `ewm:reviewer` before leaving IMPLEMENT, recorded as a decision.
- Native pane with the phase, counts, models, next action and buttons Overview, Map, Questions and Approve, plus a status line. Text output is the fallback.
- Token usage per phase, taken from the engine's turn usage when it is reported.
- Audit log per task (`audit.jsonl`) and a `.ewm/.gitignore` that keeps task files out of git.
- Plugin manifest and marketplace manifest for installation with `/plugin install ewm`.

### Security

- Policy guard on every tool call, including calls made by subagents. It is enforced in code, not by prompts, and it denies any call it cannot decide.
- Before IMPLEMENT, edits are denied (EXPLORE allows them only with `allow_write_in_explore`). Only read tools, read-only Bash and `mcp__ewm__*` tools run.
- Destructive commands are denied in every active phase after their wrappers are unwrapped: `git push`, `git reset --hard`, `git clean`, `rm -rf`, `find -delete`, `sudo` and similar.
- `deny_by_default` network policy: web tools, outbound tools, third-party MCP tools not listed in `allowed_mcp_tools`, and network commands are denied while a task is active.
- Read-only subagents cannot edit, even in IMPLEMENT, and may call only `mcp__ewm__status`.
- `.ewm/` cannot be written by the model. Gate state lives in a mod-private ledger that the model's tools cannot write.
- Approvals come only from a human origin. The model has no approve tool.
- A task folder deleted while the ledger names the task as active does not switch the guard off or deny every call without a hint: the guard enforces the ledger phase and every denial says how to get out.
- The time a task entered VALIDATE, which decides which validation runs count for acceptance, is kept in the ledger, not read from `task.json`, so editing the task file cannot make an old pass look fresh. A ledger from before this change counts no run until validation is run again.
- Validation runs only exact commands from `validation.commands`, with no shell. Destructive or network commands never run.
- Secrets are redacted in audit lines, validation commands and validation output.
- Task ids must match `TASK-NNN` before they are used in a path.
- `EnterWorktree` and `ExitWorktree` are denied during a task, so the session cannot leave the pinned workspace root.

### Known limits

- The mod runs with the user's permissions and is not sandboxed. It does not defend against a malicious local user or a malicious co-installed plugin.
- Bash rules read shell text. In IMPLEMENT, obfuscated commands and scripts written and then run can get past the destructive and network rules. Claude Code's own permissions still apply there.
- Package managers such as `npm install` are governed by Claude Code's permissions, not by `deny_by_default`.
- `budgets.max_parallel_researchers` is enforced only when the engine reports which agents are running. Otherwise it is an instruction to the lead.
- Writes are serialized per process. Run one session per task.
- `task.json` is written whole, without an atomic rename. A crash mid-write can corrupt it; `task.json.bak` is used when it is unreadable.
- The mod API is early access. v0.0.0 targets Claude Code 2.1.296 and must be re-checked on each upgrade with `npm run check`.
- Not in v0.0.0: quick and adaptive modes, automatic model escalation, multi-repository and monorepo detection, ticket and CI adapters, Verdi and UVM introspection.
- Observed in the live acceptance run (`docs/ACCEPTANCE.md`):
  - Deleting `.ewm/` does not reset the gate ledger, so a stale or malformed entry blocks `/ewm new` until you run `/ewm reset` (observation 1).
  - In headless `claude -p` runs the follow-up turn after a command is best effort; send a follow-up prompt if none starts. `/ewm approve` can return without starting the IMPLEMENT turn (observation 2).
  - A compound read-only Bash loop in EXPLORE can be refused as not read-only; use Read, Grep and Glob instead (observation 3).
  - No gate forces the `ewm:reviewer` diff review before VALIDATE. `handoff.md` records whether it ran (observation 4).

See [docs/SPEC-REVIEW.md](docs/SPEC-REVIEW.md#known-limits-accepted-for-v000) for the full list of accepted limits.
