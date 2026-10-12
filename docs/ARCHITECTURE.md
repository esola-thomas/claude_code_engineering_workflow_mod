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
src/graph.ts           Mermaid flowchart subset: parse, lay out, draw as text or SVG (pure)
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
- Errors that reach the person or model are `EwmError` with a clear, actionable message prefixed `ewm:` exactly once (`types.unprefixed` removes a prefix a message already carries before it is wrapped in another).
- ISO timestamps: `new Date(ms).toISOString()`.

Tests:

- `tests/unit/*.spec.ts`: `node:test` + `node:assert/strict`, run by `npm run test:unit`. Use `tests/support/memory-io.ts` for IO and `tests/support/fixtures.ts` for tasks/profiles.
- `tests/mod/*.test.ts`: `claude-code/testing`, run by `claude plugin test .` against the real engine. Mock `$.store` with `mock.store(on)`; answer `$.fs.*`, `$.process.run`, `$.clock.*` and every other `$` call the mod makes with test hooks backed by a `MemoryIo`.

## Trust model (D2, D13, D14)

The model can write files in IMPLEMENT, so nothing that gates the workflow may
be read from a file the model can write:

| Data | Source of truth | Written by |
|---|---|---|
| Active task pointer, phase and resume target (`phase`, `paused_from`) | ledger (`$.store`) | human commands and the service's own transitions (CR5); `task.json` mirrors them |
| Profile used by the guard and tools | ledger snapshot | human commands (`new`, `resume`) reload `.ewm/project.yaml` |
| Approvals | ledger | `/ewm approve`, `/ewm reject`, pane press (human origins only) |
| Validation runs that count for gates (id, exit code, `ok`, `at`, command) | ledger | `run_validation` (the mod executes the command itself) |
| When the task last entered VALIDATE (`validating_since`, F5) | ledger | the service, on every saved phase change |
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
  | { name: 'pause' } | { name: 'reset' } | { name: 'list' } | { name: 'help' }  // reset: back up the gate ledger and start an empty one (F2)
  | { name: 'approve'; note?: string; plan?: string }     // /ewm approve [--plan <hash>] [note...]  (plan: lower-case hex prefix, 8-64 digits)
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

/** Stable, order-sensitive hash (CR8: SHA-256 hex, 64 characters, over a canonical JSON of summary, steps[].text, steps[].files, risks, tests, alternatives). Step status is excluded. */
export function planHash(plan: Omit<Plan, 'hash' | 'updated_at'>): string

/** Whether `to` is reachable from task.phase by `actor` now. Rules:
 *  - edge must exist in EDGES (PAUSED/DONE/unknown -> not ok, explain);
 *  - -> IMPLEMENT: task.plan must exist with >= 1 step; if require_plan_approval, hasValidApproval(task,'plan_approval');
 *  - -> DONE: >= 1 passing entry in task.validations recorded since the ledger's `validating_since` (CR9, F5) AND hasValidApproval(task,'done_acceptance');
 *  - UNDERSTAND -> PLAN: actor must be 'user' (CR10; the model gets a gate_required reason naming /ewm plan);
 *  - reasons name the missing condition and the human action (e.g. "ask the person to run /ewm approve").
 *  The caller passes a task whose approvals/validations are the trusted (ledger) ones. */
export function checkTransition(task: TrustedTask, to: Phase, actor: Actor, profile: Profile): Check
/** Applies a checked transition: phase, transitions[] (+{from,to,actor,reason,at}), next_action (defaultNextAction), updated_at. Throws EwmError('invalid_transition' | 'gate_required'). */
export function transition(task: TrustedTask, to: Phase, actor: Actor, reason: string, at: string, profile: Profile): Task
/** ACTIVE -> PAUSED, sets paused_from, records transition. Throws if PAUSED or DONE. */
export function pause(task: Task, at: string, reason?: string): Task
/** PAUSED -> paused_from (records transition, clears paused_from). A non-PAUSED task is returned unchanged.
 *  With `profile` (the service always passes it, on the trusted task), a target of IMPLEMENT or VALIDATE is clamped to PLAN unless the plan gate is
 *  satisfied now (a plan with steps and, when required, a valid approval), so a forged resume target cannot skip plan_approval (CR5). */
export function resume(task: TrustedTask, at: string, profile?: Profile): Task
/** CR9, F5: the runs that can back an acceptance: ok and recorded at or after `task.validating_since`, the ledger's time of the latest entry into VALIDATE
 *  (carried by `store.trustedTask`; `task.transitions` is NOT read). No `validating_since` (an older ledger, a plain task) -> [] (fail closed). */
export function freshValidations(task: TrustedTask): ValidationRun[]
/** The gate a human could act on now, else null:
 *  PLAN with plan (>=1 step), require_plan_approval, no valid approval -> 'plan_approval';
 *  VALIDATE with >= 1 freshValidations and no valid acceptance -> 'done_acceptance'. */
