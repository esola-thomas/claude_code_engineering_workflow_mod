# Architecture and module contracts (v0.0.0)

This is the build contract. Every module's exported API is fixed here; workers
implement against it and may add internal helpers but must not change exported
signatures without updating this file. Decisions referenced as D# / F# are in
[SPEC-REVIEW.md](SPEC-REVIEW.md). Shared types are in `src/types.ts`.

## Layers

```
hooks/register.tsx     wiring only: events, commands, tools, pane, status line
   │  adapts $ to Io (src/io-engine.ts)
src/service.ts         use cases: commands + model tools + spawn/usage recording
   │
src/controller.ts      FSM, gates, approvals (pure)
src/policies.ts        tool-call verdicts, Bash classifier (pure)
src/router.ts          model routing for subagents (pure)
src/render.ts          text, markdown, pane model, resume brief (pure)
src/store.ts           task store over Io (paths, ids, json, artifacts, audit)
src/profile.ts         profile load + YAML subset parser + defaults (over Io)
src/args.ts            /ewm argument parsing (pure)
src/types.ts           shared types + Io port
```

Rules for everything under `src/`:

- Runs inside the hooks environment: **no `node:*` imports, no npm packages, no `Date.now()`-style ambient time in logic** (time comes from `io.now()` and is passed as ISO strings), no `import()`.
- Imports use explicit `.ts` suffixes and `import type` for types (`verbatimModuleSyntax`).
- Erasable TypeScript only (no enums, namespaces, parameter properties, decorators).
- Pure modules never touch `Io`. Functions that "change" a task return a new `Task` (no mutation of inputs).
- Errors that reach the person or model are `EwmError` with a clear, actionable message prefixed `ewm:`.
- ISO timestamps: `new Date(ms).toISOString()`.

Tests:

- `tests/unit/*.spec.ts`: `node:test` + `node:assert/strict`, run by `npm run test:unit`. Use `tests/support/memory-io.ts` for IO.
- `tests/mod/*.test.ts`: `claude-code/testing`, run by `claude plugin test .` against the real engine. Mock `$.store` with `mock.store(on)`; answer `$.fs.*` and `$.process.run` with test hooks (`on('fs.read', ...)`, `on('process.run', ...)`) backed by a `MemoryIo`.

## Workspace layout (runtime)

```
<workspace>/.ewm/
├── .gitignore          "tasks/\nstate.json\n" (written by ensureWorkspace)
├── project.yaml        optional profile (or project.json)
├── state.json          {"active_task": "TASK-001" | null}
└── tasks/TASK-001/
    ├── task.json       the Task (pretty JSON, 2-space indent, trailing newline)
    ├── audit.jsonl     AuditEntry per line
    └── exploration.md system-map.md questions.md plan.md validation.md decisions.md handoff.md
```

Paths passed to `Io` are workspace-relative (`root` joined with POSIX `/`). `root` is the session's working directory.

## src/args.ts (pure)

```ts
/** Shell-like split: whitespace separates; '...' and "..." group; backslash escapes inside "...". Throws EwmError('invalid_input') on an unterminated quote. */
export function splitArgs(input: string): string[]
export type EwmCommand =
  | { name: 'new'; title: string; goal?: string }        // /ewm new "title" [--goal "text"]
  | { name: 'resume'; id?: string }                       // /ewm resume [TASK-001]
  | { name: 'status' } | { name: 'map' } | { name: 'questions' } | { name: 'plan' }
  | { name: 'pause' } | { name: 'list' } | { name: 'help' }
  | { name: 'approve'; note?: string }                    // /ewm approve [note...]
  | { name: 'reject'; note: string }                      // /ewm reject <reason...>  (note required)
/** Empty input -> status. Unknown sub-command or bad args -> { error } with usage text. Ids are upper-cased and validated with TASK_ID_PATTERN. */
export function parseCommand(input: string): EwmCommand | { error: string }
export const USAGE: string   // one line per command
```

## src/controller.ts (pure)

Phase graph (F1, D2). `PAUSED` and `DONE` are not in the edge table; pause/resume are separate.

```
INTAKE -> EXPLORE
EXPLORE -> UNDERSTAND
UNDERSTAND -> EXPLORE | PLAN
PLAN -> UNDERSTAND | IMPLEMENT*          * gate plan_approval (if profile.policies.require_plan_approval)
IMPLEMENT -> VALIDATE
VALIDATE -> IMPLEMENT | PLAN | DONE*     * gate done_acceptance (always)
any ACTIVE_PHASE -> PAUSED (pause), PAUSED -> paused_from (resume)
```

