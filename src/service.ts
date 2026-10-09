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
import { classifyBash } from './policies.ts'
import { DEFAULT_PROFILE, loadProfile } from './profile.ts'
import {
  paneModel,
  renderDecisions,
  renderExploration,
  renderHandoff,
  renderPlan,
  renderQuestions,
  renderResumeBrief,
  renderStatus,
  renderSystemMap,
  renderTaskList,
  renderValidation,
} from './render.ts'
import type { GateState } from './render.ts'
import { summarizeModels } from './router.ts'
import {
  EWM_DIR,
  appendAudit,
  createTask,
  ensureWorkspace,
  joinPath,
  listTasks,
  loadLedger,
  loadTask,
  nextTaskId,
  redactSecrets,
  saveLedger,
  saveTask,
  taskDir,
  trustedTask,
  updateLedgerEntry,
  writeArtifact,
} from './store.ts'
import { ARTIFACT_NAMES, EwmError, PHASES } from './types.ts'
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
  ValidationRun,
} from './types.ts'

export type Ctx = { io: Io; root: string } // root is absolute

type Input = Record<string, unknown>

/** The active task as the ledger names it, with the profile snapshot the guard and tools must use. */
type Active = { ledger: Ledger; task: Task; profile: Profile }

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

function errorText(error: unknown): string {
  if (error instanceof EwmError) return error.message
  return `ewm: unexpected error: ${error instanceof Error ? error.message : String(error)}`
}

function invalid(message: string): EwmError {
  return new EwmError('invalid_input', `ewm: ${message}`)
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

const NO_ACTIVE_TASK_HELP = 'ewm: there is no active task. Ask the person to run /ewm new "<title>" or /ewm resume.'

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

/** Undoes git's C-style quoting of unusual path names. */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  return path.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

function isWorkflowState(path: string): boolean {
  return path === EWM_DIR || path.startsWith(`${EWM_DIR}/`)
}

function pathList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => unquoteGitPath(line.trim()))
    .filter(path => path !== '' && !isWorkflowState(path))
}

/** Paths changed between `commit` and HEAD, relative to root; null when git cannot tell. */
async function changedSince(ctx: Ctx, commit: string): Promise<string[] | null> {
  if (!COMMIT_PATTERN.test(commit)) return null
  const out = await git(ctx, 'diff', '--name-only', '--relative', commit, 'HEAD')
  return out === null ? null : pathList(out)
}

/** Paths git reports as modified, added, renamed (new name) or untracked, relative to root; null when git cannot tell. */
async function worktreeChanges(ctx: Ctx): Promise<string[] | null> {
  const out = await git(ctx, 'status', '--porcelain')
  if (out === null) return null
  // Porcelain paths are relative to the repository top level; root may be a subdirectory.
  const prefix = (await git(ctx, 'rev-parse', '--show-prefix'))?.trim() ?? ''
  const paths: string[] = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    path = unquoteGitPath(path)
    if (!path.startsWith(prefix)) continue // outside root
    path = path.slice(prefix.length)
    if (path !== '' && !isWorkflowState(path)) paths.push(path)
  }
  return paths
}