export function pendingGate(task: TrustedTask, profile: Profile): GateName | null
/** The latest approval record for the gate is 'approved'; for plan_approval its plan_hash must equal planHash(task.plan) RECOMPUTED now (never the stored task.plan.hash). */
export function hasValidApproval(task: Task, gate: GateName): boolean
/** Appends an Approval (by:'user', plan_hash = planHash(task.plan) for plan_approval). Throws EwmError('invalid_input') if gate !== pendingGate(task, profile). */
export function recordApproval(task: TrustedTask, gate: GateName, decision: 'approved' | 'rejected', via: 'command' | 'pane', at: string, profile: Profile, note?: string): Task
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
/** TASK-001 when none; else max(existing task dirs, ids in `ledger.tasks`) + 1, zero-padded to >= 3 digits (CR7). Ignores non-matching dir names. */
export async function nextTaskId(io: Io, root: string, ledger?: Ledger): Promise<string>
/** Pure constructor for a fresh INTAKE task (schema_version 1, empty collections, system_map null; next_action supplied by caller). */
export function createTask(input: { id: string; title: string; goal: string; profile_id: string; repo: Task['repo']; at: string; next_action: string }): Task
export async function loadTask(io: Io, root: string, id: string): Promise<Task>   // EwmError('not_found') when missing; 'parse_error' when corrupt AND task.json.bak cannot stand in (CR13)
/** Like loadTask, but says whether the task came from task.json.bak so the caller can audit it (CR13). */
export async function loadTaskRecovering(io: Io, root: string, id: string): Promise<{ task: Task; recovered: boolean }>
export async function saveTask(io: Io, root: string, task: Task): Promise<void>  // pretty JSON + '\n'; first copies the previous task.json, if it is a valid task, to task.json.bak (CR13)
export async function listTasks(io: Io, root: string): Promise<TaskSummary[]>   // sorted by id; skips unreadable tasks
/** Writes an artifact file in the task dir (name must be in ARTIFACT_NAMES). Returns its absolute path. */
export async function writeArtifact(io: Io, root: string, id: string, name: ArtifactName, content: string): Promise<string>
export async function readArtifact(io: Io, root: string, id: string, name: ArtifactName): Promise<string | null>
/** Appends one JSON line (read + rewrite; Io has no append). Applies redactSecrets to detail. A log of >= 1 MiB first moves to audit.1.jsonl (CR13). */
export async function appendAudit(io: Io, root: string, id: string, entry: AuditEntry): Promise<void>
/** Masks likely secrets (CR19): `KEY=value`, `KEY: value`, `"key": "value"` and `--flag value` for names matching /(secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key)/i
 *  ("author" excluded for the spaced forms); Authorization/Proxy-Authorization (scheme word kept), Cookie, Set-Cookie and API-key headers; bearer tokens; URL userinfo passwords;
 *  AWS (AKIA...), GitHub (gh[pousr]_...), GitLab (glpat-), npm (npm_), Slack (xox?-), Stripe (sk_live_), Google (AIza) and sk-... keys; JWTs; PEM private key blocks.
 *  Replacement: '[REDACTED]'. Idempotent. */
export function redactSecrets(text: string): string

// Gate ledger (D14), in Io.kvGet/kvSet under ledgerKey(root).
export function ledgerKey(root: string): string                       // "ledger:" + root
/** Missing -> { version: 1, root, active_task: null, tasks: {} }. Present but malformed -> EwmError('parse_error') (the guard then fails closed); its message sends the person to /ewm reset (F2).
 *  An entry's `validating_since`, when present, must be a string or null. */
export async function loadLedger(io: Io, root: string): Promise<Ledger>
export async function saveLedger(io: Io, root: string, ledger: Ledger): Promise<void>
/** A fresh entry: phase (default INTAKE), paused_from null, no approvals, no validations, a private copy of the profile. */
export function createLedgerEntry(init: { profile: Profile; profile_source: string | null }, phase?: Phase): LedgerEntry
/** Pure: returns a copy of the ledger with the task's entry created (createLedgerEntry) or updated by fn. */
export function updateLedgerEntry(ledger: Ledger, id: string, fn: (entry: LedgerEntry) => LedgerEntry, init: { profile: Profile; profile_source: string | null }): Ledger
/** Pure: the task as the mod trusts it (CR5, CR9). `phase`/`paused_from` come from the ledger entry, approvals are the ledger's, validations are kept only for ledger ids with
 *  matching exit codes and take `ok`, `at` and `command` from the ledger. Without an entry nothing is approved and phase/paused_from are clamped to PLAN at most. Gate checks use this.
 *  `ledgerKey`-stored entries now require `phase` and `paused_from`; a ledger whose `active_task` has no entry is malformed (the guard fails closed).
 *  Returns a `TrustedTask` (types.ts): `validating_since` (F5) is the ledger entry's value, never task.json's (a key of that name in task.json is dropped); no entry, or an older entry without it, yields none. */
export function trustedTask(task: Task, entry: LedgerEntry | undefined): TrustedTask
/** Pure. A ledger for `root` with no active task and no entries. */
export function emptyLedger(root: string): Ledger
/** F2, the recovery path behind /ewm reset. Writes the raw value stored under ledgerKey(root) (whatever kvGet returns, even malformed; nothing -> "null") to
 *  <root>/.ewm/ledger-backup-<`at` with ':' replaced by '-'>.json, THEN stores emptyLedger(root); when the backup cannot be written the ledger is left as it was.
 *  `at` is an ISO time. Task files are untouched. Returns the backup's absolute path. */
export async function resetLedger(io: Io, root: string, at: string): Promise<{ backup: string }>
```

## src/policies.ts (pure)

```ts
export const WRITE_TOOLS: readonly string[]      // ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const SAFE_TOOLS: readonly string[]       // allowed in every active phase: ['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'Agent', 'Task',
                                                 //  'Skill', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
                                                 //  'EnterPlanMode', 'ExitPlanMode', 'ListAgents']
export const NETWORK_READ_TOOLS: readonly string[] // ['WebFetch', 'WebSearch']: allowed in every active phase when external_network is 'allow'
export const OUTBOUND_TOOLS: readonly string[]   // denied under deny_by_default: ['WebFetch', 'WebSearch', 'Artifact', 'ArtifactData', 'ArtifactComments', 'SendFile',
                                                 //  'SendUserFile', 'SendMessage', 'PushNotification', 'RemoteTrigger', 'PublishPlugin', 'DesignSync']
export const ALWAYS_DENIED_TOOLS: readonly string[] // ['EnterWorktree', 'ExitWorktree'] (they move the session away from the pinned root)
export const OWN_TOOL_PREFIX = 'mcp__ewm__'
export const READONLY_OWN_TOOLS: readonly string[]  // ['mcp__ewm__status'] (the only own tool read-only agents may call)
export const READONLY_AGENT_TYPES: readonly string[] // ['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer']
export const NETWORK_PROGRAMS: readonly string[]     // ['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'socat'] + (CR18) ['ping', 'dig', 'nslookup', 'host', 'whois',
                                                     //  'traceroute', 'mtr', 'tftp', 'lftp', 'aria2c', 'http', 'https', 'gh', 'ssh-keyscan', 'ssh-copy-id']

