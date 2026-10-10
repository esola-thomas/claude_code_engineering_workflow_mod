// Task store and gate ledger over the Io port: workspace layout, task ids,
// task.json and artifact files, the audit log, secret redaction, and the
// mod-private ledger that gate checks trust instead of task.json (D14).

import { ACTIVE_PHASES, ARTIFACT_NAMES, EwmError, PHASES, TASK_ID_PATTERN } from './types.ts'
import type { ArtifactName, AuditEntry, Io, Ledger, LedgerEntry, LedgerValidation, Phase, Profile, Task, TaskSummary } from './types.ts'

export const EWM_DIR = '.ewm'

const TASKS_DIR = 'tasks'
const TASK_FILE = 'task.json'
const AUDIT_FILE = 'audit.jsonl'
const AUDIT_ROTATED_FILE = 'audit.1.jsonl'
/** CR13: past this many characters audit.jsonl moves to audit.1.jsonl, so no file nears the engine's 4 MiB read/write limit. */
const AUDIT_ROTATE_AT = 1024 * 1024
const BACKUP_SUFFIX = '.bak'
const GITIGNORE_FILE = '.gitignore'
const GITIGNORE_CONTENT = 'tasks/\n'
const TASK_ID_PREFIX = 'TASK-'

// ---------------------------------------------------------------------------
// Paths and ids
// ---------------------------------------------------------------------------

/** POSIX join that ignores empty parts and collapses duplicate slashes; keeps a leading '/'; never resolves '..' (callers validate ids instead). */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(part => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

function assertTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new EwmError('invalid_id', `ewm: invalid task id ${JSON.stringify(id)}; ids look like TASK-001. Run /ewm list to see the existing tasks.`)
  }
}

export function taskDir(root: string, id: string): string {
  assertTaskId(id)
  return joinPath(root, EWM_DIR, TASKS_DIR, id)
}

function taskNumber(id: string): number {
  return Number(id.slice(TASK_ID_PREFIX.length))
}

