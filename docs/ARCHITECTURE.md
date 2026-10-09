# Architecture and module contracts (v0.0.0)

This is the build contract. Every module's exported API is fixed here; workers
implement against it and may add internal helpers but must not change exported
signatures without updating this file. Decisions referenced as D# / F# are in
[SPEC-REVIEW.md](SPEC-REVIEW.md). Shared types are in `src/types.ts`.

## Layers

```
hooks/register.tsx     wiring only: events, commands, tools, pane, status line
   │  adapts $ to Io (src/io-engine.ts)
src/service.ts         use cases: commands + model tools + spawn/usage recording; serializes all writes
   │
src/controller.ts      FSM, gates, approvals (pure)
src/policies.ts        tool-call verdicts, Bash classifier (pure)
src/router.ts          model routing for subagents (pure)
src/render.ts          text, markdown, pane model, resume brief (pure)
src/store.ts           task store + gate ledger over Io (paths, ids, json, artifacts, audit)
src/profile.ts         profile load + YAML subset parser + defaults (over Io)
src/args.ts            /ewm argument parsing (pure)
src/types.ts           shared types + Io port
```

Rules for everything under `src/`:

- Runs inside the hooks environment: **no `node:*` imports, no npm packages, no ambient time in logic** (time comes from `io.now()` and is passed as ISO strings), no `import()`.
- Imports use explicit `.ts` suffixes and `import type` for types (`verbatimModuleSyntax`).
- Erasable TypeScript only (no enums, namespaces, parameter properties, decorators).
- Pure modules never touch `Io`. Functions that "change" a task return a new `Task` (no mutation of inputs).
- Errors that reach the person or model are `EwmError` with a clear, actionable message prefixed `ewm:`.
- ISO timestamps: `new Date(ms).toISOString()`.

Tests:

- `tests/unit/*.spec.ts`: `node:test` + `node:assert/strict`, run by `npm run test:unit`. Use `tests/support/memory-io.ts` for IO and `tests/support/fixtures.ts` for tasks/profiles.
- `tests/mod/*.test.ts`: `claude-code/testing`, run by `claude plugin test .` against the real engine. Mock `$.store` with `mock.store(on)`; answer `$.fs.*`, `$.process.run`, `$.clock.*` and every other `$` call the mod makes with test hooks backed by a `MemoryIo`.

## Trust model (D2, D13, D14)

The model can write files in IMPLEMENT, so nothing that gates the workflow may
be read from a file the model can write:

| Data | Source of truth | Written by |
|---|---|---|
| Active task pointer | ledger (`$.store`) | human commands only (`new`, `resume`, `pause`, `approve` at DONE) |
| Profile used by the guard and tools | ledger snapshot | human commands (`new`, `resume`) reload `.ewm/project.yaml` |
| Approvals | ledger | `/ewm approve`, `/ewm reject`, pane press (human origins only) |
| Validation runs that count for gates | ledger | `run_validation` (the mod executes the command itself) |
| Plan hash | recomputed from `task.plan` at check time | never trusted from the stored `hash` field |
| Everything else (findings, questions, decisions, plan, map, usage) | `task.json` | service |

`task.json` keeps copies of approvals and validations for humans; gate checks
use the ledger. The guard also denies write tools on `<root>/.ewm/**` in every
active phase, so the files are tamper-evident at worst, never a gate bypass.

## Workspace layout (runtime)

`root` is the absolute session working directory captured once at
`session.start` (`e.cwd`) and pinned for the session (held in a module variable
and re-read from `$.state` after a hot reload). Later `cd`s or worktree moves
do not change it. All `Io` paths are absolute (`joinPath(root, ...)`), and every
`io.run` passes `cwd: root`.

```
<root>/.ewm/
├── .gitignore          "tasks/\n" (written by ensureWorkspace)
├── project.yaml        optional profile (or project.json); read only by human commands
└── tasks/TASK-001/
    ├── task.json       the Task (pretty JSON, 2-space indent, trailing newline)
    ├── audit.jsonl     AuditEntry per line
    └── exploration.md system-map.md questions.md plan.md validation.md decisions.md handoff.md
$.store  "ledger:<root>" -> Ledger
```

## src/args.ts (pure)