export type BashClass = 'read_only' | 'validation' | 'destructive' | 'network' | 'other'
/** Classifies a shell command string. Quote-aware tokenizer (single quotes literal, double quotes with backslash escapes, backslash outside quotes);
 *  segments split on |, ||, &&, ;, & and newlines OUTSIDE quotes. Program names are taken by basename whatever the path.
 *  Wrappers are unwrapped before reading the program: env (with VAR=x and flags), command, exec, nohup, nice (-n N), time, timeout (opts + duration), xargs (opts), sudo, doas.
 *  git global options are skipped before the subcommand: -C <p>, -c <k=v>, --git-dir[=]<p>, --work-tree[=]<p>, --namespace[=]<n>, --no-pager, -P, --bare, --exec-path[=]<p>.
 *  `sh|bash|zsh|dash|ksh -c <str>` and `eval <args>` are classified recursively on <str>/<args> (depth <= 3; deeper -> 'other').
 *  Precedence: 'destructive' > 'network' > 'read_only' > 'validation' > 'other'.
 *  - 'destructive': any segment (after unwrapping) is git push | git reset --hard | git clean with -f/-d/-x (any spelling) | git checkout/restore with a pathspec '.'
 *     | rm with both recursive and force (any spelling: -rf, -fr, -r -f, -R, --recursive --force) | find with -delete | sudo/doas present | mkfs*, dd of=, shred.
 *  - 'network': any segment's program is in NETWORK_PROGRAMS, or is git fetch | pull | clone | ls-remote | fetch-pack | send-pack | http-fetch | http-push | imap-send | send-email | svn
 *     | submodule update | submodule add | remote update.
 *  - CR18, payloads: `git submodule foreach <cmd>` is classified on <cmd>; `git -c alias.<x>=<v> <x>` on <v> (a `!` alias is a shell command line, any other alias a git command line,
 *     chains followed up to 5 hops; git ignores an alias named like a built-in, so the built-in is inspected too); `git -c core.sshCommand|core.pager|core.fsmonitor|core.editor|core.askpass|
 *     diff.external|sequence.editor|gpg.program=<v>` on <v>.
 *  - 'read_only': EVERY segment is allowlisted, and the whole string has no unquoted `$`, backtick, `<` (any input redirection or <(/<<), `>` except exactly
 *     `2>/dev/null` or `2>&1`, no env assignments, no wrappers. Allowlist (program: argument rules):
 *       ls, cat, head, tail, wc, pwd, echo, printf, stat, du, df, which, type, basename, dirname, realpath, readlink, cut, tr, diff, cmp, comm, nl, column, true, false, test: any args
 *       grep, egrep, fgrep: any args;  rg: deny --pre*;  find: deny -exec*, -ok*, -delete, -fprint*, -fls;  tree: deny -o and -R (CR18: -R writes 00Tree.html files);  file: deny -C, --compile;
 *       sort: deny -o*, --output*, --compress-program*;  uniq: at most one positional argument;  jq: any args;
 *       git <sub> with sub in {status, log, diff, show, blame, ls-files, ls-tree, grep, rev-parse, describe, shortlog, cat-file}, denying for every git sub:
 *         --output*, -O*, --open-files-in-pager*, --ext-diff, --textconv, --exec*, --upload-pack*;
 *       git branch only with no positional args and flags in {-a, -r, -v, -vv, --list, -l, --show-current, --all, --remotes};
 *       git remote only bare or with -v; git tag only bare or -l/--list (no positional args); git config only with --get, --get-all or --list.
 *     (sed, awk, xargs, interpreters are NOT read_only.)
 *  - 'validation': not destructive/network, no shell metacharacters at all (| & ; < > $ ` newline \ quotes), and after whitespace normalization EQUALS one of
 *     profile.validation.commands (CR11: no extra arguments; `npm test --help` exits 0 without testing). The service does not depend on this class: run_validation checks
 *     exact membership itself, so an entry that classifies read_only or network is still runnable there; the class only lets a VALIDATE Bash call through the guard.
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
 *     text mentioning '.ewm' and class not 'read_only' -> deny (D14, best effort). "Mentioning" includes building the name: the text with quotes, backslashes, `+`
 *     and `,` removed (`'.e'+'wm'`, `.e""wm`), an unquoted glob or brace group that can match `.ewm` (`.e*m`, `.e?m`, `.{e,x}wm`; a leading wildcard never matches the dot),
 *     a word mixing an expansion with literal text that fits inside `.ewm` (`${d}wm`, `.e$x`), an assignment of `.e`, `.ew`, `ew`, `ewm` or `wm`, and `dotglob`.
 *     Still best effort: a script written to a file and run later evades it; the ledger keeps the gates intact regardless (D14, CR5).
 *  8. OUTBOUND_TOOLS under deny_by_default -> deny; other `mcp__*` tools under deny_by_default unless allowed_mcp_tools matches (exact, or `prefix*`) -> deny (D6).
 *  9. Phase IMPLEMENT -> allow (Claude Code's own permissions still apply).
 * 10. Phases INTAKE/EXPLORE/UNDERSTAND/PLAN/VALIDATE (allowlist, F2, D4):
 *     SAFE_TOOLS -> allow; NETWORK_READ_TOOLS when external_network is 'allow' -> allow; mcp__* only when allowed_mcp_tools lists it, whatever external_network says (CR12);
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
/** "haiku [claude-haiku-5-5] (ewm:repo-scout x2)" lines (CR16): grouped by the family of the RESOLVED model (`model`, else `routed_model`) then agent type, in first-seen order;
 *  the resolved id is shown in brackets unless it equals the family alias; a resolved family different from the routed one adds " - asked for <routed_model>". */
