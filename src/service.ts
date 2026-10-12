// Use cases of the mod: the /ewm commands, the model tools (mcp__ewm__*) and the
// recording hooks (agent spawns, usage, denials), all over the Io port.
//
// Every function that writes runs inside one module-level queue (withLock), so
// parallel hooks never lose an update to task.json, the ledger or audit.jsonl.
// Gates are checked on trustedTask(task, ledger entry) with the ledger's profile
// snapshot, never on what task.json or project.yaml say at check time (D2, D13, D14).

import { parseCommand, splitArgs, USAGE } from './args.ts'
import type { EwmCommand } from './args.ts'
import { checkTransition, defaultNextAction, hasValidApproval, pause, pendingGate, planHash, recordApproval, resume, transition } from './controller.ts'
import { formatParseErrors, parseFlowchart } from './graph.ts'
import { classifyBash } from './policies.ts'
import { DEFAULT_PROFILE, loadProfile } from './profile.ts'
import {
  paneModel,
  renderDecisions,
  renderExploration,
  renderHandoff,
  renderMapHtml,
  renderMapText,
  renderPlan,
  renderQuestions,
  renderResumeBrief,
  renderStatus,
  renderSystemMap,
  renderTaskList,
  renderValidation,
  shortHash,
} from './render.ts'
import type { GateState } from './render.ts'
import { summarizeModels } from './router.ts'
import {
  EWM_DIR,
  appendAudit,
  createLedgerEntry,
  createTask,
  ensureWorkspace,
  joinPath,
  listTasks,
  loadLedger,
  loadTaskRecovering,
  nextTaskId,
  redactSecrets,
  resetLedger,
  saveLedger,
  saveTask,
  taskDir,
  trustedTask,
  updateLedgerEntry,
  writeArtifact,
} from './store.ts'
import { ARTIFACT_NAMES, EWM_PREFIX, EwmError, PHASES, unprefixed } from './types.ts'
import type {
  ArtifactName,
  AuditEntry,
  Confidence,
  Decision,
  Evidence,
  Finding,
  GateName,
  Io,
  Ledger,
  LedgerEntry,
  PaneModel,
  Phase,
  PhaseUsage,
  Plan,
  PlanStep,
  Profile,
  Question,
  CommandOutput,
  Staleness,
  Task,
  ToolOutput,
  TrustedTask,
  ValidationRun,
} from './types.ts'

export type Ctx = { io: Io; root: string } // root is absolute

type Input = Record<string, unknown>

/** The active task as the ledger names it, with the profile snapshot the guard and tools must use.
 *  `task.phase` and `task.paused_from` are the ledger's (CR5), whatever task.json says. `recovered` is set when task.json was unreadable and task.json.bak stood in (CR13). */
type Active = { ledger: Ledger; task: Task; profile: Profile; recovered?: boolean }

// ---------------------------------------------------------------------------
// Serialized writes
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve()

/** Runs jobs one at a time, in call order. A failing job rejects its own caller only. */
function withLock<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The message for the person or model, with the "ewm: " prefix exactly once (F4), whatever the error already carried. */
function errorText(error: unknown): string {
  if (error instanceof EwmError) return `${EWM_PREFIX}${unprefixed(error.message)}`
  return `${EWM_PREFIX}unexpected error: ${unprefixed(error instanceof Error ? error.message : String(error))}`
}

/** The same message to embed inside another one: no prefix of its own. */
function reasonText(error: unknown): string {
  return unprefixed(errorText(error))
}

function invalid(message: string): EwmError {
  return new EwmError('invalid_input', `${EWM_PREFIX}${unprefixed(message)}`)
}

