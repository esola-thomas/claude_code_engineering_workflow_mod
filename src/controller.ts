// Workflow controller: the phase graph, the two human gates and approvals.
//
// Pure: no IO and no clock (callers pass `at` as an ISO string). Functions that
// "change" a task return a new object and never mutate their inputs. Gate checks
// expect a task whose approvals and validations are the trusted (ledger) ones;
// the plan hash is always recomputed here, never read from `task.plan.hash` (D3, D14).

import { ACTIVE_PHASES, EwmError } from './types.ts'
import type { ActivePhase, Actor, Approval, GateName, Phase, Plan, Profile, Task } from './types.ts'

function edgesTo(...phases: Phase[]): readonly Phase[] {
  return Object.freeze(phases)
}

/** Allowed phase changes (F1, D2). PAUSED and DONE have no edges: pause/resume are separate. */
export const EDGES: Readonly<Record<ActivePhase, readonly Phase[]>> = Object.freeze({
  INTAKE: edgesTo('EXPLORE'),
  EXPLORE: edgesTo('UNDERSTAND'),
  UNDERSTAND: edgesTo('EXPLORE', 'PLAN'),
  PLAN: edgesTo('UNDERSTAND', 'IMPLEMENT'), // IMPLEMENT: gate plan_approval
  IMPLEMENT: edgesTo('VALIDATE'),
  VALIDATE: edgesTo('IMPLEMENT', 'PLAN', 'DONE'), // DONE: gate done_acceptance
})

export type Check = { ok: true } | { ok: false; reason: string }

type Failure = { ok: false; reason: string; code: 'invalid_transition' | 'gate_required' }
type Verdict = { ok: true } | Failure

const OK: Verdict = { ok: true }

function isActivePhase(phase: string): phase is ActivePhase {
  return (ACTIVE_PHASES as readonly string[]).includes(phase)
}

// ---------------------------------------------------------------------------
// Plan hash
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** UTF-8 bytes of a string (TextEncoder is not guaranteed in the hooks environment). Lone surrogates are encoded as-is. */
function* utf8Bytes(text: string): Generator<number> {
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code < 0x80) {
      yield code
    } else if (code < 0x800) {
      yield 0xc0 | (code >> 6)
      yield 0x80 | (code & 0x3f)
    } else if (code < 0x10000) {
      yield 0xe0 | (code >> 12)
      yield 0x80 | ((code >> 6) & 0x3f)
      yield 0x80 | (code & 0x3f)
    } else {
      yield 0xf0 | (code >> 18)
      yield 0x80 | ((code >> 12) & 0x3f)
      yield 0x80 | ((code >> 6) & 0x3f)
      yield 0x80 | (code & 0x3f)
    }
  }
}

function fnv1a32Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of utf8Bytes(text)) hash = Math.imul(hash ^ byte, FNV_PRIME)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable, order-sensitive hash (FNV-1a 32-bit hex over a canonical JSON of summary, steps[].text, steps[].files, risks, tests, alternatives). Step status is excluded. */
export function planHash(plan: Omit<Plan, 'hash' | 'updated_at'>): string {
  // The object literal fixes the key order, so the JSON is canonical.
  const canonical = JSON.stringify({
    summary: plan.summary,
    steps: plan.steps.map((step) => ({ text: step.text, files: step.files })),
    risks: plan.risks,
    tests: plan.tests,
    alternatives: plan.alternatives,
  })
  return fnv1a32Hex(canonical)
}

/** The hash of the plan as it is now, or null without a plan. */
function currentPlanHash(task: Task): string | null {
  return task.plan === null ? null : planHash(task.plan)
}

// ---------------------------------------------------------------------------
// Approvals and gates
// ---------------------------------------------------------------------------

/** The most recent human record for the gate. Only 'user' records count: the ledger is JSON, so the field is checked at runtime. */
function latestApproval(task: Task, gate: GateName): Approval | undefined {
  for (let i = task.approvals.length - 1; i >= 0; i--) {
    const approval = task.approvals[i] as Approval
    if (approval.gate === gate && approval.by === 'user') return approval
  }
  return undefined
}

/** The latest approval record for the gate is 'approved'; for plan_approval its plan_hash must equal planHash(task.plan) RECOMPUTED now (never the stored task.plan.hash). */
export function hasValidApproval(task: Task, gate: GateName): boolean {
  const latest = latestApproval(task, gate)
  if (latest === undefined || latest.decision !== 'approved') return false
  if (gate !== 'plan_approval') return true
  const hash = currentPlanHash(task)
  return hash !== null && latest.plan_hash === hash
}

function hasPlanSteps(task: Task): boolean {
  return task.plan !== null && task.plan.steps.length >= 1
}