export function summarizeModels(uses: readonly AgentUse[]): string[]
```

## src/graph.ts (pure)

Mermaid is not available in the hooks environment (no DOM, no npm), and no surface renders it. The system map is a strict subset of
Mermaid's flowchart syntax that this module parses, lays out and draws itself, so the same source reads the same in system-map.md
(real Mermaid, for GitHub and other viewers), in the terminal (box-drawing text) and on desktop, VS Code and mobile (SVG).

Subset: `flowchart|graph [TD|TB|BT|LR|RL]`; node shapes `[] () ([]) [[]] [()] (()) {} {{}} >] [/ /]`; quoted or plain labels (`<br>` becomes a
space, other tags are dropped, `#quot;` and `#NN;` decode); edges `--> --- -.-> -.- ==> ===` with `<`, `o`, `x` ends, longer variants,
`|label|` and `-- label -->` / `-. label .->` / `== label ==>` forms, `~~~` (kept for layout, not drawn); `A & B --> C & D` chains; `;` separators;
`subgraph id [label]` / `subgraph "label"` ... `end`; `%%` comments and directives; YAML front matter. `classDef`, `class`, `style`, `linkStyle`,
`click`, `direction`, `accTitle`, `accDescr` are accepted and ignored. Other diagram types are refused with a message naming the fix.

```ts
export type Graph = { direction: Direction; nodes: GraphNode[]; edges: GraphEdge[]; subgraphs: Subgraph[] }
/** Errors carry 1-based line and column; at most 8; a node (300) or edge (600) limit stops the parse. */
export function parseFlowchart(source: string): { ok: true; graph: Graph } | { ok: false; errors: ParseError[] }
export function formatParseErrors(errors: readonly ParseError[]): string   // "line 3, column 5: ...; ..."
/** "a --calls--> b" per edge (Mermaid's spelling), then "x (no links)", then "Group g: a, b": the fallback list and the SVG alt text. */
export function adjacencyLines(graph: Graph): string[]
/** Layered layout on a cell grid: DFS cycle breaking, longest-path ranks (sources pulled next to their first successor), dummy nodes on long
 *  edges, barycenter sweeps keeping subgraph members together (best crossing count wins), ports spread per side, orthogonal routing with one
 *  track per bent segment in each channel, edge labels on the first run (LR) or beside the line (TD, else listed as unplaced). BT and RL mirror. */
export function layoutGraph(graph: Graph, options: { direction: Direction; labelWidth: number; ascii: boolean }): Layout
/** Text lines that fit `columns`: the declared direction, then the other axis, then narrower labels; null when nothing fits or the graph has
 *  more than MAX_DRAWN_NODES (80) nodes. Unplaced labels and self-loops are listed under the drawing; stale nodes (marks) get a heavy box and a legend. */
export function drawText(graph: Graph, options?: { columns?: number; ascii?: boolean; marks?: Record<string, NodeMark> }): string[] | null
export function undrawnNote(graph: Graph, columns: number): string   // why drawText returned null
/** A standalone SVG (light and dark through prefers-color-scheme, node tooltips from marks, dashed subgraph frames); every label is XML-escaped.
 *  Null when the graph is empty, has more than 80 nodes, or the markup exceeds MAX_SVG_CHARS (131072, the Svg element's limit). */
export function drawSvg(graph: Graph, options?: { marks?: Record<string, NodeMark>; title?: string }): string | null
/** Markdown split into plain runs and ```mermaid (or ~~~mermaid) fenced blocks; other fences are copied whole, an unclosed fence stays text. */
export function splitMermaid(markdown: string): DocSegment[]
```

## src/render.ts (pure)

Render imports neither controller.ts nor router.ts: the caller passes gate state and model lines in.

```ts
export function formatEvidence(e: Evidence): string           // "src/a.ts:10-20", "src/a.ts:10", "docs/x.md#ADR-3", "README.md"
export function renderPhaseRail(phase: Phase, pausedFrom?: ActivePhase | null): string  // "Explore > [UNDERSTAND] > Plan > Build > Test" (+ " (paused)")
/** Computed by the caller (service): pendingGate/hasValidApproval on the trusted task, and summarizeModels(task.agent_usage).
 *  `plan` is set only while plan_approval is pending: the plan the person is asked to approve (hash = full SHA-256). */
export type GateState = { pending: GateName | null; planApproved: boolean; models: string[]; plan?: { hash: string; steps: number; summary: string } | null }
/** ANSI/OSC sequences and C0/C1 control characters except \n and \t are removed from everything shown (CR16); `document()` applies it to every markdown artifact. */
export function stripControls(text: string): string
/** First 8 characters of a plan hash: what the person is shown and may type after `/ewm approve --plan`. */
export function shortHash(hash: string): string
/** F3: the next action shown in status, pane and resume brief: while `gate.pending` is 'plan_approval' "Review the plan and run /ewm approve (or /ewm reject <reason>)",
 *  while 'done_acceptance' "Review the validation results and run /ewm approve to accept closure (or /ewm reject <reason>)", else the stored task.next_action (which is never rewritten). */
export function nextActionOf(task: Task, gate?: GateState): string
/** counts.components = task.system_map.components.length (0 when null); sources = distinct evidence paths; risks = plan risks; stale = stale findings.
 *  map_lines = text_map lines (else the parsed diagram's adjacencyLines, else components); map_marks = mapMarks(task);
 *  docs = { map: renderMapView, plan: renderPlan, questions: renderQuestions, findings: renderExploration }, each cut at 30000 characters
 *  with a line naming the file; question_lines = open questions "Q-001 text"; models = gate.models; plan = gate.plan while pending_gate is 'plan_approval', else null
 *  (PaneModel.plan = { hash (full), steps, summary }). All model-written text is stripped of control characters. */
