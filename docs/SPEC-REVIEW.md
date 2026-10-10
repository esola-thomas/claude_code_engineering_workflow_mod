# Spec review and decision register (v0.0.0)

Reviewed: [SPEC.md](SPEC.md) v0.1, 2026-10-09.
Grounded against: Claude Code 2.1.296 function-hook (mod) API, its generated
declarations, `claude plugin validate`, `claude plugin test`, and a headless
`claude -p --plugin-dir` run of a spike mod. Where this file and SPEC.md
differ, this file wins for v0.0.0.

## Verdict

The spec is buildable on the current mod API with no unsupported assumptions
in the MVP scope. Every MVP acceptance criterion maps to an engine primitive
that exists today. Five defects need fixing before code, and seven gaps need a
decision. None changes the product promise.

## Platform facts that shape the design

| Fact (verified on 2.1.296) | Consequence |
|---|---|
| A mod is `.claude-plugin/plugin.json` + `hooks/hooks.json` (`{"modules": [...]}`) + one hooks module exporting `register(on, options)`. | Layout in SPEC §5 is right; the hooks module is `hooks/register.tsx`. |
| The hooks module runs with **no Node and no DOM**. All IO goes through `$` (`$.fs`, `$.process`, `$.store`, `$.state`, `$.clock`). | Core logic is pure TypeScript behind an `Io` port; the mod adapts `$` to it. Core is unit-testable under plain Node. |
| No `npm` dependencies at runtime: the module may import only files of the plugin. | No YAML library. We ship a small, tested YAML-subset parser for `project.yaml`, and also accept `project.json`. |
| `tool.call` hooks can deny any tool call, for the main loop **and subagents** (`agentId`), with a fail-closed `.catch`. | AC6 is enforced in code, not prompts. |
| `agent.spawn` hooks see and can rewrite `model` and get back `{ model, agentId }`. | Model router lives in the hook, and every spawn's actual model is recorded (AC4). |
| `command.run` carries `origin.kind` (`composer`, `bridge`, `sdk`, `plugin`, ...). | Gate approvals accept only human origins. The model cannot approve its own plan. |
| `$.tool.register` exposes typed tools `mcp__ewm__<name>` to the model. | Findings, questions, decisions, plan, map and validation runs are written through schema-checked tools, not free-form file writes. |
| `$.ui.open` + `ui.render` (`Pane`) draw a native pane on terminal and desktop; `$.ui.status` sets a status line. Mermaid is not rendered. | Pane shows text; Mermaid goes to `system-map.md`. `/ewm status` text is the fallback when no pane is placed. |
| `claude plugin test` runs `*.test.ts` against the real engine, offline and without auth. `claude -p --plugin-dir` loads the mod headless. | CI can run the mod tests; acceptance can be proven end to end with real models. |

## Defects in the spec (fixed here)

| # | Spec location | Defect | Fix |
|---|---|---|---|
| F1 | §4 diagram, `PAUSED --> INTAKE` | Resuming to INTAKE loses the phase, which contradicts §7 ("conserva fase"). | `PAUSED` stores `paused_from`; resume returns to it after the staleness check. |
| F2 | §5 profile | `allow_write_in_explore` exists, but the model must still write exploration artifacts in EXPLORE. Taken literally, either the flag is meaningless or artifacts cannot be written. | Artifacts are written only by the mod's own tools (`mcp__ewm__*`). Edit/Write stay denied before IMPLEMENT; the flag only opens repo writes in EXPLORE. |
| F3 | §5 task JSON, `open_questions: string[]` | Questions cannot be resolved or referenced without ids. | `open_questions` is `{id, text, status, answer?}[]`. |
| F4 | §6 "max N findings" plus the "no unverified facts" rule | Nothing enforces sources. | `record_finding` rejects findings without at least one evidence item whose path exists in the repo (and whose line range is in bounds), and stamps `last_verified_commit`. |
| F5 | §5 task ids `TASK-001` used as a path segment | `/ewm resume ../../x` would be a path traversal. | Ids must match `^TASK-\d{3,}$` everywhere they enter. |

## Gaps closed by decision

