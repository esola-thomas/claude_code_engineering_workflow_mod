// policies.allowed_commands (issue #3): profile-listed command prefixes the guard lets through.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { allowedCommandWarnings, classifyBash, describeAllowedCommands, evaluateToolCall } from '../../src/policies.ts'
import { normalizeProfile, parseYamlSubset } from '../../src/profile.ts'
import { renderStatus } from '../../src/render.ts'
import { ACTIVE_PHASES } from '../../src/types.ts'
import type { Phase, Profile } from '../../src/types.ts'
import { deepFreeze, makeProfile, makeTask } from '../support/fixtures.ts'

type Lists = Partial<Profile['policies']['allowed_commands']>

function profileWith(lists: Lists, network: Profile['policies']['external_network'] = 'allow'): Profile {
  const base = makeProfile()
  return deepFreeze(
    makeProfile({
      policies: {
        ...base.policies,
        external_network: network,
        allowed_commands: { read_only: [], implement: [], validate: [], ...lists },
      },
    }),
  )
}

const GITHUB = profileWith({
  read_only: ['gh issue list', 'gh issue view', 'gh pr view', 'gh pr checks', 'gh run view', 'git fetch', 'gh api'],
  implement: ['git push', 'gh pr create'],
  validate: ['gh pr create'],
})
const NONE = deepFreeze(makeProfile({ policies: { ...makeProfile().policies, external_network: 'allow' } }))

function verdict(phase: Phase, command: string, profile: Profile = GITHUB, agentType: string | null = null, tool = 'Bash') {
  return evaluateToolCall({ phase, profile, root: '/repo', agentType }, { tool, input: { command } })
}

function allowed(phase: Phase, command: string, profile: Profile = GITHUB, agentType: string | null = null): boolean {
  return verdict(phase, command, profile, agentType).allow
}

const PRE_IMPLEMENT: Phase[] = ['INTAKE', 'EXPLORE', 'UNDERSTAND', 'PLAN']

describe('policies.allowed_commands: acceptance criteria of issue #3', () => {
  it('runs a listed read-only gh command with extra arguments in EXPLORE', () => {
    assert.equal(allowed('EXPLORE', 'gh issue list --repo owner/name --state open'), true)
  })

  it('still denies an unlisted gh subcommand in EXPLORE', () => {
    const result = verdict('EXPLORE', 'gh issue close 1')
    assert.equal(result.allow, false)
  })

  it('runs git push -u origin feat/x in IMPLEMENT and denies it in EXPLORE', () => {
    assert.equal(allowed('IMPLEMENT', 'git push -u origin feat/x'), true)
    const explore = verdict('EXPLORE', 'git push -u origin feat/x')
    assert.equal(explore.allow, false)
    assert.match(explore.allow ? '' : explore.reason, /allowed_commands\.implement, which does not cover EXPLORE/)
  })

  for (const command of [
    'git push --force',
    'git push -f',
    'git push -uf origin x',
    'git push --force-with-lease origin x',
    'git push --force-w origin x',
    'git push origin +main',
    'git push origin +HEAD:main',
    'git push --delete origin x',
    'git push -d origin x',
    'git push origin :x',
    'git push --mirror origin',
    'git push --prune origin',
    'git push --receive-pack=/tmp/evil origin',
    'git push --exec=/tmp/evil origin',
  ]) {
    it(`denies "${command}" in every active phase whatever the profile lists`, () => {
      const everywhere = profileWith({ read_only: ['git push'], implement: ['git push'], validate: ['git push'] })
      for (const phase of ACTIVE_PHASES) assert.equal(allowed(phase, command, everywhere), false, phase)
    })
  }

  it('leaves behavior unchanged when the profile has no allowed_commands entries', () => {
    for (const phase of PRE_IMPLEMENT) {
      assert.equal(allowed(phase, 'gh issue list', NONE), false)
      assert.equal(allowed(phase, 'git fetch', NONE), false)
    }
    for (const phase of ACTIVE_PHASES) assert.equal(allowed(phase, 'git push origin x', NONE), false)
    assert.equal(allowed('IMPLEMENT', 'gh issue list', NONE), true) // network under allow in IMPLEMENT, as before
  })

  it('leaves behavior unchanged for a profile snapshot saved before the key existed', () => {
    const { allowed_commands: _dropped, ...policies } = makeProfile().policies
    const legacy = deepFreeze({ ...makeProfile(), policies: { ...policies, external_network: 'allow' } }) as unknown as Profile
    assert.equal(allowed('EXPLORE', 'gh issue list', legacy), false)
    assert.equal(allowed('IMPLEMENT', 'git push origin x', legacy), false)
    assert.deepEqual(allowedCommandWarnings(legacy), [])
    assert.deepEqual(describeAllowedCommands(legacy), [])
  })
})