```ts
/** Shell-like split: whitespace separates; '...' and "..." group; backslash escapes inside "..." and outside quotes. Throws EwmError('invalid_input') on an unterminated quote. */
export function splitArgs(input: string): string[]
export type EwmCommand =
  | { name: 'new'; title: string; goal?: string }        // /ewm new "title" [--goal "text"]
  | { name: 'resume'; id?: string }                       // /ewm resume [TASK-001]
  | { name: 'status' } | { name: 'map' } | { name: 'questions' } | { name: 'plan' }
  | { name: 'pause' } | { name: 'list' } | { name: 'help' }
  | { name: 'approve'; note?: string }                    // /ewm approve [note...]
  | { name: 'reject'; note: string }                      // /ewm reject <reason...>  (note required)
/** Empty input -> status. Unknown sub-command or bad args -> { error } including USAGE. Ids are upper-cased and validated with TASK_ID_PATTERN. */
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

/** Stable, order-sensitive hash (FNV-1a 32-bit hex over a canonical JSON of summary, steps[].text, steps[].files, risks, tests, alternatives). Step status is excluded. */
export function planHash(plan: Omit<Plan, 'hash' | 'updated_at'>): string

/** Whether `to` is reachable from task.phase by `actor` now. Rules:
 *  - edge must exist in EDGES (PAUSED/DONE/unknown -> not ok, explain);
 *  - -> IMPLEMENT: task.plan must exist with >= 1 step; if require_plan_approval, hasValidApproval(task,'plan_approval');
 *  - -> DONE: >= 1 entry in task.validations AND hasValidApproval(task,'done_acceptance');
 *  - reasons name the missing condition and the human action (e.g. "ask the person to run /ewm approve").
 *  The caller passes a task whose approvals/validations are the trusted (ledger) ones. */
export function checkTransition(task: Task, to: Phase, actor: Actor, profile: Profile): Check
/** Applies a checked transition: phase, transitions[] (+{from,to,actor,reason,at}), next_action (defaultNextAction), updated_at. Throws EwmError('invalid_transition' | 'gate_required'). */
export function transition(task: Task, to: Phase, actor: Actor, reason: string, at: string, profile: Profile): Task
/** ACTIVE -> PAUSED, sets paused_from, records transition. Throws if PAUSED or DONE. */
export function pause(task: Task, at: string, reason?: string): Task
/** PAUSED -> paused_from (records transition, clears paused_from). A non-PAUSED task is returned unchanged. */
export function resume(task: Task, at: string): Task
/** The gate a human could act on now, else null:
 *  PLAN with plan (>=1 step), require_plan_approval, no valid approval -> 'plan_approval';
 *  VALIDATE with >= 1 validation and no valid acceptance -> 'done_acceptance'. */
export function pendingGate(task: Task, profile: Profile): GateName | null
/** The latest approval record for the gate is 'approved'; for plan_approval its plan_hash must equal planHash(task.plan) RECOMPUTED now (never the stored task.plan.hash). */
export function hasValidApproval(task: Task, gate: GateName): boolean
/** Appends an Approval (by:'user', plan_hash = planHash(task.plan) for plan_approval). Throws EwmError('invalid_input') if gate !== pendingGate(task, profile). */
export function recordApproval(task: Task, gate: GateName, decision: 'approved' | 'rejected', via: 'command' | 'pane', at: string, profile: Profile, note?: string): Task
/** Default next_action sentence per phase (e.g. EXPLORE: "Delegate bounded searches to ewm scouts and record sourced findings."). */
export function defaultNextAction(phase: Phase): string
```

## src/profile.ts (over Io)

```ts
export const DEFAULT_PROFILE: Profile   // identical to makeProfile() in tests/support/fixtures.ts
/** YAML subset: '#' comments (full-line and trailing; '#' inside quotes is kept), `key: scalar`, `key: [a, "b c", 3]` flow lists, block lists (`- item`),
 *  nested maps by indentation (spaces only), scalars: single/double-quoted strings, true/false, null/~, integers, floats, bare strings.
 *  No anchors, tags, multi-line strings, or flow maps. Throws EwmError('parse_error', 'ewm: project.yaml line N: ...'). */
export function parseYamlSubset(text: string): unknown
/** Deep-merges raw over DEFAULT_PROFILE with type checks per field; wrong types or unknown enum values fall back to the default and add a warning naming the dotted field. Unknown keys warn, never error. */
export function normalizeProfile(raw: unknown): { profile: Profile; warnings: string[] }
/** Reads <root>/.ewm/project.yaml, else project.json, else DEFAULT_PROFILE (source null). Parse errors throw. */
export async function loadProfile(io: Io, root: string): Promise<{ profile: Profile; source: string | null; warnings: string[] }>
```

