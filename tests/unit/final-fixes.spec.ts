// Regression tests for the final fixes (F1-F5 of the last review round): a task folder that vanished,
// /ewm reset, the next action of a pending gate, the single "ewm: " prefix, and ledger-held validation freshness.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { activeContext, activeTaskId, runCommand, runTool, statusLine } from '../../src/service.ts'
import type { Ctx } from '../../src/service.ts'
import { DEFAULT_PROFILE } from '../../src/profile.ts'
import { ledgerKey, loadLedger, loadTask, resetLedger, saveLedger, trustedTask } from '../../src/store.ts'
import { nextActionOf, paneModel, renderResumeBrief, renderStatus } from '../../src/render.ts'
import type { GateState } from '../../src/render.ts'
import { unprefixed } from '../../src/types.ts'
import type { CommandOutput, Ledger, LedgerEntry, Task, ToolOutput } from '../../src/types.ts'
import { createMemoryIo, fakeGit } from '../support/memory-io.ts'
import type { MemoryIo } from '../support/memory-io.ts'
import { makeProfile, makeTask } from '../support/fixtures.ts'

const ROOT = '/repo'
const TASK_DIR = '/repo/.ewm/tasks/TASK-001'
const PROJECT_YAML = ['validation:', '  commands:', '    - npm test', ''].join('\n')

type Env = { io: MemoryIo; ctx: Ctx }

function setup(files: Record<string, string> = {}): Env {
  const io = createMemoryIo({ '/repo/src/math.ts': 'a\nb\nc\n', '/repo/README.md': 'x\n', ...files })
  io.onRun((argv, opts) => (argv[0] === 'git' ? fakeGit({ branch: 'main', commit: 'a1b2c3d' })(argv, opts) : { exitCode: 0, stdout: 'ok\n', stderr: '' }))
  return { io, ctx: { io, root: ROOT } }
}

const cmd = (env: Env, args: string, via: 'command' | 'pane' = 'command'): Promise<CommandOutput> => runCommand(env.ctx, args, via)
const tool = (env: Env, name: string, input: Record<string, unknown> = {}): Promise<ToolOutput> => runTool(env.ctx, name, input)
const taskOf = (env: Env, id = 'TASK-001'): Promise<Task> => loadTask(env.io, ROOT, id)
const entryOf = async (env: Env, id = 'TASK-001'): Promise<LedgerEntry> => {
  const entry = (await loadLedger(env.io, ROOT)).tasks[id]
  assert.ok(entry !== undefined, `no ledger entry for ${id}`)
  return entry
}

async function ok(result: Promise<ToolOutput>): Promise<ToolOutput> {
  const out = await result
  assert.equal(out.ok, true, out.text)
  return out
}

const advance = (env: Env, to: string): Promise<ToolOutput> => ok(tool(env, 'advance', { to, reason: `ready for ${to}` }))

const PLAN_INPUT = {
  summary: 'Fix the loop bound in sum()',
  steps: [{ text: 'Use <= in the loop', files: ['src/math.ts'] }],
  risks: ['off by one elsewhere'],
  tests: ['npm test'],
  alternatives: [],
}

async function toPlan(env: Env): Promise<void> {
  await cmd(env, 'new "Fix sum"')
  await advance(env, 'EXPLORE')
  await advance(env, 'UNDERSTAND')
  assert.match((await cmd(env, 'plan')).text, /UNDERSTAND > PLAN/)
}

async function toImplement(env: Env): Promise<void> {
  await toPlan(env)
  await ok(tool(env, 'set_plan', PLAN_INPUT))
  assert.match((await cmd(env, 'approve')).text, /IMPLEMENT/)
}

async function toValidate(env: Env): Promise<void> {
  await toImplement(env)
  env.io.advance(1000)
  await advance(env, 'VALIDATE')
}

async function passValidation(env: Env): Promise<void> {
  env.io.advance(1000)
  await ok(tool(env, 'run_validation', { command: 'npm test' }))
}

async function editTaskFile(env: Env, edit: (task: Record<string, unknown>) => void): Promise<void> {
  const task = JSON.parse(await env.io.readText(`${TASK_DIR}/task.json`)) as Record<string, unknown>
  edit(task)
  await env.io.writeText(`${TASK_DIR}/task.json`, JSON.stringify(task, null, 2) + '\n')
}

