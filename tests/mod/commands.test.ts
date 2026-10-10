import { expect, test } from 'claude-code/testing'

import { createHarness, ROOT, TASK_DIR } from './harness.ts'

test('/ewm new creates the task, returns status text and queues the kickoff after the command returns', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  expect(h.commands).toEqual(['ewm'])

  const out = await h.ewm('new "Fix sum" --goal "sum subtracts instead of adding"')
  expect(out.text).toContain('Started TASK-001: Fix sum')
  expect(out.text).toContain('Phase: INTAKE')
  expect(h.io.files.has(`${ROOT}/.ewm/.gitignore`)).toBe(true)
  expect(h.task()).toMatchObject({ id: 'TASK-001', title: 'Fix sum', goal: 'sum subtracts instead of adding', phase: 'INTAKE' })
  expect(h.task().repo).toEqual({ root: '.', branch: 'main', base_commit: 'abc1234' })

  // The host refuses $.prompt.submit inside command.run, so the kickoff waits for the clock.
  expect(h.submitted).toEqual([])
  await h.clock.advance(1)
  expect(h.submitted).toHaveLength(1)
  expect(h.submitted[0]).toContain('ewm:intake')
  expect(h.submitted[0]).toContain('TASK-001')

  // The ledger (not task.json) holds the active pointer.
  const ledger = h.ledger()
  expect(ledger.active_task).toBe('TASK-001')
  expect(h.statuses.at(-1)).toBe('ewm TASK-001 · INTAKE')
})

test('/ewm status, list and help answer from the active task', async ($, on) => {
  const h = createHarness($, on)
  await h.start()

  expect((await h.ewm('status')).text).toContain('No active task')
  expect((await h.ewm('')).text).toContain('No active task')

  await h.ewm('new "Fix sum"')
  await h.ewm('new "Second task"')
  const status = await h.ewm('status')
  expect(status.text).toContain('TASK-002')
  expect(status.text).toContain('Phase: INTAKE')

  const list = await h.ewm('list')
  expect(list.text).toContain('TASK-001')
  expect(list.text).toContain('TASK-002')
  expect(list.text).toContain('Second task')
  // Starting a second task paused the first one.
  expect(h.task().id).toBe('TASK-001')
  expect(h.task().phase).toBe('PAUSED')

  const help = await h.ewm('help')
  expect(help.text).toContain('/ewm new')
  expect(help.text).toContain('/ewm approve')

  const unknown = await h.ewm('frobnicate')
  // F4: the engine shows a command's output as "ewm: <text>", so the text itself carries no prefix (it would read "ewm: ewm: ...").
  expect(unknown.text).toContain('unknown command')
  expect(unknown.text).not.toMatch(/^ewm: /)
  expect(unknown.text).toContain('/ewm new')
})

test('/ewm approve and reject are refused from a plugin origin and accepted from a person (D13)', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', { summary: 'Fix the operator', steps: [{ text: 'Use + in sum', files: ['src/a.ts'] }], risks: ['none'], tests: ['npm test'], alternatives: [] })
  expect(h.task().phase).toBe('PLAN')

  const forged = await h.ewm('approve looks fine', { kind: 'plugin', name: 'x' })
  expect(forged.text).toContain('refused')
  expect(h.task().phase).toBe('PLAN')
  expect(h.task().approvals).toEqual([])
  expect((await h.ewm('reject because', { kind: 'plugin', name: 'x' })).text).toContain('refused')

  for (const kind of ['composer', 'bridge', 'sdk'] as const) {
    const out = await h.ewm('reject needs more detail', { kind })
    expect(out.text).not.toContain('refused')
  }
  expect(h.task().approvals.every(a => a.decision === 'rejected')).toBe(true)
  expect(h.task().phase).toBe('PLAN')

  const approved = await h.ewm('approve go', { kind: 'composer' })
  expect(approved.text).not.toContain('refused')
  expect(h.task().phase).toBe('IMPLEMENT')
  expect(h.task().approvals.at(-1)).toMatchObject({ gate: 'plan_approval', decision: 'approved', by: 'user', via: 'command' })
  await h.clock.advance(1)
  expect(h.submitted.at(-1)).toContain('ewm:implement')
})

test('/ewm approve without a pending gate explains what is missing', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  const out = await h.ewm('approve')
  expect(out.text).toContain('nothing to approve in INTAKE')
  expect(out.text).not.toMatch(/^ewm: /)
  expect(h.task().phase).toBe('INTAKE')
  expect(TASK_DIR).toContain('TASK-001')
})