```ts
export const EDGES: Readonly<Record<ActivePhase, readonly Phase[]>>
export type Check = { ok: true } | { ok: false; reason: string }

/** Stable, order-sensitive hash (e.g. FNV-1a 32-bit hex over a canonical JSON of summary, steps[].text, steps[].files, risks, tests, alternatives). Step status is excluded. */
export function planHash(plan: Omit<Plan, 'hash' | 'updated_at'>): string

/** Whether `to` is reachable from task.phase by `actor` now. Rules:
 *  - edge must exist in EDGES (PAUSED/DONE/unknown -> not ok, explain);
 *  - -> IMPLEMENT: task.plan must exist with >= 1 step; if require_plan_approval, hasValidApproval(task,'plan_approval');
 *  - -> DONE: >= 1 validation run AND hasValidApproval(task,'done_acceptance');
 *  - reasons name the missing condition and the human action (e.g. "run /ewm approve"). */
export function checkTransition(task: Task, to: Phase, actor: Actor, profile: Profile): Check
/** Applies a checked transition: phase, transitions[] (+{from,to,actor,reason,at}), next_action (defaultNextAction), updated_at. Throws EwmError('invalid_transition' | 'gate_required'). */
export function transition(task: Task, to: Phase, actor: Actor, reason: string, at: string, profile: Profile): Task
/** ACTIVE -> PAUSED, sets paused_from, records transition. Throws if PAUSED or DONE. */
export function pause(task: Task, at: string, reason?: string): Task
/** PAUSED -> paused_from (records transition, clears paused_from). A non-PAUSED task is returned unchanged. */
export function resume(task: Task, at: string): Task
/** The gate a human could act on now, else null:
 *  PLAN with plan (>=1 step), require_plan_approval, no valid approval -> 'plan_approval';
 *  VALIDATE with >= 1 validation run and no valid acceptance -> 'done_acceptance'. */
export function pendingGate(task: Task, profile: Profile): GateName | null
/** Latest approval record for the gate is 'approved' (and, for plan_approval, plan_hash === task.plan?.hash). */
export function hasValidApproval(task: Task, gate: GateName): boolean
/** Appends an Approval (by:'user'). Throws EwmError('invalid_input') if gate !== pendingGate(task, profile). */
export function recordApproval(task: Task, gate: GateName, decision: 'approved' | 'rejected', via: 'command' | 'pane', at: string, profile: Profile, note?: string): Task
/** Default next_action sentence per phase (e.g. EXPLORE: "Delegate bounded searches to ewm scouts and record sourced findings."). */
export function defaultNextAction(phase: Phase): string
```

## src/profile.ts (over Io)

```ts
export const DEFAULT_PROFILE: Profile   // profile_id 'default', name 'Default', repositories ['.'], domains [], entrypoints ['README.md','docs/'],
                                        // policies {external_network:'deny_by_default', require_plan_approval:true, allow_write_in_explore:false, allowed_mcp_tools:[]},
                                        // models {lead:'opus', search:'haiku', reviewer:'sonnet'},
                                        // budgets {max_parallel_researchers:3, max_research_rounds_without_user_update:2, max_findings_per_scout:8},
                                        // validation {commands:[], timeout_ms:300000}
/** YAML subset: '#' comments, `key: scalar`, `key: [a, "b c", 3]` flow lists, block lists (`- item`), nested maps by indentation (spaces only),
 *  scalars: single/double-quoted strings, true/false, null/~, integers, floats, bare strings. No anchors, tags, multi-line strings, or flow maps.
 *  Throws EwmError('parse_error', 'ewm: project.yaml line N: ...'). */
export function parseYamlSubset(text: string): unknown
/** Deep-merges raw over DEFAULT_PROFILE with type checks per field; wrong types or unknown enum values fall back to the default and add a warning naming the field. Unknown keys produce a warning, not an error. */
export function normalizeProfile(raw: unknown): { profile: Profile; warnings: string[] }
/** Reads .ewm/project.yaml, else .ewm/project.json, else DEFAULT_PROFILE (source null). Parse errors throw. */
export async function loadProfile(io: Io, root: string): Promise<{ profile: Profile; source: string | null; warnings: string[] }>
```

## src/store.ts (over Io)