/** Removes everything under .ewm/tasks/TASK-001, as `git clean -fdx` would. */
function deleteTaskFolder(env: Env): void {
  for (const key of [...env.io.files.keys()]) if (key.startsWith(`${TASK_DIR}/`)) env.io.files.delete(key)
}

// ---------------------------------------------------------------------------
// F1: missing task files must not brick the session
// ---------------------------------------------------------------------------

describe('F1: activeContext when the active task has no files', () => {
  it('has no task, the default profile and no phase when nothing is active', async () => {
    const env = setup()
    assert.deepEqual(await activeContext(env.ctx), { task: null, profile: DEFAULT_PROFILE, phase: null })
  })

  it('returns the ledger phase and snapshot with the task, and still the ledger phase without it', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toImplement(env)
    const present = await activeContext(env.ctx)
    assert.equal(present.task?.phase, 'IMPLEMENT')
    assert.equal(present.phase, 'IMPLEMENT')

    deleteTaskFolder(env)
    const gone = await activeContext(env.ctx)
    assert.equal(gone.task, null)
    assert.equal(gone.phase, 'IMPLEMENT')
    assert.deepEqual(gone.profile.validation.commands, ['npm test'], 'the profile is the ledger snapshot')
    assert.equal(await activeTaskId(env.ctx), 'TASK-001')
  })

  it('follows the ledger phase for every active phase and for PAUSED', async () => {
    const env = setup()
    await toPlan(env)
    deleteTaskFolder(env)
    assert.equal((await activeContext(env.ctx)).phase, 'PLAN')
    const ledger = await loadLedger(env.io, ROOT)
    await saveLedger(env.io, ROOT, { ...ledger, tasks: { 'TASK-001': { ...(ledger.tasks['TASK-001'] as LedgerEntry), phase: 'PAUSED', paused_from: 'PLAN' } } })
    assert.equal((await activeContext(env.ctx)).phase, 'PAUSED')
  })

  it('treats an unreadable task.json with no backup the same as a missing one', async () => {
    const env = setup()
    await toPlan(env)
    env.io.files.set(`${TASK_DIR}/task.json`, '{ broken')
    env.io.files.delete(`${TASK_DIR}/task.json.bak`)
    const context = await activeContext(env.ctx)
    assert.equal(context.task, null)
    assert.equal(context.phase, 'PLAN')
  })

  it('a deleted task.json counts as missing even when a task.json.bak is left (the backup only stands in for a corrupt file, CR13)', async () => {
    const env = setup()
    await toPlan(env)
    await ok(tool(env, 'decision', { title: 'T', choice: 'c', rationale: 'r' })) // leaves a task.json.bak
    env.io.files.delete(`${TASK_DIR}/task.json`)
    const context = await activeContext(env.ctx)
    assert.equal(context.task, null)
    assert.equal(context.phase, 'PLAN')
  })

  it('a malformed ledger still throws, and its message names /ewm reset', async () => {
    const env = setup()
    await toPlan(env)
    env.io.kv.set(ledgerKey(ROOT), { version: 7 })
    await assert.rejects(activeContext(env.ctx), /\/ewm reset/)
  })
})