| # | Question | Decision | Why | Reversible? |
|---|---|---|---|---|
| D1 | Plugin name | `ewm` (skills `ewm:explore`, agents `ewm:repo-scout`, tools `mcp__ewm__*`). Repository name unchanged. | Short, matches `/ewm`, keeps tool names well under 64 chars. | Yes, before first public install. |
| D2 | Who may move phases | Model may take non-gated edges via `mcp__ewm__advance`. Two gates (PLAN→IMPLEMENT, VALIDATE→DONE) need a recorded human approval (`/ewm approve` or the pane button). The model has no approve tool. | Matches SPEC §9 ("dos gates") and Principle 1, enforced in code. | Yes |
| D3 | Plan approval after the plan changes | Approval stores the plan hash; editing the plan invalidates it. | Prevents approve-then-swap. | Yes |
| D4 | Bash before IMPLEMENT | Only a read-only allowlist with per-program argument rules (`git status/log/diff/show/...` without `--output`/`-O`/`--ext-diff`, `ls`, `cat`, `grep`, `rg` without `--pre`, `find` without `-exec`/`-delete`, ...), no redirection, no `$`, no command substitution; pipes and `&&` only between allowlisted segments. VALIDATE adds the profile's `validation.commands`. IMPLEMENT defers to Claude Code's own permissions. | A deny-list on shell text is bypassable; an allowlist is not (within its parser's limits, documented). | Yes |
| D5 | Destructive commands during a task | Denied in every active phase, after unwrapping `env`/`xargs`/`timeout`/`sh -c`/`eval` and git global options: `git push`, `git reset --hard`, `git clean -f`, `rm -rf` (any spelling), `find -delete`, `sudo`. `/ewm pause` makes the mod inert for out-of-band work. | SPEC §8: the mod never authorizes push or destructive execution. | Yes |
| D6 | Network | Default profile is `external_network: deny_by_default`: WebFetch, WebSearch, outbound tools (Artifact, SendMessage, PushNotification, RemoteTrigger, ...), third-party MCP tools (unless listed in `policies.allowed_mcp_tools`) and network programs in Bash (`curl`, `wget`, `ssh`, `git fetch/pull/clone`, ...) are denied while a task is active. | Secure default; SPEC §8. Opt-out is one line. | Yes |
| D7 | Read-only subagents | `ewm:repo-scout`, `ewm:docs-scout` and `ewm:reviewer` are held to the read-only policy in every phase, identified by `$.agent.list()` at call time (not by their tool list, and not by a record written after spawn). They may call only `mcp__ewm__status` of the mod's tools. | SPEC §6 says read-only; this makes it true in IMPLEMENT too. | Yes |
| D8 | Mod behaviour outside a task | Inert. No active task, or the active task is PAUSED or DONE: every tool call passes through untouched, and the model tools are deferred behind ToolSearch. | The plugin must not tax sessions that do not use it. | Yes |
| D9 | Storage location | `<workspace>/.ewm/`. The mod writes `.ewm/.gitignore` ignoring `tasks/`; `project.yaml` stays committable. | SPEC §5. Home-dir storage is a later option. | Yes |
| D10 | Quick/adaptive mode | Out of v0.0.0. `mode` exists in the schema (`deep` only). | SPEC places classification in v0.2. | Yes |
| D11 | Escalation to the strong model | Out of v0.0.0. The router maps role to model from the profile; no automatic escalation. | SPEC v0.2. | Yes |
| D12 | Token metering | Recorded per phase from `turn.complete` usage where the engine reports it; never estimated. | SPEC §6 "donde la API lo exponga". | Yes |
| D14 | Gate ledger | Approvals, the validation runs that count, the active-task pointer and the profile snapshot live in a mod-private ledger in `$.store`, which the model's tools cannot write. Gate checks read the ledger and recompute the plan hash. Write tools on `.ewm/**` are denied in every active phase. Profile edits take effect on the next `/ewm new` or `/ewm resume`. | In IMPLEMENT the model can write files; without this it could forge an approval in `task.json` or relax `project.yaml`. | Yes |
| D15 | Unknown tools | Before IMPLEMENT and in VALIDATE, tools are allowlisted (Read, Grep, Glob, Agent, Skill, ToolSearch, ...); anything not listed is denied. `EnterWorktree`/`ExitWorktree` are always denied during a task. `Monitor` is classified like Bash. | Claude Code ships tools that write, schedule or send data (Monitor, Artifact, SendMessage, CronCreate, ...); a default-allow matrix would leak. | Yes |
| D16 | Workspace root | Pinned to the absolute session `cwd` at `session.start`; all paths absolute; git runs with `cwd: root`. A `cd` or worktree move cannot make the mod inert. | The engine's session root follows `cd`; the guard must not. | Yes |
| D17 | Concurrent writes | All service writes go through one async queue. | Parallel scouts, turn completions and tool calls write the same `task.json`. | Yes |
| D18 | Phase integrity | The task's phase and resume target live in the ledger too; task.json mirrors them. | While PAUSED the mod is inert, so the model could otherwise edit `paused_from` and skip the plan gate on resume. | Yes |
| D19 | Who may change state | Every state-changing `/ewm` command needs a human origin, not only approve/reject. | A scheduled or model-originated `/ewm resume` must not reload a model-edited profile. | Yes |
| D20 | Readiness to plan | UNDERSTAND -> PLAN is the person's call (`/ewm plan`), as SPEC §4 labels it ("usuario listo"). The live run showed the model jumping to PLAN on its own. | Principle 1. | Yes |
| D21 | Ledger recovery | `/ewm reset` (human origins only, D19) saves the raw ledger value to `<root>/.ewm/ledger-backup-<time>.json` and stores an empty ledger. Tasks on disk are kept; a task with no ledger entry resumes with no approvals or validations, at PLAN at most, and a DONE task is not resumed. | A malformed or stale ledger fails closed (D14); without a command the only way out was editing the mod store by hand. | Yes |
| D22 | Missing task files | While the ledger names an active task whose files are unreadable, the guard enforces the ledger phase and appends how to get out (`/ewm status`, `/ewm list`) to every denial. | A deleted task folder must neither disable the policy nor deny every call without explanation. | Yes |
| D13 | Approval origin | `/ewm approve` is accepted only from `composer`, `bridge` or `sdk` origins, or a pane button press. A plugin, peer, trigger or notification origin is refused. | Keeps approvals human. `sdk` is needed for headless runs; a headless caller is the human's script. | Yes |

## Known limits (accepted for v0.0.0)

- The mod runs with the user's permissions and is not sandboxed (SPEC §8 note). The policy layer narrows what the model can do; it does not defend against a malicious local user or a malicious co-installed plugin.
- Bash classification parses shell text. It is an allowlist, so unknown forms are denied, but exotic quoting can still be refused wrongly (false denials, not false allows, is the design goal).
- In IMPLEMENT, Bash is left to Claude Code's own permission system apart from the destructive and network deny rules, which are best effort: an obfuscated command (variables, scripts written then run) can evade text classification. The ledger keeps gates intact regardless.
- Package managers (`npm install`, `pip install`) reach the network and are not blocked by `deny_by_default`; Claude Code's permissions govern them.
- The ledger lives in the user's Claude Code config directory; a Bash command in IMPLEMENT that writes there is outside the policy's view (Claude Code asks permission for writes outside the project by default).
- `max_parallel_researchers` is enforced at spawn only when the engine reports which agents are still running; otherwise it is a skill instruction.
- Write serialization is per process. Two Claude Code sessions driving the same workspace at once can still interleave writes to one task; run one session per task.
- Task files are written whole, without atomic rename (the `$.fs` API has none). A crash mid-write can corrupt one `task.json`; artifacts are re-renderable from it.
- In headless `claude -p` runs the follow-up turn after a command is best effort; send a follow-up prompt if none starts.
- The mod API is early access. v0.0.0 targets Claude Code 2.1.296 and must be re-validated on upgrades (`npm run check`).
- Monorepo detection, multi-repo, ticket/CI adapters, Verdi/UVM introspection: out of scope per SPEC §9.

## Acceptance criteria mapping

| AC | How v0.0.0 proves it |
|---|---|
| AC1 create TASK-001, map + 5 sourced findings | `/ewm new`, scouts, `mcp__ewm__record_finding` (path existence checked), `mcp__ewm__write_map`. Live e2e run. |
| AC2 discuss before implementing | Edit/Write denied before IMPLEMENT by `tool.call`; IMPLEMENT unreachable without a human approval. Mod tests + live run. |
| AC3 pause, close, resume intact | `/ewm pause` then `/ewm resume TASK-001` in a new process; phase, decisions, approvals, questions compared byte for byte. |
| AC4 cheap model did research, and which | `agent.spawn` hook records the resolved model id and the routed alias per spawn in `task.json.agent_usage`; `/ewm status` lists them by family. |
| AC5 validate a small change, handoff | `mcp__ewm__run_validation` runs an allowlisted command, records exit code and output tail; `/ewm approve` at VALIDATE writes `handoff.md`. |
| AC6 disallowed tool in EXPLORE is blocked without relying on prompts | `tool.call` guard with fail-closed `.catch`; shown under `--permission-mode acceptEdits`, where Claude Code itself would allow the edit. |
