import { expect, test } from 'claude-code/testing'

import { createHarness, ROOT, SOURCE_FILE, TASK_DIR } from './harness.ts'

const EDIT = { tool: 'Edit', file_path: SOURCE_FILE, old_string: 'a - b', new_string: 'a + b' } as const

test('AC6: in EXPLORE the guard blocks writes and unknown tools before the engine runs them', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')
  expect(h.task().phase).toBe('EXPLORE')
  h.reached.length = 0

  const edit = await $.tool.call(EDIT)
  expect(edit.deny).toContain('EXPLORE')
  expect(edit.deny).toContain('Edit')
  expect(h.reached).not.toContain('Edit')

  // Monitor runs shell commands and websockets: classified like Bash, so only read-only commands pass.
  const monitor = await $.tool.call({ tool: 'Monitor', command: 'npm run watch', description: 'watch', timeout_ms: 1000 })
  expect(monitor.deny).toContain('Monitor')
  const socket = await $.tool.call({ tool: 'Monitor', ws: { url: 'wss://example.com/feed' }, description: 'feed', timeout_ms: 1000 })
  expect(socket.deny).toContain('Monitor')

  const fetch = await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x' })
  expect(fetch.deny).toContain('WebFetch')

  const rm = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(rm.deny).toContain('ewm:')
  expect(h.reached).toEqual([])

  // Read-only work still flows to the engine.
  const log = await $.tool.call({ tool: 'Bash', command: 'git log -1' })
  expect(log.deny).toBeUndefined()
  const read = await $.tool.call({ tool: 'Read', file_path: SOURCE_FILE })
  expect(read.deny).toBeUndefined()
  expect(h.reached).toEqual(['Bash', 'Read'])

  // The denials are in the audit log of the task.
  const audit = h.io.files.get(`${TASK_DIR}/audit.jsonl`) ?? ''
  const denied = audit
    .split('\n')
    .filter(line => line.includes('tool_denied'))
    .map(line => JSON.parse(line) as { tool: string; phase: string; detail: string })
  expect(denied.map(entry => entry.tool)).toEqual(['Edit', 'Monitor', 'Monitor', 'WebFetch', 'Bash'])
  expect(denied[0]?.phase).toBe('EXPLORE')
  expect(denied[0]?.detail).toContain('EXPLORE')
})