describe('policies.allowed_commands: phases and network', () => {
  it('read_only entries run in every active phase', () => {
    for (const phase of ACTIVE_PHASES) {
      assert.equal(allowed(phase, 'git fetch origin'), true, phase)
      assert.equal(allowed(phase, 'gh pr view 12 --json title'), true, phase)
    }
  })

  it('validate entries run only in VALIDATE (and implement entries only in IMPLEMENT)', () => {
    const validateOnly = profileWith({ validate: ['gh pr create'] })
    assert.equal(allowed('VALIDATE', 'gh pr create --fill', validateOnly), true)
    for (const phase of PRE_IMPLEMENT) assert.equal(allowed(phase, 'gh pr create --fill', validateOnly), false)
    const implementOnly = profileWith({ implement: ['git push'] })
    assert.equal(allowed('VALIDATE', 'git push origin x', implementOnly), false)
  })

  it('network entries do nothing under deny_by_default, and the denial says why', () => {
    const closed = profileWith({ read_only: ['gh issue list'], implement: ['git push'] }, 'deny_by_default')
    const read = verdict('EXPLORE', 'gh issue list', closed)
    assert.equal(read.allow, false)
    assert.match(read.allow ? '' : read.reason, /external_network is deny_by_default/)
    assert.equal(allowed('IMPLEMENT', 'git push origin x', closed), false)
  })

  it('a read_only entry never lifts the destructive rule', () => {
    const misplaced = profileWith({ read_only: ['git push'] })
    for (const phase of ACTIVE_PHASES) assert.equal(allowed(phase, 'git push origin x', misplaced), false, phase)
    const result = verdict('IMPLEMENT', 'git push origin x', misplaced)
    assert.match(result.allow ? '' : result.reason, /never allows a destructive command/)
  })

  it('a non-network entry applies under deny_by_default', () => {
    const local = profileWith({ read_only: ['npm run typecheck'] }, 'deny_by_default')
    assert.equal(allowed('EXPLORE', 'npm run typecheck', local), true)
    assert.equal(allowed('EXPLORE', 'npm run build', local), false)
  })

  it('also covers Monitor, but not Monitor with ws', () => {
    assert.equal(verdict('EXPLORE', 'gh run view 1', GITHUB, null, 'Monitor').allow, true)
    const ws = evaluateToolCall({ phase: 'EXPLORE', profile: GITHUB, root: '/repo', agentType: null }, { tool: 'Monitor', input: { command: 'gh run view 1', ws: 'wss://x' } })
    assert.equal(ws.allow, false)
  })

  it('does not change classifyBash', () => {
    assert.equal(classifyBash('gh issue list', GITHUB), 'network')
    assert.equal(classifyBash('git push origin x', GITHUB), 'destructive')
  })
})