async function nowIso(io: Io): Promise<string> {
  return new Date(await io.now()).toISOString()
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** "F-004" for ids F-001..F-003: max numeric suffix + 1, padded to `pad` digits. */
function nextId(prefix: string, ids: readonly string[], pad: number): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let highest = 0
  for (const id of ids) {
    const match = pattern.exec(id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix}-${String(highest + 1).padStart(pad, '0')}`
}

/** Who reads an error: the model (via a tool) is told to ask the person; the person (via a command) is told what to type. */
type Audience = 'model' | 'person'

function noActiveTaskHelp(audience: Audience): string {
  return audience === 'person'
    ? 'ewm: there is no active task. Run /ewm new "<title>" or /ewm resume.'
    : 'ewm: there is no active task. Ask the person to run /ewm new "<title>" or /ewm resume.'
}

// ---------------------------------------------------------------------------
// Git (read-only, always with cwd = root)
// ---------------------------------------------------------------------------

const COMMIT_PATTERN = /^[0-9a-f]{4,64}$/i

/** stdout of a successful git command, else null (git missing, not a repo, bad ref, ...). */
async function git(ctx: Ctx, ...args: string[]): Promise<string | null> {
  try {
    const result = await ctx.io.run(['git', ...args], { cwd: ctx.root })
    return result.exitCode === 0 ? result.stdout : null
  } catch {
    return null
  }
}

async function gitLine(ctx: Ctx, ...args: string[]): Promise<string | null> {
  const line = (await git(ctx, ...args))?.trim()
  return line === undefined || line === '' ? null : line
}

/** Git prints non-ASCII paths as octal escapes unless told otherwise (CR14); every call that returns paths also uses -z. */
const GIT_RAW_PATHS = ['-c', 'core.quotepath=off'] as const

function isWorkflowState(path: string): boolean {
  return path === EWM_DIR || path.startsWith(`${EWM_DIR}/`)
}

/** Paths from `-z` output (NUL separated, never quoted), without workflow state. */
function pathList(stdout: string): string[] {
  return stdout.split('\0').filter(path => path !== '' && !isWorkflowState(path))
}

/** Paths changed between `commit` and HEAD, relative to root, both sides of a rename; null when git cannot tell. */
async function changedSince(ctx: Ctx, commit: string): Promise<string[] | null> {
  if (!COMMIT_PATTERN.test(commit)) return null
  const out = await git(ctx, ...GIT_RAW_PATHS, 'diff', '--name-only', '--no-renames', '-z', '--relative', commit, 'HEAD')
  return out === null ? null : pathList(out)
}

/** Paths git reports as modified, added, renamed (both the old and the new name), deleted or untracked, relative to root; null when git cannot tell. */
async function worktreeChanges(ctx: Ctx): Promise<string[] | null> {
  const out = await git(ctx, ...GIT_RAW_PATHS, 'status', '--porcelain', '-z')
  if (out === null) return null
  // Porcelain paths are relative to the repository top level; root may be a subdirectory.
  const prefix = (await git(ctx, 'rev-parse', '--show-prefix'))?.trim() ?? ''
  const fields = out.split('\0')
  const paths: string[] = []
  const keep = (path: string): void => {
    if (!path.startsWith(prefix)) return // outside root
    const relative = path.slice(prefix.length)
    if (relative !== '' && !isWorkflowState(relative)) paths.push(relative)
  }
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    keep(field.slice(3))
    // A rename or copy is followed by its original path as a field of its own.
    if (field.charAt(0) === 'R' || field.charAt(0) === 'C' || field.charAt(1) === 'R' || field.charAt(1) === 'C') {
      i++
      keep(fields[i] ?? '')
    }
  }
  return paths
}

/** Whether `path` is among the changed paths (a changed directory such as "src/new/" covers what is inside it, and an evidence directory is changed by files beneath it). */
function isChanged(path: string, changed: readonly string[]): boolean {
  return changed.some(entry => entry === path || (entry.endsWith('/') && path.startsWith(entry)) || entry.startsWith(`${path}/`))
}

const BLOB_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** `git hash-object` of the working-tree file, or null for a directory, a missing file or no git. */
async function fingerprintOf(ctx: Ctx, path: string): Promise<string | null> {
  const out = await gitLine(ctx, 'hash-object', '--', path)
  return out !== null && BLOB_ID.test(out) ? out : null
}

/** Files changed since the task's base commit (committed and uncommitted), sorted, without workflow state. */
async function changedFilesOf(ctx: Ctx, task: Task): Promise<string[]> {
  const base = task.repo.base_commit
  const committed = base === null ? [] : ((await changedSince(ctx, base)) ?? [])
  const uncommitted = (await worktreeChanges(ctx)) ?? []
  return unique([...committed, ...uncommitted]).sort()
}

// ---------------------------------------------------------------------------
// Staleness (resume)
// ---------------------------------------------------------------------------

/**
 * Marks findings whose evidence changed since it was verified. Evidence recorded with a fingerprint is compared by content, so a
 * file that was already dirty when the finding was recorded is not stale until it changes again; other evidence is stale when
 * git lists its path as changed (committed since the verified commit, or uncommitted). Never re-runs validations or any other
 * side effect. When git cannot answer, nothing is marked and `checked` is false.
 */
async function checkStaleness(ctx: Ctx, task: Task): Promise<{ staleness: Staleness; task: Task }> {
  const previous = { branch: task.repo.branch, commit: task.repo.base_commit }
  const current = { branch: await gitLine(ctx, 'rev-parse', '--abbrev-ref', 'HEAD'), commit: await gitLine(ctx, 'rev-parse', 'HEAD') }
  const unchecked = (note: string) => ({
    staleness: { checked: false, branch_changed: false, head_changed: false, previous, current, changed_paths: [], stale_findings: [], note },
    task,
  })
  if (current.commit === null) return unchecked('git is unavailable here')
  if (previous.commit === null) return unchecked('the task has no base commit recorded')
  const dirty = await worktreeChanges(ctx)
  if (dirty === null) return unchecked('git status failed')

  const fresh = task.findings.filter(finding => !finding.stale)
  const baseOf = (finding: Finding): string => finding.last_verified_commit ?? previous.commit ?? ''
  const changedByBase = new Map<string, string[] | null>()
  for (const base of unique(fresh.map(baseOf))) changedByBase.set(base, await changedSince(ctx, base))

  const stale = new Set<string>()
  for (const finding of fresh) {
    const committed = changedByBase.get(baseOf(finding)) ?? null
    let touched = false
    for (const item of finding.evidence) {
      const now = item.fingerprint === undefined ? null : await fingerprintOf(ctx, item.path)
      if (now !== null) {
        touched = now !== item.fingerprint
      } else {
        // A commit git cannot diff against cannot vouch for the evidence either.
        touched = committed === null || isChanged(item.path, [...committed, ...dirty])
      }
      if (touched) break
    }
    if (touched) stale.add(finding.id)
  }
  const changedPaths = unique([...[...changedByBase.values()].flatMap(paths => paths ?? []), ...dirty]).sort()
  const staleness: Staleness = {
    checked: true,
    branch_changed: current.branch !== previous.branch,
    head_changed: current.commit !== previous.commit,
    previous,
    current,
    changed_paths: changedPaths,
    stale_findings: [...stale],
  }
  const findings = task.findings.map(finding => (stale.has(finding.id) ? { ...finding, stale: true } : finding))
  return { staleness, task: { ...task, findings } }
}

// ---------------------------------------------------------------------------
// Ledger-backed state
// ---------------------------------------------------------------------------

function profileOf(ledger: Ledger, id: string): Profile {
  return ledger.tasks[id]?.profile ?? DEFAULT_PROFILE
}

/** The task with the phase and resume target the ledger holds (CR5); task.json's own copies are a mirror the model could have edited. */
function withLedgerPhase(task: Task, ledger: Ledger): Task {
  const entry = ledger.tasks[task.id]
  return entry === undefined ? task : { ...task, phase: entry.phase, paused_from: entry.paused_from }
}

/** The active task per the ledger, or null when none is active. Throws when the ledger or the task is unreadable. */
async function loadActive(ctx: Ctx): Promise<Active | null> {
  const ledger = await loadLedger(ctx.io, ctx.root)
  if (ledger.active_task === null) return null
  const { task, recovered } = await loadTaskRecovering(ctx.io, ctx.root, ledger.active_task)
  const active: Active = { ledger, task: withLedgerPhase(task, ledger), profile: profileOf(ledger, task.id) }
  if (recovered) active.recovered = true
  return active
}

async function requireActive(ctx: Ctx, audience: Audience): Promise<Active> {
  const active = await loadActive(ctx)
  if (active === null) throw new EwmError('no_active_task', noActiveTaskHelp(audience))
  return active
}

/** The active task, which must be neither PAUSED nor DONE. */
async function requireRunning(ctx: Ctx, audience: Audience = 'model'): Promise<Active> {
  const active = await requireActive(ctx, audience)
  const { task } = active
  const ask = audience === 'person' ? 'Run' : 'Ask the person to run'
  if (task.phase === 'PAUSED') {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is paused, so the workflow tools are off. ${ask} /ewm resume ${task.id}.`)
  }
  if (task.phase === 'DONE') {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is DONE. ${ask} /ewm new "<title>" to start another task.`)
  }
  return active
}

/** What the controller sees: phase, approvals and validations from the ledger only. */
function trustedOf(task: Task, ledger: Ledger): TrustedTask {
  return trustedTask(task, ledger.tasks[task.id])
}

function gateOf(task: Task, ledger: Ledger, profile: Profile): GateState {
  const trusted = trustedOf(task, ledger)
  const pending = pendingGate(trusted, profile)
  return {
    pending,
    planApproved: hasValidApproval(trusted, 'plan_approval'),
    models: summarizeModels(task.agent_usage),
    plan:
      pending === 'plan_approval' && trusted.plan !== null
        ? { hash: planHash(trusted.plan), steps: trusted.plan.steps.length, summary: trusted.plan.summary }
        : null,
  }
}

function statusOf(task: Task, ledger: Ledger, profile: Profile): string {
  return renderStatus(task, profile, gateOf(task, ledger, profile))
}

/** Carries a controller result computed on the trusted task back onto the real one: task.json keeps its own approvals and validations. */
function fromTrusted(original: Task, computed: Task): Task {
  // validating_since lives in the ledger only (F5); it must not leak into task.json, where the model could edit it.
  const { validating_since: _ledgerOnly, ...rest } = computed as TrustedTask
  return { ...rest, approvals: original.approvals, validations: original.validations }
}

// ---------------------------------------------------------------------------
// Persisting a mutation: ledger first, then task.json, artifacts and audit
// ---------------------------------------------------------------------------

const STATE_ARTIFACTS: readonly ArtifactName[] = ARTIFACT_NAMES.filter(name => name !== 'handoff.md')

type AuditDraft = { kind: AuditEntry['kind']; detail: string; tool?: string; commit?: string | null }

type PersistOptions = {
  at: string
  /** The ledger to store; omit when it did not change. */
  ledger?: Ledger
  artifacts?: readonly ArtifactName[]
  /** For handoff.md. */
  changedFiles?: readonly string[]
  audit?: readonly AuditDraft[]
}

/** The ledger the mutation ends with (its phase mirrors the saved task) and the task as saved. */
type Saved = { task: Task; ledger: Ledger }

function renderArtifact(name: ArtifactName, task: Task, gate: GateState, changedFiles: readonly string[]): string {
  switch (name) {
    case 'exploration.md':
      return renderExploration(task)
    case 'system-map.md':
      return renderSystemMap(task)
    case 'questions.md':
      return renderQuestions(task)
    case 'plan.md':
      return renderPlan(task, gate)
    case 'validation.md':
      return renderValidation(task)
    case 'decisions.md':
      return renderDecisions(task)
    case 'handoff.md':
      return renderHandoff(task, changedFiles)
  }
}

/**
 * Stores a mutation. The ledger is the authority, so it goes first and carries the saved phase and resume target (CR5);
 * then task.json (listing the artifacts it now has); then the re-rendered artifacts and the audit lines. Artifacts and audit
 * are best effort (CR13): a failure there is never reported as a failed mutation, because the state is already stored, and
 * the next transition or resume re-renders every artifact.
 */
async function commitState(ctx: Ctx, view: { ledger: Ledger; profile: Profile; recovered?: boolean }, task: Task, options: PersistOptions): Promise<Saved> {
  const { io, root } = ctx
  const names = options.artifacts ?? []
  const present = new Set([...task.artifacts, ...names])
  const saved: Task = { ...task, artifacts: ARTIFACT_NAMES.filter(name => present.has(name)) }

  let ledger = options.ledger ?? view.ledger
  const entry = ledger.tasks[saved.id]
  let ledgerChanged = options.ledger !== undefined
  if (entry !== undefined && (entry.phase !== saved.phase || entry.paused_from !== saved.paused_from)) {
    const synced: LedgerEntry = { ...entry, phase: saved.phase, paused_from: saved.paused_from }
    // F5: the ledger, not task.json, remembers when the task entered VALIDATE; leaving it clears the mark.
    if (entry.phase !== saved.phase) synced.validating_since = saved.phase === 'VALIDATE' ? options.at : null
    ledger = { ...ledger, tasks: { ...ledger.tasks, [saved.id]: synced } }
    ledgerChanged = true
  }
  if (ledgerChanged) await saveLedger(io, root, ledger)
  await saveTask(io, root, saved)

  const drafts: AuditDraft[] = [
    ...(view.recovered === true ? [{ kind: 'error' as const, detail: 'task.json was unreadable; the task was restored from task.json.bak' }] : []),
    ...(options.audit ?? []),
  ]
  try {
    const gate = gateOf(saved, ledger, view.profile)
    for (const name of names) {
      await writeArtifact(io, root, saved.id, name, renderArtifact(name, saved, gate, options.changedFiles ?? []))
    }
  } catch (error) {
    drafts.push({ kind: 'error', detail: `an artifact could not be written (${reasonText(error)}); it is re-rendered on the next transition or resume` })
  }
  for (const draft of drafts) {
    const item: AuditEntry = { at: options.at, kind: draft.kind, phase: saved.phase, detail: draft.detail }
    if (draft.tool !== undefined) item.tool = draft.tool
    if (draft.commit !== undefined) item.commit = draft.commit
    try {
      await appendAudit(io, root, saved.id, item)
    } catch {
      // The audit log never fails a mutation (CR13).
    }
  }
  return { task: saved, ledger }
}

async function persist(ctx: Ctx, view: { ledger: Ledger; profile: Profile; recovered?: boolean }, task: Task, options: PersistOptions): Promise<Task> {
  return (await commitState(ctx, view, task, options)).task
}

// ---------------------------------------------------------------------------
// Phase moves shared by commands and tools
// ---------------------------------------------------------------------------

async function moveTo(ctx: Ctx, active: Active, to: Phase, actor: 'user' | 'model', reason: string, at: string): Promise<Saved> {
  const { task, profile } = active
  const moved = transition(trustedOf(task, active.ledger), to, actor, reason, at, profile)
  return commitState(ctx, active, fromTrusted(task, moved), {
    at,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'transition', detail: `${task.phase} -> ${to} by ${actor}: ${reason}` }],
  })
}

function skillFor(phase: Phase): string {
  switch (phase) {
    case 'INTAKE':
      return 'ewm:intake'
    case 'EXPLORE':
      return 'ewm:explore'
    case 'UNDERSTAND':
      return 'ewm:understand'
    case 'PLAN':
      return 'ewm:plan'
    case 'IMPLEMENT':
      return 'ewm:implement'
    case 'VALIDATE':
      return 'ewm:validate'
    case 'DONE':
    case 'PAUSED':
      return 'ewm:intake'
  }
}

/** Pauses the ledger's active task when it is running and is not `keepId`; says what it did and returns the ledger as it now stands. A task that cannot be read is left alone. */
async function pauseOther(ctx: Ctx, ledger: Ledger, keepId: string | null, at: string): Promise<{ note: string | null; ledger: Ledger }> {
  const otherId = ledger.active_task
  if (otherId === null || otherId === keepId) return { note: null, ledger }
  try {
    const { task: loaded, recovered } = await loadTaskRecovering(ctx.io, ctx.root, otherId)
    const other = withLedgerPhase(loaded, ledger)
    if (other.phase === 'PAUSED' || other.phase === 'DONE') return { note: null, ledger }
    const paused = pause(other, at, `paused: the person started or resumed another task`)
    const saved = await commitState(ctx, { ledger, profile: profileOf(ledger, otherId), recovered }, paused, {
      at,
      artifacts: STATE_ARTIFACTS,
      audit: [{ kind: 'pause', detail: `paused from ${other.phase}: another task became active` }],
    })
    return { note: `Paused ${otherId} (was in ${other.phase}); resume it later with /ewm resume ${otherId}.`, ledger: saved.ledger }
  } catch (error) {
    return { note: `Could not pause ${otherId} (${reasonText(error)}); it was left untouched.`, ledger }
  }
}

// ---------------------------------------------------------------------------
// /ewm commands
// ---------------------------------------------------------------------------

type Via = 'command' | 'pane'

function noActiveOutput(): CommandOutput {
  return { text: renderStatus(null, DEFAULT_PROFILE, { pending: null, planApproved: false, models: [] }), changed: false }
}

function warningLines(warnings: readonly string[]): string[] {
  return warnings.length === 0 ? [] : ['Profile warnings:', ...warnings.map(warning => `  - ${warning}`)]
}

/** Shell syntax that run_validation never accepts (CR11): the command runs without a shell, so these could only be a mistake or an attack. */
const VALIDATION_SHELL_SYNTAX = /[|&;<>$`\\"'\r\n]/

/** Why a command can never run as a validation, or null when it can. The command is whitespace-normalized by the caller. */
function validationRefusal(command: string, profile: Profile): string | null {
  if (VALIDATION_SHELL_SYNTAX.test(command)) {
    return 'it contains shell syntax (| & ; < > $ ` quotes or a backslash) and validation commands run without a shell; put compound commands in a package script and list that'
  }
  const kind = classifyBash(command, profile)
  if (kind === 'destructive') return 'it is classified as destructive'
  if (kind === 'network') return 'it uses the network'
  return null
}

/** Profile entries run_validation can never run, as warnings the person sees when the profile is (re)loaded. */
function validationWarnings(profile: Profile): string[] {
  const warnings: string[] = []
  for (const entry of profile.validation.commands) {
    const reason = validationRefusal(oneLine(entry), profile)
    if (reason !== null) warnings.push(`validation.commands entry "${entry}" can never run: ${reason}.`)
  }
  return warnings
}

function leafValues(value: unknown, path: string, out: Record<string, string>): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) leafValues(child, path === '' ? key : `${path}.${key}`, out)
  } else {
    out[path] = JSON.stringify(value)
  }
}