## src/store.ts (over Io)

```ts
export const EWM_DIR = '.ewm'
/** POSIX join that ignores empty parts and collapses duplicate slashes; keeps a leading '/'; never resolves '..' (callers validate ids instead). */
export function joinPath(...parts: string[]): string
export function taskDir(root: string, id: string): string           // throws EwmError('invalid_id') unless TASK_ID_PATTERN
/** Creates <root>/.ewm/.gitignore ("tasks/\n") when missing; leaves an existing one alone. */
export async function ensureWorkspace(io: Io, root: string): Promise<void>
/** TASK-001 when none; else max existing numeric id + 1, zero-padded to >= 3 digits. Ignores non-matching dir names. */
export async function nextTaskId(io: Io, root: string): Promise<string>
/** Pure constructor for a fresh INTAKE task (schema_version 1, empty collections, system_map null; next_action supplied by caller). */
export function createTask(input: { id: string; title: string; goal: string; profile_id: string; repo: Task['repo']; at: string; next_action: string }): Task
export async function loadTask(io: Io, root: string, id: string): Promise<Task>   // EwmError('not_found') when missing; 'parse_error' when corrupt
export async function saveTask(io: Io, root: string, task: Task): Promise<void>  // pretty JSON + '\n'
export async function listTasks(io: Io, root: string): Promise<TaskSummary[]>   // sorted by id; skips unreadable tasks
/** Writes an artifact file in the task dir (name must be in ARTIFACT_NAMES). Returns its absolute path. */
export async function writeArtifact(io: Io, root: string, id: string, name: ArtifactName, content: string): Promise<string>
export async function readArtifact(io: Io, root: string, id: string, name: ArtifactName): Promise<string | null>
/** Appends one JSON line (read + rewrite; Io has no append). Applies redactSecrets to detail. */
export async function appendAudit(io: Io, root: string, id: string, entry: AuditEntry): Promise<void>
/** Masks likely secrets: `KEY=value`/`"key": "value"` for names matching /(secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key)/i,
 *  bearer tokens, AWS access keys (AKIA...), GitHub tokens (gh[pousr]_...), sk-... keys, PEM private key blocks. Replacement: '[REDACTED]'. */
export function redactSecrets(text: string): string

// Gate ledger (D14), in Io.kvGet/kvSet under ledgerKey(root).
export function ledgerKey(root: string): string                       // "ledger:" + root
/** Missing -> { version: 1, root, active_task: null, tasks: {} }. Present but malformed -> EwmError('parse_error') (the guard then fails closed). */
export async function loadLedger(io: Io, root: string): Promise<Ledger>
export async function saveLedger(io: Io, root: string, ledger: Ledger): Promise<void>
/** Pure: returns a copy of the ledger with the task's entry created (from profile) or updated by fn. */
export function updateLedgerEntry(ledger: Ledger, id: string, fn: (entry: LedgerEntry) => LedgerEntry, init: { profile: Profile; profile_source: string | null }): Ledger
/** Pure: the task with approvals replaced by the ledger's and validations filtered to ledger ids with matching exit codes. Gate checks use this. */
export function trustedTask(task: Task, entry: LedgerEntry | undefined): Task
```

## src/policies.ts (pure)

