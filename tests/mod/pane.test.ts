import { expect, test } from 'claude-code/testing'

import { createHarness } from './harness.ts'

const PANE = {
  plugin: 'ewm',
  component: 'Pane',
  requestId: 'ewm',
  props: { title: 'Engineering Workflow', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  viewport: { columns: 100, rows: 30, isFullscreen: true },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane on ${surface}: shows the task and approves a pending plan gate`, async ($, on) => {
    const h = createHarness($, on)
    await h.start()
    const pane = await $.ui.mount({ ...PANE, surface })

    expect((await pane.find({ type: 'Text', text: /No active task/ }))?.text).toContain('/ewm new')

    await h.ewm('new "Fix sum" --goal "sum subtracts"')
    expect(await pane.find({ type: 'Text', text: /TASK-001 · INTAKE · Fix sum/ })).toBeDefined()
    expect(await pane.find({ key: 'approve' })).toBeUndefined()

    await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
    await h.tool('set_plan', { summary: 'Fix the operator', steps: [{ text: 'Use + in sum', files: ['src/a.ts'] }], risks: ['none'], tests: [], alternatives: [] })
    expect(await pane.find({ type: 'Text', text: /TASK-001 · PLAN/ })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /Explore > Understand > \[Plan\]/ }))?.text).toContain('[Plan]')
    expect(await pane.find({ type: 'Text', text: /plan approval/ })).toBeDefined()
    expect(await pane.find({ key: 'approve' })).toBeDefined()

    // The other sections.
    await h.tool('question', { action: 'add', text: 'Should ZERO change too?' })
    await pane.press({ key: 'questions' })
    expect(await pane.find({ type: 'Text', text: 'Q-001 Should ZERO change too?' })).toBeDefined()
    await h.tool('write_map', { mermaid: 'graph TD; A-->B', text_map: 'sum is the entry point', components: ['sum'] })
    await pane.press({ key: 'map' })
    expect(await pane.find({ type: 'Text', text: 'sum is the entry point' })).toBeDefined()
    await pane.press({ key: 'overview' })
    expect(await pane.find({ type: 'Text', text: /1 components/ })).toBeDefined()

    // Approve is a human press: it moves the task to IMPLEMENT and starts the build skill.
    await pane.press({ key: 'approve' })
    expect(h.task().phase).toBe('IMPLEMENT')
    expect(h.task().approvals.at(-1)).toMatchObject({ gate: 'plan_approval', decision: 'approved', via: 'pane' })
    expect(await pane.find({ type: 'Text', text: /TASK-001 · IMPLEMENT/ })).toBeDefined()
    expect(await pane.find({ key: 'approve' })).toBeUndefined()
    await h.clock.advance(1)
    expect(h.submitted.at(-1)).toContain('ewm:implement')

    await pane.unmount()
  })
}

test('/ewm status opens the pane, and an unplaced pane is fine: the text is the fallback', async ($, on) => {
  const h = createHarness($, on, { isPaneUnplaced: true })
  await h.start()
  const out = await h.ewm('status')
  expect(out.text).toContain('No active task')
  expect(h.opened).toEqual(['ewm'])
})