```ts
export const EWM_DIR = '.ewm'
/** POSIX join that ignores empty parts and collapses duplicate slashes; never resolves '..' (callers validate ids instead). */
export function joinPath(...parts: string[]): string
export function taskDir(root: string, id: string): string           // throws EwmError('invalid_id') unless TASK_ID_PATTERN
/** Creates .ewm/.gitignore ("tasks/\nstate.json\n") when missing; leaves an existing one alone. */
export async function ensureWorkspace(io: Io, root: string): Promise<void>
/** TASK-001 when none; else max existing numeric id + 1, zero-padded to >= 3 digits. Ignores non-matching dir names. */
export async function nextTaskId(io: Io, root: string): Promise<string>
/** Pure constructor for a fresh INTAKE task (schema_version 1, empty collections, next_action = defaultNextAction('INTAKE') supplied by caller). */
export function createTask(input: { id: string; title: string; goal: string; profile_id: string; repo: Task['repo']; at: string; next_action: string }): Task
export async function loadTask(io: Io, root: string, id: string): Promise<Task>   // EwmError('not_found') when missing; 'parse_error' when corrupt
export async function saveTask(io: Io, root: string, task: Task): Promise<void>  // pretty JSON + '\n'
export async function listTasks(io: Io, root: string): Promise<TaskSummary[]>   // sorted by id; skips unreadable tasks
export async function getActiveTaskId(io: Io, root: string): Promise<string | null>  // missing/corrupt state.json -> null
export async function setActiveTaskId(io: Io, root: string, id: string | null): Promise<void>
/** Writes an artifact file in the task dir. Returns its workspace-relative path. */
export async function writeArtifact(io: Io, root: string, id: string, name: ArtifactName, content: string): Promise<string>
export async function readArtifact(io: Io, root: string, id: string, name: ArtifactName): Promise<string | null>
/** Appends one JSON line (read + rewrite; Io has no append). Applies redactSecrets to detail. */
export async function appendAudit(io: Io, root: string, id: string, entry: AuditEntry): Promise<void>
/** Masks likely secrets: `KEY=value`/`"token": "..."` for names matching /(secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key)/i,
 *  bearer tokens, AWS access keys (AKIA...), GitHub tokens (gh[pousr]_...), sk-... keys, PEM private key blocks. Replacement: '[REDACTED]'. */
export function redactSecrets(text: string): string
```

## src/policies.ts (pure)