export function paneModel(task: Task, profile: Profile, gate: GateState): PaneModel
/** The text fallback of the pane (SPEC §2 panel as plain text, <= 20 lines): project, task, phase rail, counts, models, pending gate + how to act, next action. */
export function renderStatus(task: Task | null, profile: Profile, gate: GateState): string
export function renderTaskList(tasks: readonly TaskSummary[], activeId: string | null): string
export function renderExploration(task: Task): string  // findings: id, claim, confidence, source, evidence list, open questions, STALE marker
export function renderQuestions(task: Task): string
export function renderDecisions(task: Task): string    // goal, success criteria, constraints, decisions, approvals (gate, decision, via, at, note), transitions
export function renderPlan(task: Task, gate: GateState): string  // summary, steps with status + files, risks, tests, alternatives, approval state
export function renderValidation(task: Task): string   // each run: command, exit code, ok, duration, commit, output tail in a fenced block
/** system-map.md: heading, text map, links (adjacencyLines of the parsed diagram), components list, ```mermaid block; a placeholder line when task.system_map is null. */
export function renderSystemMap(task: Task): string
/** The stored diagram parsed, or null (no map, or a map saved before write_map checked the source). */
export function mapGraph(task: Task): Graph | null
/** Node overlays: a node whose id or label names a finding's evidence path (whole path) gets the findings in `note`, and `stale` when one is stale. */
export function mapMarks(task: Task): Record<string, NodeMark>
/** The pane's Map section: the ```mermaid fence first (drawn by the pane), then notes, links and components. A source that does not parse is shown as text. */
export function renderMapView(task: Task): string
/** /ewm map: title, the drawing sized to `columns` (with stale marks), else the links with undrawnNote; then notes, components and `File: <path>`. */
export function renderMapText(task: Task, columns: number, file: string): string
/** DONE handoff: summary, goal, success criteria, decisions, files changed (given), validations, open questions, follow-ups. */
export function renderHandoff(task: Task, changedFiles: readonly string[]): string   // Summary includes "Diff review: ..." from the ewm:reviewer spawns in agent_usage (CR15)
/** Resume brief readable in <= 60 s: <= 180 words. Where we were (phase), approved gates, decisions, open questions (max 5), stale evidence, next action.
 *  "Approved gates" comes from the trusted `gate` (gate.planApproved), never from task.json's approvals; without `gate` the brief claims none (CR16). */
export function renderResumeBrief(task: Task, staleness: Staleness, gate?: GateState): string
```

## src/service.ts (over Io)

```ts
export type Ctx = { io: Io; root: string }   // root is absolute
export const TOOL_SPECS: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
/** Parses and runs one /ewm command. `via` is 'pane' when invoked from a pane button. Never throws: EwmError becomes { text: message, changed: false }. */
export async function runCommand(ctx: Ctx, args: string, via: 'command' | 'pane', options?: { columns?: number }): Promise<CommandOutput>  // columns: the terminal width for /ewm map (80 when absent)
/** Runs one model tool by short name (e.g. 'record_finding'). Never throws: errors become { ok: false, text }. */
export async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<ToolOutput>
/** For the policy guard (F1). Reads the ledger first; returns { task: null, profile: DEFAULT_PROFILE, phase: null } when no task is active WITHOUT touching any other file.
 *  With an active task `phase` is the LEDGER phase and `profile` the ledger's snapshot; `task` is task.json (or task.json.bak when it is corrupt) with the ledger's phase/paused_from,
 *  or null when it cannot be read (deleted by `git clean -fdx`, corrupt without a usable backup). The guard enforces `phase` either way (inert only when phase is null, PAUSED or DONE).
 *  A malformed ledger throws EwmError('parse_error') whose message names /ewm reset; the guard then denies with that message (fail closed). */