/** The gate a human could act on now, else null:
 *  PLAN with plan (>=1 step), require_plan_approval, no valid approval -> 'plan_approval';
 *  VALIDATE with >= 1 validation and no valid acceptance -> 'done_acceptance'. */
export function pendingGate(task: Task, profile: Profile): GateName | null {
  if (
    task.phase === 'PLAN' &&
    hasPlanSteps(task) &&
    profile.policies.require_plan_approval &&
    !hasValidApproval(task, 'plan_approval')
  ) {
    return 'plan_approval'
  }
  if (task.phase === 'VALIDATE' && task.validations.length >= 1 && !hasValidApproval(task, 'done_acceptance')) {
    return 'done_acceptance'
  }
  return null
}

function whyNotPending(task: Task, gate: GateName, profile: Profile): string {
  if (gate === 'plan_approval') {
    if (task.phase !== 'PLAN') return `plan_approval is decided in PLAN, but ${task.id} is in ${task.phase}`
    if (!hasPlanSteps(task)) return 'the plan has no steps yet (record it with mcp__ewm__set_plan)'
    if (!profile.policies.require_plan_approval) return 'the profile does not require plan approval'
    return 'the current plan is already approved'
  }
  if (task.phase !== 'VALIDATE') return `done_acceptance is decided in VALIDATE, but ${task.id} is in ${task.phase}`
  if (task.validations.length === 0) return 'no validation run is recorded yet (use mcp__ewm__run_validation)'
  return 'the work is already accepted'
}