```ts
export const WRITE_TOOLS: readonly string[]      // ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const SAFE_TOOLS: readonly string[]       // allowed in every active phase: ['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'Agent', 'Task',
                                                 //  'Skill', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'EnterPlanMode', 'ExitPlanMode', 'ListAgents']
export const OUTBOUND_TOOLS: readonly string[]   // denied under deny_by_default: ['WebFetch', 'WebSearch', 'Artifact', 'ArtifactData', 'ArtifactComments', 'SendFile',
                                                 //  'SendUserFile', 'SendMessage', 'PushNotification', 'RemoteTrigger', 'PublishPlugin', 'DesignSync']
export const ALWAYS_DENIED_TOOLS: readonly string[] // ['EnterWorktree', 'ExitWorktree'] (they move the session away from the pinned root)
export const OWN_TOOL_PREFIX = 'mcp__ewm__'
export const READONLY_OWN_TOOLS: readonly string[]  // ['mcp__ewm__status'] (the only own tool read-only agents may call)
export const READONLY_AGENT_TYPES: readonly string[] // ['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer']
export const NETWORK_PROGRAMS: readonly string[]     // ['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat']

export type BashClass = 'read_only' | 'validation' | 'destructive' | 'network' | 'other'
/** Classifies a shell command string. Quote-aware tokenizer (single quotes literal, double quotes with backslash escapes, backslash outside quotes);
 *  segments split on |, ||, &&, ;, & and newlines OUTSIDE quotes. Program names are taken by basename whatever the path.
 *  Wrappers are unwrapped before reading the program: env (with VAR=x and flags), command, exec, nohup, nice (-n N), time, timeout (opts + duration), xargs (opts), sudo, doas.
 *  git global options are skipped before the subcommand: -C <p>, -c <k=v>, --git-dir[=]<p>, --work-tree[=]<p>, --namespace[=]<n>, --no-pager, -P, --bare, --exec-path[=]<p>.
 *  `sh|bash|zsh|dash|ksh -c <str>` and `eval <args>` are classified recursively on <str>/<args> (depth <= 3; deeper -> 'other').
 *  Precedence: 'destructive' > 'network' > 'read_only' > 'validation' > 'other'.
 *  - 'destructive': any segment (after unwrapping) is git push | git reset --hard | git clean with -f/-d/-x (any spelling) | git checkout/restore with a pathspec '.'
 *     | rm with both recursive and force (any spelling: -rf, -fr, -r -f, -R, --recursive --force) | find with -delete | sudo/doas present | mkfs*, dd of=, shred.
 *  - 'network': any segment's program is in NETWORK_PROGRAMS, or is git fetch | pull | clone | ls-remote | submodule update | remote update.
 *  - 'read_only': EVERY segment is allowlisted, and the whole string has no unquoted `$`, backtick, `<` (any input redirection or <(/<<), `>` except exactly
 *     `2>/dev/null` or `2>&1`, no env assignments, no wrappers. Allowlist (program: argument rules):
 *       ls, cat, head, tail, wc, pwd, echo, printf, stat, du, df, which, type, basename, dirname, realpath, readlink, cut, tr, diff, cmp, comm, nl, column, true, false, test: any args
 *       grep, egrep, fgrep: any args;  rg: deny --pre*;  find: deny -exec*, -ok*, -delete, -fprint*, -fls;  tree: deny -o;  file: deny -C, --compile;
 *       sort: deny -o*, --output*, --compress-program*;  uniq: at most one positional argument;  jq: any args;
 *       git <sub> with sub in {status, log, diff, show, blame, ls-files, ls-tree, grep, rev-parse, describe, shortlog, cat-file}, denying for every git sub:
 *         --output*, -O*, --open-files-in-pager*, --ext-diff, --textconv, --exec*, --upload-pack*;
 *       git branch only with no positional args and flags in {-a, -r, -v, -vv, --list, -l, --show-current, --all, --remotes};
 *       git remote only bare or with -v; git tag only bare or -l/--list (no positional args); git config only with --get, --get-all or --list.
 *     (sed, awk, xargs, interpreters are NOT read_only.)
 *  - 'validation': not destructive/network, no shell metacharacters at all (| & ; < > $ ` newline \ quotes), and after whitespace normalization equals one of
 *     profile.validation.commands or starts with one followed by a space.
 *  - 'other': anything else, including unparseable input. */
export function classifyBash(command: string, profile: Profile): BashClass

export type PolicyContext = {
  /** Phase of the active task, or null when there is none. */
  phase: Phase | null
  profile: Profile
  /** Absolute pinned workspace root. */
  root: string
  /** Agent type of the calling loop when it is a subagent (from $.agent.list() by agentId), else null for the main loop. */
  agentType: string | null
}
export type PolicyCall = {
  tool: string
  input: Record<string, unknown>
  /** For WRITE_TOOLS: the absolute real path the call would write (resolved by the mod with $.fs.stat realPath, or the parent's realPath + name for a new file);
   *  undefined when it could not be resolved (then the raw file_path/notebook_path is checked, and an unresolvable path counts as inside .ewm -> deny). */
  resolvedPath?: string
}

