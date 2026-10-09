import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EDGES,
  checkTransition,
  defaultNextAction,
  hasValidApproval,
  pause,
  pendingGate,
  planHash,
  recordApproval,
  resume,
  transition,
} from '../../src/controller.ts'
import { ACTIVE_PHASES, EwmError, PHASES } from '../../src/types.ts'
import type { Actor, Approval, GateName, Phase, Plan, PlanStep, Task, ValidationRun } from '../../src/types.ts'
import { AT, deepFreeze, makeProfile, makeTask } from '../support/fixtures.ts'

const LATER = '2026-10-09T18:00:00.000Z'
const ACTORS: readonly Actor[] = ['user', 'model', 'system']

const strict = deepFreeze(makeProfile())
const relaxed = deepFreeze(
  makeProfile({ policies: { ...makeProfile().policies, require_plan_approval: false } }),
)

// ---------------------------------------------------------------------------
// Builders. Every task handed to the controller is deep-frozen, so any mutation
// inside the controller throws (ES modules run in strict mode).
// ---------------------------------------------------------------------------

type PlanContent = Omit<Plan, 'hash' | 'updated_at'>

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return { id: 'S-1', text: 'Patch sum', files: ['src/sum.ts'], status: 'todo', ...overrides }
}

function planContent(overrides: Partial<PlanContent> = {}): PlanContent {
  return {
    summary: 'Fix sum()',
    steps: [makeStep()],
    risks: ['Edge cases'],
    tests: ['npm test'],
    alternatives: ['Rewrite'],
    ...overrides,
  }
}

function makePlan(overrides: Partial<PlanContent> = {}): Plan {
  const content = planContent(overrides)
  return { ...content, hash: planHash(content), updated_at: AT }
}

function makeValidation(overrides: Partial<ValidationRun> = {}): ValidationRun {
  return {
    id: 'V-001',
    command: 'npm test',
    exit_code: 0,
    ok: true,
    duration_ms: 1200,
    output_tail: 'ok',
    commit: 'aaaaaaa',
    at: AT,
    ...overrides,
  }
}

function approval(gate: GateName, decision: 'approved' | 'rejected' = 'approved', overrides: Partial<Approval> = {}): Approval {
  return { gate, decision, by: 'user', via: 'command', at: AT, ...overrides }
}

/** A plan_approval record bound to the plan's current content. */
function planApproval(plan: Plan, decision: 'approved' | 'rejected' = 'approved'): Approval {
  return approval('plan_approval', decision, { plan_hash: planHash(plan) })
}

function frozenTask(overrides: Partial<Task> = {}): Task {
  return deepFreeze(makeTask(overrides))
}

/** A task in `phase` with every gate prerequisite satisfied: plan, plan approval, validation, acceptance. */
function readyTask(phase: Phase, overrides: Partial<Task> = {}): Task {
  const plan = makePlan()
  return frozenTask({
    phase,
    plan,
    validations: [makeValidation()],
    approvals: [planApproval(plan), approval('done_acceptance')],
    ...overrides,
  })
}

function assertEwmError(fn: () => unknown, code: EwmError['code'], message?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EwmError, `expected EwmError, got ${String(error)}`)
    assert.equal(error.code, code)
    assert.match(error.message, /^ewm: /)
    if (message) assert.match(error.message, message)
    return true
  })
}

function assertRejected(check: ReturnType<typeof checkTransition>, message?: RegExp): void {
  assert.equal(check.ok, false)
  if (check.ok) return
  assert.match(check.reason, /^ewm: /)
  if (message) assert.match(check.reason, message)
}

// ---------------------------------------------------------------------------
// Phase graph
// ---------------------------------------------------------------------------

describe('EDGES', () => {
  it('is exactly the contract table', () => {
    assert.deepEqual(EDGES, {
      INTAKE: ['EXPLORE'],
      EXPLORE: ['UNDERSTAND'],
      UNDERSTAND: ['EXPLORE', 'PLAN'],
      PLAN: ['UNDERSTAND', 'IMPLEMENT'],
      IMPLEMENT: ['VALIDATE'],
      VALIDATE: ['IMPLEMENT', 'PLAN', 'DONE'],
    })
  })

  it('has a row for every active phase and none for PAUSED or DONE', () => {
    assert.deepEqual(Object.keys(EDGES), [...ACTIVE_PHASES])
  })

  it('never lists PAUSED as a destination (pause and resume are separate, F1)', () => {
    for (const destinations of Object.values(EDGES)) assert.ok(!destinations.includes('PAUSED'))
  })

  it('is read-only at runtime', () => {
    assert.ok(Object.isFrozen(EDGES))
    for (const destinations of Object.values(EDGES)) assert.ok(Object.isFrozen(destinations))
  })
})

describe('every edge is allowed when its prerequisites are satisfied', () => {
  for (const from of ACTIVE_PHASES) {
    for (const to of EDGES[from]) {
      it(`${from} -> ${to}`, () => {
        const task = readyTask(from)
        for (const actor of ACTORS) {
          assert.deepEqual(checkTransition(task, to, actor, strict), { ok: true }, `actor ${actor}`)
        }
        const next = transition(task, to, 'model', 'because', LATER, strict)
        assert.equal(next.phase, to)
      })
    }
  }
})