describe('F1: /ewm status explains a missing task and the ways out', () => {
  it('names the task, says the guard still applies, and offers /ewm list and /ewm new', async () => {
    const env = setup()
    await toImplement(env)
    deleteTaskFolder(env)
    const out = await cmd(env, 'status')
    assert.equal(out.changed, false)
    assert.match(out.text, /TASK-001's files are missing/)
    assert.match(out.text, /IMPLEMENT rules/)
    assert.match(out.text, /\/ewm list/)
    assert.match(out.text, /deactivates/)
    assert.match(out.text, /\/ewm new/)
    assert.doesNotMatch(out.text, /^ewm: /)
  })

  it('/ewm list then deactivates the pointer, and the guard goes inert', async () => {
    const env = setup()
    await toImplement(env)
    deleteTaskFolder(env)
    assert.equal((await cmd(env, 'list')).changed, true)
    const context = await activeContext(env.ctx)
    assert.equal(context.phase, null)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
  })

  it('/ewm new starts over without touching the missing task', async () => {
    const env = setup()
    await toImplement(env)
    deleteTaskFolder(env)
    const out = await cmd(env, 'new "Second try"')
    assert.match(out.text, /Started TASK-002/)
    assert.equal((await activeContext(env.ctx)).phase, 'INTAKE')
  })

  it('the malformed-ledger text names /ewm reset and no longer asks for a hand edit of the store', async () => {
    const env = setup()
    await toPlan(env)
    env.io.kv.set(ledgerKey(ROOT), { version: 7 })
    for (const text of [(await cmd(env, 'status')).text, (await cmd(env, 'new "x"')).text, (await tool(env, 'status')).text]) {
      assert.match(text, /\/ewm reset/)
      assert.doesNotMatch(text, /mod store entry/)
    }
  })
})

// ---------------------------------------------------------------------------
// F2: /ewm reset
// ---------------------------------------------------------------------------

describe('F2: resetLedger (store)', () => {
  it('saves the raw value to .ewm/ledger-backup-<time with : as ->.json and stores an empty ledger', async () => {
    const io = createMemoryIo()
    const broken = { version: 7, junk: [1, 2] }
    await io.kvSet(ledgerKey(ROOT), broken)
    const { backup } = await resetLedger(io, ROOT, '2026-10-09T17:00:00.000Z')
    assert.equal(backup, '/repo/.ewm/ledger-backup-2026-10-09T17-00-00.000Z.json')
    assert.deepEqual(JSON.parse(io.files.get(backup) ?? 'null'), broken)
    assert.deepEqual(await loadLedger(io, ROOT), { version: 1, root: ROOT, active_task: null, tasks: {} })
  })

  it('backs up whatever is there, a string or nothing at all', async () => {
    const io = createMemoryIo()
    await io.kvSet(ledgerKey(ROOT), 'garbage')
    const first = await resetLedger(io, ROOT, '2026-10-09T17:00:00.000Z')
    assert.equal(JSON.parse(io.files.get(first.backup) ?? ''), 'garbage')
    const fresh = createMemoryIo()
    const second = await resetLedger(fresh, ROOT, '2026-10-09T18:00:00.000Z')
    assert.equal(JSON.parse(fresh.files.get(second.backup) ?? ''), null)
  })

  it('does not replace the ledger when the backup cannot be written', async () => {
    const io = createMemoryIo()
    await io.kvSet(ledgerKey(ROOT), { version: 7 })
    io.writeText = async () => {
      throw new Error('disk full')
    }
    await assert.rejects(resetLedger(io, ROOT, '2026-10-09T17:00:00.000Z'), /disk full/)
    assert.deepEqual(io.kv.get(ledgerKey(ROOT)), { version: 7 })
  })
})

describe('F2: /ewm reset and resuming afterwards', () => {
  it('recovers from a malformed ledger: backup, empty ledger, tasks untouched', async () => {
    const env = setup()
    await toImplement(env)
    const before = env.io.files.get(`${TASK_DIR}/task.json`)
    env.io.kv.set(ledgerKey(ROOT), { version: 7 })
    assert.match((await cmd(env, 'status')).text, /\/ewm reset/)

    const out = await cmd(env, 'reset')
    assert.equal(out.changed, true)
    assert.match(out.text, /ledger-backup-2026-10-09T17-00-00\.000Z\.json/)
    assert.match(out.text, /TASK-001/)
    assert.deepEqual(JSON.parse(env.io.files.get('/repo/.ewm/ledger-backup-2026-10-09T17-00-00.000Z.json') ?? ''), { version: 7 })
    assert.deepEqual(await loadLedger(env.io, ROOT), { version: 1, root: ROOT, active_task: null, tasks: {} })
    assert.equal(env.io.files.get(`${TASK_DIR}/task.json`), before, 'task files are untouched')
    assert.match((await cmd(env, 'status')).text, /No active task/)
  })

  it('works on a healthy ledger too, as a fresh start', async () => {
    const env = setup()
    await toPlan(env)
    const out = await cmd(env, 'reset')
    assert.equal(out.changed, true)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
    const backups = [...env.io.files.keys()].filter(key => key.includes('ledger-backup-'))
    assert.equal(backups.length, 1)
    const saved = JSON.parse(env.io.files.get(backups[0] ?? '') ?? '') as Ledger
    assert.equal(saved.active_task, 'TASK-001', 'the backup holds the old ledger')
  })

  it('resume of an IMPLEMENT task without a ledger entry lands in PLAN with no approvals, records why, and says so', async () => {
    const env = setup()
    await toImplement(env)
    await cmd(env, 'reset')

    const out = await cmd(env, 'resume TASK-001')
    assert.match(out.text, /Ledger reset/)
    assert.match(out.text, /gates must be approved again/i)
    assert.match(out.text, /PLAN/)
    assert.ok(out.context?.some(line => /Ledger reset/.test(line)), 'the model is told too')
    assert.doesNotMatch(out.text, /Approved gates/)

    const entry = await entryOf(env)
    assert.equal(entry.phase, 'PLAN')
    assert.deepEqual(entry.approvals, [])
    assert.deepEqual(entry.validations, [])
    assert.equal((await loadLedger(env.io, ROOT)).active_task, 'TASK-001')

    const task = await taskOf(env)
    assert.equal(task.phase, 'PLAN')
    assert.deepEqual(task.transitions.at(-1), { from: 'IMPLEMENT', to: 'PLAN', actor: 'system', reason: 'ledger reset: gates must be approved again', at: '2026-10-09T17:00:00.000Z' })
    assert.match(task.next_action, /plan/i)
    assert.doesNotMatch(task.next_action, /^Implement/)
  })

  it('task.json approvals are not trusted: the plan needs approving again', async () => {
    const env = setup()
    await toImplement(env)
    const approvedBefore = (await taskOf(env)).approvals.length
    assert.ok(approvedBefore >= 1)
    await cmd(env, 'reset')
    await cmd(env, 'resume TASK-001')
    // task.json still shows the old approval, but the ledger has none: the gate is open again.
    const status = (await cmd(env, 'status')).text
    assert.match(status, /plan approval pending/)
    const advanced = await tool(env, 'advance', { to: 'IMPLEMENT', reason: 'try' })
    assert.equal(advanced.ok, false)
    assert.match((await cmd(env, 'approve')).text, /Plan approved/)
  })

  it('caps VALIDATE at PLAN too, and a PAUSED task by its paused_from', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await cmd(env, 'reset')
    assert.match((await cmd(env, 'resume TASK-001')).text, /Ledger reset/)
    assert.equal((await taskOf(env)).phase, 'PLAN')

    // Paused in VALIDATE, per a task.json no ledger vouches for.
    await cmd(env, 'pause')
    await editTaskFile(env, task => {
      task.phase = 'PAUSED'
      task.paused_from = 'VALIDATE'
    })
    await cmd(env, 'reset')
    const out = await cmd(env, 'resume TASK-001')
    assert.match(out.text, /Ledger reset/)
    const task = await taskOf(env)
    assert.equal(task.phase, 'PLAN')
    assert.equal(task.paused_from, null)
    assert.equal(task.transitions.at(-1)?.reason, 'ledger reset: gates must be approved again')
    assert.equal(task.transitions.at(-1)?.from, 'PAUSED')
  })

  it('keeps an early phase as it is (EXPLORE stays EXPLORE) and still records the reset', async () => {
    const env = setup()
    await cmd(env, 'new "Fix sum"')
    await advance(env, 'EXPLORE')
    await cmd(env, 'reset')
    const out = await cmd(env, 'resume TASK-001')
    assert.match(out.text, /Ledger reset/)
    assert.match(out.text, /Phase EXPLORE/)
    const task = await taskOf(env)
    assert.equal(task.phase, 'EXPLORE')
    assert.equal(task.transitions.at(-1)?.reason, 'ledger reset: gates must be approved again')
  })

  it('refuses to resume a DONE task without a ledger entry, and says so', async () => {
    const env = setup()
    await cmd(env, 'new "Fix sum"')
    await editTaskFile(env, task => {
      task.phase = 'DONE'
    })
    await cmd(env, 'reset')
    const out = await cmd(env, 'resume TASK-001')
    assert.equal(out.changed, false)
    assert.match(out.text, /DONE/)
    assert.match(out.text, /nothing to resume/)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
    assert.equal((await loadLedger(env.io, ROOT)).tasks['TASK-001'], undefined)
  })

  it('a resume for a task the ledger knows is unchanged (no reset notice, no extra transition)', async () => {
    const env = setup()
    await toPlan(env)
    await cmd(env, 'pause')
    const transitionsBefore = (await taskOf(env)).transitions.length
    const out = await cmd(env, 'resume TASK-001')
    assert.doesNotMatch(out.text, /Ledger reset/)
    assert.equal((await taskOf(env)).transitions.length, transitionsBefore + 1)
  })

  it('the new id never reuses a task that the reset ledger forgot', async () => {
    const env = setup()
    await toPlan(env)
    await cmd(env, 'reset')
    assert.match((await cmd(env, 'new "Again"')).text, /Started TASK-002/)
  })
})