/** Whether `path` is among the changed paths (a changed directory such as "src/new/" covers what is inside it). */
function isChanged(path: string, changed: readonly string[]): boolean {
  return changed.some(entry => entry === path || (entry.endsWith('/') && path.startsWith(entry)))
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
 * Marks findings whose evidence file changed since it was verified. Never re-runs validations or
 * any other side effect. When git cannot answer, nothing is marked and `checked` is false.
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
    // A commit git cannot diff against cannot vouch for the evidence either.
    const touched = committed === null || finding.evidence.some(item => isChanged(item.path, [...committed, ...dirty]))
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

/** The active task per the ledger, or null when none is active. Throws when the ledger or the task is unreadable. */
async function loadActive(ctx: Ctx): Promise<Active | null> {
  const ledger = await loadLedger(ctx.io, ctx.root)
  if (ledger.active_task === null) return null
  const task = await loadTask(ctx.io, ctx.root, ledger.active_task)
  return { ledger, task, profile: profileOf(ledger, task.id) }
}

async function requireActive(ctx: Ctx): Promise<Active> {
  const active = await loadActive(ctx)
  if (active === null) throw new EwmError('no_active_task', NO_ACTIVE_TASK_HELP)
  return active
}

/** The active task, which must be neither PAUSED nor DONE. */
async function requireRunning(ctx: Ctx): Promise<Active> {
  const active = await requireActive(ctx)
  const { task } = active
  if (task.phase === 'PAUSED') {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is paused, so the workflow tools are off. Ask the person to run /ewm resume ${task.id}.`)
  }
  if (task.phase === 'DONE') {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is DONE. Ask the person to run /ewm new "<title>" to start another task.`)
  }
  return active
}

/** What the controller sees: approvals and validations from the ledger only. */
function trustedOf(task: Task, ledger: Ledger): Task {
  return trustedTask(task, ledger.tasks[task.id])
}

function gateOf(task: Task, ledger: Ledger, profile: Profile): GateState {
  const trusted = trustedOf(task, ledger)
  return {
    pending: pendingGate(trusted, profile),
    planApproved: hasValidApproval(trusted, 'plan_approval'),
    models: summarizeModels(task.agent_usage),
  }
}

function statusOf(task: Task, ledger: Ledger, profile: Profile): string {
  return renderStatus(task, profile, gateOf(task, ledger, profile))
}

/** Carries a controller result computed on the trusted task back onto the real one: task.json keeps its own approvals and validations. */
function fromTrusted(original: Task, computed: Task): Task {
  return { ...computed, approvals: original.approvals, validations: original.validations }
}

// ---------------------------------------------------------------------------
// Persisting a mutation: save task (+ ledger), re-render artifacts, append audit
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

/** Saves the task (listing the artifacts it now has), stores a changed ledger, re-renders `artifacts` and appends the audit lines. */
async function persist(ctx: Ctx, view: { ledger: Ledger; profile: Profile }, task: Task, options: PersistOptions): Promise<Task> {
  const { io, root } = ctx
  const names = options.artifacts ?? []
  const present = new Set([...task.artifacts, ...names])
  const saved: Task = { ...task, artifacts: ARTIFACT_NAMES.filter(name => present.has(name)) }
  await saveTask(io, root, saved)
  if (options.ledger !== undefined) await saveLedger(io, root, options.ledger)
  const gate = gateOf(saved, options.ledger ?? view.ledger, view.profile)
  for (const name of names) {
    await writeArtifact(io, root, saved.id, name, renderArtifact(name, saved, gate, options.changedFiles ?? []))
  }
  for (const draft of options.audit ?? []) {
    const entry: AuditEntry = { at: options.at, kind: draft.kind, phase: saved.phase, detail: draft.detail }
    if (draft.tool !== undefined) entry.tool = draft.tool
    if (draft.commit !== undefined) entry.commit = draft.commit
    await appendAudit(io, root, saved.id, entry)
  }
  return saved
}

// ---------------------------------------------------------------------------
// Phase moves shared by commands and tools
// ---------------------------------------------------------------------------

