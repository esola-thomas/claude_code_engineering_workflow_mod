import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AGENT_ROLES, modelFamily, routeModel, summarizeModels } from '../../src/router.ts'
import type { AgentUse } from '../../src/types.ts'
import { AT, deepFreeze, makeProfile } from '../support/fixtures.ts'

const profile = deepFreeze(makeProfile())
const customProfile = deepFreeze(makeProfile({ models: { lead: 'opus', search: 'sonnet', reviewer: 'haiku' } }))

function use(agent_type: string, model: string, extra: Partial<AgentUse> = {}): AgentUse {
  return { agent_type, model, phase: 'EXPLORE', rule: 'profile.models.search', at: AT, ...extra }
}

describe('AGENT_ROLES', () => {
  it('maps the three ewm agent types to their role', () => {
    assert.deepEqual(
      { ...AGENT_ROLES },
      { 'ewm:repo-scout': 'search', 'ewm:docs-scout': 'search', 'ewm:reviewer': 'reviewer' },
    )
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(AGENT_ROLES))
  })
})

describe('routeModel: ewm agent types', () => {
  it('uses the profile model for the role of each ewm type', () => {
    assert.deepEqual(routeModel('ewm:repo-scout', undefined, profile), { model: 'haiku', rule: 'profile.models.search' })
    assert.deepEqual(routeModel('ewm:docs-scout', undefined, profile), { model: 'haiku', rule: 'profile.models.search' })
    assert.deepEqual(routeModel('ewm:reviewer', undefined, profile), { model: 'sonnet', rule: 'profile.models.reviewer' })
  })

  it('follows the profile, not a hard-coded table', () => {
    assert.equal(routeModel('ewm:repo-scout', undefined, customProfile).model, 'sonnet')
    assert.equal(routeModel('ewm:reviewer', undefined, customProfile).model, 'haiku')
  })

  it('overrides whatever model was requested (cost discipline)', () => {
    assert.deepEqual(routeModel('ewm:repo-scout', 'opus', profile), { model: 'haiku', rule: 'profile.models.search' })
    assert.deepEqual(routeModel('ewm:docs-scout', 'claude-opus-4-1', profile), { model: 'haiku', rule: 'profile.models.search' })
    assert.deepEqual(routeModel('ewm:reviewer', 'opus', profile), { model: 'sonnet', rule: 'profile.models.reviewer' })
    assert.deepEqual(routeModel('ewm:reviewer', 'haiku', profile), { model: 'sonnet', rule: 'profile.models.reviewer' })
  })

  it('routes to the same model when the request already matches', () => {
    assert.deepEqual(routeModel('ewm:repo-scout', 'haiku', profile), { model: 'haiku', rule: 'profile.models.search' })
  })
})

describe('routeModel: other agent types', () => {
  it('leaves a requested model untouched', () => {
    assert.deepEqual(routeModel('general-purpose', 'opus', profile), { model: 'opus', rule: 'requested' })
    assert.deepEqual(routeModel('Explore', 'claude-haiku-4-5-20251001', profile), {
      model: 'claude-haiku-4-5-20251001',
      rule: 'requested',
    })
  })

  it("reports 'unrouted' when nothing was requested", () => {
    assert.deepEqual(routeModel('general-purpose', undefined, profile), { model: undefined, rule: 'unrouted' })
    assert.deepEqual(routeModel('general-purpose', '', profile), { model: '', rule: 'unrouted' })
  })

  it('does not treat near-miss names as ewm types', () => {
    for (const type of ['ewm:other', 'ewm:repo-scout2', 'EWM:repo-scout', 'repo-scout', 'ewm', '']) {
      assert.deepEqual(routeModel(type, 'opus', profile), { model: 'opus', rule: 'requested' }, type)
    }
  })

  it('does not mistake Object.prototype members for roles', () => {
    for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      assert.deepEqual(routeModel(type, 'opus', profile), { model: 'opus', rule: 'requested' }, type)
      assert.deepEqual(routeModel(type, undefined, profile), { model: undefined, rule: 'unrouted' }, type)
    }
  })
})