describe('policies.allowed_commands: matching', () => {
  it('matches whole words from the start, not a raw string prefix', () => {
    assert.equal(allowed('EXPLORE', 'gh issue listing'), false)
    assert.equal(allowed('EXPLORE', 'gh issue'), false)
    assert.equal(allowed('EXPLORE', 'gh --repo x issue list'), false)
    assert.equal(allowed('EXPLORE', 'git -C /elsewhere fetch'), false)
    assert.equal(allowed('EXPLORE', '/usr/bin/gh issue list'), false)
    assert.equal(allowed('EXPLORE', 'GH issue list'), false)
  })

  it('accepts quoted arguments and a harmless stderr redirection', () => {
    assert.equal(allowed('EXPLORE', 'gh issue list --search "label:bug is:open"'), true)
    assert.equal(allowed('EXPLORE', 'gh issue list 2>&1'), true)
    assert.equal(allowed('EXPLORE', 'gh issue list 2>/dev/null'), true)
  })

  for (const command of [
    'gh issue list | sh',
    'gh issue list; rm -rf src',
    'gh issue list && git push --force',
    'gh issue list > out.txt',
    'gh issue list $(touch x)',
    'gh issue list `touch x`',
    'gh issue list $HOME',
    'gh issue list *',
    'gh issue list {a,b}',
    'GH_HOST=evil gh issue list',
    'env gh issue list',
    'timeout 5 gh issue list',
    'sh -c "gh issue list"',
    'xargs gh issue list',
    '(gh issue list)',
    'gh issue list <<EOF\nx\nEOF',
    'gh issue list --repo .ewm/x',
    'git fetch --upload-pack=/tmp/evil origin',
    'git fetch --upload-p=/tmp/evil origin',
    'gh api -X POST repos/o/r/issues',
    'gh api -XDELETE repos/o/r',
    'gh api --method=PATCH repos/o/r',
    'gh api repos/o/r/issues -f title=x',
    'gh api graphql -F query=mutation',
    'gh api repos/o/r --input body.json',
  ]) {
    it(`does not let "${command.replace(/\n/g, '\\n')}" through in EXPLORE`, () => {
      assert.equal(allowed('EXPLORE', command), false)
    })
  }

  it('lets gh api read requests through when listed', () => {
    assert.equal(allowed('EXPLORE', 'gh api repos/o/r/issues'), true)
    assert.equal(allowed('EXPLORE', 'gh api -X GET search/issues -f q=bug'), true)
    assert.equal(allowed('EXPLORE', 'gh api --method get repos/o/r'), true)
  })

  it('never gives the allowances to the read-only agents', () => {
    for (const agent of ['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer']) {
      assert.equal(allowed('EXPLORE', 'gh issue list', GITHUB, agent), false, agent)
      assert.equal(allowed('IMPLEMENT', 'git push origin x', GITHUB, agent), false, agent)
    }
  })

  it('applies to other subagents and the lead', () => {
    assert.equal(allowed('EXPLORE', 'gh issue list', GITHUB, 'general-purpose'), true)
  })
})

describe('policies.allowed_commands: profile loading, warnings and status', () => {
  it('parses from YAML with nested lists', () => {
    const yaml = [
      'policies:',
      '  external_network: allow',
      '  allowed_commands:',
      '    read_only:',
      '      - "gh issue list"',
      '      - git fetch',
      '    implement: ["git push"]',
    ].join('\n')
    const { profile, warnings } = normalizeProfile(parseYamlSubset(yaml))
    assert.deepEqual(warnings, [])
    assert.deepEqual(profile.policies.allowed_commands, { read_only: ['gh issue list', 'git fetch'], implement: ['git push'], validate: [] })
  })

  it('warns about unknown lists and wrong types like other profile keys', () => {
    const { profile, warnings } = normalizeProfile({ policies: { allowed_commands: { readonly: ['gh issue list'], implement: 'git push' } } })
    assert.deepEqual(profile.policies.allowed_commands, { read_only: [], implement: [], validate: [] })
    assert.ok(warnings.some((warning) => warning.startsWith('policies.allowed_commands.implement: expected a list')))
    assert.ok(warnings.includes('policies.allowed_commands.readonly: unknown field, ignored'))
  })

  it('warns about entries that can never match', () => {
    const profile = profileWith({
      read_only: ['gh', 'sh -c', 'env gh', 'sudo apt', './gh issue', 'gh "issue"', 'gh --repo', 'gh issue list', 'git push'],
      implement: ['git push --force', 'gh api -X POST'],
    })
    const warnings = allowedCommandWarnings(profile)
    const ignored = (entry: string) => warnings.some((warning) => warning.includes(`entry "${entry}" is ignored`))
    for (const entry of ['gh', 'sh -c', 'env gh', 'sudo apt', './gh issue', 'gh "issue"', 'gh --repo', 'git push', 'git push --force', 'gh api -X POST']) {
      assert.ok(ignored(entry), entry)
    }
    assert.equal(ignored('gh issue list'), false)
  })

  it('warns about network entries under deny_by_default', () => {
    const warnings = allowedCommandWarnings(profileWith({ read_only: ['gh issue list', 'npm run lint'], implement: ['git push'] }, 'deny_by_default'))
    assert.deepEqual(warnings, [
      'policies.allowed_commands.read_only entry "gh issue list" uses the network and applies only with policies.external_network: allow.',
      'policies.allowed_commands.implement entry "git push" uses the network and applies only with policies.external_network: allow.',
    ])
  })

  it('/ewm status shows the active allowances, and nothing when there are none', () => {
    const task = makeTask({ phase: 'EXPLORE' })
    const gate = { pending: null, planApproved: false, models: [] }
    const status = renderStatus(task, profileWith({ read_only: ['gh issue list', 'git fetch'], implement: ['git push'] }), gate)
    assert.match(status, /^Allowed commands: read_only: gh issue list, git fetch; implement: git push$/m)
    assert.doesNotMatch(renderStatus(task, NONE, gate), /Allowed commands/)
  })
})