```ts
export const WRITE_TOOLS: readonly string[]     // ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const NETWORK_TOOLS: readonly string[]   // ['WebFetch', 'WebSearch']
export const OWN_TOOL_PREFIX = 'mcp__ewm__'
export const READONLY_AGENT_TYPES: readonly string[]  // ['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer']

export type BashClass = 'read_only' | 'validation' | 'destructive' | 'other'
/** Classifies a shell command string.
 *  - 'destructive': any segment is `git push`, `git reset --hard`, `git clean` (with -f/-d/-x), `rm` with both -r and -f (any flag spelling: -rf, -fr, -r -f, --recursive --force), or `sudo`.
 *  - 'read_only': every segment (split on |, &&, ||, ; outside quotes) has an allowlisted argv0 with allowed args, and there is no output redirection
 *     (>, >>, except `2>/dev/null` and `2>&1`), no `$(`, backtick, `<(`, `>(`, here-doc, or newline-separated commands.
 *     Allowlist: ls, cat, head, tail, wc, grep, egrep, fgrep, rg, find (deny -exec, -execdir, -ok, -okdir, -delete, -fprint*, -fls), tree, pwd, echo, printf,
 *     file, stat, du, df, which, type, basename, dirname, realpath, readlink, sort, uniq, cut, tr, diff, cmp, comm, jq, nl, column, true, false, test,
 *     sed only with -n and without -i/--in-place/w commands, git with subcommand in {status, log, diff, show, blame, ls-files, ls-tree, grep, rev-parse,
 *     describe, shortlog, cat-file, branch (no -d/-D/-m/-M/-c/-C/--delete/--move/--copy), remote (only `-v` or no args), tag (list only: no args or -l/--list), config (--get/--list only)}.
 *  - 'validation': not read_only/destructive, contains no shell metacharacters (| & ; < > $ ` newline), and equals or starts with (followed by a space) one of
 *     profile.validation.commands after whitespace normalization.
 *  - 'other': anything else (including unparseable input). */
export function classifyBash(command: string, profile: Profile): BashClass

export type PolicyContext = {
  /** Phase of the active task, or null when there is none. */
  phase: Phase | null
  profile: Profile
  /** Agent type of the calling loop when it is a subagent we know (from agent_usage), else null. */
  agentType: string | null
}

/** The verdict for one tool call. Matrix (first match wins):
 *  1. phase null, PAUSED or DONE -> allow (inert, D8).
 *  2. tool starts with OWN_TOOL_PREFIX -> allow (the tools enforce their own rules).
 *  3. Bash classified 'destructive' -> deny (D5) in every active phase.
 *  4. NETWORK_TOOLS when external_network is 'deny_by_default' -> deny (D6).
 *  5. other `mcp__*` tools under 'deny_by_default' unless matched by allowed_mcp_tools (exact or `prefix*`) -> deny (D6).
 *  6. agentType in READONLY_AGENT_TYPES: WRITE_TOOLS deny; Bash allowed only if 'read_only' (D7).
 *  7. WRITE_TOOLS: allow in IMPLEMENT; allow in EXPLORE only if allow_write_in_explore; otherwise deny (F2).
 *  8. Bash: INTAKE/EXPLORE/UNDERSTAND/PLAN -> only 'read_only'; VALIDATE -> 'read_only' or 'validation'; IMPLEMENT -> allow (Claude Code permissions still apply).
 *  9. everything else -> allow.
 *  Deny reasons start with "ewm: ", name the phase and the rule, and say how to proceed (e.g. "get the plan approved with /ewm approve", "/ewm pause to work outside the workflow"). */
export function evaluateToolCall(ctx: PolicyContext, call: { tool: string; input: Record<string, unknown> }): ToolVerdict
```

## src/router.ts (pure)

```ts
export type Role = 'search' | 'reviewer' | 'lead'
export const AGENT_ROLES: Readonly<Record<string, Role>>  // 'ewm:repo-scout'->'search', 'ewm:docs-scout'->'search', 'ewm:reviewer'->'reviewer'
/** For ewm agent types: the profile's model for the role, always (cost discipline), rule 'profile.models.<role>'.
 *  For other types: { model: requested, rule: requested ? 'requested' : 'unrouted' } (untouched). */
export function routeModel(agentType: string, requested: string | undefined, profile: Profile): { model: string | undefined; rule: string }
/** "haiku (ewm:repo-scout x2)" lines grouped by model then agent type, in first-seen order. */
export function summarizeModels(uses: readonly AgentUse[]): string[]
```

## src/render.ts (pure)

```ts
export function formatEvidence(e: Evidence): string           // "src/a.ts:10-20", "src/a.ts:10", "docs/x.md#ADR-3", "README.md"
export function renderPhaseRail(phase: Phase, pausedFrom?: ActivePhase | null): string  // "Explore > [UNDERSTAND] > Plan > Build > Test" (+ " (paused)")
export function paneModel(task: Task, profile: Profile, mapText: string | null): PaneModel  // see PaneModel; counts.components from map component lines,
                                                                                           // sources = distinct evidence paths, risks = plan risks
/** The text fallback of the pane (SPEC §2 panel as plain text, <= 20 lines): project, task, phase rail, counts, models, pending gate + how to act, next action. */
export function renderStatus(task: Task | null, profile: Profile, mapText: string | null): string
export function renderTaskList(tasks: readonly TaskSummary[], activeId: string | null): string
export function renderExploration(task: Task): string  // findings: id, claim, confidence, evidence list, open questions, STALE marker
export function renderQuestions(task: Task): string
export function renderDecisions(task: Task): string    // decisions, approvals (gate, decision, via, at, note), transitions
export function renderPlan(task: Task): string         // summary, steps with status + files, risks, tests, alternatives, approval state
export function renderValidation(task: Task): string   // each run: command, exit code, ok, duration, commit, output tail in a fenced block
/** system-map.md: title, optional text map, ```mermaid block. */
export function renderSystemMap(task: Task, input: { mermaid: string; text_map: string; components: string[] }): string
/** DONE handoff: summary, success criteria, decisions, files changed (given), validations, open questions, follow-ups. */
export function renderHandoff(task: Task, changedFiles: readonly string[]): string
/** Resume brief readable in <= 60 s: <= 180 words. Where we were (phase), approved decisions, open questions (max 5), stale evidence, next action. */
export function renderResumeBrief(task: Task, staleness: Staleness): string
```

## src/service.ts (over Io)

```ts
export type Ctx = { io: Io; root: string }
export const TOOL_SPECS: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
/** Parses and runs one /ewm command. `via` is 'pane' when invoked from a pane button. Never throws: EwmError becomes { text: message, changed: false }. */
export async function runCommand(ctx: Ctx, args: string, via: 'command' | 'pane'): Promise<CommandOutput>
/** Runs one model tool by short name (e.g. 'record_finding'). Never throws: errors become { ok: false, text }. */
export async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<ToolOutput>
/** Active task + profile for the policy guard; { task: null } when none. Cheap: one state read + one task read + profile read. */
export async function activeContext(ctx: Ctx): Promise<{ task: Task | null; profile: Profile }>
/** Records an agent spawn on the active task (no-op without one) and appends an audit line. */
export async function recordAgentSpawn(ctx: Ctx, use: { agent_type: string; model: string; agent_id?: string; description?: string; rule: string }): Promise<void>
/** Adds one turn's usage to usage_by_phase[task.phase] of the active task (no-op without one). */
export async function recordUsage(ctx: Ctx, usage: Partial<PhaseUsage>): Promise<void>
/** Records a denied tool call in the active task's audit log. */
export async function recordDenial(ctx: Ctx, tool: string, reason: string): Promise<void>
/** The pane model of the active task, or null. */
export async function currentView(ctx: Ctx): Promise<PaneModel | null>
```

Command semantics (`runCommand`):

| Command | Behaviour |
|---|---|
| `new "title" [--goal g]` | ensureWorkspace; load profile; if an active task is running, pause it first (checkpoint) and say so; id = nextTaskId; repo = {root:'.', branch, base_commit} from `git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` (null if git fails); create task in INTAKE with goal (default = title); save; set active; render all artifacts; audit `task_created`. Output: status text + `kickoff` prompt telling the lead to load skill `ewm:intake` for TASK-NNN; `openPane: true`. |
| `resume [id]` | id defaults to the active task, else the most recently updated non-DONE task. Load; staleness check (below); if PAUSED -> controller.resume; set active; save; render artifacts; audit `resume`. Output: renderResumeBrief + `context` [brief + "Do not repeat side-effecting operations; re-verify stale evidence before relying on it."] + `kickoff` to continue with the skill for the phase; `openPane: true`. |
| `status` | renderStatus of the active task (or "No active task" + list hint). `openPane: true`. |
| `map` | system-map.md content if present, else the text map from findings; plus its path. |
| `questions` | open questions list (renderQuestions). |
| `plan` | UNDERSTAND (or EXPLORE) -> transition to PLAN as user (EXPLORE->PLAN is not an edge: say so); in PLAN or later: show renderPlan. Kickoff `ewm:plan` on transition. |
| `pause` | controller.pause; save; render artifacts; audit `pause`. Keeps the active pointer. Output says how to resume. |
| `approve [note]` | pendingGate: plan_approval -> recordApproval + transition IMPLEMENT (actor user), kickoff `ewm:implement`; done_acceptance -> recordApproval + transition DONE + write handoff.md (changed files from `git diff --name-only <base_commit>` + `git status --porcelain`) + clear active pointer. No pending gate -> explain what is missing. Audit `approval` + `transition`. |
| `reject <note>` | records a rejected approval for the pending gate (stays in phase); kickoff asks the lead to revise. |
| `list` | renderTaskList. |
| `help` / parse error | USAGE. |

Staleness check (resume): read current branch/HEAD via git. If git fails or the task has no base commit -> `checked:false`. Otherwise for each distinct `last_verified_commit` among non-stale findings run `git diff --name-only <commit> HEAD`, plus `git status --porcelain` once; any finding whose evidence path is in the changed set becomes `stale: true`. Never re-run validations or other side effects.

Model tools (`runTool`; registered as `mcp__ewm__<name>`; every one requires an active, non-PAUSED, non-DONE task):

| Tool | Input | Rules |
|---|---|---|
| `status` | `{}` | Returns renderStatus + JSON of {id, phase, pending_gate, open question ids, plan step ids}. |
| `advance` | `{to, reason}` | controller.transition with actor 'model'. Gate failures return the reason (the model must ask the human). |
| `record_finding` | `{claim, evidence[{path,line_start?,line_end?,doc_id?,note?}], confidence, open_questions?[], source?}` | Not in DONE. 1-20 evidence items; each path must be repo-relative (no leading '/', no '..'), must exist (`io.exists`), and line_start/line_end must be >= 1, ordered, and <= the file's line count. Dedupe: same claim text (case/space-insensitive) -> update instead of add. Stamps id F-NNN, last_verified_commit (git rev-parse HEAD), recorded_at. Re-renders exploration.md. |
| `question` | `{action:'add', text}` or `{action:'resolve', id, answer}` | Q-NNN ids; re-renders questions.md. |
| `decision` | `{title, choice, rationale}` | D-NNN, decided_by 'model' (the lead records decisions the user stated); re-renders decisions.md. |
| `set_plan` | `{summary, steps[{text, files[]}], risks[], tests[], alternatives[]}` | Only in PLAN. 1-30 steps. Computes hash; replaces plan (step ids S-1..); re-renders plan.md. A changed hash invalidates a prior plan approval (by construction). |
| `update_step` | `{id, status}` | Only in IMPLEMENT/VALIDATE. Re-renders plan.md. |
| `write_map` | `{mermaid, text_map, components[]}` | Not in DONE. mermaid 1-20000 chars; writes system-map.md; adds to artifacts. |
| `run_validation` | `{command}` | Only in VALIDATE. classifyBash must be 'validation' (exact allowlist). Splits with splitArgs, runs via io.run (no shell) with profile timeout; records ValidationRun (output tail <= 4000 chars, redacted); re-renders validation.md; audit `validation_run`. |

## src/io-engine.ts (hooks environment only)

```ts
import type { EngineInterface } from 'claude-code'
/** Adapts $ to Io: fs.read/write/exists/list, process.run (timeoutMs), clock.now. */
export function engineIo($: EngineInterface): Io
```

## hooks/register.tsx (wiring)

- `session.start`: register `/ewm` (`argumentHint: '<new|resume|status|map|questions|plan|pause|approve|reject|list|help> [args]'`) and the model tools from `TOOL_SPECS`; if an active running task exists, set the status line and pane view. Never throw out of session.start.
- `command.run {command:'ewm'}`: `approve`/`reject` only when `e.origin.kind` is `composer`, `bridge` or `sdk` (D13); otherwise refuse with a reason. Call `runCommand`; refresh view/status when `changed`; open the pane when `openPane` (fall back silently when not placed); queue `kickoff` via `$.prompt.submit`. Return `{ text, context }`.
- `tool.call {tool:'mcp__ewm__<name>'}`: `runTool` -> `{ result: text, text }`, or the error as an error result.
- `tool.call` (all tools) guard: `activeContext` + agent type lookup by `e.agentId` (from the active task's `agent_usage`) -> `evaluateToolCall`; on deny return `{ deny: reason }` and `recordDenial`. Registered with the fail-closed `.catch(($, e, next) => next.called ? next(e) : { deny: 'ewm: policy guard failed; denied to stay safe' })`. The guard must never block `mcp__ewm__*` tools and must be inert without an active running task.
- `agent.spawn`: `routeModel` for `ewm:*` types (rewrite `e.model`), `await next(e)`, then `recordAgentSpawn` with the resolved `model` and `agentId`.
- `turn.complete`: `recordUsage` from the turn's usage when present.
- `tool.describe` (or registration-time `isDeferred`): model tools are non-deferred while a task is active and deferred otherwise (D8).
- Pane: `$.ui.open({ id: 'ewm', title: 'Engineering Workflow' })`; `ui.render {component:'Pane', requestId:'ewm'}` draws `PaneModel` from `$.state` (`ewm.view`, `ewm.section`, `ewm.notice`): header, rail, counts, models, next action, and buttons `Map`, `Questions`, `Approve` (only with a pending gate). Approve calls `runCommand(ctx, 'approve', 'pane')`. Works on `terminal` and `desktop`.
- Status line: `$.ui.status('ewm TASK-001 · EXPLORE · 2 open questions')` while a task is active; cleared otherwise.

## Plugin content

- `agents/repo-scout.md` (model: haiku; tools: Read, Grep, Glob), `agents/docs-scout.md` (haiku; Read, Grep, Glob), `agents/reviewer.md` (sonnet; Read, Grep, Glob, Bash). Each returns at most `max_findings_per_scout` findings in the evidence format (claim, evidence path:line, confidence, open questions) and never edits.
- `skills/{intake,explore,understand,plan,implement,validate}/SKILL.md`: the stage contract from SPEC §4, which `mcp__ewm__*` tools to use, delegation rules (<= 3 concurrent scouts, bounded asks, structured outputs, dedupe, verify before recording), gates (never implement before approval; ask the human to run `/ewm approve`), and the exit condition for the stage.
- `schemas/project.schema.json`, `schemas/task.schema.json`: JSON Schema (draft 2020-12) mirroring `Profile` and `Task`.