describe('every non-edge from an active phase is rejected with a reason', () => {
  let count = 0
  for (const from of ACTIVE_PHASES) {
    for (const to of PHASES) {
      if (EDGES[from].includes(to)) continue
      count++
      it(`${from} -> ${to}`, () => {
        // Fully satisfied gates: only the graph can be the cause.
        const task = readyTask(from)
        for (const actor of ACTORS) {
          const check = checkTransition(task, to, actor, strict)
          if (to === 'PAUSED') assertRejected(check, /\/ewm pause/)
          else assertRejected(check, new RegExp(`from ${from} to ${to}\\..*allowed next phases are: ${EDGES[from].join(', ')}`))
        }
        assertEwmError(() => transition(task, to, 'user', 'nope', LATER, strict), 'invalid_transition')
      })
    }
  }

  it('covers 38 non-edges (6 phases x 8 targets - 10 edges)', () => {
    assert.equal(count, 38)
  })

  it('rejects a phase name that does not exist', () => {
    const check = checkTransition(readyTask('EXPLORE'), 'LAUNCH' as Phase, 'model', strict)
    assertRejected(check, /LAUNCH/)
  })
})

describe('PAUSED and DONE have no edges', () => {
  const paused = readyTask('PAUSED', { paused_from: 'PLAN' })
  const done = readyTask('DONE')

  for (const to of PHASES) {
    it(`PAUSED -> ${to} is rejected and points to /ewm resume`, () => {
      for (const actor of ACTORS) assertRejected(checkTransition(paused, to, actor, strict), /\/ewm resume/)
      assertEwmError(() => transition(paused, to, 'user', 'x', LATER, strict), 'invalid_transition', /\/ewm resume/)
    })

    it(`DONE -> ${to} is rejected`, () => {
      for (const actor of ACTORS) assertRejected(checkTransition(done, to, actor, strict), /DONE/)
      assertEwmError(() => transition(done, to, 'user', 'x', LATER, strict), 'invalid_transition', /DONE/)
    })
  }
})

// ---------------------------------------------------------------------------
// transition()
// ---------------------------------------------------------------------------

describe('transition', () => {
  it('appends a Transition, sets next_action from defaultNextAction and updated_at', () => {
    const earlier = { from: 'INTAKE', to: 'EXPLORE', actor: 'model', reason: 'scoped', at: AT } as const
    const task = frozenTask({ phase: 'EXPLORE', transitions: [earlier], next_action: 'custom sentence' })
    const next = transition(task, 'UNDERSTAND', 'model', 'enough sources', LATER, strict)

    assert.equal(next.phase, 'UNDERSTAND')
    assert.deepEqual(next.transitions, [
      earlier,
      { from: 'EXPLORE', to: 'UNDERSTAND', actor: 'model', reason: 'enough sources', at: LATER },
    ])
    assert.equal(next.next_action, defaultNextAction('UNDERSTAND'))
    assert.equal(next.updated_at, LATER)
  })

  it('returns a new task and leaves the input untouched', () => {
    const task = frozenTask({ phase: 'EXPLORE' })
    const before = structuredClone(task)
    const next = transition(task, 'UNDERSTAND', 'user', 'go', LATER, strict)
    assert.notEqual(next, task)
    assert.notEqual(next.transitions, task.transitions)
    assert.deepEqual(task, before)
  })

  it('leaves every other field as it was', () => {
    const task = readyTask('PLAN', { title: 'keep me', open_questions: [{ id: 'Q-001', text: 'why?', status: 'open', raised_at: AT }] })
    const next = transition(task, 'UNDERSTAND', 'user', 'revisit', LATER, strict)
    assert.deepEqual({ ...next, phase: 0, transitions: 0, next_action: 0, updated_at: 0 }, { ...task, phase: 0, transitions: 0, next_action: 0, updated_at: 0 })
  })

  it('sets the default next_action for every edge', () => {
    for (const from of ACTIVE_PHASES) {
      for (const to of EDGES[from]) {
        assert.equal(transition(readyTask(from), to, 'user', 'x', LATER, strict).next_action, defaultNextAction(to))
      }
    }
  })

  it('records the actor that moved the task', () => {
    for (const actor of ACTORS) {
      const next = transition(frozenTask({ phase: 'INTAKE' }), 'EXPLORE', actor, 'start', LATER, strict)
      assert.equal(next.transitions.at(-1)?.actor, actor)
    }
  })

  it('throws invalid_transition for a missing edge', () => {
    assertEwmError(() => transition(frozenTask({ phase: 'INTAKE' }), 'PLAN', 'model', 'skip', LATER, strict), 'invalid_transition', /INTAKE to PLAN/)
  })

  it('throws gate_required when an approval is missing', () => {
    const task = frozenTask({ phase: 'PLAN', plan: makePlan() })
    assertEwmError(() => transition(task, 'IMPLEMENT', 'model', 'go', LATER, strict), 'gate_required', /\/ewm approve/)
  })

  it('throws invalid_transition when the plan is missing', () => {
    assertEwmError(() => transition(frozenTask({ phase: 'PLAN' }), 'IMPLEMENT', 'model', 'go', LATER, relaxed), 'invalid_transition', /plan/)
  })
})

// ---------------------------------------------------------------------------
// pause / resume (F1)
// ---------------------------------------------------------------------------