function compareTaskIds(a: string, b: string): number {
  return taskNumber(a) - taskNumber(b)
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Ids of the task directories on disk. Only a missing tasks/ folder counts as empty; other failures surface. */
async function listTaskIds(io: Io, root: string): Promise<string[]> {
  const dir = joinPath(root, EWM_DIR, TASKS_DIR)
  if (!(await io.exists(dir))) return []
  try {
    const entries = await io.list(dir)
    // Files named like a task are junk, but anything else (dir, symlink) may be a task.
    return entries.filter(entry => entry.kind !== 'file' && TASK_ID_PATTERN.test(entry.name)).map(entry => entry.name)
  } catch (cause) {
    throw new EwmError('io_error', `ewm: cannot list ${EWM_DIR}/${TASKS_DIR}: ${describeError(cause)}`)
  }
}

// ---------------------------------------------------------------------------
// Workspace and tasks
// ---------------------------------------------------------------------------

/** Creates <root>/.ewm/.gitignore ("tasks/\n") when missing; leaves an existing one alone. */
export async function ensureWorkspace(io: Io, root: string): Promise<void> {
  const path = joinPath(root, EWM_DIR, GITIGNORE_FILE)
  if (await io.exists(path)) return
  await io.writeText(path, GITIGNORE_CONTENT)
}

/** TASK-001 when none; else max(existing task dirs, ledger task ids) + 1 (CR7: an id is never reused, even after .ewm/tasks was deleted),
 *  zero-padded to >= 3 digits. Ignores non-matching dir names. */
export async function nextTaskId(io: Io, root: string, ledger?: Ledger): Promise<string> {
  const fromLedger = ledger === undefined ? [] : Object.keys(ledger.tasks).filter(id => TASK_ID_PATTERN.test(id))
  const numbers = [...(await listTaskIds(io, root)), ...fromLedger].map(taskNumber)
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1
  return TASK_ID_PREFIX + String(next).padStart(3, '0')
}

/** Pure constructor for a fresh INTAKE task (schema_version 1, empty collections, system_map null; next_action supplied by caller). */
export function createTask(input: { id: string; title: string; goal: string; profile_id: string; repo: Task['repo']; at: string; next_action: string }): Task {
  return {
    schema_version: 1,
    id: input.id,
    project_profile: input.profile_id,
    title: input.title,
    goal: input.goal,
    phase: 'INTAKE',
    paused_from: null,
    mode: 'deep',
    repo: { ...input.repo },
    success_criteria: [],
    constraints: [],
    artifacts: [],
    findings: [],
    open_questions: [],
    decisions: [],
    approvals: [],
    transitions: [],
    agent_usage: [],
    validations: [],
    plan: null,
    system_map: null,
    usage_by_phase: {},
    next_action: input.next_action,
    created_at: input.at,
    updated_at: input.at,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readTaskFile(io: Io, path: string, label: string, id: string): Promise<Task> {
  let text: string
  try {
    text = await io.readText(path)
  } catch (cause) {
    throw new EwmError('io_error', `ewm: cannot read ${label}: ${describeError(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new EwmError('parse_error', `ewm: ${label} is not valid JSON (${describeError(cause)}). Restore the file from a backup, or start again with /ewm new.`)
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || parsed.id !== id) {
    throw new EwmError('parse_error', `ewm: ${label} is not a schema_version 1 task for ${id}. Restore the file from a backup, or start again with /ewm new.`)
  }
  return parsed as Task
}

/** Like loadTask, but says whether task.json was unreadable and the task came from task.json.bak (CR13), so the caller can audit it. */
export async function loadTaskRecovering(io: Io, root: string, id: string): Promise<{ task: Task; recovered: boolean }> {
  const path = joinPath(taskDir(root, id), TASK_FILE)
  const label = `${EWM_DIR}/${TASKS_DIR}/${id}/${TASK_FILE}`
  if (!(await io.exists(path))) {
    throw new EwmError('not_found', `ewm: task ${id} not found. Run /ewm list to see the existing tasks, or /ewm new "title" to start one.`)
  }
  try {
    return { task: await readTaskFile(io, path, label, id), recovered: false }
  } catch (error) {
    if (!(error instanceof EwmError) || error.code !== 'parse_error') throw error
    const backup = path + BACKUP_SUFFIX
    if (!(await io.exists(backup))) throw error
    try {
      return { task: await readTaskFile(io, backup, label + BACKUP_SUFFIX, id), recovered: true }
    } catch {
      throw error
    }
  }
}

/** EwmError('not_found') when missing; 'parse_error' when corrupt and task.json.bak cannot stand in (CR13). */
export async function loadTask(io: Io, root: string, id: string): Promise<Task> {
  return (await loadTaskRecovering(io, root, id)).task
}

/** Pretty JSON (2 spaces) plus a trailing newline. The previous task.json is copied to task.json.bak first when it is a valid task (CR13). */
export async function saveTask(io: Io, root: string, task: Task): Promise<void> {
  const path = joinPath(taskDir(root, task.id), TASK_FILE)
  try {
    if (await io.exists(path)) {
      const previous = await io.readText(path)
      const parsed: unknown = JSON.parse(previous)
      if (isRecord(parsed) && parsed.schema_version === 1 && parsed.id === task.id) await io.writeText(path + BACKUP_SUFFIX, previous)
    }
  } catch {
    // The backup is best effort: a damaged previous file must not stop the save, and must not replace a good backup.
  }
  await io.writeText(path, JSON.stringify(task, null, 2) + '\n')
}

/** Summaries sorted by id; tasks that cannot be read are skipped. */
export async function listTasks(io: Io, root: string): Promise<TaskSummary[]> {
  const summaries: TaskSummary[] = []
  for (const id of (await listTaskIds(io, root)).sort(compareTaskIds)) {
    try {
      const task = await loadTask(io, root, id)
      summaries.push({ id: task.id, title: task.title, phase: task.phase, updated_at: task.updated_at })
    } catch {
      // An unreadable task must not hide the others.
    }
  }
  return summaries
}

// ---------------------------------------------------------------------------
// Artifacts and audit log
// ---------------------------------------------------------------------------

function artifactPath(root: string, id: string, name: ArtifactName): string {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) {
    throw new EwmError('invalid_input', `ewm: unknown artifact ${JSON.stringify(name)}; expected one of ${ARTIFACT_NAMES.join(', ')}.`)
  }
  return joinPath(taskDir(root, id), name)
}

/** Writes an artifact file in the task dir (name must be in ARTIFACT_NAMES). Returns its absolute path. */
export async function writeArtifact(io: Io, root: string, id: string, name: ArtifactName, content: string): Promise<string> {
  const path = artifactPath(root, id, name)
  await io.writeText(path, content)
  return path
}

/** The artifact's text, or null when it has not been written. */
export async function readArtifact(io: Io, root: string, id: string, name: ArtifactName): Promise<string | null> {
  const path = artifactPath(root, id, name)
  if (!(await io.exists(path))) return null
  try {
    return await io.readText(path)
  } catch (cause) {
    throw new EwmError('io_error', `ewm: cannot read ${EWM_DIR}/${TASKS_DIR}/${id}/${name}: ${describeError(cause)}`)
  }
}

/** Appends one JSON line (read + rewrite; Io has no append). Applies redactSecrets to detail. Past 1 MiB the file rotates to audit.1.jsonl (CR13). */
export async function appendAudit(io: Io, root: string, id: string, entry: AuditEntry): Promise<void> {
  const dir = taskDir(root, id)
  const path = joinPath(dir, AUDIT_FILE)
  let existing = (await io.exists(path)) ? await io.readText(path) : ''
  if (existing.length >= AUDIT_ROTATE_AT) {
    await io.writeText(joinPath(dir, AUDIT_ROTATED_FILE), existing)
    existing = ''
  }
  // A previous crash may have left the last line unterminated; never glue two entries together.
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const line = JSON.stringify({ ...entry, detail: redactSecrets(entry.detail) })
  await io.writeText(path, existing + separator + line + '\n')
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]'

const SENSITIVE_NAME = /(secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key)/i

/** A PEM private key block; a block cut off before its END line is masked to the end of the text. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g

/** "Bearer <token>"; the scheme word stays so the line still reads. */
const BEARER_TOKEN = /\b(bearer\s+)[A-Za-z0-9._~+\/-]{8,}=*/gi

/** Secrets recognisable by shape alone: AWS access keys, GitHub / GitLab / npm / Slack / Stripe / Google tokens, sk-... API keys, JWTs. */
const TOKEN_SHAPES = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
]

/** `scheme://user:password@host`: the password goes, the user and host stay so the line still reads. */
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@:]+:)[^\s\/@]+@/g

/** HTTP headers that carry credentials; the value is masked (an Authorization scheme word stays so the line still reads). Group 1 is the name, 2 the separator, 3 the scheme. */
const SECRET_HEADER = /\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key|x-auth-token|x-amz-security-token)(\s*:\s*)(?:(bearer|basic|digest|token|negotiate|ntlm)\s+)?[^\r\n"']+/gi

/** "name": "value" with a quoted key and a quoted value (JSON, Python dict reprs). Group 1 is the key quote, 2 the key, 3 the separator, 4 the value. */
const QUOTED_PAIR = /(["'])([^"'\r\n]*)\1(\s*[:=]\s*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')/g

/** NAME=value (env assignments, CLI flags, URL query strings). Group 1 is the character before the name, 2 the name, 3 the '='. */
const ASSIGNMENT = /(^|[^\w.-])(-{0,2}[A-Za-z_][\w.-]*)(=)(?!\[REDACTED\])("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s&;,"'<>)\]}]+)/g

/** Names that hold secrets in `name: value` / `name = value` text (YAML, headers, config dumps). "author" is not one. */
const SPACED_SENSITIVE_NAME = /(secret|token|password|passwd|api[_-]?key|auth(?!or)|credential|private[_-]?key)/i

/** `name: value` / `name = value` (spaces allowed around the separator). Group 1 is the character before the name, 2 the name, 3 the separator, 4 the value. */
const SPACED_PAIR = /(^|[^\w.-])(-{0,2}[A-Za-z_][\w.-]*)(\s*[:=]\s*)(\[REDACTED\]|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s"'&;,<>)\]}]{4,})/g

/** `--token VALUE` / `-password VALUE`: a flag whose name is sensitive, then its value as the next word. */
const FLAG_THEN_VALUE = /(^|\s)(--?[\w-]*(?:secret|token|password|passwd|api[_-]?key|auth(?!or)|credential|private[_-]?key)[\w-]*)(\s+)(?!-)([^\s]+)/gi

/**
 * Masks likely secrets: `KEY=value` / `KEY: value` / `"key": "value"` / `--flag value` for names containing secret, token,
 * password, passwd, api key, auth, credential or private key; Authorization, Cookie and API-key headers; bearer tokens;
 * URL userinfo passwords; AWS, GitHub, GitLab, npm, Slack, Stripe, Google and sk-... keys; JWTs; PEM private key blocks.
 * Idempotent.
 */
export function redactSecrets(text: string): string {
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED).replace(BEARER_TOKEN, `$1${REDACTED}`)
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED)
  return result
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(SECRET_HEADER, (match, name: string, separator: string, scheme: string | undefined) => `${name}${separator}${scheme === undefined ? '' : `${scheme} `}${REDACTED}`)
    .replace(QUOTED_PAIR, (match, quote: string, name: string, separator: string, value: string) =>
      SENSITIVE_NAME.test(name) ? `${quote}${name}${quote}${separator}${value.charAt(0)}${REDACTED}${value.charAt(0)}` : match,
    )
    .replace(ASSIGNMENT, (match, before: string, name: string, equals: string) =>
      SENSITIVE_NAME.test(name) ? `${before}${name}${equals}${REDACTED}` : match,
    )
    .replace(SPACED_PAIR, (match, before: string, name: string, separator: string, value: string) => {
      if (!SPACED_SENSITIVE_NAME.test(name) || value === REDACTED) return match
      const quote = value.charAt(0) === '"' || value.charAt(0) === "'" ? value.charAt(0) : ''
      return `${before}${name}${separator}${quote}${REDACTED}${quote}`
    })
    .replace(FLAG_THEN_VALUE, (match, before: string, flag: string, space: string, value: string) =>
      value === REDACTED ? match : `${before}${flag}${space}${REDACTED}`,
    )
}

// ---------------------------------------------------------------------------
// Gate ledger (D14): $.store through Io.kvGet/kvSet, out of the model's reach.
// ---------------------------------------------------------------------------

export function ledgerKey(root: string): string {
  return `ledger:${root}`
}

function emptyLedger(root: string): Ledger {
  return { version: 1, root, active_task: null, tasks: {} }
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isApproval(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.gate === 'plan_approval' || value.gate === 'done_acceptance') &&
    (value.decision === 'approved' || value.decision === 'rejected') &&
    value.by === 'user' &&
    typeof value.at === 'string' &&
    (value.plan_hash === undefined || typeof value.plan_hash === 'string')
  )
}

function isLedgerValidation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.command === 'string' &&
    typeof value.exit_code === 'number' &&
    typeof value.ok === 'boolean' &&
    typeof value.at === 'string'
  )
}

/** Structural check of a profile snapshot. profile.ts owns normalization; the store only needs to know the guard can read it. */
function isProfileSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { policies, models, budgets, validation } = value
  return (
    typeof value.profile_id === 'string' &&
    typeof value.name === 'string' &&
    isStringList(value.repositories) &&
    isStringList(value.domains) &&
    isStringList(value.entrypoints) &&
    isRecord(policies) &&
    (policies.external_network === 'deny_by_default' || policies.external_network === 'allow') &&
    typeof policies.require_plan_approval === 'boolean' &&
    typeof policies.allow_write_in_explore === 'boolean' &&
    isStringList(policies.allowed_mcp_tools) &&
    isRecord(models) &&
    typeof models.lead === 'string' &&
    typeof models.search === 'string' &&
    typeof models.reviewer === 'string' &&
    isRecord(budgets) &&
    typeof budgets.max_parallel_researchers === 'number' &&
    typeof budgets.max_research_rounds_without_user_update === 'number' &&
    typeof budgets.max_findings_per_scout === 'number' &&
    isRecord(validation) &&
    isStringList(validation.commands) &&
    typeof validation.timeout_ms === 'number'
  )
}

/** What is wrong with a ledger entry, or null when it is well formed. */
function entryProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return 'not an object'
  if (typeof entry.phase !== 'string' || !(PHASES as readonly string[]).includes(entry.phase)) return 'phase is missing or not a phase'
  if (entry.paused_from !== null && !(typeof entry.paused_from === 'string' && (ACTIVE_PHASES as readonly string[]).includes(entry.paused_from))) {
    return 'paused_from is not an active phase or null'
  }
  if (!Array.isArray(entry.approvals) || !entry.approvals.every(isApproval)) return 'approvals is not a list of approval records'
  if (!Array.isArray(entry.validations) || !entry.validations.every(isLedgerValidation)) return 'validations is not a list of validation records'
  if (!isProfileSnapshot(entry.profile)) return 'profile snapshot is missing or incomplete'
  if (entry.profile_source !== null && typeof entry.profile_source !== 'string') return 'profile_source is not a string or null'
  return null
}