describe('modelFamily', () => {
  it('recognizes the aliases', () => {
    assert.equal(modelFamily('haiku'), 'haiku')
    assert.equal(modelFamily('sonnet'), 'sonnet')
    assert.equal(modelFamily('opus'), 'opus')
    assert.equal(modelFamily('fable'), 'fable')
  })

  it('recognizes full model ids', () => {
    assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku')
    assert.equal(modelFamily('claude-sonnet-4-5'), 'sonnet')
    assert.equal(modelFamily('claude-opus-4-1-20250805'), 'opus')
    assert.equal(modelFamily('claude-3-5-haiku-latest'), 'haiku')
    assert.equal(modelFamily('us.anthropic.claude-sonnet-4-5-v1:0'), 'sonnet')
    assert.equal(modelFamily('opus[1m]'), 'opus')
  })

  it('is case-insensitive', () => {
    assert.equal(modelFamily('Claude-HAIKU-4'), 'haiku')
    assert.equal(modelFamily('SONNET'), 'sonnet')
  })

  it('returns anything else unchanged', () => {
    assert.equal(modelFamily('gpt-4o'), 'gpt-4o')
    assert.equal(modelFamily('inherit'), 'inherit')
    assert.equal(modelFamily(''), '')
    assert.equal(modelFamily('Custom-Model'), 'Custom-Model')
  })
})

describe('summarizeModels', () => {
  it('returns no lines without uses', () => {
    assert.deepEqual(summarizeModels([]), [])
  })

  it('formats one family with one agent type', () => {
    assert.deepEqual(summarizeModels([use('ewm:repo-scout', 'haiku')]), ['haiku (ewm:repo-scout x1)'])
  })

  it('counts repeated uses of the same agent type', () => {
    const uses = [use('ewm:repo-scout', 'haiku'), use('ewm:repo-scout', 'haiku'), use('ewm:repo-scout', 'haiku')]
    assert.deepEqual(summarizeModels(uses), ['haiku (ewm:repo-scout x3)'])
  })

  it('groups by family, one line per family, in first-seen order', () => {
    const uses = [
      use('ewm:reviewer', 'sonnet'),
      use('ewm:repo-scout', 'haiku'),
      use('ewm:reviewer', 'sonnet'),
      use('ewm:repo-scout', 'haiku'),
    ]
    assert.deepEqual(summarizeModels(uses), ['sonnet (ewm:reviewer x2)', 'haiku (ewm:repo-scout x2)'])
  })

  it('groups agent types within a family, in first-seen order', () => {
    const uses = [
      use('ewm:docs-scout', 'haiku'),
      use('ewm:repo-scout', 'haiku'),
      use('ewm:docs-scout', 'haiku'),
      use('ewm:repo-scout', 'haiku'),
      use('ewm:repo-scout', 'haiku'),
    ]
    assert.deepEqual(summarizeModels(uses), ['haiku (ewm:docs-scout x2, ewm:repo-scout x3)'])
  })

  it('merges full ids and aliases of the same family', () => {
    const uses = [use('ewm:repo-scout', 'claude-haiku-4-5-20251001'), use('ewm:repo-scout', 'haiku')]
    assert.deepEqual(summarizeModels(uses), ['haiku (ewm:repo-scout x2)'])
  })

  it('prefers routed_model over the resolved model', () => {
    const uses = [
      use('ewm:repo-scout', 'claude-opus-4-1', { routed_model: 'haiku' }),
      use('ewm:repo-scout', 'claude-haiku-4-5-20251001', { routed_model: 'haiku' }),
    ]
    assert.deepEqual(summarizeModels(uses), ['haiku (ewm:repo-scout x2)'])
  })

  it('falls back to the resolved model when routed_model is absent or empty', () => {
    const uses = [use('general-purpose', 'opus'), use('general-purpose', 'opus', { routed_model: '' })]
    assert.deepEqual(summarizeModels(uses), ['opus (general-purpose x2)'])
  })

  it('keeps an unknown model as its own group', () => {
    const uses = [use('general-purpose', 'gpt-4o'), use('ewm:repo-scout', 'haiku'), use('general-purpose', 'gpt-4o')]
    assert.deepEqual(summarizeModels(uses), ['gpt-4o (general-purpose x2)', 'haiku (ewm:repo-scout x1)'])
  })

  it('does not mutate its input', () => {
    const uses = deepFreeze([use('ewm:repo-scout', 'haiku'), use('ewm:reviewer', 'sonnet')])
    assert.deepEqual(summarizeModels(uses), ['haiku (ewm:repo-scout x1)', 'sonnet (ewm:reviewer x1)'])
  })
})