/** The verdict for one tool call. Matrix (first match wins):
 *  1. phase null, PAUSED or DONE -> allow (inert, D8).
 *  2. agentType in READONLY_AGENT_TYPES: allow SAFE_TOOLS (except Skill and Agent), READONLY_OWN_TOOLS and Bash/Monitor classified 'read_only'; deny everything else (D7).
 *  3. tool starts with OWN_TOOL_PREFIX -> allow (the tools enforce their own rules).
 *  4. ALWAYS_DENIED_TOOLS -> deny.
 *  5. Skill whose input.skill is 'ewm' (the slash command, not 'ewm:<stage>' skills) -> deny: the model must not run /ewm commands.
 *  6. WRITE_TOOLS whose target is under <root>/.ewm/ (resolvedPath, else raw path containing a '.ewm' segment, else unresolvable) -> deny (D14).
 *  7. Bash or Monitor (input.command; Monitor with input.ws -> deny) : class 'destructive' -> deny; class 'network' under deny_by_default -> deny;
 *     text mentioning '.ewm' and class not 'read_only' -> deny (D14, best effort).
 *  8. OUTBOUND_TOOLS under deny_by_default -> deny; other `mcp__*` tools under deny_by_default unless allowed_mcp_tools matches (exact, or `prefix*`) -> deny (D6).
 *  9. Phase IMPLEMENT -> allow (Claude Code's own permissions still apply).
 * 10. Phases INTAKE/EXPLORE/UNDERSTAND/PLAN/VALIDATE (allowlist, F2, D4):
 *     SAFE_TOOLS -> allow; allowed mcp__* (rule 8 passed) -> allow;
 *     WRITE_TOOLS -> allow only in EXPLORE with allow_write_in_explore, else deny;
 *     Bash/Monitor -> allow 'read_only'; in VALIDATE also 'validation'; else deny;
 *     anything else -> deny "ewm: <tool> is not allowed in <PHASE>".
 *  Deny reasons start with "ewm: ", name the tool, the phase and the rule, and say how to proceed (e.g. "get the plan approved: ask the person to run /ewm approve",
 *  "use mcp__ewm__run_validation", "/ewm pause to work outside the workflow"). */
export function evaluateToolCall(ctx: PolicyContext, call: PolicyCall): ToolVerdict
```

## src/router.ts (pure)

```ts
export type Role = 'search' | 'reviewer' | 'lead'
export const AGENT_ROLES: Readonly<Record<string, Role>>  // 'ewm:repo-scout'->'search', 'ewm:docs-scout'->'search', 'ewm:reviewer'->'reviewer'
/** For ewm agent types: the profile's model for the role, always (cost discipline), rule 'profile.models.<role>'.
 *  For other types: { model: requested, rule: requested ? 'requested' : 'unrouted' } (untouched). */
export function routeModel(agentType: string, requested: string | undefined, profile: Profile): { model: string | undefined; rule: string }
/** 'haiku' | 'sonnet' | 'opus' | 'fable' when the id or alias contains that word (case-insensitive), else the input unchanged. */
export function modelFamily(model: string): string
/** "haiku (ewm:repo-scout x2)" lines: grouped by modelFamily(routed_model ?? model) then agent type, in first-seen order. */
export function summarizeModels(uses: readonly AgentUse[]): string[]
```

## src/render.ts (pure)

Render imports neither controller.ts nor router.ts: the caller passes gate state and model lines in.

```ts
export function formatEvidence(e: Evidence): string           // "src/a.ts:10-20", "src/a.ts:10", "docs/x.md#ADR-3", "README.md"
export function renderPhaseRail(phase: Phase, pausedFrom?: ActivePhase | null): string  // "Explore > [UNDERSTAND] > Plan > Build > Test" (+ " (paused)")
/** Computed by the caller (service): pendingGate/hasValidApproval on the trusted task, and summarizeModels(task.agent_usage). */
export type GateState = { pending: GateName | null; planApproved: boolean; models: string[] }
/** counts.components = task.system_map.components.length (0 when null); sources = distinct evidence paths; risks = plan risks; stale = stale findings.
 *  map_lines = text_map lines (else components); question_lines = open questions "Q-001 text"; models = gate.models. */