function malformedLedger(root: string, problem: string): EwmError {
  return new EwmError(
    'parse_error',
    `ewm: the gate ledger for ${root} is malformed (${problem}), so no gate can be checked and the policy guard fails closed. ` +
      `Tell the person: clear the mod store entry "${ledgerKey(root)}" (recorded approvals are lost), then run /ewm new or /ewm resume.`,
  )
}

function parseLedger(root: string, raw: unknown): Ledger {
  if (!isRecord(raw)) throw malformedLedger(root, 'not an object')
  if (raw.version !== 1) throw malformedLedger(root, 'unsupported version')
  if (raw.root !== root) throw malformedLedger(root, 'belongs to a different root')
  if (raw.active_task !== null && !(typeof raw.active_task === 'string' && TASK_ID_PATTERN.test(raw.active_task))) {
    throw malformedLedger(root, 'active_task is not a task id or null')
  }
  if (!isRecord(raw.tasks)) throw malformedLedger(root, 'tasks is not an object')
  for (const [id, entry] of Object.entries(raw.tasks)) {
    if (!TASK_ID_PATTERN.test(id)) throw malformedLedger(root, `${JSON.stringify(id)} is not a task id`)
    const problem = entryProblem(entry)
    if (problem !== null) throw malformedLedger(root, `${id}: ${problem}`)
  }
  // The ledger is the source of truth for the active task's phase, so the pointer needs an entry.
  if (raw.active_task !== null && raw.tasks[raw.active_task as string] === undefined) {
    throw malformedLedger(root, `active_task ${String(raw.active_task)} has no ledger entry`)
  }
  return raw as Ledger
}