/** The profile fields whose value differs between two snapshots, as "policies.external_network: "deny_by_default" -> "allow"". */
function profileChanges(before: Profile, after: Profile): string[] {
  const was: Record<string, string> = {}
  const now: Record<string, string> = {}
  leafValues(before, '', was)
  leafValues(after, '', now)
  return unique([...Object.keys(was), ...Object.keys(now)])
    .filter(key => was[key] !== now[key])
    .map(key => `${key}: ${was[key] ?? '(unset)'} -> ${now[key] ?? '(unset)'}`)
}

async function cmdNew(ctx: Ctx, command: Extract<EwmCommand, { name: 'new' }>): Promise<CommandOutput> {
  const { io, root } = ctx
  await ensureWorkspace(io, root)
  const { profile, source, warnings } = await loadProfile(io, root)
  const loaded = await loadLedger(io, root)
  const at = await nowIso(io)
  const { note: pausedNote, ledger } = await pauseOther(ctx, loaded, null, at)

  const id = await nextTaskId(io, root, ledger)
  const branch = await gitLine(ctx, 'rev-parse', '--abbrev-ref', 'HEAD')
  const baseCommit = await gitLine(ctx, 'rev-parse', 'HEAD')
  const goal = command.goal ?? command.title
  const task = createTask({
    id,
    title: command.title,
    goal,
    profile_id: profile.profile_id,
    repo: { root: '.', branch, base_commit: baseCommit },
    at,
    next_action: defaultNextAction('INTAKE'),
  })
  // CR7: a new task never inherits approvals, validations or a profile snapshot from an earlier entry for the same id.
  const nextLedger: Ledger = { ...ledger, active_task: id, tasks: { ...ledger.tasks, [id]: createLedgerEntry({ profile, profile_source: source }) } }
  const saved = await commitState(ctx, { ledger: nextLedger, profile }, task, {
    at,
    ledger: nextLedger,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'task_created', detail: `${id} "${command.title}" on profile ${profile.profile_id}`, commit: baseCommit }],
  })
  const text = [
    `Started ${id}: ${command.title}`,
    ...(pausedNote === null ? [] : [pausedNote]),
    ...warningLines([...warnings, ...validationWarnings(profile)]),
    '',
    statusOf(saved.task, saved.ledger, profile),
  ].join('\n')
  return {
    text,
    kickoff: `Load the skill ${skillFor('INTAKE')} and run intake for ${id} ("${command.title}"). Goal: ${goal}`,
    changed: true,
    openPane: true,
  }
}

/** The id /ewm resume picks without an argument: the active task, else the most recently updated one that is not DONE. */
async function defaultResumeId(ctx: Ctx, ledger: Ledger): Promise<string> {
  if (ledger.active_task !== null) return ledger.active_task
  const open = (await listTasks(ctx.io, ctx.root)).filter(summary => summary.phase !== 'DONE')
  open.sort((a, b) => (a.updated_at === b.updated_at ? b.id.localeCompare(a.id) : b.updated_at.localeCompare(a.updated_at)))
  const latest = open[0]
  if (latest === undefined) throw new EwmError('not_found', 'ewm: there is no task to resume. Start one with /ewm new "<title>", or run /ewm list.')
  return latest.id
}

const LEDGER_RESET_REASON = 'ledger reset: gates must be approved again'

/** F2: the task had no ledger entry (the ledger was reset, or never saw it). Its entry starts with no approvals and no validation runs, and its phase is capped at PLAN. */
function resumeWithoutLedger(raw: Task, resumed: Task, at: string): Task {
  const target = raw.phase === 'PAUSED' ? raw.paused_from : raw.phase
  const capped = target !== resumed.phase
  const record = { from: raw.phase, to: resumed.phase, actor: 'system' as const, reason: LEDGER_RESET_REASON, at }
  // A resume out of PAUSED already recorded its own transition; the reset reason replaces its wording instead of adding a second line.
  const added = resumed.transitions.length > raw.transitions.length
  const transitions = added ? [...resumed.transitions.slice(0, -1), { ...record, from: 'PAUSED' as const }] : [...resumed.transitions, record]
  return { ...resumed, transitions, next_action: capped ? defaultNextAction(resumed.phase) : resumed.next_action, updated_at: at }
}

function ledgerResetNotice(raw: Task, resumed: Task): string {
  const from = raw.phase === 'PAUSED' ? raw.paused_from ?? 'INTAKE' : raw.phase
  const cap = from === resumed.phase ? `Phase ${resumed.phase}` : `Phase ${resumed.phase} (it was ${from}; resuming without a ledger caps it at PLAN)`
  return `Ledger reset: ${raw.id} had no entry in the gate ledger, so it resumes with no recorded approvals or validation runs. ${cap}. Gates must be approved again.`
}

async function cmdResume(ctx: Ctx, command: Extract<EwmCommand, { name: 'resume' }>): Promise<CommandOutput> {
  const { io, root } = ctx
  const loadedLedger = await loadLedger(io, root)
  const id = command.id ?? (await defaultResumeId(ctx, loadedLedger))
  const { task: raw, recovered } = await loadTaskRecovering(io, root, id)
  // CR5: phase, resume target, approvals and validations come from the ledger; task.json is only a mirror.
  const known = loadedLedger.tasks[id]
  const trusted = trustedTask(raw, known)
  // F2: a task with no ledger entry (after /ewm reset) is read from task.json, whose phase trustedTask caps at PLAN; DONE must still be refused.
  if ((known === undefined ? raw.phase : trusted.phase) === 'DONE') {
    throw invalid(`${id} is DONE, so there is nothing to resume. Its handoff is in ${EWM_DIR}/tasks/${id}/handoff.md; start a new task with /ewm new.`)
  }
  const { profile, source, warnings } = await loadProfile(io, root)
  const at = await nowIso(io)
  const { note: pausedNote, ledger } = await pauseOther(ctx, loadedLedger, id, at)

  const { staleness, task: checked } = await checkStaleness(ctx, trusted)
  const resumed = known === undefined ? resumeWithoutLedger(raw, resume(checked, at, profile), at) : { ...resume(checked, at, profile), updated_at: at }
  // Humans reload the profile here; the guard and tools use this snapshot until the next resume.
  const withEntry = updateLedgerEntry(
    ledger,
    id,
    entry => ({ ...entry, phase: trusted.phase, paused_from: trusted.paused_from, profile, profile_source: source }),
    { profile, profile_source: source },
  )
  const nextLedger: Ledger = { ...withEntry, active_task: id }
  const saved = await commitState(ctx, { ledger: nextLedger, profile, recovered }, fromTrusted(raw, resumed), {
    at,
    ledger: nextLedger,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'resume', detail: `resumed in ${resumed.phase}; ${staleness.checked ? `${staleness.stale_findings.length} finding(s) newly stale` : 'staleness not checked'}` }],
  })
  const brief = renderResumeBrief(saved.task, staleness, gateOf(saved.task, saved.ledger, profile))
  const changes = known === undefined ? [] : profileChanges(known.profile, profile)
  const profileNotice =
    changes.length === 0
      ? []
      : ['', 'The project profile changed since the last snapshot and applies from now on:', ...changes.map(change => `  - ${change}`), 'If you did not edit .ewm/project.yaml yourself, check it before continuing.']
  const resetNotice = known === undefined ? [ledgerResetNotice(raw, saved.task)] : []
  const text = [brief, ...resetNotice.flatMap(line => ['', line]), ...(pausedNote === null ? [] : ['', pausedNote]), ...profileNotice, ...warningLines([...warnings, ...validationWarnings(profile)])].join('\n')
  return {
    text,
    context: [brief, ...resetNotice, 'Do not repeat side-effecting operations; re-verify stale evidence before relying on it.'],
    kickoff: `Continue ${id} in ${saved.task.phase}: load the skill ${skillFor(saved.task.phase)} and pick up from the resume brief.`,
    changed: true,
    openPane: true,
  }
}