export function paneModel(task: Task, profile: Profile, gate: GateState): PaneModel
/** The text fallback of the pane (SPEC §2 panel as plain text, <= 20 lines): project, task, phase rail, counts, models, pending gate + how to act, next action. */
export function renderStatus(task: Task | null, profile: Profile, gate: GateState): string
export function renderTaskList(tasks: readonly TaskSummary[], activeId: string | null): string
export function renderExploration(task: Task): string  // findings: id, claim, confidence, source, evidence list, open questions, STALE marker
export function renderQuestions(task: Task): string
export function renderDecisions(task: Task): string    // goal, success criteria, constraints, decisions, approvals (gate, decision, via, at, note), transitions
export function renderPlan(task: Task, gate: GateState): string  // summary, steps with status + files, risks, tests, alternatives, approval state
export function renderValidation(task: Task): string   // each run: command, exit code, ok, duration, commit, output tail in a fenced block
/** system-map.md: heading, text map, components list, ```mermaid block; a placeholder line when task.system_map is null. */
export function renderSystemMap(task: Task): string
/** DONE handoff: summary, goal, success criteria, decisions, files changed (given), validations, open questions, follow-ups. */
export function renderHandoff(task: Task, changedFiles: readonly string[]): string
/** Resume brief readable in <= 60 s: <= 180 words. Where we were (phase), approved decisions, open questions (max 5), stale evidence, next action. */
export function renderResumeBrief(task: Task, staleness: Staleness): string
```

## src/service.ts (over Io)

```ts
export type Ctx = { io: Io; root: string }   // root is absolute
export const TOOL_SPECS: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
/** Parses and runs one /ewm command. `via` is 'pane' when invoked from a pane button. Never throws: EwmError becomes { text: message, changed: false }. */
export async function runCommand(ctx: Ctx, args: string, via: 'command' | 'pane'): Promise<CommandOutput>
/** Runs one model tool by short name (e.g. 'record_finding'). Never throws: errors become { ok: false, text }. */
export async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<ToolOutput>
/** For the policy guard. Reads the ledger first; returns { task: null, profile: DEFAULT_PROFILE } when no task is active WITHOUT touching any other file.
 *  With an active task: loads task.json and returns the ledger's profile snapshot. A malformed ledger or unreadable active task throws (the guard fails closed). */
