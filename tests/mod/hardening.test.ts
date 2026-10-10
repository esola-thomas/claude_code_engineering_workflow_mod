// Engine tests for the Run 2 hardening that lives in hooks/register.tsx: who may change state (CR6, D19),
// the write-path resolver (CR17), the ledger-authoritative phase seen by the guard (CR5), and the pane (CR16).

import { expect, test } from 'claude-code/testing'

import { runTool } from '../../src/service.ts'
import { createHarness, ROOT, TASK_DIR } from './harness.ts'

const PANE = {
  plugin: 'ewm',
  component: 'Pane',
  requestId: 'ewm',
  props: { title: 'Engineering Workflow', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  viewport: { columns: 100, rows: 30, isFullscreen: true },
  surface: 'terminal',
} as const

const PLAN = { summary: 'Fix the operator', steps: [{ text: 'Use + in sum', files: ['src/a.ts'] }], risks: ['none'], tests: [], alternatives: [] }

const NON_HUMAN = [{ kind: 'plugin', name: 'x' }, { kind: 'scheduled-trigger' }, { kind: 'task-notification' }] as const

test('CR6: every state-changing /ewm command is refused from a non-human origin, and changes nothing', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  for (const origin of NON_HUMAN) {
    expect((await h.ewm('new "Sneaky"', origin)).text).toContain('refused')
  }
  expect(h.io.files.has(`${TASK_DIR}/task.json`)).toBe(false)

  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND')
  for (const origin of NON_HUMAN) {
    for (const args of ['plan', 'pause', 'resume', 'resume TASK-001', 'new "Other"', 'approve', 'reject no']) {
      const out = await h.ewm(args, origin)
      expect(out.text, `${args} from ${origin.kind}`).toContain('refused')
      expect(out.text).toContain(`/ewm ${args.split(' ')[0]}`)
    }
  }
  expect(h.task().phase).toBe('UNDERSTAND')
  expect(h.ledger().active_task).toBe('TASK-001')
  expect(Object.keys(h.ledger().tasks)).toEqual(['TASK-001'])

  // A person can still do all of it.
  expect((await h.ewm('plan')).text).toContain('UNDERSTAND > PLAN')
  expect(h.task().phase).toBe('PLAN')
})

test('CR6: the read-only commands work from any origin', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  for (const origin of NON_HUMAN) {
    for (const args of ['status', '', 'map', 'questions', 'list', 'help']) {
      const out = await h.ewm(args, origin)
      expect(out.text, `${args} from ${origin.kind}`).not.toContain('refused')
    }
  }
  expect((await h.ewm('list', { kind: 'plugin', name: 'x' })).text).toContain('TASK-001')
})

test('CR6: a scheduled /ewm resume cannot reload a profile the model edited', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  await h.ewm('approve')
  expect(h.ledger().tasks['TASK-001']?.profile.policies.external_network).toBe('deny_by_default')

  await h.io.writeText(`${ROOT}/.ewm/project.yaml`, 'policies:\n  external_network: allow\n  require_plan_approval: false\n')
  expect((await h.ewm('resume', { kind: 'scheduled-trigger' })).text).toContain('refused')
  expect(h.ledger().tasks['TASK-001']?.profile.policies.external_network).toBe('deny_by_default')
  expect((await $.tool.call({ tool: 'Bash', command: 'curl https://example.com' })).deny).toContain('external_network')

  // The person's own resume reloads it, and says so on screen.
  const out = await h.ewm('resume')
  expect(out.text).toContain('The project profile changed since the last snapshot')
  expect(out.text).toContain('policies.external_network')
})

test('CR5: editing task.json cannot switch the guard off or move the phase', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')

  // What `sed -i s/IMPLEMENT/PAUSED/ .e*m/tasks/TASK-001/task.json` would do, behind the guard's back.
  const task = h.task()
  await h.io.writeText(`${TASK_DIR}/task.json`, JSON.stringify({ ...task, phase: 'PAUSED' }, null, 2))
  h.reached.length = 0
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toContain('ewm:')
  expect((await $.tool.call({ tool: 'Write', file_path: `${TASK_DIR}/task.json`, content: '{}' })).deny).toContain('.ewm')
  expect(h.reached).toEqual([])
  expect(h.statuses.at(-1)).toContain('IMPLEMENT')
})

test('CR17: the write-path resolver walks up to the nearest existing ancestor', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  await h.ewm('approve')
  h.reached.length = 0

  // New files in new folders of the repository are fine (the old resolver could not place them and denied).
  expect((await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new/deeper/file.ts`, content: 'x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: 'src/relative/new.ts', content: 'x' })).deny).toBeUndefined()

  // New files below .ewm, however deep, are workflow state.
  for (const file_path of [
    `${TASK_DIR}/sub/deep/new.json`,
    `${ROOT}/.ewm/not-yet/created/file`,
    `${ROOT}/src/../.ewm/project.yaml`,
    `${ROOT}/missing-dir/../.ewm/tasks/TASK-001/task.json`,
    `${ROOT}/src/./../.ewm/new-file`,
  ]) {
    const out = await $.tool.call({ tool: 'Write', file_path, content: 'x' })
    expect(out.deny, file_path).toContain('.ewm')
  }
  expect(h.reached).toEqual(['Write', 'Write'])
})

test('CR16: the pane names the project and the plan awaiting approval; the Approve button carries that plan hash', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  const pane = await $.ui.mount(PANE)
  await h.ewm('new "Fix sum"')
  expect(await pane.find({ type: 'Text', text: 'Project: default' })).toBeDefined()
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  expect(await pane.find({ type: 'Text', text: /Plan [0-9a-f]{8}/ })).toBeUndefined()
  await h.tool('set_plan', PLAN)
  const hash = h.task().plan?.hash ?? ''
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(await pane.find({ type: 'Text', text: new RegExp(`Plan ${hash.slice(0, 8)} · 1 step: Fix the operator`) })).toBeDefined()
  expect(h.statuses.at(-1)).toBe('ewm TASK-001 · PLAN · awaiting /ewm approve')

  await pane.press({ key: 'approve' })
  expect(h.task().phase).toBe('IMPLEMENT')
  expect(h.task().approvals.at(-1)).toMatchObject({ via: 'pane', plan_hash: hash })
  await pane.unmount()
})

test('CR16: Approve is refused when the plan changed after the pane drew it', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  const pane = await $.ui.mount(PANE)
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', PLAN)
  expect(await pane.find({ key: 'approve' })).toBeDefined()

  // The plan is replaced behind the pane's back (no refresh: this is the window the person's click can fall into).
  const swapped = await runTool({ io: h.io, root: ROOT }, 'set_plan', { ...PLAN, summary: 'Rewrite everything', steps: [{ text: 'rm -rf', files: ['package.json'] }] })
  expect(swapped.ok).toBe(true)

  await pane.press({ key: 'approve' })
  expect(h.task().phase).toBe('PLAN')
  expect(h.task().approvals).toEqual([])
  expect(await pane.find({ type: 'Text', text: /plan changed after you reviewed it/ })).toBeDefined()
  await pane.unmount()
})