describe('pause and resume', () => {
  for (const phase of ACTIVE_PHASES) {
    it(`pause() from ${phase} records paused_from and the transition`, () => {
      const task = readyTask(phase, { next_action: 'keep this sentence' })
      const before = structuredClone(task)
      const paused = pause(task, LATER)

      assert.equal(paused.phase, 'PAUSED')
      assert.equal(paused.paused_from, phase)
      assert.deepEqual(paused.transitions.at(-1), { from: phase, to: 'PAUSED', actor: 'user', reason: 'paused', at: LATER })
      assert.equal(paused.transitions.length, task.transitions.length + 1)
      assert.equal(paused.updated_at, LATER)
      assert.equal(paused.next_action, 'keep this sentence')
      assert.deepEqual(task, before)
    })

    it(`resume() returns to ${phase} and clears paused_from`, () => {
      const task = readyTask(phase)
      const resumed = resume(pause(task, LATER), '2026-10-09T19:00:00.000Z')

      assert.equal(resumed.phase, phase)
      assert.equal(resumed.paused_from, null)
      assert.deepEqual(resumed.transitions.slice(-2), [
        { from: phase, to: 'PAUSED', actor: 'user', reason: 'paused', at: LATER },
        { from: 'PAUSED', to: phase, actor: 'user', reason: 'resumed', at: '2026-10-09T19:00:00.000Z' },
      ])
      assert.equal(resumed.updated_at, '2026-10-09T19:00:00.000Z')
    })

    it(`a pause/resume round trip from ${phase} changes only phase bookkeeping`, () => {
      const task = readyTask(phase)
      const resumed = resume(pause(task, LATER), LATER)
      const bookkeeping = { transitions: [], updated_at: '' }
      assert.deepEqual({ ...resumed, ...bookkeeping }, { ...task, ...bookkeeping })
    })

    it(`resume() of a running ${phase} task is a no-op`, () => {
      const task = readyTask(phase)
      assert.equal(resume(task, LATER), task)
    })
  }

  it('resume() of a DONE task is a no-op', () => {
    const task = readyTask('DONE')
    assert.equal(resume(task, LATER), task)
  })

  it('pause() takes a reason', () => {
    const paused = pause(readyTask('PLAN'), LATER, 'switching to TASK-002')
    assert.equal(paused.transitions.at(-1)?.reason, 'switching to TASK-002')
  })

  it('pause() of a PAUSED task throws and points to /ewm resume', () => {
    const paused = pause(readyTask('PLAN'), LATER)
    assertEwmError(() => pause(paused, LATER), 'invalid_transition', /already paused.*\/ewm resume/)
  })

  it('pause() of a DONE task throws', () => {
    assertEwmError(() => pause(readyTask('DONE'), LATER), 'invalid_transition', /DONE/)
  })

  it('a paused task can pause again after resuming', () => {
    const again = pause(resume(pause(readyTask('VALIDATE'), LATER), LATER), '2026-10-09T20:00:00.000Z')
    assert.equal(again.phase, 'PAUSED')
    assert.equal(again.paused_from, 'VALIDATE')
    assert.equal(again.transitions.length, 3)
  })

  it('a resumed task follows the edges of the phase it returned to', () => {
    const resumed = resume(pause(readyTask('UNDERSTAND'), LATER), LATER)
    assert.equal(checkTransition(resumed, 'PLAN', 'model', strict).ok, true)
    assert.equal(checkTransition(resumed, 'IMPLEMENT', 'model', strict).ok, false)
  })

  it('resume() restarts a damaged task with no recorded phase at INTAKE and says so', () => {
    const damaged = frozenTask({ phase: 'PAUSED', paused_from: null })
    const resumed = resume(damaged, LATER)
    assert.equal(resumed.phase, 'INTAKE')
    assert.equal(resumed.paused_from, null)
    assert.match(resumed.transitions.at(-1)?.reason ?? '', /missing/)
  })

  it('does not move gate state: approvals survive a pause', () => {
    const plan = makePlan()
    const task = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan)] })
    const resumed = resume(pause(task, LATER), LATER)
    assert.equal(hasValidApproval(resumed, 'plan_approval'), true)
  })
})

// ---------------------------------------------------------------------------
// planHash (D3)
// ---------------------------------------------------------------------------

