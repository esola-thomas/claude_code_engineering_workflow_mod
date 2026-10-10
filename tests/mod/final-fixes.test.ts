// Final fixes through the real engine: a vanished task folder, /ewm reset, and the single "ewm: " prefix.

import { expect, test } from 'claude-code/testing'

import { createHarness, ROOT, SOURCE_FILE, TASK_DIR } from './harness.ts'
import type { Harness } from './harness.ts'

const EDIT = { tool: 'Edit', file_path: SOURCE_FILE, old_string: 'a - b', new_string: 'a + b' } as const
const MISSING = "TASK-001's files are missing: run /ewm status to see options (/ewm list deactivates it)"
const PLAN = { summary: 's', steps: [{ text: 'fix', files: ['src/a.ts'] }], risks: [], tests: [], alternatives: [] }

function deleteTaskFolder(h: Harness): void {
  for (const key of [...h.io.files.keys()]) if (key.startsWith(`${TASK_DIR}/`)) h.io.files.delete(key)
}

test('F1: with the task folder gone, the guard keeps enforcing the ledger phase and every deny says how to get out', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  deleteTaskFolder(h)
  h.reached.length = 0

  // PLAN: writes are denied, the reason carries the way out, and nothing reaches the engine.
  const edit = await $.tool.call(EDIT)
  expect(edit.deny).toContain('PLAN')
  expect(edit.deny).toContain(MISSING)
  const push = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(push.deny).toContain(MISSING)
  expect(h.reached).toEqual([])

  // Reading still works, and the session is not bricked.
  const read = await $.tool.call({ tool: 'Read', file_path: SOURCE_FILE })
  expect(read.deny).toBeUndefined()
  const status = await h.ewm('status')
  expect(status.text).toContain("TASK-001's files are missing")
  expect(status.text).toContain('/ewm list')
  expect(status.text).toContain('/ewm new')
  expect(status.text).not.toMatch(/^ewm: /)

  // The way out: /ewm list deactivates the task and the guard goes inert.
  const list = await h.ewm('list')
  expect(list.text).toContain('deactivated')
  expect(h.ledger().active_task).toBeNull()
  const after = await $.tool.call(EDIT)
  expect(after.deny).toBeUndefined()
})

test('F1: an IMPLEMENT task with no files still has its destructive commands denied; PAUSED stays inert', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')
  deleteTaskFolder(h)

  const push = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(push.deny).toContain('destructive')
  expect(push.deny).toContain(MISSING)
  const toState = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.ewm/tasks/TASK-001/task.json`, content: '{}' })
  expect(toState.deny).toContain(MISSING)

  // Another process wrote PAUSED into the ledger: that phase is inert even without files.
  const ledger = h.ledger()
  const entry = ledger.tasks['TASK-001']
  if (entry === undefined) throw new Error('no entry')
  h.io.kv.set(`ledger:${ROOT}`, { ...ledger, tasks: { 'TASK-001': { ...entry, phase: 'PAUSED', paused_from: 'IMPLEMENT' } } })
  const inert = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(inert.deny).toBeUndefined()
})

test('F2: a malformed ledger denies with a way out, /ewm reset is human-only, and afterwards the session works', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')
  h.io.kv.set(`ledger:${ROOT}`, { version: 'broken' })
  h.reached.length = 0

  const denied = await $.tool.call({ tool: 'Read', file_path: SOURCE_FILE })
  expect(denied.deny).toContain('/ewm reset')
  expect(denied.deny).not.toContain('mod store entry')
  expect(h.reached).toEqual([])
  const fresh = await h.ewm('new "Again"')
  expect(fresh.text).toContain('/ewm reset')

  // A plugin, a scheduled trigger or a notification cannot reset gates.
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'scheduled-trigger' }, { kind: 'task-notification' }] as const) {
    const refused = await h.ewm('reset', origin)
    expect(refused.text).toContain('refused')
    expect(h.io.kv.get(`ledger:${ROOT}`)).toEqual({ version: 'broken' })
  }

  const out = await h.ewm('reset', { kind: 'composer' })
  expect(out.text).toContain('ledger-backup-2026-10-09T17-00-00.000Z.json')
  expect(out.text).not.toMatch(/^ewm: /)
  expect(JSON.parse(h.io.files.get(`${ROOT}/.ewm/ledger-backup-2026-10-09T17-00-00.000Z.json`) ?? 'null')).toEqual({ version: 'broken' })
  expect(h.ledger()).toEqual({ version: 1, root: ROOT, active_task: null, tasks: {} })
  expect(h.statuses.at(-1)).toBeUndefined()
  expect(h.view()).toBeNull()

  // Tasks on disk are untouched, and resuming one needs its gates approved again.
  expect(h.task().id).toBe('TASK-001')
  const read = await $.tool.call({ tool: 'Read', file_path: SOURCE_FILE })
  expect(read.deny).toBeUndefined()
  const resumed = await h.ewm('resume TASK-001')
  expect(resumed.text).toContain('Ledger reset')
  expect(h.ledger().active_task).toBe('TASK-001')
  expect(h.ledger().tasks['TASK-001']).toMatchObject({ phase: 'EXPLORE', approvals: [], validations: [] })
})

test('F4: command replies carry no "ewm: " of their own, so the engine\'s prefix appears once', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  const replies: string[] = []
  replies.push((await h.ewm('frobnicate')).text ?? '')
  replies.push((await h.ewm('approve')).text ?? '')
  await h.ewm('new "Fix sum"')
  replies.push((await h.ewm('approve', { kind: 'plugin', name: 'x' })).text ?? '')
  replies.push((await h.ewm('resume TASK-009')).text ?? '')
  h.io.kv.set(`ledger:${ROOT}`, { version: 'broken' })
  replies.push((await h.ewm('status')).text ?? '')
  replies.push((await h.ewm('new "x"')).text ?? '')
  for (const text of replies) {
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/^ewm: /)
    expect(text).not.toContain('ewm: ewm:')
  }
})

test('F6: the kickoff after /ewm approve is queued on the clock like the others (best effort in headless runs)', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  await h.clock.advance(1)
  h.submitted.length = 0
  await h.ewm('approve')
  expect(h.submitted).toEqual([])
  await h.clock.advance(1)
  expect(h.submitted).toHaveLength(1)
  expect(h.submitted[0]).toContain('ewm:implement')
})