/** What /ewm status says when the ledger names an active task whose files cannot be read (F1): why, what still applies, and the two ways out. */
function missingFilesText(id: string, entry: LedgerEntry | undefined, error: unknown): string {
  const phase = entry === undefined ? 'its' : entry.phase
  return [
    `${id}'s files are missing or unreadable, but the gate ledger still lists it as the active task (${reasonText(error)})`,
    `Until you act, the policy guard keeps enforcing the ${phase} rules, so tool calls may be denied.`,
    'Two ways out:',
    `  - /ewm list: deactivates ${id} (its ledger entry is kept, so restoring the folder .ewm/tasks/${id}/ and running /ewm resume ${id} brings it back) and shows the tasks that are left.`,
    '  - /ewm new "<title>": starts a new task (the missing one is left as it is).',
  ].join('\n')
}

async function cmdStatus(ctx: Ctx): Promise<CommandOutput> {
  const ledger = await loadLedger(ctx.io, ctx.root)
  const id = ledger.active_task
  if (id === null) return { ...noActiveOutput(), openPane: true }
  let task: Task
  try {
    task = (await loadTaskRecovering(ctx.io, ctx.root, id)).task
  } catch (error) {
    return { text: missingFilesText(id, ledger.tasks[id], error), changed: false, openPane: true }
  }
  const profile = profileOf(ledger, id)
  return { text: statusOf(withLedgerPhase(task, ledger), ledger, profile), changed: false, openPane: true }
}

/** F2: the recovery path for a malformed ledger, or a fresh start. Backs up the raw ledger value, stores an empty ledger, leaves every task on disk alone. */
async function cmdReset(ctx: Ctx): Promise<CommandOutput> {
  const { io, root } = ctx
  await ensureWorkspace(io, root)
  const at = await nowIso(io)
  const { backup } = await resetLedger(io, root, at)
  const tasks = await listTasks(io, root)
  const left = tasks.length === 0 ? 'There are no tasks on disk.' : `Tasks on disk (untouched): ${tasks.map(task => task.id).join(', ')}.`
  return {
    text: [
      'The gate ledger was reset: no task is active now.',
      `The previous ledger value was saved to ${backup}.`,
      left,
      'Approvals and validation runs recorded in the old ledger no longer count: a task you resume starts at PLAN at most and its gates must be approved again.',
      'Continue with /ewm resume TASK-NNN, or start over with /ewm new "<title>".',
    ].join('\n'),
    changed: true,
    openPane: true,
  }
}

/** The diagram drawn as text for the terminal (`columns` wide), with the pane switched to its Map section, where desktop surfaces draw it as SVG. */
async function cmdMap(ctx: Ctx, columns: number, html: boolean): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return noActiveOutput()
  const dir = taskDir(ctx.root, active.task.id)
  const text = renderMapText(active.task, columns, joinPath(dir, 'system-map.md'))
  if (!html) return { text, changed: false, openPane: true, section: 'map' }
  // A view, not workflow state: the page is rewritten on each run and nothing else reads it.
  const page = joinPath(dir, MAP_HTML_FILE)
  await ctx.io.writeText(page, renderMapHtml(active.task))
  return { text: `${text}\nPage: file://${encodeURI(page)} (open it in a browser; it needs no network and runs no script)`, changed: false, openPane: true, section: 'map' }
}

/** Written by /ewm map --html next to system-map.md. */
export const MAP_HTML_FILE = 'system-map.html'

async function cmdQuestions(ctx: Ctx): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return noActiveOutput()
  return { text: renderQuestions(active.task), changed: false, openPane: true, section: 'questions' }
}

async function cmdPlan(ctx: Ctx): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return noActiveOutput()
  const { task, ledger, profile } = active
  switch (task.phase) {
    case 'INTAKE':
    case 'EXPLORE':
      return {
        text: `${task.id} is in ${task.phase}. The path is INTAKE > EXPLORE > UNDERSTAND > PLAN: finish exploring and agree on the understanding first, then run /ewm plan again.`,
        changed: false,
      }
    case 'UNDERSTAND': {
      const at = await nowIso(ctx.io)
      const moved = await moveTo(ctx, active, 'PLAN', 'user', 'the person asked to plan', at)
      return {
        text: `${task.id} moved UNDERSTAND > PLAN.\n\n${statusOf(moved.task, moved.ledger, profile)}`,
        kickoff: `The person is ready to plan ${task.id}. Load the skill ${skillFor('PLAN')} and write the plan.`,
        changed: true,
        openPane: true,
      }
    }
    case 'PAUSED':
      return { text: `${task.id} is paused. Run /ewm resume ${task.id} first.`, changed: false }
    default:
      return { text: renderPlan(task, gateOf(task, ledger, profile)), changed: false }
  }
}

async function cmdPause(ctx: Ctx): Promise<CommandOutput> {
  const { io, root } = ctx
  const ledger = await loadLedger(io, root)
  const id = ledger.active_task
  if (id === null) throw new EwmError('no_active_task', 'ewm: there is no active task to pause.')
  let task: Task
  let recovered = false
  try {
    const loaded = await loadTaskRecovering(io, root, id)
    task = withLedgerPhase(loaded.task, ledger)
    recovered = loaded.recovered
  } catch (error) {
    await saveLedger(io, root, { ...ledger, active_task: null })
    return {
      text: `${errorText(error)}\nThe active task ${id} could not be read, so it was deactivated. Run /ewm list to see what is left.`,
      changed: true,
    }
  }
  const at = await nowIso(io)
  const profile = profileOf(ledger, id)
  const paused = pause(task, at, 'paused by the person')
  await commitState(ctx, { ledger, profile, recovered }, paused, {
    at,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'pause', detail: `paused from ${task.phase}` }],
  })
  return {
    text: `Paused ${id} (was in ${task.phase}). The checkpoint is saved; continue later with /ewm resume ${id}.`,
    changed: true,
  }
}

/** Why a gate decision is not possible now, in the controller's own words when a gate exists for the phase. */
function noGateError(trusted: Task, profile: Profile, decision: 'approved' | 'rejected'): EwmError {
  const attempt: GateName | null = trusted.phase === 'PLAN' ? 'plan_approval' : trusted.phase === 'VALIDATE' ? 'done_acceptance' : null
  if (attempt !== null) {
    try {
      recordApproval(trusted, attempt, decision, 'command', trusted.updated_at, profile)
    } catch (error) {
      if (error instanceof EwmError) return error
    }
  }
  const verb = decision === 'approved' ? 'approve' : 'reject'
  return invalid(
    `nothing to ${verb} in ${trusted.phase}. A gate opens in PLAN once the plan has steps (plan approval) and in VALIDATE once a validation has passed (final acceptance).`,
  )
}

/** "hash 6ec3494e, 2 steps, updated <time>": what the person approves, echoed back so they can see which plan it was. */
function describePlan(plan: Plan): string {
  return `hash ${shortHash(planHash(plan))}, ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}, updated ${plan.updated_at}`
}

async function cmdDecide(
  ctx: Ctx,
  via: Via,
  decision: 'approved' | 'rejected',
  note: string | undefined,
  reviewedPlan: string | undefined,
): Promise<CommandOutput> {
  const active = await requireRunning(ctx, 'person')
  const { task, ledger, profile } = active
  const trusted = trustedOf(task, ledger)
  const gate = pendingGate(trusted, profile)
  if (gate === null) throw noGateError(trusted, profile, decision)
  if (decision === 'approved' && gate === 'plan_approval' && reviewedPlan !== undefined && trusted.plan !== null) {
    const current = planHash(trusted.plan)
    if (!current.startsWith(reviewedPlan.toLowerCase())) {
      throw invalid(
        `the plan changed after you reviewed it (you approved ${reviewedPlan.slice(0, 8)}; it is now ${describePlan(trusted.plan)}). Nothing was approved: read it with /ewm plan, then approve again.`,
      )
    }
  }

  const at = await nowIso(ctx.io)
  const withApproval = recordApproval(trusted, gate, decision, via, at, profile, note)
  const approval = withApproval.approvals[withApproval.approvals.length - 1]
  if (approval === undefined) throw invalid('the approval could not be recorded')
  const withEntry = updateLedgerEntry(ledger, task.id, entry => ({ ...entry, approvals: [...entry.approvals, approval] }), { profile, profile_source: null })
  const recorded: Task = { ...task, approvals: [...task.approvals, approval], updated_at: at }
  const approvalAudit: AuditDraft = {
    kind: 'approval',
    detail: `${gate} ${decision} via ${via}${trusted.plan !== null && gate === 'plan_approval' ? ` (${describePlan(trusted.plan)})` : ''}${note === undefined || note === '' ? '' : `: ${note}`}`,
  }

  if (decision === 'rejected') {
    const saved = await persist(ctx, { ledger: withEntry, profile, recovered: active.recovered === true }, recorded, {
      at,
      ledger: withEntry,
      artifacts: ['decisions.md', 'plan.md'],
      audit: [approvalAudit],
    })
    const reason = note ?? ''
    const next =
      gate === 'plan_approval'
        ? 'Revise the plan with mcp__ewm__set_plan (or go back with mcp__ewm__advance), then ask again.'
        : 'Fix the issues in IMPLEMENT (or re-plan), validate again, then ask for acceptance again.'
    return {
      text: `Rejected ${gate} for ${saved.id}: ${reason}\n${saved.id} stays in ${saved.phase}.`,
      kickoff: `The person rejected the ${gate} gate of ${saved.id}: "${reason}". ${next}`,
      changed: true,
      openPane: true,
    }
  }

  const to: Phase = gate === 'plan_approval' ? 'IMPLEMENT' : 'DONE'
  const moved = fromTrusted(recorded, transition(withApproval, to, 'user', `${gate} approved`, at, profile))
  const transitionAudit: AuditDraft = { kind: 'transition', detail: `${task.phase} -> ${to} by user: ${gate} approved` }
  const view = { profile, recovered: active.recovered === true }

  if (to === 'IMPLEMENT') {
    const saved = await commitState(ctx, { ledger: withEntry, ...view }, moved, {
      at,
      ledger: withEntry,
      artifacts: STATE_ARTIFACTS,
      audit: [approvalAudit, transitionAudit],
    })
    const echo = trusted.plan === null ? '' : ` (${describePlan(trusted.plan)})`
    return {
      text: `Plan approved${echo}. ${saved.task.id} moves to IMPLEMENT.\n\n${statusOf(saved.task, saved.ledger, profile)}`,
      kickoff: `The person approved the plan for ${saved.task.id}. Load the skill ${skillFor('IMPLEMENT')} and implement it step by step.`,
      changed: true,
      openPane: true,
    }
  }

  const changedFiles = await changedFilesOf(ctx, moved)
  const finished: Ledger = { ...withEntry, active_task: null }
  const saved = await persist(ctx, { ledger: finished, ...view }, moved, {
    at,
    ledger: finished,
    artifacts: [...STATE_ARTIFACTS, 'handoff.md'],
    changedFiles,
    audit: [approvalAudit, transitionAudit],
  })
  const handoff = joinPath(taskDir(ctx.root, saved.id), 'handoff.md')
  return {
    text: `Accepted. ${saved.id} is DONE and no task is active now.\nHandoff: ${handoff}`,
    changed: true,
    openPane: true,
  }
}