describe('planHash', () => {
  it('is eight lowercase hex digits', () => {
    assert.match(planHash(planContent()), /^[0-9a-f]{8}$/)
  })

  it('is stable across calls and across equal copies', () => {
    const content = planContent()
    assert.equal(planHash(content), planHash(content))
    assert.equal(planHash(content), planHash(structuredClone(content)))
  })

  it('keeps known values, so a stored approval survives a release (FNV-1a 32 over UTF-8 canonical JSON)', () => {
    assert.equal(planHash(planContent()), '3cf80f1f')
    assert.equal(planHash(planContent({ summary: 'Añadir ✓ 😀' })), '84f5666b')
    assert.equal(planHash({ summary: '', steps: [], risks: [], tests: [], alternatives: [] }), 'aa442719')
  })

  const base = planContent()
  const changes: [string, Partial<PlanContent>][] = [
    ['summary', { summary: 'Fix sum() and mul()' }],
    ['a step text', { steps: [makeStep({ text: 'Patch mul' })] }],
    ['a step files list', { steps: [makeStep({ files: ['src/sum.ts', 'src/mul.ts'] })] }],
    ['an added step', { steps: [makeStep(), makeStep({ id: 'S-2', text: 'Add test' })] }],
    ['a removed step', { steps: [] }],
    ['risks', { risks: ['Edge cases', 'Overflow'] }],
    ['tests', { tests: ['npm test', 'npm run lint'] }],
    ['alternatives', { alternatives: [] }],
  ]
  for (const [what, override] of changes) {
    it(`changes when ${what} changes`, () => {
      assert.notEqual(planHash({ ...base, ...override }), planHash(base))
    })
  }

  it('changes when the file order of a step is swapped', () => {
    const ab = planContent({ steps: [makeStep({ files: ['src/a.ts', 'src/b.ts'] })] })
    const ba = planContent({ steps: [makeStep({ files: ['src/b.ts', 'src/a.ts'] })] })
    assert.notEqual(planHash(ab), planHash(ba))
  })

  it('changes when steps are reordered', () => {
    const first = makeStep({ id: 'S-1', text: 'Write test' })
    const second = makeStep({ id: 'S-2', text: 'Fix code' })
    assert.notEqual(planHash(planContent({ steps: [first, second] })), planHash(planContent({ steps: [second, first] })))
  })

  for (const field of ['risks', 'tests', 'alternatives'] as const) {
    it(`changes when ${field} are reordered`, () => {
      assert.notEqual(planHash(planContent({ [field]: ['one', 'two'] })), planHash(planContent({ [field]: ['two', 'one'] })))
    })
  }

  it('tells list items apart from their concatenation', () => {
    assert.notEqual(planHash(planContent({ risks: ['ab'] })), planHash(planContent({ risks: ['a', 'b'] })))
  })

  it('tells the lists apart: the same text under risks, tests or alternatives', () => {
    const hashes = new Set(
      (['risks', 'tests', 'alternatives'] as const).map((field) =>
        planHash({ summary: 's', steps: [], risks: [], tests: [], alternatives: [], [field]: ['x'] }),
      ),
    )
    assert.equal(hashes.size, 3)
  })

  it('ignores step status and step ids', () => {
    const todo = planContent({ steps: [makeStep({ status: 'todo' })] })
    const done = planContent({ steps: [makeStep({ id: 'S-9', status: 'done' })] })
    assert.equal(planHash(todo), planHash(done))
  })

  it('ignores the stored hash and updated_at of a full Plan', () => {
    const plan = makePlan()
    assert.equal(planHash({ ...plan, hash: 'whatever', updated_at: LATER } as Plan), planHash(plan))
    assert.equal(planHash(plan), plan.hash)
  })

  it('does not mutate a frozen plan', () => {
    assert.doesNotThrow(() => planHash(deepFreeze(makePlan())))
  })
})

// ---------------------------------------------------------------------------
// hasValidApproval
// ---------------------------------------------------------------------------

describe('hasValidApproval', () => {
  it('is false with no records', () => {
    assert.equal(hasValidApproval(frozenTask({ plan: makePlan() }), 'plan_approval'), false)
    assert.equal(hasValidApproval(frozenTask(), 'done_acceptance'), false)
  })

  it('accepts an approval bound to the current plan content', () => {
    const plan = makePlan()
    assert.equal(hasValidApproval(frozenTask({ plan, approvals: [planApproval(plan)] }), 'plan_approval'), true)
  })

  it('is void when the plan content changes after approval (D3)', () => {
    const approved = makePlan()
    const edited = makePlan({ steps: [makeStep({ text: 'Patch something else' })] })
    const task = frozenTask({ plan: edited, approvals: [planApproval(approved)] })
    assert.equal(hasValidApproval(task, 'plan_approval'), false)
  })

  it('recomputes the hash: a changed plan whose stored hash field still equals the approved hash is NOT approved', () => {
    const approved = makePlan()
    const edited = { ...makePlan({ summary: 'Something entirely different' }), hash: approved.hash }
    assert.equal(edited.hash, approved.hash)
    const task = frozenTask({ plan: edited, approvals: [planApproval(approved)] })
    assert.equal(hasValidApproval(task, 'plan_approval'), false)
  })

  it('recomputes the hash: an unchanged plan is approved whatever its stored hash field says', () => {
    const plan = makePlan()
    const task = frozenTask({ plan: { ...plan, hash: 'not-the-hash' }, approvals: [planApproval(plan)] })
    assert.equal(hasValidApproval(task, 'plan_approval'), true)
  })

  it('ignores step status changes after approval', () => {
    const plan = makePlan()
    const progressed = makePlan({ steps: [makeStep({ status: 'done' })] })
    const task = frozenTask({ plan: progressed, approvals: [planApproval(plan)] })
    assert.equal(hasValidApproval(task, 'plan_approval'), true)
  })

  it('is false without a plan, even with an approval record', () => {
    const task = frozenTask({ plan: null, approvals: [approval('plan_approval', 'approved', { plan_hash: planHash(planContent()) })] })
    assert.equal(hasValidApproval(task, 'plan_approval'), false)
  })

  it('is false when the approval carries no plan_hash', () => {
    const task = frozenTask({ plan: makePlan(), approvals: [approval('plan_approval')] })
    assert.equal(hasValidApproval(task, 'plan_approval'), false)
  })

  it('is closed again by a later rejection and reopened by a later approval', () => {
    const plan = makePlan()
    const approved = planApproval(plan)
    const rejected = planApproval(plan, 'rejected')
    assert.equal(hasValidApproval(frozenTask({ plan, approvals: [approved, rejected] }), 'plan_approval'), false)
    assert.equal(hasValidApproval(frozenTask({ plan, approvals: [approved, rejected, approved] }), 'plan_approval'), true)
    assert.equal(hasValidApproval(frozenTask({ plan, approvals: [rejected, approved] }), 'plan_approval'), true)
  })

  it('treats each gate separately', () => {
    const plan = makePlan()
    const task = frozenTask({ plan, approvals: [planApproval(plan), approval('done_acceptance', 'rejected')] })
    assert.equal(hasValidApproval(task, 'plan_approval'), true)
    assert.equal(hasValidApproval(task, 'done_acceptance'), false)
    assert.equal(hasValidApproval(frozenTask({ approvals: [approval('done_acceptance')] }), 'plan_approval'), false)
  })

  it('accepts done_acceptance without a plan hash', () => {
    assert.equal(hasValidApproval(frozenTask({ approvals: [approval('done_acceptance')] }), 'done_acceptance'), true)
  })

  it('ignores records that are not by the user (the ledger is JSON, not a typed channel)', () => {
    const forged = { ...approval('done_acceptance'), by: 'model' } as unknown as Approval
    assert.equal(hasValidApproval(frozenTask({ approvals: [forged] }), 'done_acceptance'), false)
  })
})

