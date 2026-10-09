import { expect, test } from 'claude-code/testing'

import { createHarness } from './harness.ts'

const SCOUT = { subagentType: 'ewm:repo-scout', prompt: 'find sum', description: 'locate sum' } as const

test('AC4: a scout is routed to the profile search model and the spawn is recorded', async ($, on) => {
  const h = createHarness($, on)
  const seen: { model: string | undefined; subagentType: string }[] = []
  on('agent.spawn', (_$, e) => {
    seen.push({ model: e.model, subagentType: e.subagentType })
    return { model: 'claude-haiku-4-5-20251001', agentId: 'a1' }
  })
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')

  const spawned = await h.spawn(SCOUT)
  expect(spawned).toEqual({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' })
  // The bottom (the engine) saw the profile's search model, whatever the caller asked for.
  expect(seen).toEqual([{ model: 'haiku', subagentType: 'ewm:repo-scout' }])

  expect(h.task().agent_usage).toHaveLength(1)
  expect(h.task().agent_usage[0]).toMatchObject({
    agent_type: 'ewm:repo-scout',
    model: 'claude-haiku-4-5-20251001',
    routed_model: 'haiku',
    agent_id: 'a1',
    description: 'locate sum',
    phase: 'EXPLORE',
    rule: 'profile.models.search',
  })
  const status = await h.ewm('status')
  expect(status.text).toContain('haiku (ewm:repo-scout x1)')

  // An explicit request for a stronger model does not override the profile (cost discipline).
  await h.spawn({ ...SCOUT, model: 'opus' })
  expect(seen.at(-1)?.model).toBe('haiku')
})

test('agents that are not ewm scouts are left alone', async ($, on) => {
  const h = createHarness($, on)
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => {
    seen.push(e.model)
    return { model: 'claude-opus-4', agentId: 'g1' }
  })
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'd', model: 'opus' })
  expect(seen).toEqual(['opus'])
  expect(h.task().agent_usage).toEqual([])
})

test('the (N+1)th concurrent scout is refused; finished scouts do not count', async ($, on) => {
  const h = createHarness($, on)
  let started = 0
  on('agent.spawn', () => {
    started += 1
    return { model: 'claude-haiku-4-5-20251001', agentId: `a${started}` }
  })
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')

  for (const id of ['s1', 's2']) h.agents.push({ id, type: 'ewm:repo-scout', description: 'd', status: 'running' })
  h.agents.push({ id: 's3', type: 'ewm:docs-scout', description: 'd', status: 'completed' })
  expect((await h.spawn(SCOUT)).deny).toBeUndefined()

  h.agents.push({ id: 's4', type: 'ewm:docs-scout', description: 'd', status: 'running' })
  const refused = await h.spawn(SCOUT)
  expect(refused.deny).toContain('max_parallel_researchers')
  expect(started).toBe(1)
  expect(h.task().agent_usage).toHaveLength(1)

  // The reviewer is not a scout and is not limited.
  expect((await h.spawn({ subagentType: 'ewm:reviewer', prompt: 'x', description: 'r' })).deny).toBeUndefined()
})

test('turn.complete usage is added to the phase of the active task', async ($, on) => {
  const h = createHarness($, on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await h.start()
  await h.ewm('new "Fix sum"')
  await h.advanceTo('EXPLORE')

  const usage = { model: 'claude-opus-4', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer', usage, agentId: 'a1' })
  expect(h.task().usage_by_phase.EXPLORE).toEqual({
    turns: 1,
    input_tokens: 200,
    output_tokens: 40,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 2,
  })
})