export async function activeContext(ctx: Ctx): Promise<{ task: Task | null; profile: Profile }>
/** Records an agent spawn on the active task (no-op without one) and appends an audit line. */
export async function recordAgentSpawn(ctx: Ctx, use: { agent_type: string; model: string; routed_model?: string; agent_id?: string; description?: string; rule: string }): Promise<void>
/** Adds one turn's usage to usage_by_phase[task.phase] of the active task (no-op without one). */
export async function recordUsage(ctx: Ctx, usage: Partial<PhaseUsage>): Promise<void>
/** Records a denied tool call in the active task's audit log (no-op without one). */
export async function recordDenial(ctx: Ctx, tool: string, reason: string): Promise<void>
/** The pane model of the active task, or null. */
export async function currentView(ctx: Ctx): Promise<PaneModel | null>
/** Status-line text for the active running task ("ewm TASK-001 · EXPLORE · 2 open questions"), or null. */
export async function statusLine(ctx: Ctx): Promise<string | null>
```

Implementation rules:

- **Serialized writes**: every function that writes (commands, tools, spawn/usage/denial recording) runs inside one module-level async queue (`withLock`), so concurrent hooks (parallel scouts, `turn.complete`, denials, tool calls) never lose updates.
- **Trusted gating**: every gate check, `pendingGate`, `recordApproval` and gated `transition` runs on `trustedTask(task, ledgerEntry)` with the ledger's profile; approvals and validation runs are written to both the ledger and `task.json`.
- Every mutation: load task, apply, save task, re-render the affected artifacts (system-map.md from `task.system_map`, handoff.md only at DONE), append an audit entry.
- Git: run with `cwd: root`. Paths from `git status --porcelain` are top-level relative: strip the prefix from `git rev-parse --show-prefix`; use `git diff --name-only --relative`; parse renames (`R  a -> b` -> b); drop paths under `.ewm/`.

Command semantics (`runCommand`):

| Command | Behaviour |
|---|---|
| `new "title" [--goal g]` | ensureWorkspace; loadProfile (snapshot into the ledger); if another task is active and running, pause it first and say so; id = nextTaskId; repo = {root:'.', branch, base_commit} from `git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` (null when git fails); create task in INTAKE with goal (default = title); save; set ledger active_task; render artifacts; audit `task_created`. Output: status text + `kickoff` asking the lead to load skill `ewm:intake` for TASK-NNN; `openPane: true`. |
| `resume [id]` | id defaults to the ledger's active task, else the most recently updated non-DONE task. Load; reload profile into the ledger snapshot; staleness check (below); if PAUSED -> controller.resume; set active; save; render artifacts; audit `resume`. Output: renderResumeBrief + `context` [brief + "Do not repeat side-effecting operations; re-verify stale evidence before relying on it."] + `kickoff` to continue with the skill for the phase; `openPane: true`. |
| `status` | renderStatus of the active task (or "No active task" + list hint). `openPane: true`. |
| `map` | renderSystemMap + the artifact path. |
| `questions` | renderQuestions. |
| `plan` | UNDERSTAND -> transition to PLAN as user + kickoff `ewm:plan`; EXPLORE/INTAKE -> explain the path; PLAN or later -> renderPlan. |
| `pause` | controller.pause; save; render; audit `pause`. Keeps the active pointer. If the active task cannot be loaded, clears the pointer and says so. |
| `approve [note]` | pendingGate (trusted): plan_approval -> recordApproval + transition IMPLEMENT (actor user), kickoff `ewm:implement`; done_acceptance -> recordApproval + transition DONE + write handoff.md (changed files since base_commit, committed and uncommitted) + clear the active pointer. No pending gate -> explain what is missing. Audit `approval` + `transition`. |
| `reject <note>` | records a rejected approval for the pending gate (stays in phase); kickoff asks the lead to revise. |
| `list` | renderTaskList (clears a dangling active pointer). |
| `help` / parse error | USAGE. |

Staleness check (resume): current branch/HEAD via git. If git fails or the task has no base commit -> `checked:false`. Otherwise for each distinct `last_verified_commit` among non-stale findings run `git diff --name-only --relative <commit> HEAD`, plus `git status --porcelain` once; any finding whose evidence path is in the changed set becomes `stale: true`. Never re-run validations or other side effects.

Model tools (`runTool`; registered as `mcp__ewm__<name>`; every one requires an active, non-PAUSED, non-DONE task):

| Tool | Input | Rules |
|---|---|---|
| `status` | `{}` | renderStatus + JSON of {id, phase, pending_gate, open question ids, plan step ids, success_criteria}. |
| `set_intake` | `{goal?, success_criteria[], constraints[]}` | INTAKE through PLAN. Replaces the lists (1-20 items each for criteria; 0-20 constraints). Re-renders decisions.md. |
| `advance` | `{to, reason}` | controller.transition with actor 'model' on the trusted task. Gate failures return the reason (the model must ask the human). |
| `record_finding` | `{claim, evidence[{path,line_start?,line_end?,doc_id?,note?}], confidence, open_questions?[], source?}` | 1-20 evidence items; each path repo-relative (no leading '/', no '..' segment, not under .ewm/), must exist, line_start/line_end >= 1, ordered, <= the file's line count. Same claim text (case/space-insensitive) -> update instead of add. Stamps F-NNN, last_verified_commit (git rev-parse HEAD), recorded_at. Re-renders exploration.md. |
| `question` | `{action:'add', text}` or `{action:'resolve', id, answer}` | Q-NNN ids; re-renders questions.md. |
| `decision` | `{title, choice, rationale}` | D-NNN, decided_by 'model' (the lead records decisions the person stated); re-renders decisions.md. |
| `set_plan` | `{summary, steps[{text, files[]}], risks[], tests[], alternatives[]}` | Only in PLAN. 1-30 steps. Computes hash; replaces plan (step ids S-1..); re-renders plan.md. A changed plan invalidates a prior approval by construction. |
| `update_step` | `{id, status}` | Only in IMPLEMENT/VALIDATE. Re-renders plan.md. |
| `write_map` | `{mermaid, text_map, components[]}` | mermaid 1-20000 chars; sets task.system_map; writes system-map.md. |
| `run_validation` | `{command}` | Only in VALIDATE. classifyBash must be 'validation' (exact allowlist). Splits with splitArgs, runs via io.run (no shell, cwd root) with the profile timeout; records ValidationRun (output tail <= 4000 chars, redacted) in task.json and the ledger; re-renders validation.md; audit `validation_run`. |

## src/io-engine.ts (hooks environment only)

```ts
import type { EngineInterface } from 'claude-code'
/** Adapts $ to Io: fs.read/write/exists/list, process.run (cwd, timeoutMs), clock.now, store.get/set. */
export function engineIo($: EngineInterface): Io
```

## hooks/register.tsx (wiring)

- `session.start`: pin `root` from `e.cwd` (absolute; keep it in `$.state` so a hot reload keeps it). Register `/ewm` (`argumentHint: '<new|resume|status|map|questions|plan|pause|approve|reject|list|help> [args]'`) and the model tools from `TOOL_SPECS` with `isDeferred` = no active running task (D8). If a task is active and running, set the status line and pane view. Never throw out of session.start.
- `command.run {command:'ewm'}`: `approve`/`reject` are accepted only when `e.origin.kind` is `composer`, `bridge` or `sdk` (D13); otherwise refuse with a reason. Call `runCommand`; after a change refresh view, status line and tool deferral (re-register the tools with the new `isDeferred`; registering a name again replaces it); open the pane when `openPane` (fine when not placed: the text output is the fallback). Queue `kickoff` AFTER the command returns: `$.clock.after(0, () => void $.prompt.submit({ text: kickoff }))` (the host refuses `$.prompt.submit` inside a `command.run` hook). Return `{ text, context }`.
- `tool.call {tool:'mcp__ewm__<name>'}`: `runTool` -> `{ result: text, text }`, or the error as an error result; refresh view and status line after a change.
- `tool.call` (all tools) guard: check the `mcp__ewm__` prefix and the read-only-agent rule without file access first where possible; otherwise `activeContext` + agent type from `$.agent.list()` by `e.agentId` + resolved write path (`$.fs.stat(path, { resolve: true }).realPath`, or the parent's realPath + name) -> `evaluateToolCall`; on deny return `{ deny: reason }` and `recordDenial`. Registered with the fail-closed `.catch(($, e, next) => next.called ? next(e) : { deny: 'ewm: policy guard failed; denied to stay safe' })`. Inert (no file reads beyond the ledger) without an active running task.
- `agent.spawn`: for `ewm:*` types, `routeModel` (rewrite `e.model`) and, when `$.agent.list()` exposes running state, deny an (N+1)th concurrent ewm scout where N = `budgets.max_parallel_researchers`; `await next(e)`; then `recordAgentSpawn` with the resolved `model`, the `routed_model` and `agentId`. Refresh view.
- `turn.complete`: `recordUsage` from the turn's usage when present.
- Pane: `$.ui.open({ id: 'ewm', title: 'Engineering Workflow' })`; `ui.render {component:'Pane', requestId:'ewm'}` draws `PaneModel` from `$.state` (`ewm.view`, `ewm.section`, `ewm.notice`): header, rail, counts, models, next action, and buttons `Map`, `Questions`, `Overview`, `Approve` (only with a pending gate; a press is a human origin). Approve calls `runCommand(ctx, 'approve', 'pane')`. Works on `terminal` and `desktop`.
- Status line: `$.ui.status(statusLine)` after every change; cleared when no task is running.

## Plugin content

- `agents/repo-scout.md` (model: haiku; tools: Read, Grep, Glob), `agents/docs-scout.md` (haiku; Read, Grep, Glob), `agents/reviewer.md` (sonnet; Read, Grep, Glob, Bash). Each returns at most N findings in the evidence format (claim, evidence path:line, confidence, open questions) and never edits.
- `skills/{intake,explore,understand,plan,implement,validate}/SKILL.md`: the stage contract from SPEC §4, which `mcp__ewm__*` tools to use (load them with ToolSearch `select:mcp__ewm__status,mcp__ewm__advance,...` if they are not loaded), delegation rules (<= 3 concurrent scouts, bounded asks, structured outputs, dedupe, verify before recording; the Agent tool may run scouts in the background, wait for their results), gates (never implement before approval; ask the human to run `/ewm approve`), and the exit condition for the stage.
- `schemas/project.schema.json`, `schemas/task.schema.json`: JSON Schema (draft 2020-12) mirroring `Profile` and `Task`.