// ---------------------------------------------------------------------------
// Gate: plan_approval
// ---------------------------------------------------------------------------

describe('gate plan_approval (PLAN -> IMPLEMENT)', () => {
  const plan = makePlan()
  const unapproved = frozenTask({ phase: 'PLAN', plan })
  const approved = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan)] })

  it('is required when profile.policies.require_plan_approval is true', () => {
    for (const actor of ACTORS) {
      assertRejected(checkTransition(unapproved, 'IMPLEMENT', actor, strict), /plan_approval.*\/ewm approve/)
    }
  })

  it('is not required when require_plan_approval is false', () => {
    for (const actor of ACTORS) assert.deepEqual(checkTransition(unapproved, 'IMPLEMENT', actor, relaxed), { ok: true })
  })

  it('passes once the plan is approved', () => {
    for (const actor of ACTORS) assert.deepEqual(checkTransition(approved, 'IMPLEMENT', actor, strict), { ok: true })
  })

  it('needs a plan, whether or not approval is required', () => {
    for (const profile of [strict, relaxed]) {
      assertRejected(checkTransition(frozenTask({ phase: 'PLAN', plan: null }), 'IMPLEMENT', 'model', profile), /at least one step.*set_plan/)
    }
  })

  it('needs a plan with at least one step, whether or not approval is required', () => {
    const empty = makePlan({ steps: [] })
    const task = frozenTask({ phase: 'PLAN', plan: empty, approvals: [planApproval(empty)] })
    for (const profile of [strict, relaxed]) {
      assertRejected(checkTransition(task, 'IMPLEMENT', 'model', profile), /at least one step/)
    }
  })

  it('gives the model the human action to ask for, and the person the command to run', () => {
    const forModel = checkTransition(unapproved, 'IMPLEMENT', 'model', strict)
    const forUser = checkTransition(unapproved, 'IMPLEMENT', 'user', strict)
    assertRejected(forModel, /ask the person to run \/ewm approve/i)
    assertRejected(forUser, /run \/ewm approve/i)
    if (!forUser.ok) assert.doesNotMatch(forUser.reason, /ask the person/i)
  })

  it('the model cannot pass the gate without an approval, and a rejection does not count', () => {
    const rejected = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan, 'rejected')] })
    for (const task of [unapproved, rejected]) {
      assertRejected(checkTransition(task, 'IMPLEMENT', 'model', strict))
      assertEwmError(() => transition(task, 'IMPLEMENT', 'model', 'go', LATER, strict), 'gate_required')
    }
  })

  it('a later rejection closes the gate again', () => {
    const task = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan), planApproval(plan, 'rejected')] })
    assertRejected(checkTransition(task, 'IMPLEMENT', 'model', strict), /plan_approval/)
  })

  it('an approval is void once the plan content changes', () => {
    const edited = makePlan({ risks: ['Edge cases', 'New risk found later'] })
    const task = frozenTask({ phase: 'PLAN', plan: edited, approvals: [planApproval(plan)] })
    assertRejected(checkTransition(task, 'IMPLEMENT', 'model', strict), /plan_approval.*voids/)
  })

  it('a changed plan with the old stored hash field is not approved', () => {
    const edited = { ...makePlan({ summary: 'Swapped after approval' }), hash: plan.hash }
    const task = frozenTask({ phase: 'PLAN', plan: edited, approvals: [planApproval(plan)] })
    assertRejected(checkTransition(task, 'IMPLEMENT', 'model', strict), /plan_approval/)
    assert.equal(pendingGate(task, strict), 'plan_approval')
  })

  it('also guards VALIDATE -> IMPLEMENT: the plan must still be approved', () => {
    assertRejected(checkTransition(frozenTask({ phase: 'VALIDATE', plan }), 'IMPLEMENT', 'model', strict), /plan_approval/)
    assertRejected(checkTransition(frozenTask({ phase: 'VALIDATE', plan: null }), 'IMPLEMENT', 'model', relaxed), /at least one step/)
    assert.deepEqual(checkTransition(frozenTask({ phase: 'VALIDATE', plan, approvals: [planApproval(plan)] }), 'IMPLEMENT', 'model', strict), { ok: true })
  })

  it('does not gate the other edges out of PLAN', () => {
    assert.deepEqual(checkTransition(frozenTask({ phase: 'PLAN' }), 'UNDERSTAND', 'model', strict), { ok: true })
  })
})

// ---------------------------------------------------------------------------
// Gate: done_acceptance
// ---------------------------------------------------------------------------