// ---------------------------------------------------------------------------
// F3: the next action of a pending gate
// ---------------------------------------------------------------------------

describe('F3: next_action reflects a pending gate', () => {
  const PLAN_GATE: GateState = { pending: 'plan_approval', planApproved: false, models: [], plan: { hash: 'a'.repeat(64), steps: 2, summary: 'S' } }
  const DONE_GATE: GateState = { pending: 'done_acceptance', planApproved: true, models: [] }
  const NO_GATE: GateState = { pending: null, planApproved: false, models: [] }
  const task = makeTask({ phase: 'PLAN', next_action: 'Write the plan (steps, files, risks, tests, alternatives) and present it for approval.' })

  it('nextActionOf', () => {
    assert.equal(nextActionOf(task, PLAN_GATE), 'Review the plan and run /ewm approve (or /ewm reject <reason>)')
    assert.equal(nextActionOf(task, DONE_GATE), 'Review the validation results and run /ewm approve to accept closure (or /ewm reject <reason>)')
    assert.equal(nextActionOf(task, NO_GATE), task.next_action)
    assert.equal(nextActionOf(task), task.next_action)
  })

  it('status, pane and resume brief show it while the gate is pending', () => {
    const profile = makeProfile()
    assert.match(renderStatus(task, profile, PLAN_GATE), /Next: Review the plan and run \/ewm approve \(or \/ewm reject <reason>\)/)
    assert.equal(paneModel(task, profile, PLAN_GATE).next_action, 'Review the plan and run /ewm approve (or /ewm reject <reason>)')
    const staleness = { checked: true, branch_changed: false, head_changed: false, previous: { branch: null, commit: null }, current: { branch: null, commit: null }, changed_paths: [], stale_findings: [] }
    assert.match(renderResumeBrief(task, staleness, PLAN_GATE), /Next: Review the plan and run \/ewm approve/)
    assert.match(renderResumeBrief(task, staleness, DONE_GATE), /Next: Review the validation results and run \/ewm approve to accept closure \(or \/ewm reject <reason>\)/)
    assert.match(renderResumeBrief(task, staleness), /Next: Write the plan/, 'without a trusted gate the stored sentence stands')
    assert.match(renderStatus(task, profile, NO_GATE), /Next: Write the plan/)
  })

  it('end to end: after set_plan the status and the resume brief ask for the review, and after approval they do not', async () => {
    const env = setup()
    await toPlan(env)
    assert.match((await cmd(env, 'status')).text, /Next: Write the plan/, 'no plan yet')
    await ok(tool(env, 'set_plan', PLAN_INPUT))
    assert.match((await cmd(env, 'status')).text, /Next: Review the plan and run \/ewm approve/)
    assert.match((await tool(env, 'status')).text, /Next: Review the plan and run \/ewm approve/)

    await cmd(env, 'pause')
    const resumed = await cmd(env, 'resume')
    assert.match(resumed.text, /Next: Review the plan and run \/ewm approve/)
    assert.doesNotMatch(resumed.text, /Next: Write the plan/)

    await cmd(env, 'approve')
    assert.doesNotMatch((await cmd(env, 'status')).text, /Review the plan/)
  })

  it('done_acceptance: a passing validation turns the next action into the acceptance review', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    assert.match((await cmd(env, 'status')).text, /Next: Run the allowed validation commands/)
    await passValidation(env)
    assert.match((await cmd(env, 'status')).text, /Next: Review the validation results and run \/ewm approve to accept closure/)
  })

  it('the stored next_action is left as it was', async () => {
    const env = setup()
    await toPlan(env)
    await ok(tool(env, 'set_plan', PLAN_INPUT))
    assert.match((await taskOf(env)).next_action, /^Write the plan/)
  })
})

