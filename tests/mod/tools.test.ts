import { expect, test } from 'claude-code/testing'

import { createHarness, ROOT, TASK_DIR } from './harness.ts'

test('mcp__ewm__ tools run end to end through the engine and refresh the pane view', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  expect(h.view()).toBeNull()

  await h.ewm('new "Fix sum" --goal "sum subtracts"')
  expect(h.view()).toMatchObject({ task_id: 'TASK-001', phase: 'INTAKE', pending_gate: null })

  const intake = await h.tool('set_intake', { goal: 'Make sum add', success_criteria: ['sum(1,2) is 3'], constraints: ['no new deps'] })
  expect(intake.isError).toBe(false)
  expect(h.task().success_criteria).toEqual(['sum(1,2) is 3'])
  expect(h.task().constraints).toEqual(['no new deps'])
  expect(h.io.files.get(`${TASK_DIR}/decisions.md`)).toContain('sum(1,2) is 3')

  await h.advanceTo('EXPLORE')
  expect(h.statuses.at(-1)).toBe('ewm TASK-001 · EXPLORE')

  const finding = await h.tool('record_finding', {
    claim: 'sum subtracts its second argument',
    evidence: [{ path: 'src/a.ts', line_start: 1, line_end: 2 }],
    confidence: 'high',
    source: 'ewm:repo-scout',
  })
  expect(finding.isError).toBe(false)
  expect(finding.text).toContain('F-001')
  expect(h.task().findings).toHaveLength(1)
  expect(h.task().findings[0]).toMatchObject({ id: 'F-001', last_verified_commit: 'abc1234', source: 'ewm:repo-scout', stale: false })
  expect(h.io.files.get(`${TASK_DIR}/exploration.md`)).toContain('sum subtracts its second argument')

  // Evidence is checked against the repository: a file that does not exist, or lines past its end, are refused.
  const missing = await h.tool('record_finding', { claim: 'ghost', evidence: [{ path: 'src/missing.ts' }], confidence: 'low' })
  expect(missing.isError).toBe(true)
  expect(missing.text).toContain('src/missing.ts')
  const tooLong = await h.tool('record_finding', { claim: 'long', evidence: [{ path: 'src/a.ts', line_start: 1, line_end: 99 }], confidence: 'low' })
  expect(tooLong.isError).toBe(true)
  expect(h.task().findings).toHaveLength(1)

  const asked = await h.tool('question', { action: 'add', text: 'Should ZERO change too?' })
  expect(asked.isError).toBe(false)
  expect(h.task().open_questions).toMatchObject([{ id: 'Q-001', status: 'open' }])
  expect(h.statuses.at(-1)).toBe('ewm TASK-001 · EXPLORE · 1 open question')

  const map = await h.tool('write_map', { mermaid: 'graph TD; sum-->ZERO', text_map: 'sum is the entry point', components: ['sum', 'ZERO'] })
  expect(map.isError).toBe(false)
  expect(h.io.files.get(`${TASK_DIR}/system-map.md`)).toContain('graph TD; sum-->ZERO')

  const view = h.view()
  if (!view) throw new Error('no view')
  expect(view.counts).toMatchObject({ components: 2, findings: 1, open_questions: 1, sources: 1 })
  expect(view.question_lines).toEqual(['Q-001 Should ZERO change too?'])
  expect(view.map_lines).toContain('sum is the entry point')

  const answered = await h.tool('question', { action: 'resolve', id: 'Q-001', answer: 'No, only sum.' })
  expect(answered.isError).toBe(false)
  expect(h.view()?.counts.open_questions).toBe(0)
  expect(h.statuses.at(-1)).toBe('ewm TASK-001 · EXPLORE')

  const status = await h.tool('status')
  expect(status.text).toContain('TASK-001')
  expect(status.text).toContain('EXPLORE')
})

test('tool errors reach the model as error results with a way forward', async ($, on) => {
  const h = createHarness($, on)
  await h.start()

  const none = await h.tool('status')
  expect(none.isError).toBe(true)
  expect(none.text).toContain('ewm:')

  await h.ewm('new "Fix sum"')
  const early = await h.tool('advance', { to: 'IMPLEMENT', reason: 'skip ahead' })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('ewm:')
  expect(h.task().phase).toBe('INTAKE')

  const badInput = await h.tool('question', { action: 'add' })
  expect(badInput.isError).toBe(true)

  // A task that is not running offers no tools.
  await h.ewm('pause')
  expect((await h.tool('status')).isError).toBe(true)
})

test('the model cannot reach the gates: approval needs the person, and the plan hash is checked', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', { summary: 'v1', steps: [{ text: 'fix', files: ['src/a.ts'] }], risks: [], tests: [], alternatives: [] })

  const blocked = await h.tool('advance', { to: 'IMPLEMENT', reason: 'I approve my own plan' })
  expect(blocked.isError).toBe(true)
  expect(blocked.text).toContain('/ewm approve')

  // Forging the approval in task.json does not count: the ledger decides.
  const forged = h.task()
  forged.approvals.push({ gate: 'plan_approval', decision: 'approved', by: 'user', via: 'command', at: forged.created_at, plan_hash: forged.plan?.hash })
  h.io.files.set(`${TASK_DIR}/task.json`, JSON.stringify(forged, null, 2) + '\n')
  expect((await h.tool('advance', { to: 'IMPLEMENT', reason: 'forged' })).isError).toBe(true)

  // A real approval, then a changed plan: the model must ask again.
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')
  expect(h.ledger().tasks['TASK-001']?.approvals).toHaveLength(1)
  expect(ROOT).toBe('/repo')
})