describe('gate done_acceptance (VALIDATE -> DONE)', () => {
  const validation = makeValidation()

  it('needs at least one validation run, even with an approval', () => {
    const task = frozenTask({ phase: 'VALIDATE', approvals: [approval('done_acceptance')] })
    for (const profile of [strict, relaxed]) {
      assertRejected(checkTransition(task, 'DONE', 'user', profile), /validation run.*run_validation/)
    }
    assert.equal(pendingGate(task, strict), null)
  })

  it('needs an approval, even with a validation run', () => {
    const task = frozenTask({ phase: 'VALIDATE', validations: [validation] })
    for (const profile of [strict, relaxed]) {
      for (const actor of ACTORS) assertRejected(checkTransition(task, 'DONE', actor, profile), /done_acceptance.*\/ewm approve/)
    }
    assertEwmError(() => transition(task, 'DONE', 'model', 'done', LATER, strict), 'gate_required')
  })

  it('passes with a validation run and an approval, whatever require_plan_approval says', () => {
    const task = frozenTask({ phase: 'VALIDATE', validations: [validation], approvals: [approval('done_acceptance')] })
    for (const profile of [strict, relaxed]) {
      for (const actor of ACTORS) assert.deepEqual(checkTransition(task, 'DONE', actor, profile), { ok: true })
    }
    assert.equal(transition(task, 'DONE', 'user', 'accepted', LATER, strict).phase, 'DONE')
  })

  it('a later rejection closes the gate again', () => {
    const task = frozenTask({
      phase: 'VALIDATE',
      validations: [validation],
      approvals: [approval('done_acceptance'), approval('done_acceptance', 'rejected')],
    })
    assertRejected(checkTransition(task, 'DONE', 'model', strict), /done_acceptance/)
  })

  it('the plan approval does not stand in for the acceptance', () => {
    const plan = makePlan()
    const task = frozenTask({ phase: 'VALIDATE', plan, validations: [validation], approvals: [planApproval(plan)] })
    assertRejected(checkTransition(task, 'DONE', 'model', strict), /done_acceptance/)
  })

  it('does not gate the other edges out of VALIDATE', () => {
    const plan = makePlan()
    const task = frozenTask({ phase: 'VALIDATE', plan, approvals: [planApproval(plan)] })
    assert.deepEqual(checkTransition(task, 'PLAN', 'model', strict), { ok: true })
    assert.deepEqual(checkTransition(task, 'IMPLEMENT', 'model', strict), { ok: true })
  })
})

// ---------------------------------------------------------------------------
// pendingGate
// ---------------------------------------------------------------------------

describe('pendingGate', () => {
  const plan = makePlan()

  it('is plan_approval in PLAN with a plan, a policy requiring approval and no valid approval', () => {
    assert.equal(pendingGate(frozenTask({ phase: 'PLAN', plan }), strict), 'plan_approval')
  })

  it('is null in PLAN without a plan or without steps', () => {
    assert.equal(pendingGate(frozenTask({ phase: 'PLAN', plan: null }), strict), null)
    assert.equal(pendingGate(frozenTask({ phase: 'PLAN', plan: makePlan({ steps: [] }) }), strict), null)
  })

  it('is null in PLAN when the profile does not require approval', () => {
    assert.equal(pendingGate(frozenTask({ phase: 'PLAN', plan }), relaxed), null)
  })

  it('is null in PLAN once the plan is approved, and back after a rejection or a plan edit', () => {
    const approved = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan)] })
    assert.equal(pendingGate(approved, strict), null)
    const rejected = frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan), planApproval(plan, 'rejected')] })
    assert.equal(pendingGate(rejected, strict), 'plan_approval')
    const edited = frozenTask({ phase: 'PLAN', plan: makePlan({ summary: 'v2' }), approvals: [planApproval(plan)] })
    assert.equal(pendingGate(edited, strict), 'plan_approval')
  })

  it('is done_acceptance in VALIDATE with a validation run and no valid acceptance', () => {
    assert.equal(pendingGate(frozenTask({ phase: 'VALIDATE', validations: [makeValidation()] }), strict), 'done_acceptance')
    assert.equal(pendingGate(frozenTask({ phase: 'VALIDATE', validations: [makeValidation()] }), relaxed), 'done_acceptance')
  })

  it('is null in VALIDATE without a validation run', () => {
    assert.equal(pendingGate(frozenTask({ phase: 'VALIDATE' }), strict), null)
  })

  it('is null in VALIDATE once accepted, and back after a rejection', () => {
    const accepted = frozenTask({ phase: 'VALIDATE', validations: [makeValidation()], approvals: [approval('done_acceptance')] })
    assert.equal(pendingGate(accepted, strict), null)
    const rejected = frozenTask({
      phase: 'VALIDATE',
      validations: [makeValidation()],
      approvals: [approval('done_acceptance'), approval('done_acceptance', 'rejected')],
    })
    assert.equal(pendingGate(rejected, strict), 'done_acceptance')
  })

  it('is null in every other phase, whatever data the task holds', () => {
    for (const phase of PHASES) {
      if (phase === 'PLAN' || phase === 'VALIDATE') continue
      const task = frozenTask({ phase, paused_from: phase === 'PAUSED' ? 'PLAN' : null, plan, validations: [makeValidation()] })
      assert.equal(pendingGate(task, strict), null, phase)
    }
  })
})

// ---------------------------------------------------------------------------
// recordApproval
// ---------------------------------------------------------------------------