export async function activeContext(ctx: Ctx): Promise<{ task: Task | null; profile: Profile; phase: Phase | null }>
/** The active task id per the ledger, or null (throws on a malformed ledger). The guard names it when the task's files are missing. */
export async function activeTaskId(ctx: Ctx): Promise<string | null>
/** Records an agent spawn on the active task (no-op without one) and appends an audit line. */
export async function recordAgentSpawn(ctx: Ctx, use: { agent_type: string; model: string; routed_model?: string; agent_id?: string; description?: string; rule: string }): Promise<void>
/** Adds one turn's usage to usage_by_phase[task.phase] of the active task (no-op without one). */
export async function recordUsage(ctx: Ctx, usage: Partial<PhaseUsage>): Promise<void>
/** Records a denied tool call in the active task's audit log (no-op without one). */
export async function recordDenial(ctx: Ctx, tool: string, reason: string): Promise<void>
/** The pane model of the active task, or null. */
export async function currentView(ctx: Ctx): Promise<PaneModel | null>
/** Status-line text for the active running task ("ewm TASK-001 · PLAN · 2 open questions · awaiting /ewm approve", the last part only while a gate is pending on the trusted task), or null. */
export async function statusLine(ctx: Ctx): Promise<string | null>
```

Implementation rules:

- **Persistence order (CR5, CR13)**: a mutation saves the ledger first (it is the authority; its entry's `phase`/`paused_from` mirror the saved task), then `task.json` (previous copy to `task.json.bak`), then the artifacts and the audit lines, which are best effort: their failure never fails the mutation (an `error` audit line is attempted).
- **Phase source**: `loadActive` returns the task with the ledger's `phase`/`paused_from`; `activeContext`, the guard, `statusLine` and every tool therefore ignore edits of those fields in task.json, and the next write repairs the mirror.
- **Serialized writes**: every function that writes (commands, tools, spawn/usage/denial recording) runs inside one module-level async queue (`withLock`), so concurrent hooks (parallel scouts, `turn.complete`, denials, tool calls) never lose updates.
- **Trusted gating**: every gate check, `pendingGate`, `recordApproval` and gated `transition` runs on `trustedTask(task, ledgerEntry)` with the ledger's profile; approvals and validation runs are written to both the ledger and `task.json`.
- Every mutation: load task, apply, save task, re-render the affected artifacts (system-map.md from `task.system_map`, handoff.md only at DONE), append an audit entry (model-tool writes use kind `tool_effect` with the tool name and a one-line summary).
- Git: run with `cwd: root`. Paths from `git status --porcelain` are top-level relative: strip the prefix from `git rev-parse --show-prefix`; use `git diff --name-only --relative`; parse renames (`R  a -> b` -> b); drop paths under `.ewm/`.

Command semantics (`runCommand`):

| Command | Behaviour |
|---|---|
| `new "title" [--goal g]` | ensureWorkspace; loadProfile (snapshot into the ledger); if another task is active and running, pause it first and say so; id = nextTaskId; repo = {root:'.', branch, base_commit} from `git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` (null when git fails); create task in INTAKE with goal (default = title); save; set ledger active_task; render artifacts; audit `task_created`. Output: status text + `kickoff` asking the lead to load skill `ewm:intake` for TASK-NNN; `openPane: true`. |
| `resume [id]` | id defaults to the ledger's active task, else the most recently updated non-DONE task. Load; reload profile into the ledger snapshot; staleness check (below); if PAUSED -> controller.resume(trusted task, at, profile) (phase and target from the ledger, clamped to PLAN without a valid plan approval); the reply lists, visibly, every profile field that differs from the previous snapshot; set active; save; render artifacts; audit `resume`. Output: renderResumeBrief + `context` [brief + "Do not repeat side-effecting operations; re-verify stale evidence before relying on it."] + `kickoff` to continue with the skill for the phase; `openPane: true`. F2: a task with NO ledger entry (after `/ewm reset`) is read from task.json: its entry is created with approvals and validations EMPTY (task.json's copies are not trusted), its phase capped at PLAN (IMPLEMENT/VALIDATE -> PLAN; PAUSED -> its `paused_from` capped the same way); a DONE task is refused. A transition `{actor:'system', reason:'ledger reset: gates must be approved again'}` is recorded (it replaces the wording of the PAUSED -> target transition `resume` records) and the reply and `context` say so. |
| `status` | renderStatus of the active task (or "No active task" + list hint). `openPane: true`. |
| `map` | renderSystemMap + the artifact path. |
| `questions` | renderQuestions. |
| `plan` | UNDERSTAND -> transition to PLAN as user + kickoff `ewm:plan` (the only way into PLAN from UNDERSTAND, CR10); EXPLORE/INTAKE -> explain the path; PLAN or later -> renderPlan. |
| `reset` | F2, human origins only. The recovery path for a malformed ledger, or a fresh start: ensureWorkspace; `resetLedger` (backup of the raw ledger value to `<root>/.ewm/ledger-backup-<ISO time, ':' -> '-'>.json`, then an empty ledger: no active task). Task files are untouched. Output: where the backup is, which tasks are on disk, that gates must be approved again; `changed: true`. |
| `pause` | controller.pause; save; render; audit `pause`. Keeps the active pointer. If the active task cannot be loaded, clears the pointer and says so. |
| `approve [--plan <hash>] [note]` | pendingGate (trusted): plan_approval -> recordApproval + transition IMPLEMENT (actor user), kickoff `ewm:implement`; the reply echoes "(hash <8>, N steps, updated <plan.updated_at>)"; with `--plan` the command is refused when the plan hash does not start with the given prefix (the pane's Approve button always sends the full hash of the plan it drew, CR16); done_acceptance -> recordApproval + transition DONE + write handoff.md (changed files since base_commit, committed and uncommitted) + clear the active pointer. No pending gate -> explain what is missing. Audit `approval` + `transition`. |
| `reject <note>` | records a rejected approval for the pending gate (stays in phase); kickoff asks the lead to revise. |
| `status` (F1) | When the ledger names an active task whose files cannot be read, the reply says so, that the guard still enforces the ledger phase, and the two ways out: `/ewm list` (deactivates it) and `/ewm new` (start over). |
| `list` | renderTaskList (clears a dangling active pointer). |
| `help` / parse error | USAGE. |

Staleness check (resume): current branch/HEAD via git. If git fails or the task has no base commit -> `checked:false`. Otherwise for each distinct `last_verified_commit` among non-stale findings run `git -c core.quotepath=off diff --name-only --no-renames -z --relative <commit> HEAD`, plus `git -c core.quotepath=off status --porcelain -z` once (a rename counts both names); any finding whose evidence path is in the changed set (a directory evidence path matches files beneath it) becomes `stale: true`. Evidence recorded with a `fingerprint` (`git hash-object` of the file at record time) is compared by content instead, so a file that was already dirty is not stale until it changes. Never re-run validations or other side effects.

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
| `run_validation` | `{command}` | Only in VALIDATE. CR11: the whitespace-normalized command must equal a `profile.validation.commands` entry exactly, contain no shell syntax (`| & ; < > $` backtick, quotes, backslash) and not classify destructive or network (it need not classify 'validation': `git diff --check` is allowed). The recorded command is redacted. Entries that can never run are listed as warnings by `/ewm new` and `/ewm resume`. Splits with splitArgs, runs via io.run (no shell, cwd root) with the profile timeout; records ValidationRun (output tail <= 4000 chars, redacted) in task.json and the ledger; re-renders validation.md; audit `validation_run`. |

## src/io-engine.ts (hooks environment only)

```ts
/** The slice of $ the adapter needs, as plain functions. The engine refuses a hooks module that passes `$`
 *  to a function imported from another file, so hooks/register.tsx builds this with same-file wrappers. */