async function cmdList(ctx: Ctx): Promise<CommandOutput> {
  const { io, root } = ctx
  const ledger = await loadLedger(io, root)
  const tasks = await listTasks(io, root)
  const activeId = ledger.active_task
  const dangling = activeId !== null && !tasks.some(task => task.id === activeId)
  if (dangling) await saveLedger(io, root, { ...ledger, active_task: null })
  const list = renderTaskList(tasks, dangling ? null : activeId)
  const note = dangling ? `\n(${activeId} was the active task but could not be read, so it was deactivated.)` : ''
  return { text: list + note, changed: dangling }
}

/** Where the command's text is shown: the terminal width (80 when unknown). */
export type CommandOptions = { columns?: number }

async function dispatchCommand(ctx: Ctx, command: EwmCommand, via: Via, options: CommandOptions): Promise<CommandOutput> {
  switch (command.name) {
    case 'new':
      return cmdNew(ctx, command)
    case 'resume':
      return cmdResume(ctx, command)
    case 'status':
      return cmdStatus(ctx)
    case 'map':
      return cmdMap(ctx, options.columns ?? 80, command.html === true)
    case 'questions':
      return cmdQuestions(ctx)
    case 'plan':
      return cmdPlan(ctx)
    case 'pause':
      return cmdPause(ctx)
    case 'reset':
      return cmdReset(ctx)
    case 'approve':
      return cmdDecide(ctx, via, 'approved', command.note, command.plan)
    case 'reject':
      return cmdDecide(ctx, via, 'rejected', command.note, undefined)
    case 'list':
      return cmdList(ctx)
    case 'help':
      return { text: USAGE, changed: false }
  }
}

/** Parses and runs one /ewm command. `via` is 'pane' when invoked from a pane button. Never throws: EwmError becomes { text: message, changed: false }. */
export async function runCommand(ctx: Ctx, args: string, via: 'command' | 'pane', options: CommandOptions = {}): Promise<CommandOutput> {
  return withLock(async () => {
    try {
      const command = parseCommand(args)
      if ('error' in command) return { text: command.error, changed: false }
      return await dispatchCommand(ctx, command, via, options)
    } catch (error) {
      return { text: errorText(error), changed: false }
    }
  })
}

// ---------------------------------------------------------------------------
// Tool input validation
// ---------------------------------------------------------------------------

function checkedString(tool: string, label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${tool}: "${label}" must be a non-empty string.`)
  if (value.length > max) throw invalid(`${tool}: "${label}" is too long (${value.length} characters, at most ${max}).`)
  return value.trim()
}

function requireString(tool: string, input: Input, key: string, max = 2000): string {
  return checkedString(tool, key, input[key], max)
}

function optionalString(tool: string, input: Input, key: string, max = 2000): string | undefined {
  return input[key] === undefined ? undefined : requireString(tool, input, key, max)
}

/** A list of non-empty strings. A missing key is an error when min > 0 and an empty list otherwise. */
function stringList(tool: string, input: Input, key: string, min: number, max: number, itemMax = 1000): string[] {
  const value = input[key]
  if (value === undefined && min === 0) return []
  if (!Array.isArray(value)) throw invalid(`${tool}: "${key}" must be a list of strings (${min}-${max} items).`)
  if (value.length < min || value.length > max) throw invalid(`${tool}: "${key}" has ${value.length} items; it needs ${min}-${max}.`)
  return value.map((item, index) => checkedString(tool, `${key}[${index}]`, item, itemMax))
}

function objectList(tool: string, input: Input, key: string, min: number, max: number): Input[] {
  const value = input[key]
  if (!Array.isArray(value)) throw invalid(`${tool}: "${key}" must be a list of objects (${min}-${max} items).`)
  if (value.length < min || value.length > max) throw invalid(`${tool}: "${key}" has ${value.length} items; it needs ${min}-${max}.`)
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`${tool}: ${key}[${index}] must be an object.`)
    return item as Input
  })
}

function oneOf<T extends string>(tool: string, input: Input, key: string, allowed: readonly T[]): T {
  const value = input[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${tool}: "${key}" must be one of ${allowed.join(', ')}.`)
  }
  return value as T
}

function requirePhase(tool: string, task: Task, allowed: readonly Phase[]): void {
  if (!allowed.includes(task.phase)) {
    throw invalid(`${tool} works only in ${allowed.join(', ')}; ${task.id} is in ${task.phase}.`)
  }
}

// ---------------------------------------------------------------------------
// Model tools
// ---------------------------------------------------------------------------

type ToolHandler = (ctx: Ctx, active: Active, input: Input, at: string) => Promise<ToolOutput>

/** CR3: a model-tool write leaves a 'tool_effect' audit line with the tool and a one-line summary (redacted when appended). */
function effect(tool: string, summary: string): AuditDraft {
  return { kind: 'tool_effect', tool, detail: snippet(summary, 160) }
}

/** The first `max` characters of text on one line, with "..." when cut. */
function snippet(text: string, max = 80): string {
  const line = oneLine(text)
  return line.length <= max ? line : `${line.slice(0, max)}...`
}

function done(text: string): ToolOutput {
  return { ok: true, text, changed: true }
}

async function toolStatus(_ctx: Ctx, active: Active): Promise<ToolOutput> {
  const { task, ledger, profile } = active
  const gate = gateOf(task, ledger, profile)
  const facts = {
    id: task.id,
    phase: task.phase,
    pending_gate: gate.pending,
    open_question_ids: task.open_questions.filter(question => question.status === 'open').map(question => question.id),
    plan_step_ids: task.plan?.steps.map(step => step.id) ?? [],
    success_criteria: task.success_criteria,
  }
  return { ok: true, text: `${renderStatus(task, profile, gate)}\n\n${JSON.stringify(facts, null, 2)}`, changed: false }
}

const INTAKE_PHASES: readonly Phase[] = ['INTAKE', 'EXPLORE', 'UNDERSTAND', 'PLAN']

async function toolSetIntake(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'set_intake'
  const { task } = active
  requirePhase(tool, task, INTAKE_PHASES)
  const goal = optionalString(tool, input, 'goal')
  const successCriteria = stringList(tool, input, 'success_criteria', 1, 20)
  // Required even when empty: the lists are replaced, so a forgotten key must not silently clear them.
  if (input.constraints === undefined) throw invalid(`${tool}: "constraints" is required; pass [] for none.`)
  const constraints = stringList(tool, input, 'constraints', 0, 20)
  const next: Task = { ...task, goal: goal ?? task.goal, success_criteria: successCriteria, constraints, updated_at: at }
  await persist(ctx, active, next, {
    at,
    artifacts: ['decisions.md'],
    audit: [effect(tool, `intake saved: ${successCriteria.length} success criteria, ${constraints.length} constraints`)],
  })
  return done(`Intake saved for ${task.id}: ${successCriteria.length} success criteria, ${constraints.length} constraints.`)
}

async function toolAdvance(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'advance'
  const to = oneOf(tool, input, 'to', PHASES)
  const reason = requireString(tool, input, 'reason', 1000)
  const { task, profile } = active
  const check = checkTransition(trustedOf(task, active.ledger), to, 'model', profile)
  if (!check.ok) return { ok: false, text: check.reason, changed: false }
  const { task: moved } = await moveTo(ctx, active, to, 'model', reason, at)
  return done(`${task.id} moved ${task.phase} > ${moved.phase}. Next: ${moved.next_action}`)
}

// -- record_finding ----------------------------------------------------------

function countLines(text: string): number {
  if (text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/** Repo-relative, normalized evidence path; rejects absolute paths, '..' segments and workflow state. */
function evidencePath(label: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid(`record_finding: ${label}.path must be a non-empty string.`)
  const path = raw.trim()
  if (path.includes('\0')) throw invalid(`record_finding: ${label}.path contains a NUL character.`)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw invalid(`record_finding: ${label}.path must be relative to the repository root, not absolute (got "${path}").`)
  }
  const segments = path.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw invalid(`record_finding: ${label}.path must stay inside the repository (no ".." segments; got "${path}").`)
  if (segments.length === 0) throw invalid(`record_finding: ${label}.path "${path}" does not name a file.`)
  if (segments[0] === EWM_DIR) {
    throw invalid(`record_finding: ${label}.path "${path}" is inside ${EWM_DIR}/, which holds workflow state. Cite the repository file the claim is about.`)
  }
  return segments.join('/')
}

function lineNumber(label: string, field: 'line_start' | 'line_end', raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw invalid(`record_finding: ${label}.${field} must be an integer >= 1.`)
  }
  return raw
}