describe('recordApproval', () => {
  const plan = makePlan()
  const planningTask = frozenTask({ phase: 'PLAN', plan })
  const validatingTask = frozenTask({ phase: 'VALIDATE', validations: [makeValidation()] })

  it('appends an approval by the user, bound to the plan hash, and stamps updated_at', () => {
    const next = recordApproval(planningTask, 'plan_approval', 'approved', 'command', LATER, strict, 'looks right')
    assert.deepEqual(next.approvals, [
      { gate: 'plan_approval', decision: 'approved', by: 'user', via: 'command', at: LATER, note: 'looks right', plan_hash: planHash(plan) },
    ])
    assert.equal(next.updated_at, LATER)
    assert.equal(next.phase, 'PLAN')
  })

  it('binds the approval to the recomputed hash, never to the stored task.plan.hash', () => {
    const lying = frozenTask({ phase: 'PLAN', plan: { ...plan, hash: 'stale-stored-hash' } })
    const next = recordApproval(lying, 'plan_approval', 'approved', 'pane', LATER, strict)
    assert.equal(next.approvals[0]?.plan_hash, planHash(plan))
    assert.equal(hasValidApproval(next, 'plan_approval'), true)
  })

  it('records done_acceptance without a plan hash', () => {
    const next = recordApproval(validatingTask, 'done_acceptance', 'approved', 'command', LATER, strict)
    assert.deepEqual(next.approvals, [{ gate: 'done_acceptance', decision: 'approved', by: 'user', via: 'command', at: LATER }])
    assert.equal(hasValidApproval(next, 'done_acceptance'), true)
    assert.equal(pendingGate(next, strict), null)
  })

  it('is always by the user, for either decision and either origin', () => {
    for (const decision of ['approved', 'rejected'] as const) {
      for (const via of ['command', 'pane'] as const) {
        const next = recordApproval(planningTask, 'plan_approval', decision, via, LATER, strict)
        assert.equal(next.approvals[0]?.by, 'user')
        assert.equal(next.approvals[0]?.via, via)
        assert.equal(next.approvals[0]?.decision, decision)
      }
    }
  })

  it('omits the note when none or only whitespace is given, and trims one that is', () => {
    assert.ok(!('note' in (recordApproval(planningTask, 'plan_approval', 'approved', 'command', LATER, strict).approvals[0] ?? {})))
    assert.ok(!('note' in (recordApproval(planningTask, 'plan_approval', 'approved', 'command', LATER, strict, '  ').approvals[0] ?? {})))
    assert.equal(recordApproval(planningTask, 'plan_approval', 'rejected', 'command', LATER, strict, '  rework step 2 \n').approvals[0]?.note, 'rework step 2')
  })

  it('a rejection is recorded, leaves the phase alone, keeps the gate pending and closes any earlier approval', () => {
    const next = recordApproval(planningTask, 'plan_approval', 'rejected', 'command', LATER, strict, 'too risky')
    assert.equal(next.phase, 'PLAN')
    assert.equal(next.approvals[0]?.decision, 'rejected')
    assert.equal(hasValidApproval(next, 'plan_approval'), false)
    assert.equal(pendingGate(next, strict), 'plan_approval')
    assertRejected(checkTransition(next, 'IMPLEMENT', 'model', strict))
  })

  it('a rejected gate can be approved after the plan is revised', () => {
    const rejected = recordApproval(planningTask, 'plan_approval', 'rejected', 'command', LATER, strict, 'revise')
    const revised = deepFreeze({ ...rejected, plan: makePlan({ summary: 'Revised plan' }) })
    const approved = recordApproval(revised, 'plan_approval', 'approved', 'command', LATER, strict)
    assert.equal(approved.approvals.length, 2)
    assert.deepEqual(checkTransition(approved, 'IMPLEMENT', 'model', strict), { ok: true })
  })

  it('keeps earlier approvals and does not mutate its input', () => {
    const earlier = approval('done_acceptance', 'rejected', { at: '2026-10-08T00:00:00.000Z' })
    const task = frozenTask({ phase: 'PLAN', plan, approvals: [earlier] })
    const before = structuredClone(task)
    const next = recordApproval(task, 'plan_approval', 'approved', 'command', LATER, strict)
    assert.deepEqual(next.approvals[0], earlier)
    assert.equal(next.approvals.length, 2)
    assert.notEqual(next.approvals, task.approvals)
    assert.deepEqual(task, before)
  })

  it('lets the approved task pass the gate it was recorded for', () => {
    const approved = recordApproval(planningTask, 'plan_approval', 'approved', 'command', LATER, strict)
    assert.equal(transition(approved, 'IMPLEMENT', 'user', 'approved', LATER, strict).phase, 'IMPLEMENT')
    const accepted = recordApproval(validatingTask, 'done_acceptance', 'approved', 'command', LATER, strict)
    assert.equal(transition(accepted, 'DONE', 'user', 'accepted', LATER, strict).phase, 'DONE')
  })

  describe('throws EwmError(invalid_input) when the gate is not pending', () => {
    const cases: [string, Task, GateName, RegExp][] = [
      ['plan_approval outside PLAN', frozenTask({ phase: 'EXPLORE', plan }), 'plan_approval', /decided in PLAN.*EXPLORE/],
      ['plan_approval without a plan', frozenTask({ phase: 'PLAN' }), 'plan_approval', /no steps/],
      ['plan_approval for a plan without steps', frozenTask({ phase: 'PLAN', plan: makePlan({ steps: [] }) }), 'plan_approval', /no steps/],
      ['plan_approval when the profile does not require it', planningTask, 'plan_approval', /does not require/],
      ['plan_approval that is already approved', frozenTask({ phase: 'PLAN', plan, approvals: [planApproval(plan)] }), 'plan_approval', /already approved/],
      ['done_acceptance outside VALIDATE', frozenTask({ phase: 'IMPLEMENT', validations: [makeValidation()] }), 'done_acceptance', /decided in VALIDATE.*IMPLEMENT/],
      ['done_acceptance before any validation run', frozenTask({ phase: 'VALIDATE' }), 'done_acceptance', /no validation run/],
      [
        'done_acceptance that is already accepted',
        frozenTask({ phase: 'VALIDATE', validations: [makeValidation()], approvals: [approval('done_acceptance')] }),
        'done_acceptance',
        /already accepted/,
      ],
      ['done_acceptance while plan_approval is the pending gate', planningTask, 'done_acceptance', /decided in VALIDATE.*PLAN/],
      ['plan_approval while done_acceptance is the pending gate', validatingTask, 'plan_approval', /decided in PLAN.*VALIDATE/],
      ['any gate in PAUSED', frozenTask({ phase: 'PAUSED', paused_from: 'PLAN', plan }), 'plan_approval', /decided in PLAN.*PAUSED/],
      ['any gate in DONE', readyTask('DONE'), 'done_acceptance', /decided in VALIDATE.*DONE/],
    ]
    for (const [name, task, gate, message] of cases) {
      it(name, () => {
        const profile = name.includes('does not require') ? relaxed : strict
        for (const decision of ['approved', 'rejected'] as const) {
          assertEwmError(() => recordApproval(task, gate, decision, 'command', LATER, profile), 'invalid_input', message)
        }
      })
    }
  })
})