/** Appends an Approval (by:'user', plan_hash = planHash(task.plan) for plan_approval). Throws EwmError('invalid_input') if gate !== pendingGate(task, profile). */
export function recordApproval(
  task: Task,
  gate: GateName,
  decision: 'approved' | 'rejected',
  via: 'command' | 'pane',
  at: string,
  profile: Profile,
  note?: string,
): Task {
  if (pendingGate(task, profile) !== gate) {
    const verb = decision === 'approved' ? 'approve' : 'reject'
    throw new EwmError('invalid_input', `ewm: cannot ${verb} ${gate}: ${whyNotPending(task, gate, profile)}.`)
  }
  const approval: Approval = { gate, decision, by: 'user', via, at }
  const trimmedNote = note?.trim()
  if (trimmedNote) approval.note = trimmedNote
  const hash = currentPlanHash(task)
  if (gate === 'plan_approval' && hash !== null) approval.plan_hash = hash
  return { ...task, approvals: [...task.approvals, approval], updated_at: at }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function invalid(reason: string): Failure {
  return { ok: false, reason, code: 'invalid_transition' }
}

function gateRequired(reason: string): Failure {
  return { ok: false, reason, code: 'gate_required' }
}

/** What the human does to approve, worded for whoever is asking. */
function approveHint(actor: Actor): string {
  return actor === 'user' ? 'Run /ewm approve' : 'Ask the person to run /ewm approve'
}

function checkPlanGate(task: Task, actor: Actor, profile: Profile): Verdict {
  if (!hasPlanSteps(task)) {
    return invalid('ewm: IMPLEMENT needs a plan with at least one step. Record it with mcp__ewm__set_plan while in PLAN.')
  }
  if (profile.policies.require_plan_approval && !hasValidApproval(task, 'plan_approval')) {
    return gateRequired(
      'ewm: IMPLEMENT needs an approved plan (gate plan_approval) and the current plan has no valid approval; ' +
        `editing the plan voids an approval. ${approveHint(actor)} after reviewing the plan.`,
    )
  }
  return OK
}

function checkAcceptanceGate(task: Task, actor: Actor): Verdict {
  if (task.validations.length === 0) {
    return gateRequired(
      'ewm: DONE needs at least one validation run (gate done_acceptance). Run an allowed command with mcp__ewm__run_validation first.',
    )
  }
  if (!hasValidApproval(task, 'done_acceptance')) {
    return gateRequired(
      `ewm: DONE needs the person's acceptance (gate done_acceptance). ${approveHint(actor)} once the validation results are reviewed.`,
    )
  }
  return OK
}

function evaluateTransition(task: Task, to: Phase, actor: Actor, profile: Profile): Verdict {
  const from = task.phase
  if (from === 'PAUSED') {
    return invalid(`ewm: ${task.id} is paused, so it cannot move to ${to}. Run /ewm resume first.`)
  }
  if (from === 'DONE') {
    return invalid(`ewm: ${task.id} is DONE and has no further phases. Start a new task with /ewm new.`)
  }
  if (!isActivePhase(from)) {
    return invalid(`ewm: ${task.id} has an unknown phase "${String(from)}"; its task.json is damaged.`)
  }
  if (to === 'PAUSED') {
    return invalid(`ewm: ${task.id} cannot move to PAUSED as a phase change. Use /ewm pause.`)
  }
  const allowed = EDGES[from]
  if (!allowed.includes(to)) {
    return invalid(`ewm: ${task.id} cannot move from ${from} to ${to}. From ${from} the allowed next phases are: ${allowed.join(', ')}.`)
  }
  if (to === 'IMPLEMENT') return checkPlanGate(task, actor, profile)
  if (to === 'DONE') return checkAcceptanceGate(task, actor)
  return OK
}

/** Whether `to` is reachable from task.phase by `actor` now. Rules:
 *  - edge must exist in EDGES (PAUSED/DONE/unknown -> not ok, explain);
 *  - -> IMPLEMENT: task.plan must exist with >= 1 step; if require_plan_approval, hasValidApproval(task,'plan_approval');
 *  - -> DONE: >= 1 entry in task.validations AND hasValidApproval(task,'done_acceptance');
 *  - reasons name the missing condition and the human action (e.g. "ask the person to run /ewm approve").
 *  The caller passes a task whose approvals/validations are the trusted (ledger) ones. */
export function checkTransition(task: Task, to: Phase, actor: Actor, profile: Profile): Check {
  const verdict = evaluateTransition(task, to, actor, profile)
  return verdict.ok ? verdict : { ok: false, reason: verdict.reason }
}

/** Applies a checked transition: phase, transitions[] (+{from,to,actor,reason,at}), next_action (defaultNextAction), updated_at. Throws EwmError('invalid_transition' | 'gate_required'). */
export function transition(task: Task, to: Phase, actor: Actor, reason: string, at: string, profile: Profile): Task {
  const verdict = evaluateTransition(task, to, actor, profile)
  if (!verdict.ok) throw new EwmError(verdict.code, verdict.reason)
  return {
    ...task,
    phase: to,
    transitions: [...task.transitions, { from: task.phase, to, actor, reason, at }],
    next_action: defaultNextAction(to),
    updated_at: at,
  }
}

// ---------------------------------------------------------------------------
// Pause and resume
// ---------------------------------------------------------------------------

/** ACTIVE -> PAUSED, sets paused_from, records transition. Throws if PAUSED or DONE.
 *  next_action is kept so a resumed task continues with the sentence it had. */
export function pause(task: Task, at: string, reason = 'paused'): Task {
  const from = task.phase
  if (from === 'PAUSED') {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is already paused. Run /ewm resume to continue.`)
  }
  if (!isActivePhase(from)) {
    throw new EwmError('invalid_transition', `ewm: ${task.id} is ${from} and cannot be paused.`)
  }
  return {
    ...task,
    phase: 'PAUSED',
    paused_from: from,
    transitions: [...task.transitions, { from, to: 'PAUSED', actor: 'user', reason, at }],
    updated_at: at,
  }
}

/** PAUSED -> paused_from (records transition, clears paused_from). A non-PAUSED task is returned unchanged.
 *  A damaged task with no phase to return to restarts at INTAKE (every gate is recomputed from data, so this opens nothing). */
export function resume(task: Task, at: string): Task {
  if (task.phase !== 'PAUSED') return task
  const recorded = task.paused_from
  const hasTarget = recorded !== null && isActivePhase(recorded)
  const target: ActivePhase = hasTarget ? recorded : 'INTAKE'
  const reason = hasTarget ? 'resumed' : 'resumed (the phase to return to was missing; restarting at INTAKE)'
  return {
    ...task,
    phase: target,
    paused_from: null,
    transitions: [...task.transitions, { from: 'PAUSED', to: target, actor: 'user', reason, at }],
    updated_at: at,
  }
}

// ---------------------------------------------------------------------------
// Next action
// ---------------------------------------------------------------------------

const NEXT_ACTIONS: Readonly<Record<Phase, string>> = {
  INTAKE: 'Confirm problem, goal and success criteria with the user.',
  EXPLORE: 'Delegate bounded searches to ewm scouts and record sourced findings.',
  UNDERSTAND: 'Explain the system with a diagram and get the person to confirm the assumptions.',
  PLAN: 'Write the plan (steps, files, risks, tests, alternatives) and present it for approval.',
  IMPLEMENT: 'Implement the approved plan in small steps and record decisions and deviations.',
  VALIDATE: 'Run the allowed validation commands and ask the person to accept the results.',
  DONE: 'Review handoff.md for the summary and follow-ups.',
  PAUSED: 'Run /ewm resume to continue where you left off.',
}

/** Default next_action sentence per phase (e.g. EXPLORE: "Delegate bounded searches to ewm scouts and record sourced findings."). */
export function defaultNextAction(phase: Phase): string {
  return NEXT_ACTIONS[phase]
}