export type EngineIoSource = { fs: {...}; process: {...}; clock: {...}; store: {...} }
/** Adapts it to Io: fs.read/write/exists/list, process.run (cwd, timeoutMs), clock.now, store.get/set. */
export function engineIo(source: EngineIoSource): Io
```

## hooks/register.tsx (wiring)

- `session.start`: pin `root` from `e.cwd` (absolute; keep it in `$.state` so a hot reload keeps it). Register `/ewm` (`argumentHint: '<new|resume|status|map|questions|plan|pause|approve|reject|reset|list|help> [args]'`) and the model tools from `TOOL_SPECS` with `isDeferred` = no active running task (D8). If a task is active and running, set the status line and pane view. Never throw out of session.start.
- `command.run {command:'ewm'}`: `new`, `resume`, `pause`, `plan`, `approve`, `reject` and `reset` are accepted only when `e.origin.kind` is `composer`, `bridge` or `sdk` (D13, D19, CR6); otherwise refuse with a reason (`status`, `map`, `questions`, `list`, `help` work from any origin). Call `runCommand`; strip a leading "ewm: " from every reply text (F4: the engine shows a command's output as "ewm: <text>"); after a change refresh view, status line and tool deferral (re-register the tools with the new `isDeferred`; registering a name again replaces it); open the pane when `openPane` (fine when not placed: the text output is the fallback). Queue `kickoff` AFTER the command returns: `$.clock.after(0, () => void $.prompt.submit({ text: kickoff }))` (the host refuses `$.prompt.submit` inside a `command.run` hook). Return `{ text, context }`.
- `tool.call {tool:'mcp__ewm__<name>'}`: `runTool` -> `{ result: text, text }`, or the error as an error result; refresh view and status line after a change.
- `tool.call` (all tools) guard: check the `mcp__ewm__` prefix and the read-only-agent rule without file access first where possible; otherwise `activeContext` + agent type from `$.agent.list()` by `e.agentId` + resolved write path (CR17: `$.fs.stat(path, { resolve: true }).realPath` of the nearest existing ancestor plus the remaining segments, `..` folded; unresolvable -> denied) -> `evaluateToolCall` with the LEDGER phase from `activeContext` (F1); on deny return `{ deny: reason }` and `recordDenial`; when the task's files are missing every deny reason ends with "TASK-NNN's files are missing: run /ewm status to see options (/ewm list deactivates it)"; a malformed ledger denies with the ledger error's own message (it names /ewm reset). Registered with the fail-closed `.catch(($, e, next) => next.called ? next(e) : { deny: 'ewm: policy guard failed; denied to stay safe' })`. Inert (no file reads beyond the ledger) without an active running task.
- `agent.spawn`: for `ewm:*` types, `routeModel` (rewrite `e.model`) and, when `$.agent.list()` exposes running state, deny an (N+1)th concurrent ewm scout where N = `budgets.max_parallel_researchers`; `await next(e)`; then `recordAgentSpawn` with the resolved `model`, the `routed_model` and `agentId`. Refresh view.
- `turn.complete`: `recordUsage` from the turn's usage when present.
- Pane: `$.ui.open({ id: 'ewm', title: 'Engineering Workflow' })`; `ui.render {component:'Pane', requestId:'ewm'}` draws `PaneModel` from `$.state` (`ewm.view`, `ewm.section`, `ewm.notice`; `ewm.root` holds the pinned root across hot reloads): header, rail, and the section: Overview (counts, models, next action as text) or Map, Plan, Questions, Findings (`view.docs[section]` split by `splitMermaid`: markdown runs as `Markdown`, mermaid fences as diagrams: `Svg` with the links as `alt` on every surface but the terminal, box-drawing `Text` sized to `e.props.bodyColumns` in the terminal, the links when it does not fit, `Code` when the source does not parse; the Map section applies `view.map_marks`). Buttons `Overview` (o), `Map` (m), `Plan` (p), `Questions` (q), `Findings` (f), `Approve` (a, only with a pending gate; a press is a human origin). A command output with `section` (`/ewm map`, `/ewm questions`) switches the pane to it. The surface, not the element table, decides SVG versus text: the terminal's table answers `Svg` with an empty fragment. The pane also shows `Project: <profile_id>` and, while plan_approval is pending, `Plan <hash8> · N steps: <summary>`. Approve calls `runCommand(ctx, 'approve --plan <full hash of the plan drawn>', 'pane')`, so a plan replaced after the pane drew it is refused. Works on `terminal`, `desktop`, `vscode` and `mobile`.
- Status line: `$.ui.status(statusLine)` after every change; cleared when no task is running.

## Plugin content

- `agents/repo-scout.md` (model: haiku; tools: Read, Grep, Glob), `agents/docs-scout.md` (haiku; Read, Grep, Glob), `agents/reviewer.md` (sonnet; Read, Grep, Glob, Bash). Each returns at most N findings in the evidence format (claim, evidence path:line, confidence, open questions) and never edits.
- `skills/{intake,explore,understand,plan,implement,validate}/SKILL.md`: the stage contract from SPEC §4, which `mcp__ewm__*` tools to use (load them with ToolSearch `select:mcp__ewm__status,mcp__ewm__advance,...` if they are not loaded), delegation rules (<= 3 concurrent scouts, bounded asks, structured outputs, dedupe, verify before recording; the Agent tool may run scouts in the background, wait for their results), gates (never implement before approval; ask the human to run `/ewm approve`), and the exit condition for the stage.
- `schemas/project.schema.json`, `schemas/task.schema.json`: JSON Schema (draft 2020-12) mirroring `Profile` and `Task`.

## Hardening amendments (Run 2)

These amend the sections above; where they conflict, this section wins.

| # | Amendment |
|---|---|
| CR5 | The ledger entry holds `phase` and `paused_from` and is their source of truth. Every transition, pause and resume writes both ledger and task.json; the guard, gates, `activeContext` and `resume` use the ledger values (`trustedTask` overrides `phase`/`paused_from` too). A model edit of task.json while PAUSED or in IMPLEMENT cannot change the phase the mod enforces or where a task resumes. |
| CR6 | State-changing commands (`new`, `resume`, `pause`, `plan`, `approve`, `reject`, `reset`) are accepted only from human origins (`composer`, `bridge`, `sdk`, or a pane press). `status`, `map`, `questions`, `list`, `help` work from any origin. |
| CR7 | `nextTaskId` = max(task dirs, ledger task ids) + 1; creating a task replaces any stale ledger entry for its id. |
| CR8 | `planHash` is SHA-256 (hex) over the canonical plan JSON, from a pure TypeScript implementation in `src/sha256.ts` tested against NIST vectors. |
| CR9 | VALIDATE -> DONE needs >= 1 trusted validation with `ok: true` recorded after the latest transition into VALIDATE, plus the human acceptance. `pendingGate` follows the same rule. |
| CR10 | UNDERSTAND -> PLAN requires actor `user` (SPEC §4 "usuario listo"): `/ewm plan` or the pane. The model is told to ask the person to run `/ewm plan`. |
| CR11 | `run_validation` and the VALIDATE Bash rule accept a command only when its whitespace-normalized text equals a `profile.validation.commands` entry exactly, it has no shell metacharacters, and it is not destructive or network. No shell is used: compound commands belong in a package script. |
| CR12 | Before IMPLEMENT and in VALIDATE, third-party `mcp__*` tools are allowed only when `allowed_mcp_tools` lists them, whatever `external_network` says. |
| CR13 | `saveTask` first copies the previous task.json to `task.json.bak`; `loadTask` falls back to the backup on a parse error (audited). Audit appends never fail a mutation; `audit.jsonl` rotates to `audit.1.jsonl` past 1 MiB. |
| CR14 | Git staleness uses `-c core.quotepath=off` and `-z` output, counts both sides of a rename, and a directory evidence path matches changed files beneath it. |
| CR15 | The implement skill makes diff review explicit: show `git diff --stat` and the key hunks to the person and delegate a diff review to `ewm:reviewer` before advancing to VALIDATE. |
| CR16 | Status and pane show the full model id next to the family (`haiku [claude-haiku-5-5] (ewm:repo-scout x1)`); model-written text is stripped of control characters before display; the resume brief uses trusted approvals; all artifacts re-render on every transition, pause and resume; `/ewm approve` echoes the plan hash prefix, step count and plan `updated_at`. |
| CR17 | The write-path resolver walks up to the nearest existing ancestor, takes its real path and appends the remaining segments; with no resolvable ancestor the write is denied. |
| CR18 | Classifier: `tree -R` is not read_only; `git submodule foreach <cmd>` and `git -c alias.<x>=<v>` are classified on their payload (a `!` alias is a shell command); network programs and outbound tools gain the ones the security review found. |
| CR19 | Redaction also covers the validation command, URL userinfo (`scheme://user:pass@`), `Authorization`/`Cookie` headers, `_authToken`, Slack `xox?-` tokens, JWTs and Google `AIza` keys. |