async function checkEvidence(ctx: Ctx, raw: Input, index: number): Promise<Evidence> {
  const label = `evidence[${index}]`
  const path = evidencePath(label, raw.path)
  if (!(await ctx.io.exists(joinPath(ctx.root, path)))) {
    throw invalid(`record_finding: ${label}.path "${path}" does not exist in the repository. Check the path with Glob or Grep and cite a real file.`)
  }
  const lineStart = lineNumber(label, 'line_start', raw.line_start)
  const lineEnd = lineNumber(label, 'line_end', raw.line_end)
  if (lineStart === undefined && lineEnd !== undefined) throw invalid(`record_finding: ${label}.line_end needs line_start.`)
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw invalid(`record_finding: ${label}.line_end (${lineEnd}) is before line_start (${lineStart}).`)
  }
  if (lineStart !== undefined) {
    let lines: number
    try {
      lines = countLines(await ctx.io.readText(joinPath(ctx.root, path)))
    } catch {
      throw invalid(`record_finding: ${label}.path "${path}" is not a readable file, so line numbers cannot be checked. Cite a file, or drop the line numbers.`)
    }
    const last = lineEnd ?? lineStart
    if (last > lines) throw invalid(`record_finding: ${label} cites line ${last} but ${path} has ${lines} lines.`)
  }
  const evidence: Evidence = { path }
  const fingerprint = await fingerprintOf(ctx, path)
  if (fingerprint !== null) evidence.fingerprint = fingerprint
  if (lineStart !== undefined) evidence.line_start = lineStart
  if (lineEnd !== undefined) evidence.line_end = lineEnd
  const docId = optionalString('record_finding', raw, 'doc_id', 200)
  if (docId !== undefined) evidence.doc_id = docId
  const note = optionalString('record_finding', raw, 'note', 500)
  if (note !== undefined) evidence.note = note
  return evidence
}

function claimKey(claim: string): string {
  return oneLine(claim).toLowerCase()
}

async function toolRecordFinding(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'record_finding'
  const { task } = active
  const claim = requireString(tool, input, 'claim')
  const evidence: Evidence[] = []
  for (const [index, raw] of objectList(tool, input, 'evidence', 1, 20).entries()) evidence.push(await checkEvidence(ctx, raw, index))
  const confidence: Confidence = oneOf(tool, input, 'confidence', ['high', 'medium', 'low'])
  const openQuestions = stringList(tool, input, 'open_questions', 0, 20)
  const source = optionalString(tool, input, 'source', 100) ?? 'lead'
  const commit = await gitLine(ctx, 'rev-parse', 'HEAD')

  const existing = task.findings.find(finding => claimKey(finding.claim) === claimKey(claim))
  const finding: Finding = {
    id: existing?.id ?? nextId('F', task.findings.map(item => item.id), 3),
    claim,
    evidence,
    confidence,
    open_questions: openQuestions,
    last_verified_commit: commit,
    source,
    stale: false,
    recorded_at: at,
  }
  const findings = existing === undefined ? [...task.findings, finding] : task.findings.map(item => (item.id === existing.id ? finding : item))
  const verb = existing === undefined ? 'Recorded' : 'Updated'
  await persist(ctx, active, { ...task, findings, updated_at: at }, {
    at,
    artifacts: ['exploration.md'],
    audit: [effect(tool, `${finding.id} ${verb.toLowerCase()}: ${snippet(claim)}`)],
  })
  return done(`${verb} ${finding.id} (${confidence}, ${evidence.length} evidence item(s)). ${task.id} now has ${findings.length} finding(s).`)
}

// -- question, decision ------------------------------------------------------

async function toolQuestion(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'question'
  const { task } = active
  const action = oneOf(tool, input, 'action', ['add', 'resolve'])
  if (action === 'add') {
    const text = requireString(tool, input, 'text')
    const duplicate = task.open_questions.find(question => question.status === 'open' && claimKey(question.text) === claimKey(text))
    if (duplicate !== undefined) return { ok: true, text: `Already open as ${duplicate.id}; nothing added.`, changed: false }
    const question: Question = { id: nextId('Q', task.open_questions.map(item => item.id), 3), text, status: 'open', raised_at: at }
    await persist(ctx, active, { ...task, open_questions: [...task.open_questions, question], updated_at: at }, {
      at,
      artifacts: ['questions.md'],
      audit: [effect(tool, `${question.id} added: ${snippet(text)}`)],
    })
    return done(`Added ${question.id}.`)
  }
  const id = requireString(tool, input, 'id', 20)
  const answer = requireString(tool, input, 'answer')
  const target = task.open_questions.find(question => question.id === id)
  if (target === undefined) {
    const open = task.open_questions.filter(question => question.status === 'open').map(question => question.id)
    throw invalid(`question: ${id} does not exist. Open questions: ${open.length === 0 ? 'none' : open.join(', ')}.`)
  }
  if (target.status === 'resolved') throw invalid(`question: ${id} is already resolved.`)
  const resolved: Question = { ...target, status: 'resolved', answer, resolved_at: at }
  const open_questions = task.open_questions.map(question => (question.id === id ? resolved : question))
  await persist(ctx, active, { ...task, open_questions, updated_at: at }, {
    at,
    artifacts: ['questions.md'],
    audit: [effect(tool, `${id} resolved: ${snippet(answer)}`)],
  })
  return done(`Resolved ${id}.`)
}

async function toolDecision(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'decision'
  const { task } = active
  const decision: Decision = {
    id: nextId('D', task.decisions.map(item => item.id), 3),
    title: requireString(tool, input, 'title', 300),
    choice: requireString(tool, input, 'choice'),
    rationale: requireString(tool, input, 'rationale'),
    phase: task.phase,
    decided_by: 'model',
    at,
  }
  await persist(ctx, active, { ...task, decisions: [...task.decisions, decision], updated_at: at }, {
    at,
    artifacts: ['decisions.md'],
    audit: [effect(tool, `${decision.id} recorded: ${snippet(decision.title)}`)],
  })
  return done(`Recorded ${decision.id}: ${decision.title}.`)
}

// -- plan --------------------------------------------------------------------

async function toolSetPlan(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'set_plan'
  const { task } = active
  requirePhase(tool, task, ['PLAN'])
  const summary = requireString(tool, input, 'summary', 4000)
  const steps: PlanStep[] = objectList(tool, input, 'steps', 1, 30).map((raw, index) => ({
    id: `S-${index + 1}`,
    text: requireString(tool, raw, 'text', 1000),
    files: stringList(tool, raw, 'files', 0, 50, 500),
    status: 'todo',
  }))
  const content = {
    summary,
    steps,
    risks: stringList(tool, input, 'risks', 0, 30),
    tests: stringList(tool, input, 'tests', 0, 30),
    alternatives: stringList(tool, input, 'alternatives', 0, 30),
  }
  const plan: Plan = { ...content, hash: planHash(content), updated_at: at }
  const saved = await persist(ctx, active, { ...task, plan, updated_at: at }, {
    at,
    artifacts: ['plan.md'],
    audit: [effect(tool, `plan saved: ${steps.length} step(s), hash ${shortHash(plan.hash)}: ${snippet(summary, 60)}`)],
  })
  const gate = gateOf(saved, active.ledger, active.profile)
  const next =
    gate.pending === 'plan_approval'
      ? 'Present the plan to the person and ask them to run /ewm approve (a changed plan needs a new approval).'
      : 'Present the plan to the person.'
  return done(`Plan saved with ${steps.length} step(s) (hash ${shortHash(plan.hash)}). ${next}`)
}

async function toolUpdateStep(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'update_step'
  const { task } = active
  requirePhase(tool, task, ['IMPLEMENT', 'VALIDATE'])
  const id = requireString(tool, input, 'id', 20)
  const status = oneOf(tool, input, 'status', ['todo', 'doing', 'done', 'skipped'])
  const plan = task.plan
  if (plan === null) throw invalid(`update_step: ${task.id} has no plan.`)
  if (!plan.steps.some(step => step.id === id)) {
    throw invalid(`update_step: step ${id} does not exist. Steps: ${plan.steps.map(step => step.id).join(', ')}.`)
  }
  const steps = plan.steps.map(step => (step.id === id ? { ...step, status } : step))
  await persist(ctx, active, { ...task, plan: { ...plan, steps, updated_at: at }, updated_at: at }, {
    at,
    artifacts: ['plan.md'],
    audit: [effect(tool, `${id} -> ${status}`)],
  })
  return done(`${id} is now ${status}.`)
}

// -- system map --------------------------------------------------------------

async function toolWriteMap(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'write_map'
  const { task } = active
  const mermaid = requireString(tool, input, 'mermaid', 20000)
  const parsed = parseFlowchart(mermaid)
  if (!parsed.ok) {
    throw invalid(
      `${tool}: the Mermaid source does not parse (${formatParseErrors(parsed.errors)}). ` +
        'Write a flowchart: "flowchart LR" on the first line, then one edge per line, e.g. A["src/a.ts"] -->|calls| B["src/b.ts"].',
    )
  }
  const { graph } = parsed
  const textMap = input.text_map === undefined || input.text_map === '' ? '' : requireString(tool, input, 'text_map', 20000)
  const listed = stringList(tool, input, 'components', 0, 100, 200)
  // Without a list, the components are the diagram's own nodes.
  const components = listed.length > 0 ? listed : graph.nodes.slice(0, 100).map(node => node.label.slice(0, 200))
  const system_map = { mermaid, text_map: textMap, components, updated_at: at }
  await persist(ctx, active, { ...task, system_map, updated_at: at }, {
    at,
    artifacts: ['system-map.md'],
    audit: [effect(tool, `system map saved: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ${components.length} component(s)`)],
  })
  return done(
    `System map saved: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ${components.length} component(s), to ${EWM_DIR}/tasks/${task.id}/system-map.md. ` +
      'The pane draws it (Map), and /ewm map draws it in the terminal.',
  )
}

// -- run_validation ----------------------------------------------------------

const OUTPUT_TAIL_CHARS = 4000
const REPORTED_TAIL_CHARS = 1500