// ---------------------------------------------------------------------------
// F4: the prefix appears once
// ---------------------------------------------------------------------------

describe('F4: "ewm: " appears once', () => {
  const doubled = /ewm: ewm:/

  it('unprefixed drops any number of leading prefixes and nothing else', () => {
    assert.equal(unprefixed('ewm: ewm: boom'), 'boom')
    assert.equal(unprefixed('boom ewm: x'), 'boom ewm: x')
    assert.equal(unprefixed('plain'), 'plain')
  })

  it('an unexpected error that already carries the prefix is not prefixed again', async () => {
    const env = setup()
    await toPlan(env)
    const { kvSet } = env.io
    env.io.kvSet = async () => {
      throw new Error('ewm: store is down')
    }
    const out = await tool(env, 'advance', { to: 'UNDERSTAND', reason: 'back' }) // a transition writes the ledger
    env.io.kvSet = kvSet
    assert.equal(out.ok, false)
    assert.match(out.text, /^ewm: unexpected error: store is down/)
    assert.doesNotMatch(out.text, doubled)
  })

  it('a task file the io cannot read as text does not stack prefixes (store and service)', async () => {
    const env = setup()
    await toPlan(env)
    const { readText } = env.io
    env.io.readText = async path => {
      if (path.endsWith('task.json')) throw new Error('ewm: expected text from task.json')
      return readText(path)
    }
    for (const text of [(await cmd(env, 'status')).text, (await cmd(env, 'plan')).text, (await tool(env, 'status')).text]) {
      assert.doesNotMatch(text, /ewm: [^\n]*ewm: /)
    }
    env.io.readText = readText
  })

  it('an error wrapped for the audit log or a pause note carries the prefix only at the start', async () => {
    const env = setup()
    await cmd(env, 'new "First"')
    const { readText } = env.io
    env.io.readText = async path => {
      if (path.endsWith('TASK-001/task.json')) throw new Error('ewm: disk gone')
      return readText(path)
    }
    const out = await cmd(env, 'new "Second"')
    env.io.readText = readText
    assert.match(out.text, /Could not pause TASK-001 \(/)
    assert.doesNotMatch(out.text, /\(ewm: /)
    assert.doesNotMatch(out.text, doubled)
  })

  it('every reply that comes out of the service has at most one prefix', async () => {
    const env = setup()
    const texts: string[] = []
    for (const args of ['frobnicate', 'approve', 'resume TASK-009', 'resume nope', 'new', 'plan', 'pause', 'reset', 'status', 'map', 'questions', 'list', 'reject']) {
      texts.push((await cmd(env, args)).text)
    }
    env.io.kv.set(ledgerKey(ROOT), { version: 7 })
    for (const args of ['status', 'new "x"', 'pause', 'approve', 'resume']) texts.push((await cmd(env, args)).text)
    for (const text of texts) assert.doesNotMatch(text, doubled, text)
  })
})

// ---------------------------------------------------------------------------
// F5: validation freshness comes from the ledger
// ---------------------------------------------------------------------------

describe('F5: validating_since is kept in the ledger', () => {
  it('is set when the task enters VALIDATE and cleared when it leaves', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toImplement(env)
    assert.ok((await entryOf(env)).validating_since == null, 'not in VALIDATE yet')

    env.io.advance(1000)
    await advance(env, 'VALIDATE')
    const entered = (await entryOf(env)).validating_since
    assert.equal(entered, '2026-10-09T17:00:01.000Z')
    assert.equal(Object.hasOwn(await taskOf(env), 'validating_since'), false, 'task.json never carries it')

    env.io.advance(1000)
    await advance(env, 'IMPLEMENT')
    assert.equal((await entryOf(env)).validating_since, null)

    env.io.advance(1000)
    await advance(env, 'VALIDATE')
    assert.equal((await entryOf(env)).validating_since, '2026-10-09T17:00:03.000Z')

    await cmd(env, 'pause')
    assert.equal((await entryOf(env)).validating_since, null)
  })

  it('a resume into VALIDATE is a new entry', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await passValidation(env)
    await cmd(env, 'pause')
    env.io.advance(5000)
    await cmd(env, 'resume TASK-001')
    assert.equal((await taskOf(env)).phase, 'VALIDATE')
    const since = (await entryOf(env)).validating_since
    assert.equal(typeof since, 'string')
    assert.match((await cmd(env, 'status')).text, /Gate: none pending/, 'the pass from before the pause is not fresh')
  })

  it('rewriting task.transitions in task.json cannot make an old pass fresh', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await passValidation(env)
    assert.match((await cmd(env, 'status')).text, /final acceptance pending/)

    // Code changes: back to IMPLEMENT, then VALIDATE again. The old pass predates the new entry.
    env.io.advance(1000)
    await advance(env, 'IMPLEMENT')
    env.io.advance(1000)
    await advance(env, 'VALIDATE')
    assert.match((await cmd(env, 'status')).text, /Gate: none pending/)

    await editTaskFile(env, task => {
      task.transitions = [{ from: 'IMPLEMENT', to: 'VALIDATE', actor: 'model', reason: 'forged', at: '2000-01-01T00:00:00.000Z' }]
    })
    const status = (await cmd(env, 'status')).text
    assert.match(status, /Gate: none pending/)
    const approve = await cmd(env, 'approve')
    assert.equal(approve.changed, false)
    assert.match(approve.text, /no passing validation run|nothing to approve/)
    assert.equal((await taskOf(env)).phase, 'VALIDATE')
    assert.equal(await statusLine(env.ctx), 'ewm TASK-001 · VALIDATE')
  })

  it('a task.json that claims its own validating_since is ignored', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await passValidation(env)
    env.io.advance(1000)
    await advance(env, 'IMPLEMENT')
    env.io.advance(1000)
    await advance(env, 'VALIDATE')
    await editTaskFile(env, task => {
      task.validating_since = '2000-01-01T00:00:00.000Z'
    })
    assert.match((await cmd(env, 'status')).text, /Gate: none pending/)
    const trusted = trustedTask({ ...(await taskOf(env)), validating_since: '2000-01-01T00:00:00.000Z' } as Task, await entryOf(env))
    assert.equal(trusted.validating_since, (await entryOf(env)).validating_since)
  })

  it('a fresh pass opens done_acceptance and the person can accept', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await passValidation(env)
    assert.equal(await statusLine(env.ctx), 'ewm TASK-001 · VALIDATE · awaiting /ewm approve')
    const done = await cmd(env, 'approve')
    assert.match(done.text, /Accepted/)
    assert.equal((await taskOf(env)).phase, 'DONE')
    assert.equal((await entryOf(env)).validating_since, null)
  })

  it('an older ledger entry without the field fails closed; the next recorded run restores it', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    await passValidation(env)
    const ledger = await loadLedger(env.io, ROOT)
    const { validating_since: _removed, ...older } = ledger.tasks['TASK-001'] as LedgerEntry
    await saveLedger(env.io, ROOT, { ...ledger, tasks: { 'TASK-001': older } })

    assert.match((await cmd(env, 'status')).text, /Gate: none pending/)
    const refused = await cmd(env, 'approve')
    assert.equal(refused.changed, false)
    assert.equal((await taskOf(env)).phase, 'VALIDATE')
    assert.equal((await tool(env, 'advance', { to: 'DONE', reason: 'try' })).ok, false)

    await passValidation(env)
    assert.match((await cmd(env, 'status')).text, /final acceptance pending/)
    assert.equal(typeof (await entryOf(env)).validating_since, 'string')
    assert.match((await cmd(env, 'approve')).text, /Accepted/)
  })

  it('the ledger accepts validating_since as a string or null and rejects other types', async () => {
    const env = setup()
    await toPlan(env)
    const ledger = await loadLedger(env.io, ROOT)
    const entry = ledger.tasks['TASK-001'] as LedgerEntry
    for (const value of ['2026-10-09T17:00:00.000Z', null]) {
      env.io.kv.set(ledgerKey(ROOT), { ...ledger, tasks: { 'TASK-001': { ...entry, validating_since: value } } })
      await loadLedger(env.io, ROOT)
    }
    env.io.kv.set(ledgerKey(ROOT), { ...ledger, tasks: { 'TASK-001': { ...entry, validating_since: 5 } } })
    await assert.rejects(loadLedger(env.io, ROOT), /validating_since/)
  })
})