test('M14: in IMPLEMENT the model cannot write the workflow state, but can edit the repository', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', { summary: 's', steps: [{ text: 'fix', files: ['src/a.ts'] }], risks: [], tests: [], alternatives: [] })
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')
  h.reached.length = 0

  const forged = await $.tool.call({ tool: 'Edit', file_path: `${TASK_DIR}/task.json`, old_string: '"approvals"', new_string: '"x"' })
  expect(forged.deny).toContain('.ewm')
  const profile = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.ewm/project.yaml`, content: 'policies: {}' })
  expect(profile.deny).toContain('.ewm')
  expect(h.reached).toEqual([])

  const edit = await $.tool.call(EDIT)
  expect(edit.deny).toBeUndefined()
  const created = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'export {}\n' })
  expect(created.deny).toBeUndefined()
  expect(h.reached).toEqual(['Edit', 'Write'])
})

test('D14: in IMPLEMENT a shell command cannot build the name .ewm from a glob, a variable or a quote split', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', { summary: 's', steps: [{ text: 'fix', files: ['src/a.ts'] }], risks: [], tests: [], alternatives: [] })
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')
  h.reached.length = 0

  for (const command of [
    "sed -i 's/IMPLEMENT/PAUSED/' .e*m/tasks/TASK-001/task.json",
    "d=.e; echo '{}' > ${d}wm/tasks/TASK-001/task.json",
    "python3 -c \"open('.e'+'wm/tasks/TASK-001/task.json','w')\"",
    'ln -s .e?m link',
  ]) {
    const verdict = await $.tool.call({ tool: 'Bash', command })
    expect(verdict.deny, command).toContain('.ewm')
  }
  expect(h.reached).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'git add *' })).deny).toBeUndefined()
  expect(h.reached).toEqual(['Bash'])
})

test('CR12: before IMPLEMENT a third-party MCP tool needs allowed_mcp_tools', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')
  h.reached.length = 0
  expect((await $.tool.call({ tool: 'mcp__other__lookup' })).deny).toContain('allowed_mcp_tools')
})

test('M10: without an active task the mod is inert and its tools stay deferred', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  expect([...h.tools.values()].every(isDeferred => isDeferred === true)).toBe(true)
  expect(h.tools.size).toBeGreaterThanOrEqual(10)
  expect(h.statuses.at(-1)).toBeUndefined()
  h.fsTouched.length = 0

  for (const call of [EDIT, { tool: 'Bash', command: 'rm -rf x' }, { tool: 'WebFetch', url: 'https://example.com', prompt: 'x' }] as const) {
    expect((await $.tool.call(call)).deny).toBeUndefined()
  }
  expect(h.reached).toEqual(['Edit', 'Bash', 'WebFetch'])
  // Inert means no file access beyond the ledger in $.store.
  expect(h.fsTouched).toEqual([])

  // A task makes the tools first-class and the guard live.
  await h.ewm('new "Fix sum"')
  expect([...h.tools.values()].every(isDeferred => isDeferred === false)).toBe(true)
  await h.advanceTo('EXPLORE')
  expect((await $.tool.call(EDIT)).deny).toContain('EXPLORE')

  // Pausing hands the session back.
  await h.ewm('pause')
  expect(h.task().phase).toBe('PAUSED')
  expect([...h.tools.values()].every(isDeferred => isDeferred === true)).toBe(true)
  expect(h.statuses.at(-1)).toBeUndefined()
  h.reached.length = 0
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })).deny).toBeUndefined()
  expect(h.reached).toEqual(['Edit', 'Bash'])

  // Resuming turns the guard back on.
  await h.ewm('resume')
  expect(h.task().phase).toBe('EXPLORE')
  expect((await $.tool.call(EDIT)).deny).toContain('EXPLORE')
})

test('the guard fails closed when the ledger is unreadable', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  h.io.kv.set(`ledger:${ROOT}`, { version: 'broken' })
  h.reached.length = 0
  const out = await $.tool.call({ tool: 'Read', file_path: SOURCE_FILE })
  expect(out.deny).toContain('ewm:')
  expect(h.reached).toEqual([])
})

test('D7: read-only subagents cannot write or record, even in IMPLEMENT', async ($, on) => {
  const h = createHarness($, on)
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE', 'UNDERSTAND', 'PLAN')
  await h.tool('set_plan', { summary: 's', steps: [{ text: 'fix', files: ['src/a.ts'] }], risks: [], tests: [], alternatives: [] })
  await h.ewm('approve')
  expect(h.task().phase).toBe('IMPLEMENT')
  h.agents.push(
    { id: 'rev-1', type: 'ewm:reviewer', description: 'review', status: 'running' },
    { id: 'gen-1', type: 'general-purpose', description: 'other work', status: 'running' },
  )
  h.reached.length = 0

  const write = await h.callAs('rev-1', { tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'x' })
  expect(write.deny).toContain('ewm:reviewer')
  const record = await h.callAs('rev-1', { tool: 'mcp__ewm__record_finding', claim: 'c', evidence: [], confidence: 'high' })
  expect(record.deny).toContain('ewm:reviewer')
  const rm = await h.callAs('rev-1', { tool: 'Bash', command: 'touch x' })
  expect(rm.deny).toContain('read-only')
  expect(h.reached).toEqual([])

  // What a reviewer may do still works.
  expect((await h.callAs('rev-1', { tool: 'Read', file_path: SOURCE_FILE })).deny).toBeUndefined()
  expect((await h.callAs('rev-1', { tool: 'Bash', command: 'git diff' })).deny).toBeUndefined()
  expect((await h.callAs('rev-1', { tool: 'mcp__ewm__status' })).deny).toBeUndefined()

  // Other agents and the lead keep the IMPLEMENT rules.
  expect((await h.callAs('gen-1', EDIT)).deny).toBeUndefined()
  expect((await h.callAs('unknown', EDIT)).deny).toBeUndefined()
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
})