type PreparedRun = { taskId: string; command: string; argv: string[]; timeoutMs: number }

/** First locked step: check the phase and the allowlist. Nothing is run here.
 *  CR11: the command, whitespace-normalized, must equal a profile.validation.commands entry exactly, with no shell syntax, and not be destructive or network. */
async function prepareValidation(ctx: Ctx, input: Input): Promise<PreparedRun> {
  const tool = 'run_validation'
  const { task, profile } = await requireRunning(ctx)
  requirePhase(tool, task, ['VALIDATE'])
  const command = requireString(tool, input, 'command', 1000)
  const normalized = oneLine(command)
  const allowed = profile.validation.commands
  const listed = allowed.some(entry => oneLine(entry) === normalized)
  const refusal = listed ? validationRefusal(normalized, profile) : null
  if (!listed || refusal !== null) {
    throw invalid(
      `run_validation: "${command}" is not an allowed validation command${refusal === null ? '' : ` (${refusal})`}. Allowed (the exact text, no extra arguments, no shell syntax): ${
        allowed.length === 0 ? 'none configured' : allowed.map(item => `"${item}"`).join(', ')
      }. To add one, ask the person to list it under validation.commands in ${EWM_DIR}/project.yaml and run /ewm resume.`,
    )
  }
  const argv = splitArgs(normalized)
  if (argv.length === 0) throw invalid('run_validation: "command" is empty.')
  return { taskId: task.id, command: normalized, argv, timeoutMs: profile.validation.timeout_ms }
}

/** Runs the command without holding the write queue: a long test run must not block other hooks. */
async function executeValidation(ctx: Ctx, prepared: PreparedRun): Promise<{ exitCode: number; output: string; durationMs: number }> {
  const started = await ctx.io.now()
  let exitCode: number
  let output: string
  try {
    const result = await ctx.io.run(prepared.argv, { cwd: ctx.root, timeoutMs: prepared.timeoutMs })
    exitCode = result.exitCode
    output = result.stderr === '' ? result.stdout : `${result.stdout}${result.stdout.endsWith('\n') || result.stdout === '' ? '' : '\n'}${result.stderr}`
  } catch (error) {
    exitCode = -1
    output = `ewm: could not run the command (not started, or it timed out after ${prepared.timeoutMs} ms): ${unprefixed(error instanceof Error ? error.message : String(error))}`
  }
  const finished = await ctx.io.now()
  return { exitCode, output, durationMs: Math.max(0, finished - started) }
}

/** Second locked step: record the run in task.json and in the ledger, where the gate trusts it. */
async function recordValidation(ctx: Ctx, prepared: PreparedRun, result: { exitCode: number; output: string; durationMs: number }): Promise<ToolOutput> {
  const active = await requireRunning(ctx)
  const { task, ledger, profile } = active
  if (task.id !== prepared.taskId || task.phase !== 'VALIDATE') {
    throw invalid(
      `run_validation: the command finished, but ${prepared.taskId} is no longer the active task in VALIDATE (now ${task.id} in ${task.phase}), so the result was not recorded. Run it again once the task is in VALIDATE.`,
    )
  }
  const at = await nowIso(ctx.io)
  const commit = await gitLine(ctx, 'rev-parse', 'HEAD')
  const ids = [...task.validations.map(run => run.id), ...(ledger.tasks[task.id]?.validations.map(run => run.id) ?? [])]
  const run: ValidationRun = {
    id: nextId('V', ids, 3),
    // The command is a profile entry, but the profile is not secret-free (a token in an argument); redact like the output.
    command: redactSecrets(prepared.command),
    exit_code: result.exitCode,
    ok: result.exitCode === 0,
    duration_ms: result.durationMs,
    // Redact before cutting, so a secret split by the cut cannot slip through.
    output_tail: tail(redactSecrets(result.output), OUTPUT_TAIL_CHARS),
    commit,
    at,
  }
  const nextLedger = updateLedgerEntry(
    ledger,
    task.id,
    // An older ledger entry has no validating_since (F5): the first run the mod records in VALIDATE sets it, so the person can accept after re-running validation.
    entry => ({
      ...entry,
      validating_since: typeof entry.validating_since === 'string' ? entry.validating_since : at,
      validations: [...entry.validations, { id: run.id, command: run.command, exit_code: run.exit_code, ok: run.ok, at }],
    }),
    { profile, profile_source: null },
  )
  const saved = await persist(ctx, { ledger: nextLedger, profile }, { ...task, validations: [...task.validations, run], updated_at: at }, {
    at,
    ledger: nextLedger,
    artifacts: ['validation.md'],
    audit: [{ kind: 'validation_run', detail: `${run.id} "${run.command}" exit ${run.exit_code}`, tool: 'run_validation', commit }],
  })
  const gate = gateOf(saved, nextLedger, profile)
  const guidance = !run.ok
    ? 'This run failed, so the person cannot accept yet. Report the failure, fix it in IMPLEMENT (mcp__ewm__advance to IMPLEMENT), then return to VALIDATE and run it again.'
    : gate.pending === 'done_acceptance'
      ? 'Summarize the results for the person and ask them to run /ewm approve to accept, or fix the problems in IMPLEMENT.'
      : ''
  const shown = tail(run.output_tail, REPORTED_TAIL_CHARS)
  return done(
    [
      `${run.id} ${run.ok ? 'PASS' : 'FAIL'}: ${run.command} (exit ${run.exit_code}, ${run.duration_ms} ms).`,
      shown.trim() === '' ? 'No output.' : `Output tail:\n${shown}`,
      guidance,
    ]
      .filter(line => line !== '')
      .join('\n'),
  )
}

async function toolRunValidation(ctx: Ctx, input: Input): Promise<ToolOutput> {
  const prepared = await withLock(() => prepareValidation(ctx, input))
  const result = await executeValidation(ctx, prepared)
  return withLock(() => recordValidation(ctx, prepared, result))
}

// -- registry ----------------------------------------------------------------

const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  status: toolStatus,
  set_intake: toolSetIntake,
  advance: toolAdvance,
  record_finding: toolRecordFinding,
  question: toolQuestion,
  decision: toolDecision,
  set_plan: toolSetPlan,
  update_step: toolUpdateStep,
  write_map: toolWriteMap,
}

const stringArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