// ---------------------------------------------------------------------------
// defaultNextAction
// ---------------------------------------------------------------------------

describe('defaultNextAction', () => {
  it('gives a distinct, non-empty sentence for every phase', () => {
    const sentences = PHASES.map((phase) => defaultNextAction(phase))
    for (const sentence of sentences) assert.match(sentence, /^\S.*\.$/)
    assert.equal(new Set(sentences).size, PHASES.length)
  })

  it('matches the contract example for EXPLORE', () => {
    assert.equal(defaultNextAction('EXPLORE'), 'Delegate bounded searches to ewm scouts and record sourced findings.')
  })

  it('tells the person how to leave PAUSED', () => {
    assert.match(defaultNextAction('PAUSED'), /\/ewm resume/)
  })
})

// ---------------------------------------------------------------------------
// A whole task, end to end
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('walks INTAKE to DONE, stopping at both gates until a human approves', () => {
    const plan = makePlan()
    let task = frozenTask()
    const step = (to: Phase, actor: Actor = 'model') => {
      task = deepFreeze(transition(task, to, actor, `to ${to}`, LATER, strict))
    }

    step('EXPLORE')
    step('UNDERSTAND')
    step('EXPLORE')
    step('UNDERSTAND')
    step('PLAN')
    assert.equal(pendingGate(task, strict), null, 'no plan yet')

    task = deepFreeze({ ...task, plan })
    assert.equal(pendingGate(task, strict), 'plan_approval')
    assertEwmError(() => step('IMPLEMENT'), 'gate_required')

    task = deepFreeze(pause(task, LATER))
    assert.equal(pendingGate(task, strict), null, 'paused tasks have no pending gate')
    task = deepFreeze(resume(task, LATER))

    task = deepFreeze(recordApproval(task, 'plan_approval', 'approved', 'command', LATER, strict))
    assert.equal(pendingGate(task, strict), null)
    step('IMPLEMENT')
    step('VALIDATE')
    assert.equal(pendingGate(task, strict), null, 'no validation run yet')
    assertEwmError(() => step('DONE'), 'gate_required')

    task = deepFreeze({ ...task, validations: [makeValidation()] })
    assert.equal(pendingGate(task, strict), 'done_acceptance')
    assertEwmError(() => step('DONE'), 'gate_required')

    task = deepFreeze(recordApproval(task, 'done_acceptance', 'approved', 'pane', LATER, strict))
    step('DONE', 'user')

    assert.equal(task.phase, 'DONE')
    assert.deepEqual(
      task.transitions.map((t) => `${t.from}>${t.to}`),
      [
        'INTAKE>EXPLORE',
        'EXPLORE>UNDERSTAND',
        'UNDERSTAND>EXPLORE',
        'EXPLORE>UNDERSTAND',
        'UNDERSTAND>PLAN',
        'PLAN>PAUSED',
        'PAUSED>PLAN',
        'PLAN>IMPLEMENT',
        'IMPLEMENT>VALIDATE',
        'VALIDATE>DONE',
      ],
    )
    for (const to of PHASES) assert.equal(checkTransition(task, to, 'user', strict).ok, false)
  })

  it('sends a failed validation back through IMPLEMENT and PLAN without re-approving an unchanged plan', () => {
    const plan = makePlan()
    const validating = readyTask('VALIDATE', { approvals: [planApproval(plan)] })
    const back = transition(validating, 'IMPLEMENT', 'model', 'fix failing test', LATER, strict)
    assert.equal(back.phase, 'IMPLEMENT')
    assert.equal(transition(deepFreeze(back), 'VALIDATE', 'model', 'retry', LATER, strict).phase, 'VALIDATE')
    assert.equal(transition(validating, 'PLAN', 'model', 'design change', LATER, strict).phase, 'PLAN')
  })

  it('needs a fresh approval after a design change edits the plan', () => {
    const original = makePlan()
    const replanned = frozenTask({ phase: 'PLAN', plan: makePlan({ steps: [makeStep(), makeStep({ id: 'S-2', text: 'Extra step' })] }), approvals: [planApproval(original)] })
    assert.equal(pendingGate(replanned, strict), 'plan_approval')
    assertEwmError(() => transition(replanned, 'IMPLEMENT', 'model', 'go', LATER, strict), 'gate_required')
  })
})