## Final fixes (Run 3)

The items below are the final review's F1-F6, cited in comments and tests as "F1"-"F6"; they are not the spec defects F1-F5 of SPEC-REVIEW.md.

| # | Amendment |
|---|---|
| F1 | A deleted task folder (e.g. `git clean -fdx`) while the ledger names the task as active no longer bricks the session: `activeContext` returns the ledger `phase` even when `task` is null, the guard keeps enforcing it and appends "TASK-NNN's files are missing: run /ewm status to see options (/ewm list deactivates it)" to every deny, and `/ewm status` explains the two ways out. A malformed ledger still fails closed, with a message that names `/ewm reset`. |
| F2 | `/ewm reset` (human origins only, CR6) backs up the raw ledger value and starts an empty one. A task without a ledger entry resumes with empty approvals and validations, capped at PLAN, with the transition reason "ledger reset: gates must be approved again"; a DONE task is not resumed. |
| F3 | While a gate is pending (trusted), the next action shown in status, pane and resume brief is the review sentence of `render.nextActionOf`; the stored `next_action` is unchanged. |
| F4 | The engine prints a command's output as "ewm: <text>", so the hooks module strips a leading "ewm: " from every command reply; errors wrapped inside other messages (`errorText`, store read errors, pause notes, audit lines) drop the inner prefix with `types.unprefixed`. |
| F5 | `LedgerEntry.validating_since` is the only source of "entered VALIDATE at" (see Run 2 notes). |
| F6 | The follow-up turn after a command is queued with `$.clock.after(0, ...)`, as before. No more reliable mechanism exists in the 2.1.296 declarations (`command.run` has no way to start a turn, `$.prompt.submit` is refused inside the hook, and a prompt is a turn "once the session is idle"). In headless `claude -p` runs it is best effort: send a follow-up prompt if none starts. |

### Run 2 implementation notes (state, persistence, presentation)

Decisions taken while implementing CR3-CR17 and the review findings that fall in those modules. They extend the table above; nothing here overrides it.

- **Approval is bound to what the person saw.** `/ewm approve --plan <hash>` (hex prefix, 8-64 digits) is refused when the current plan hash does not start with it. The pane's Approve button always passes the full hash of the plan it drew (`PaneModel.plan.hash`), so a plan replaced by the model between the draw and the click is refused. A bare `/ewm approve` still approves the current plan, and its reply echoes the hash prefix, the step count and the plan's `updated_at` (CR16).
- **Evidence fingerprints.** `Evidence.fingerprint` (optional) is the `git hash-object` blob id of the cited file at record time. Staleness compares it with the file now, so a file that was already dirty is not stale at every resume. Directories, missing git and unknown files fall back to the changed-path rule (CR14).
- **Ledger shape.** `LedgerEntry.phase` and `paused_from` are required; a ledger whose `active_task` has no entry is malformed (the active task's phase would otherwise be untrusted) and the guard fails closed. A resume of a task the ledger has never seen starts from `trustedTask(task, undefined)`: at most PLAN.
- **Validation freshness (CR9, F5)** is computed in the controller from `TrustedTask.validating_since` and the ledger-backed `ok`/`at` of each run. The service writes `LedgerEntry.validating_since` in `commitState` whenever a saved task's phase changes: the time of the change when it becomes VALIDATE (a transition, or a resume out of PAUSED), `null` when it leaves VALIDATE (to another phase, a pause, DONE). `trustedTask` hands it to the controller (and drops any `validating_since` key in task.json; `fromTrusted` keeps it out of task.json). `task.transitions` is no longer read, so rewriting it gains nothing. A ledger entry without the field (older ledger) yields no fresh validation (fail closed); the first `run_validation` the mod records in VALIDATE sets it, so the person can accept after re-running validation. Equal timestamps count as fresh.
- **Profile changes are visible.** `/ewm resume` lists every profile field that differs from the ledger snapshot it replaces, in the reply the person reads (D14, D19).
- **Model summaries (CR16)** group by the family the engine resolved, show the resolved id in brackets, and flag a resolved family that differs from the one the router asked for.