export const TOOL_SPECS: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'status',
    description:
      'Shows the active ewm task: phase, counts, models used, the pending human gate and the next action, plus a JSON block with the ids you may need (open question ids, plan step ids, success criteria). ' +
      'Call it to re-orient after a pause, a long delegation or whenever you are unsure what comes next. Read-only. Needs an active task that is not paused or done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_intake',
    description:
      'Records the agreed goal, success criteria and constraints of the task, replacing the previous lists. Call it at the end of INTAKE once the person confirmed them, and again if they change. ' +
      'Works from INTAKE through PLAN. Needs 1-20 success criteria and 0-20 constraints. Updates decisions.md.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal in one or two sentences. Omit to keep the current goal.' },
        success_criteria: stringArray('How the person will know the task is done: 1-20 short, checkable statements.'),
        constraints: stringArray('Limits the work must respect (scope, style, compatibility, deadlines): 0-20 statements. Use [] for none.'),
      },
      required: ['success_criteria', 'constraints'],
      additionalProperties: false,
    },
  },
  {
    name: 'advance',
    description:
      'Moves the task to the next workflow phase. Allowed edges: INTAKE>EXPLORE, EXPLORE>UNDERSTAND, UNDERSTAND>EXPLORE, PLAN>UNDERSTAND|IMPLEMENT, IMPLEMENT>VALIDATE, VALIDATE>IMPLEMENT|PLAN|DONE. ' +
      'UNDERSTAND>PLAN is the person\'s call: ask whether they are ready and let them run /ewm plan (this tool refuses it). ' +
      'PLAN>IMPLEMENT needs a plan with steps and, per the profile, the person\'s approval of that exact plan; VALIDATE>DONE needs a passing validation run since entering VALIDATE and the person\'s acceptance. ' +
      'You cannot approve for the person: when a gate blocks you, this tool says so; ask the person to run /ewm approve and wait.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: [...PHASES], description: 'The phase to move to.' },
        reason: { type: 'string', description: 'Why the exit condition of the current phase is met, in one sentence.' },
      },
      required: ['to', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_finding',
    description:
      'Records one sourced finding about the repository. Call it for each verified fact you will rely on, usually from EXPLORE on; never record guesses or scout claims you did not check. ' +
      'Every finding needs 1-20 evidence items: a repo-relative path that exists (no absolute path, no "..", nothing under .ewm/) with optional line_start/line_end inside the file (line_end >= line_start). ' +
      'A claim that matches an existing one (ignoring case and spacing) updates that finding instead of adding a new one. Stamps the id (F-001...) and the current commit; updates exploration.md.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'One factual sentence, e.g. "sum() skips the last element".' },
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Where the claim comes from.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File or doc path relative to the repository root, e.g. "src/math.ts".' },
              line_start: { type: 'integer', minimum: 1, description: 'First line cited (1-based).' },
              line_end: { type: 'integer', minimum: 1, description: 'Last line cited; needs line_start and must not be before it.' },
              doc_id: { type: 'string', description: 'Section or ADR identifier inside a document, when the path alone is too coarse.' },
              note: { type: 'string', description: 'What this evidence shows.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are, given the evidence.' },
        open_questions: stringArray('Questions this finding raises and the evidence does not answer.'),
        source: { type: 'string', description: 'Who produced it: "lead" (default) or an agent type such as "ewm:repo-scout".' },
      },
      required: ['claim', 'evidence', 'confidence'],
      additionalProperties: false,
    },
  },
  {
    name: 'question',
    description:
      'Adds an open question for the person, or resolves one with the answer they gave. Use action "add" with "text" when something blocks understanding or the plan and only the person can answer; ' +
      'use action "resolve" with "id" (Q-001...) and "answer" once they answered. Updates questions.md.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'resolve'], description: '"add" a new question or "resolve" an existing one.' },
        text: { type: 'string', description: 'For add: the question, self-contained.' },
        id: { type: 'string', description: 'For resolve: the question id, e.g. "Q-001".' },
        answer: { type: 'string', description: 'For resolve: the answer the person gave.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'decision',
    description:
      'Records a decision the person stated or approved (a design choice, a scope cut, an assumption they confirmed), with the reason. Do not record your own preferences as decisions. ' +
      'Stamps D-001... with the current phase and updates decisions.md.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the decision.' },
        choice: { type: 'string', description: 'What was decided.' },
        rationale: { type: 'string', description: 'Why, in the person\'s terms.' },
      },
      required: ['title', 'choice', 'rationale'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_plan',
    description:
      'Saves the implementation plan, replacing any earlier one. Only in PLAN. 1-30 steps, each with the files it touches, plus risks, tests and alternatives considered. ' +
      'Changing the plan voids an earlier approval: after calling this, present the plan and ask the person to run /ewm approve; PLAN>IMPLEMENT stays blocked until they do. Updates plan.md.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What the change does and why, in a few sentences.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          description: 'Ordered implementation steps; ids S-1, S-2... are assigned.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'What to do in this step.' },
              files: stringArray('Repo-relative files the step creates or edits.'),
            },
            required: ['text', 'files'],
            additionalProperties: false,
          },
        },
        risks: stringArray('What could go wrong.'),
        tests: stringArray('How the change will be verified.'),
        alternatives: stringArray('Other approaches considered and why they were not chosen.'),
      },
      required: ['summary', 'steps', 'risks', 'tests', 'alternatives'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_step',
    description: 'Sets the status of one plan step (todo, doing, done, skipped). Call it as you work through the approved plan. Only in IMPLEMENT or VALIDATE. Updates plan.md.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The step id, e.g. "S-2".' },
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'skipped'], description: 'The new status.' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_map',
    description:
      'Saves the system map: a Mermaid flowchart, optional notes and the component names. Call it in EXPLORE or UNDERSTAND once you can explain how the parts fit, and again when the understanding changes. ' +
      'The source is parsed: a syntax error is refused with its line and column. The pane draws the diagram (as SVG on desktop, as text in the terminal) and /ewm map draws it in the terminal; system-map.md keeps the source.',
    inputSchema: {
      type: 'object',
      properties: {
        mermaid: {
          type: 'string',
          minLength: 1,
          maxLength: 20000,
          description:
            'Mermaid flowchart source without the code fence, e.g. "flowchart LR\\n  A[\\"src/a.ts\\"] -->|calls| B[\\"src/b.ts\\"]". Supported: flowchart/graph with TD, TB, BT, LR or RL; node shapes [] () ([]) [[]] [()] (()) {} {{}}; edges --> --- -.-> ==> with |label|; A & B --> C; subgraph ... end.',
        },
        text_map: { type: 'string', description: 'Optional notes shown under the diagram, one short line each (what the arrows cannot say).' },
        components: stringArray('Names of the components on the map; defaults to the diagram\'s node labels.'),
      },
      required: ['mermaid'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_validation',
    description:
      'Runs one validation command and records its exit code and output tail as evidence for the final acceptance. Only in VALIDATE. ' +
      'The command must equal one of the profile\'s validation.commands exactly (extra arguments are refused; no pipes, redirects, quotes or other shell syntax). It runs without a shell in the repository root. ' +
      'Run it yourself with this tool: runs made any other way do not count. Only a passing run recorded since the task entered VALIDATE lets the person accept: when it passes, ask them to run /ewm approve; when it fails, fix it in IMPLEMENT and run it again.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, e.g. "npm test".' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
]

/** Runs one model tool by short name (e.g. 'record_finding'). Never throws: errors become { ok: false, text }. */
export async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const shortName = name.startsWith('mcp__ewm__') ? name.slice('mcp__ewm__'.length) : name
  const fail = (error: unknown): ToolOutput => ({ ok: false, text: errorText(error), changed: false })
  if (!TOOL_SPECS.some(spec => spec.name === shortName)) {
    return fail(invalid(`unknown tool "${name}". Available: ${TOOL_SPECS.map(spec => spec.name).join(', ')}.`))
  }
  const args: Input = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}
  try {
    if (shortName === 'run_validation') return await toolRunValidation(ctx, args)
    const handler = TOOL_HANDLERS[shortName]
    if (handler === undefined) return fail(invalid(`unknown tool "${name}".`))
    return await withLock(async () => {
      const active = await requireRunning(ctx)
      return handler(ctx, active, args, await nowIso(ctx.io))
    })
  } catch (error) {
    return fail(error)
  }
}

// ---------------------------------------------------------------------------
// For the hooks module
// ---------------------------------------------------------------------------

/** For the policy guard. Reads the ledger first; returns { task: null, profile: DEFAULT_PROFILE, phase: null } when no task is active WITHOUT touching any other file.
 *  With an active task, `phase` is the LEDGER's phase and `profile` the ledger's snapshot (F1). `task` is task.json (or its backup) with the ledger's phase, or null when neither can be
 *  read: the guard then still enforces `phase`, so a deleted task folder (git clean -fdx) cannot switch the policy off or deny every call until someone notices.
 *  A malformed ledger throws (the guard fails closed; the message names /ewm reset). */
export async function activeContext(ctx: Ctx): Promise<{ task: Task | null; profile: Profile; phase: Phase | null }> {
  const ledger = await loadLedger(ctx.io, ctx.root)
  const id = ledger.active_task
  if (id === null) return { task: null, profile: DEFAULT_PROFILE, phase: null }
  const entry = ledger.tasks[id]
  if (entry === undefined) throw new EwmError('parse_error', `ewm: the gate ledger names ${id} as active but has no entry for it. Ask the person to run /ewm reset.`)
  try {
    const { task } = await loadTaskRecovering(ctx.io, ctx.root, id)
    return { task: withLedgerPhase(task, ledger), profile: entry.profile, phase: entry.phase }
  } catch {
    return { task: null, profile: entry.profile, phase: entry.phase }
  }
}

/** The id of the active task per the ledger, or null (throws on a malformed ledger). The guard names it when the task's files are missing. */
export async function activeTaskId(ctx: Ctx): Promise<string | null> {
  return (await loadLedger(ctx.io, ctx.root)).active_task
}

/** The active task when it is running (neither PAUSED nor DONE), else null. */
async function loadRunning(ctx: Ctx): Promise<Active | null> {
  const active = await loadActive(ctx)
  return active === null || active.task.phase === 'PAUSED' || active.task.phase === 'DONE' ? null : active
}

/** Records an agent spawn on the active task (no-op without one) and appends an audit line. */
export async function recordAgentSpawn(
  ctx: Ctx,
  use: { agent_type: string; model: string; routed_model?: string; agent_id?: string; description?: string; rule: string },
): Promise<void> {
  await withLock(async () => {
    const active = await loadRunning(ctx)
    if (active === null) return
    const at = await nowIso(ctx.io)
    const record: Task['agent_usage'][number] = { agent_type: use.agent_type, model: use.model, phase: active.task.phase, rule: use.rule, at }
    if (use.routed_model !== undefined) record.routed_model = use.routed_model
    if (use.agent_id !== undefined) record.agent_id = use.agent_id
    if (use.description !== undefined) record.description = use.description
    const routed = use.routed_model === undefined ? '' : ` (routed ${use.routed_model})`
    await persist(ctx, active, { ...active.task, agent_usage: [...active.task.agent_usage, record], updated_at: at }, {
      at,
      audit: [{ kind: 'agent_spawn', detail: `${use.agent_type} on ${use.model}${routed}; rule ${use.rule}` }],
    })
  })
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

/** Adds one turn's usage to usage_by_phase[task.phase] of the active task (no-op without one). */
export async function recordUsage(ctx: Ctx, usage: Partial<PhaseUsage>): Promise<void> {
  await withLock(async () => {
    const active = await loadRunning(ctx)
    if (active === null) return
    const { task } = active
    const at = await nowIso(ctx.io)
    const before: PhaseUsage = task.usage_by_phase[task.phase] ?? {
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const after: PhaseUsage = {
      turns: before.turns + (usage.turns === undefined ? 1 : count(usage.turns)),
      input_tokens: before.input_tokens + count(usage.input_tokens),
      output_tokens: before.output_tokens + count(usage.output_tokens),
      cache_read_input_tokens: before.cache_read_input_tokens + count(usage.cache_read_input_tokens),
      cache_creation_input_tokens: before.cache_creation_input_tokens + count(usage.cache_creation_input_tokens),
    }
    await persist(ctx, active, { ...task, usage_by_phase: { ...task.usage_by_phase, [task.phase]: after }, updated_at: at }, { at })
  })
}

/** Records a denied tool call in the active task's audit log (no-op without one). */
export async function recordDenial(ctx: Ctx, tool: string, reason: string): Promise<void> {
  await withLock(async () => {
    const active = await loadActive(ctx)
    if (active === null) return
    const at = await nowIso(ctx.io)
    try {
      await appendAudit(ctx.io, ctx.root, active.task.id, { at, kind: 'tool_denied', phase: active.task.phase, detail: reason, tool })
    } catch {
      // The audit log never fails a mutation (CR13), and a denial is already delivered to the model.
    }
  })
}

/** The pane model of the active task, or null. */
export async function currentView(ctx: Ctx): Promise<PaneModel | null> {
  const active = await loadActive(ctx)
  if (active === null) return null
  return paneModel(active.task, active.profile, gateOf(active.task, active.ledger, active.profile))
}

/** Status-line text for the active running task ("ewm TASK-001 · EXPLORE · 2 open questions"), or null. */
export async function statusLine(ctx: Ctx): Promise<string | null> {
  const active = await loadRunning(ctx)
  if (active === null) return null
  const { task } = active
  const open = task.open_questions.filter(question => question.status === 'open').length
  const parts = [`ewm ${task.id}`, task.phase]
  if (open > 0) parts.push(`${open} open question${open === 1 ? '' : 's'}`)
  if (pendingGate(trustedOf(task, active.ledger), active.profile) !== null) parts.push('awaiting /ewm approve')
  return parts.join(' · ')
}