async function moveTo(ctx: Ctx, active: Active, to: Phase, actor: 'user' | 'model', reason: string, at: string): Promise<Task> {
  const { task, profile } = active
  const moved = transition(trustedOf(task, active.ledger), to, actor, reason, at, profile)
  return persist(ctx, active, fromTrusted(task, moved), {
    at,
    artifacts: ['decisions.md', 'plan.md'],
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

/** Pauses the ledger's active task when it is running and is not `keepId`; says what it did. A task that cannot be read is left alone. */
async function pauseOther(ctx: Ctx, ledger: Ledger, keepId: string | null, at: string): Promise<string | null> {
  const otherId = ledger.active_task
  if (otherId === null || otherId === keepId) return null
  try {
    const other = await loadTask(ctx.io, ctx.root, otherId)
    if (other.phase === 'PAUSED' || other.phase === 'DONE') return null
    const paused = pause(other, at, `paused: the person started or resumed another task`)
    await persist(ctx, { ledger, profile: profileOf(ledger, otherId) }, paused, {
      at,
      artifacts: ['decisions.md'],
      audit: [{ kind: 'pause', detail: `paused from ${other.phase}: another task became active` }],
    })
    return `Paused ${otherId} (was in ${other.phase}); resume it later with /ewm resume ${otherId}.`
  } catch (error) {
    return `Could not pause ${otherId} (${errorText(error)}); it was left untouched.`
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

async function cmdNew(ctx: Ctx, command: Extract<EwmCommand, { name: 'new' }>): Promise<CommandOutput> {
  const { io, root } = ctx
  await ensureWorkspace(io, root)
  const { profile, source, warnings } = await loadProfile(io, root)
  const ledger = await loadLedger(io, root)
  const at = await nowIso(io)
  const pausedNote = await pauseOther(ctx, ledger, null, at)

  const id = await nextTaskId(io, root)
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
  const withEntry = updateLedgerEntry(ledger, id, entry => entry, { profile, profile_source: source })
  const nextLedger: Ledger = { ...withEntry, active_task: id }
  const saved = await persist(ctx, { ledger: nextLedger, profile }, task, {
    at,
    ledger: nextLedger,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'task_created', detail: `${id} "${command.title}" on profile ${profile.profile_id}`, commit: baseCommit }],
  })
  const text = [
    `Started ${id}: ${command.title}`,
    ...(pausedNote === null ? [] : [pausedNote]),
    ...warningLines(warnings),
    '',
    statusOf(saved, nextLedger, profile),
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

async function cmdResume(ctx: Ctx, command: Extract<EwmCommand, { name: 'resume' }>): Promise<CommandOutput> {
  const { io, root } = ctx
  const ledger = await loadLedger(io, root)
  const id = command.id ?? (await defaultResumeId(ctx, ledger))
  const loaded = await loadTask(io, root, id)
  if (loaded.phase === 'DONE') {
    throw invalid(`${id} is DONE, so there is nothing to resume. Its handoff is in ${EWM_DIR}/tasks/${id}/handoff.md; start a new task with /ewm new.`)
  }
  const { profile, source, warnings } = await loadProfile(io, root)
  const at = await nowIso(io)
  const pausedNote = await pauseOther(ctx, ledger, id, at)

  const { staleness, task: checked } = await checkStaleness(ctx, loaded)
  const resumed = { ...resume(checked, at), updated_at: at }
  // Humans reload the profile here; the guard and tools use this snapshot until the next resume.
  const withEntry = updateLedgerEntry(ledger, id, entry => ({ ...entry, profile, profile_source: source }), { profile, profile_source: source })
  const nextLedger: Ledger = { ...withEntry, active_task: id }
  const saved = await persist(ctx, { ledger: nextLedger, profile }, resumed, {
    at,
    ledger: nextLedger,
    artifacts: STATE_ARTIFACTS,
    audit: [{ kind: 'resume', detail: `resumed in ${resumed.phase}; ${staleness.checked ? `${staleness.stale_findings.length} finding(s) newly stale` : 'staleness not checked'}` }],
  })
  const brief = renderResumeBrief(saved, staleness)
  const text = [brief, ...(pausedNote === null ? [] : ['', pausedNote]), ...warningLines(warnings)].join('\n')
  return {
    text,
    context: [brief, 'Do not repeat side-effecting operations; re-verify stale evidence before relying on it.'],
    kickoff: `Continue ${id} in ${saved.phase}: load the skill ${skillFor(saved.phase)} and pick up from the resume brief.`,
    changed: true,
    openPane: true,
  }
}

async function cmdStatus(ctx: Ctx): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return { ...noActiveOutput(), openPane: true }
  return { text: statusOf(active.task, active.ledger, active.profile), changed: false, openPane: true }
}

async function cmdMap(ctx: Ctx): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return noActiveOutput()
  const path = joinPath(taskDir(ctx.root, active.task.id), 'system-map.md')
  return { text: `${renderSystemMap(active.task).trimEnd()}\n\nFile: ${path}`, changed: false }
}

async function cmdQuestions(ctx: Ctx): Promise<CommandOutput> {
  const active = await loadActive(ctx)
  if (active === null) return noActiveOutput()
  return { text: renderQuestions(active.task), changed: false }
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
        text: `${task.id} moved UNDERSTAND > PLAN.\n\n${statusOf(moved, ledger, profile)}`,
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
  try {
    task = await loadTask(io, root, id)
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
  await persist(ctx, { ledger, profile }, paused, {
    at,
    artifacts: ['decisions.md'],
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
    `nothing to ${verb} in ${trusted.phase}. A gate opens in PLAN once the plan has steps (plan approval) and in VALIDATE once a validation has run (final acceptance).`,
  )
}

async function cmdDecide(ctx: Ctx, via: Via, decision: 'approved' | 'rejected', note: string | undefined): Promise<CommandOutput> {
  const active = await requireRunning(ctx)
  const { task, ledger, profile } = active
  const trusted = trustedOf(task, ledger)
  const gate = pendingGate(trusted, profile)
  if (gate === null) throw noGateError(trusted, profile, decision)

  const at = await nowIso(ctx.io)
  const withApproval = recordApproval(trusted, gate, decision, via, at, profile, note)
  const approval = withApproval.approvals[withApproval.approvals.length - 1]
  if (approval === undefined) throw invalid('the approval could not be recorded')
  const withEntry = updateLedgerEntry(ledger, task.id, entry => ({ ...entry, approvals: [...entry.approvals, approval] }), { profile, profile_source: null })
  const recorded: Task = { ...task, approvals: [...task.approvals, approval], updated_at: at }
  const approvalAudit: AuditDraft = {
    kind: 'approval',
    detail: `${gate} ${decision} via ${via}${note === undefined || note === '' ? '' : `: ${note}`}`,
  }

  if (decision === 'rejected') {
    const saved = await persist(ctx, { ledger: withEntry, profile }, recorded, {
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

  if (to === 'IMPLEMENT') {
    const saved = await persist(ctx, { ledger: withEntry, profile }, moved, {
      at,
      ledger: withEntry,
      artifacts: ['decisions.md', 'plan.md'],
      audit: [approvalAudit, transitionAudit],
    })
    return {
      text: `Plan approved. ${saved.id} moves to IMPLEMENT.\n\n${statusOf(saved, withEntry, profile)}`,
      kickoff: `The person approved the plan for ${saved.id}. Load the skill ${skillFor('IMPLEMENT')} and implement it step by step.`,
      changed: true,
      openPane: true,
    }
  }

  const changedFiles = await changedFilesOf(ctx, moved)
  const finished: Ledger = { ...withEntry, active_task: null }
  const saved = await persist(ctx, { ledger: finished, profile }, moved, {
    at,
    ledger: finished,
    artifacts: ['decisions.md', 'plan.md', 'handoff.md'],
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

async function dispatchCommand(ctx: Ctx, command: EwmCommand, via: Via): Promise<CommandOutput> {
  switch (command.name) {
    case 'new':
      return cmdNew(ctx, command)
    case 'resume':
      return cmdResume(ctx, command)
    case 'status':
      return cmdStatus(ctx)
    case 'map':
      return cmdMap(ctx)
    case 'questions':
      return cmdQuestions(ctx)
    case 'plan':
      return cmdPlan(ctx)
    case 'pause':
      return cmdPause(ctx)
    case 'approve':
      return cmdDecide(ctx, via, 'approved', command.note)
    case 'reject':
      return cmdDecide(ctx, via, 'rejected', command.note)
    case 'list':
      return cmdList(ctx)
    case 'help':
      return { text: USAGE, changed: false }
  }
}

/** Parses and runs one /ewm command. `via` is 'pane' when invoked from a pane button. Never throws: EwmError becomes { text: message, changed: false }. */
export async function runCommand(ctx: Ctx, args: string, via: 'command' | 'pane'): Promise<CommandOutput> {
  return withLock(async () => {
    try {
      const command = parseCommand(args)
      if ('error' in command) return { text: command.error, changed: false }
      return await dispatchCommand(ctx, command, via)
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
  await persist(ctx, active, next, { at, artifacts: ['decisions.md'] })
  return done(`Intake saved for ${task.id}: ${successCriteria.length} success criteria, ${constraints.length} constraints.`)
}

async function toolAdvance(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'advance'
  const to = oneOf(tool, input, 'to', PHASES)
  const reason = requireString(tool, input, 'reason', 1000)
  const { task, profile } = active
  const check = checkTransition(trustedOf(task, active.ledger), to, 'model', profile)
  if (!check.ok) return { ok: false, text: check.reason, changed: false }
  const moved = await moveTo(ctx, active, to, 'model', reason, at)
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
  await persist(ctx, active, { ...task, findings, updated_at: at }, { at, artifacts: ['exploration.md'] })
  const verb = existing === undefined ? 'Recorded' : 'Updated'
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
    await persist(ctx, active, { ...task, open_questions: [...task.open_questions, question], updated_at: at }, { at, artifacts: ['questions.md'] })
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
  await persist(ctx, active, { ...task, open_questions, updated_at: at }, { at, artifacts: ['questions.md'] })
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
  await persist(ctx, active, { ...task, decisions: [...task.decisions, decision], updated_at: at }, { at, artifacts: ['decisions.md'] })
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
  const saved = await persist(ctx, active, { ...task, plan, updated_at: at }, { at, artifacts: ['plan.md'] })
  const gate = gateOf(saved, active.ledger, active.profile)
  const next =
    gate.pending === 'plan_approval'
      ? 'Present the plan to the person and ask them to run /ewm approve (a changed plan needs a new approval).'
      : 'Present the plan to the person.'
  return done(`Plan saved with ${steps.length} step(s) (hash ${plan.hash}). ${next}`)
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
  await persist(ctx, active, { ...task, plan: { ...plan, steps, updated_at: at }, updated_at: at }, { at, artifacts: ['plan.md'] })
  return done(`${id} is now ${status}.`)
}

// -- system map --------------------------------------------------------------

async function toolWriteMap(ctx: Ctx, active: Active, input: Input, at: string): Promise<ToolOutput> {
  const tool = 'write_map'
  const { task } = active
  const mermaid = requireString(tool, input, 'mermaid', 20000)
  const textMap = requireString(tool, input, 'text_map', 20000)
  const components = stringList(tool, input, 'components', 0, 100, 200)
  const system_map = { mermaid, text_map: textMap, components, updated_at: at }
  await persist(ctx, active, { ...task, system_map, updated_at: at }, { at, artifacts: ['system-map.md'] })
  return done(`System map saved with ${components.length} component(s) to ${EWM_DIR}/tasks/${task.id}/system-map.md.`)
}

// -- run_validation ----------------------------------------------------------

const OUTPUT_TAIL_CHARS = 4000
const REPORTED_TAIL_CHARS = 1500

type PreparedRun = { taskId: string; command: string; argv: string[]; timeoutMs: number }

/** First locked step: check the phase and the allowlist. Nothing is run here. */
async function prepareValidation(ctx: Ctx, input: Input): Promise<PreparedRun> {
  const tool = 'run_validation'
  const { task, profile } = await requireRunning(ctx)
  requirePhase(tool, task, ['VALIDATE'])
  const command = requireString(tool, input, 'command', 1000)
  if (classifyBash(command, profile) !== 'validation') {
    const allowed = profile.validation.commands
    throw invalid(
      `run_validation: "${command}" is not an allowed validation command. Allowed (exactly, optionally followed by plain arguments, no shell syntax): ${
        allowed.length === 0 ? 'none configured' : allowed.map(item => `"${item}"`).join(', ')
      }. To add one, ask the person to list it under validation.commands in ${EWM_DIR}/project.yaml and run /ewm resume.`,
    )
  }
  const argv = splitArgs(command)
  if (argv.length === 0) throw invalid('run_validation: "command" is empty.')
  return { taskId: task.id, command: oneLine(command), argv, timeoutMs: profile.validation.timeout_ms }
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
    output = `ewm: could not run the command (not started, or it timed out after ${prepared.timeoutMs} ms): ${error instanceof Error ? error.message : String(error)}`
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
    command: prepared.command,
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
    entry => ({ ...entry, validations: [...entry.validations, { id: run.id, command: run.command, exit_code: run.exit_code, ok: run.ok, at }] }),
    { profile, profile_source: null },
  )
  const saved = await persist(ctx, { ledger: nextLedger, profile }, { ...task, validations: [...task.validations, run], updated_at: at }, {
    at,
    ledger: nextLedger,
    artifacts: ['validation.md'],
    audit: [{ kind: 'validation_run', detail: `${run.id} "${run.command}" exit ${run.exit_code}`, tool: 'run_validation', commit }],
  })
  const gate = gateOf(saved, nextLedger, profile)
  const guidance =
    gate.pending === 'done_acceptance'
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
      'Moves the task to the next workflow phase. Allowed edges: INTAKE>EXPLORE, EXPLORE>UNDERSTAND, UNDERSTAND>EXPLORE|PLAN, PLAN>UNDERSTAND|IMPLEMENT, IMPLEMENT>VALIDATE, VALIDATE>IMPLEMENT|PLAN|DONE. ' +
      'PLAN>IMPLEMENT needs a plan with steps and, per the profile, the person\'s approval of that exact plan; VALIDATE>DONE needs a validation run and the person\'s acceptance. ' +
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
      'Saves the system map: a Mermaid diagram, a plain-text map and the component names. Call it in EXPLORE or UNDERSTAND once you can explain how the parts fit, and again when the understanding changes. ' +
      'Writes system-map.md (the diagram is not rendered in the pane; the text map is).',
    inputSchema: {
      type: 'object',
      properties: {
        mermaid: { type: 'string', minLength: 1, maxLength: 20000, description: 'Mermaid source without the code fence, e.g. "flowchart LR\\n  A --> B".' },
        text_map: { type: 'string', description: 'The same map as plain text, one line per relationship or component.' },
        components: stringArray('Names of the components on the map.'),
      },
      required: ['mermaid', 'text_map', 'components'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_validation',
    description:
      'Runs one validation command and records its exit code and output tail as evidence for the final acceptance. Only in VALIDATE. ' +
      'The command must be one of the profile\'s validation.commands (exact, optionally followed by plain arguments; no pipes, redirects, quotes or other shell syntax). It runs without a shell in the repository root. ' +
      'Run it yourself with this tool: runs made any other way do not count. When it passes, ask the person to run /ewm approve.',
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

/** For the policy guard. Reads the ledger first; returns { task: null, profile: DEFAULT_PROFILE } when no task is active WITHOUT touching any other file.
 *  With an active task: loads task.json and returns the ledger's profile snapshot. A malformed ledger or unreadable active task throws (the guard fails closed). */
export async function activeContext(ctx: Ctx): Promise<{ task: Task | null; profile: Profile }> {
  const active = await loadActive(ctx)
  return active === null ? { task: null, profile: DEFAULT_PROFILE } : { task: active.task, profile: active.profile }
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
    await appendAudit(ctx.io, ctx.root, active.task.id, { at, kind: 'tool_denied', phase: active.task.phase, detail: reason, tool })
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
  return parts.join(' · ')
}