/** Missing -> { version: 1, root, active_task: null, tasks: {} }. Present but malformed -> EwmError('parse_error') (the guard then fails closed). */
export async function loadLedger(io: Io, root: string): Promise<Ledger> {
  const raw = await io.kvGet(ledgerKey(root))
  return raw === undefined || raw === null ? emptyLedger(root) : parseLedger(root, raw)
}

export async function saveLedger(io: Io, root: string, ledger: Ledger): Promise<void> {
  await io.kvSet(ledgerKey(root), ledger)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A fresh ledger entry (no approvals, no validations) for a task about to start in `phase` with the human-loaded profile. */
export function createLedgerEntry(init: { profile: Profile; profile_source: string | null }, phase: Phase = 'INTAKE'): LedgerEntry {
  return { phase, paused_from: null, approvals: [], validations: [], profile: cloneJson(init.profile), profile_source: init.profile_source }
}

/** Pure: returns a copy of the ledger with the task's entry created (from profile) or updated by fn. fn receives a private copy it may modify. */
export function updateLedgerEntry(
  ledger: Ledger,
  id: string,
  fn: (entry: LedgerEntry) => LedgerEntry,
  init: { profile: Profile; profile_source: string | null },
): Ledger {
  assertTaskId(id)
  const current = ledger.tasks[id]
  const entry: LedgerEntry = current === undefined ? createLedgerEntry(init) : cloneJson(current)
  return { ...ledger, tasks: { ...ledger.tasks, [id]: fn(entry) } }
}

/**
 * Pure: the task as the mod trusts it (CR5, CR9). Phase and paused_from come from the ledger entry, approvals are the ledger's,
 * and validations are kept only when the ledger holds the same id with the same exit code, taking `ok`, `at` and the
 * command from the ledger. Nothing the task file claims about gates or phase is believed. Gate checks use this.
 * Without an entry nothing is approved and the task cannot be past PLAN.
 */
export function trustedTask(task: Task, entry: LedgerEntry | undefined): Task {
  const approvals = entry === undefined ? [] : entry.approvals.map(approval => ({ ...approval }))
  const recorded: readonly LedgerValidation[] = entry?.validations ?? []
  const validations: Task['validations'] = []
  for (const run of task.validations) {
    const known = recorded.find(candidate => candidate.id === run.id && candidate.exit_code === run.exit_code)
    if (known !== undefined) validations.push({ ...run, ok: known.ok, at: known.at, command: known.command })
  }
  if (entry === undefined) {
    const pastPlan = (phase: Phase | null): boolean => phase === 'IMPLEMENT' || phase === 'VALIDATE' || phase === 'DONE'
    const phase: Phase = pastPlan(task.phase) ? 'PLAN' : task.phase
    const pausedFrom = task.paused_from !== null && pastPlan(task.paused_from) ? 'PLAN' : task.paused_from
    return { ...task, phase, paused_from: pausedFrom, approvals, validations }
  }
  return { ...task, phase: entry.phase, paused_from: entry.paused_from, approvals, validations }
}
