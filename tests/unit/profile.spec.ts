import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROFILE, loadProfile, normalizeProfile, parseYamlSubset } from '../../src/profile.ts'
import { EwmError } from '../../src/types.ts'
import { createMemoryIo } from '../support/memory-io.ts'
import { deepFreeze, makeProfile } from '../support/fixtures.ts'

const ROOT = '/repo'

/** The profile example of docs/SPEC.md section 5, verbatim. */
const SPEC_EXAMPLE = `# .ewm/project.yaml  (esquema propuesto, no API oficial)
profile_id: silicon-dv
name: Silicon Design Verification
repositories: ["."]
domains: [systemverilog, uvm, axi, apb]
entrypoints: ["README.md", "docs/"]
policies:
  external_network: deny_by_default
  require_plan_approval: true
  allow_write_in_explore: false
models:
  lead: opus
  search: haiku
  reviewer: sonnet
budgets:
  max_parallel_researchers: 3
  max_research_rounds_without_user_update: 2
`

/** Parses text that must be rejected, and returns the error. */
function parseFailure(text: string): EwmError {
  try {
    parseYamlSubset(text)
  } catch (error) {
    assert.ok(error instanceof EwmError, 'expected an EwmError')
    return error
  }
  return assert.fail(`expected a parse error for ${JSON.stringify(text)}`)
}

/** Asserts the contract's error shape: code parse_error, message "ewm: project.yaml line N: ...". */
function assertParseError(text: string, line: number, fragment: RegExp): void {
  const error = parseFailure(text)
  assert.equal(error.code, 'parse_error')
  assert.ok(error.message.startsWith(`ewm: project.yaml line ${line}: `), `message was: ${error.message}`)
  assert.match(error.message, fragment)
}

describe('parseYamlSubset: the SPEC example', () => {
  it('parses every field with the right types', () => {
    assert.deepEqual(parseYamlSubset(SPEC_EXAMPLE), {
      profile_id: 'silicon-dv',
      name: 'Silicon Design Verification',
      repositories: ['.'],
      domains: ['systemverilog', 'uvm', 'axi', 'apb'],
      entrypoints: ['README.md', 'docs/'],
      policies: { external_network: 'deny_by_default', require_plan_approval: true, allow_write_in_explore: false },
      models: { lead: 'opus', search: 'haiku', reviewer: 'sonnet' },
      budgets: { max_parallel_researchers: 3, max_research_rounds_without_user_update: 2 },
    })
  })

  it('normalizes with zero warnings', () => {
    const { profile, warnings } = normalizeProfile(parseYamlSubset(SPEC_EXAMPLE))
    assert.deepEqual(warnings, [])
    assert.equal(profile.profile_id, 'silicon-dv')
    assert.equal(profile.models.lead, 'opus')
    assert.equal(profile.domains.length, 4)
    assert.deepEqual(profile.domains, ['systemverilog', 'uvm', 'axi', 'apb'])
    assert.deepEqual(profile.entrypoints, ['README.md', 'docs/'])
    assert.deepEqual(profile.repositories, ['.'])
    // Fields the example omits come from the defaults.
    assert.equal(profile.budgets.max_findings_per_scout, 8)
    assert.deepEqual(profile.policies.allowed_mcp_tools, [])
    assert.deepEqual(profile.validation, { commands: [], timeout_ms: 300000 })
  })
})

describe('parseYamlSubset: scalars', () => {
  it('reads strings: bare, single-quoted, double-quoted and their escapes', () => {
    const value = parseYamlSubset(
      [
        'bare: hello world',
        `single: 'it''s fine'`,
        'double: "tab\\there \\"quoted\\" \\\\ \\u0041 \\x42"',
        'url: http://example.com:8080/a#b',
        `empty_single: ''`,
        'empty_double: ""',
        'spaced: "  keep  "',
      ].join('\n'),
    )
    assert.deepEqual(value, {
      bare: 'hello world',
      single: "it's fine",
      double: 'tab\there "quoted" \\ A B',
      url: 'http://example.com:8080/a#b',
      empty_single: '',
      empty_double: '',
      spaced: '  keep  ',
    })
  })

  it('reads booleans, null, ~, integers and floats', () => {
    const value = parseYamlSubset(
      ['t: true', 'f: false', 'T: True', 'F: FALSE', 'n: null', 'tilde: ~', 'N: Null', 'i: 42', 'neg: -7', 'plus: +3', 'fl: 1.5', 'dot: .5', 'exp: 1e3', 'trail: 2.'].join('\n'),
    )
    assert.deepEqual(value, { t: true, f: false, T: true, F: false, n: null, tilde: null, N: null, i: 42, neg: -7, plus: 3, fl: 1.5, dot: 0.5, exp: 1000, trail: 2 })
  })

  it('keeps look-alikes as strings', () => {
    const value = parseYamlSubset(['version: 1.2.3', 'word: truthy', 'dash: -x', 'big: 123456789012345678901234567890', 'quoted_true: "true"', 'quoted_num: "42"'].join('\n'))
    assert.deepEqual(value, { version: '1.2.3', word: 'truthy', dash: '-x', big: '123456789012345678901234567890', quoted_true: 'true', quoted_num: '42' })
  })

  it('treats a key with no value as null', () => {
    assert.deepEqual(parseYamlSubset('a:\nb: 1'), { a: null, b: 1 })
    assert.deepEqual(parseYamlSubset('a: # nothing here\nb: 1'), { a: null, b: 1 })
  })

  it('splits a key at the first colon followed by a space', () => {
    assert.deepEqual(parseYamlSubset('a:b: c: d'), { 'a:b': 'c: d' })
  })

  it('reads quoted keys', () => {
    assert.deepEqual(parseYamlSubset(`"a: b": 1\n'c d': 2`), { 'a: b': 1, 'c d': 2 })
  })
})

describe('parseYamlSubset: flow lists', () => {
  it('reads empty and simple lists with mixed scalar types', () => {
    assert.deepEqual(parseYamlSubset('a: []\nb: [x, 2, true, null, 1.5]\nc: [ spaced ,  out ]'), {
      a: [],
      b: ['x', 2, true, null, 1.5],
      c: ['spaced', 'out'],
    })
  })

  it('keeps commas, brackets and hashes inside quoted items', () => {
    const value = parseYamlSubset(`cmds: ["npm test, then lint", 'a, b', "x]y", "# not a comment", plain]`)
    assert.deepEqual(value, { cmds: ['npm test, then lint', 'a, b', 'x]y', '# not a comment', 'plain'] })
  })

  it('accepts a trailing comma and a trailing comment', () => {
    assert.deepEqual(parseYamlSubset('a: [x, y,] # note\nb: 1'), { a: ['x', 'y'], b: 1 })
  })

  it('keeps an apostrophe inside a bare item', () => {
    assert.deepEqual(parseYamlSubset(`a: [it's, ok]`), { a: ["it's", 'ok'] })
  })

  it('rejects unterminated, nested, empty-item and trailing-garbage lists', () => {
    assertParseError('a: 1\nb: [x, y', 2, /unterminated flow list/)
    assertParseError('b: [x, "y]', 1, /unterminated double-quoted/)
    assertParseError('b: [x, [y]]', 1, /nested flow lists/)
    assertParseError('b: [x, , y]', 1, /empty item/)
    assertParseError('b: [x] y', 1, /unexpected text/)
    assertParseError('b: ["x" y]', 1, /expected "," or "\]"/)
  })
})

describe('parseYamlSubset: block lists', () => {
  it('reads an indented list', () => {
    assert.deepEqual(parseYamlSubset('commands:\n  - npm test\n  - "npm run lint"\n  - 3\nnext: 1'), {
      commands: ['npm test', 'npm run lint', 3],
      next: 1,
    })
  })

  it('reads a list written at the same indent as its key', () => {
    assert.deepEqual(parseYamlSubset('commands:\n- a\n- b\nnext: 1'), { commands: ['a', 'b'], next: 1 })
    assert.deepEqual(parseYamlSubset('outer:\n  inner:\n  - a\n  - b\n  other: 2'), { outer: { inner: ['a', 'b'], other: 2 } })
  })

  it('reads a top-level list, an empty item as null, and comments after items', () => {
    assert.deepEqual(parseYamlSubset('- a # first\n-\n- "b # kept"'), ['a', null, 'b # kept'])
  })

  it('ends a list at a dedent back to a sibling key', () => {
    assert.deepEqual(parseYamlSubset('a:\n  b:\n    - 1\n    - 2\n  c: 3\nd: 4'), { a: { b: [1, 2], c: 3 }, d: 4 })
  })
})

describe('parseYamlSubset: comments', () => {
  it('ignores full-line and trailing comments', () => {
    const text = ['# header', 'a: 1 # trailing', '  # indented comment', 'b: two words # more', '', 'c: [x, y] # list comment'].join('\n')
    assert.deepEqual(parseYamlSubset(text), { a: 1, b: 'two words', c: ['x', 'y'] })
  })

  it("keeps '#' inside quotes and inside words", () => {
    const text = [`a: "x # y" # real comment`, `b: 'p # q'`, 'c: a#b', 'd: "end#"'].join('\n')
    assert.deepEqual(parseYamlSubset(text), { a: 'x # y', b: 'p # q', c: 'a#b', d: 'end#' })
  })

  it('returns null for an empty document or comments only', () => {
    assert.equal(parseYamlSubset(''), null)
    assert.equal(parseYamlSubset('\n  \n# only a comment\n'), null)
  })
})

describe('parseYamlSubset: structure', () => {
  it('reads maps nested three levels deep and returns to outer levels', () => {
    const text = ['a:', '  b:', '    c:', '      d: 1', '      e: [x]', '    f: 2', '  g: 3', 'h: 4'].join('\n')
    assert.deepEqual(parseYamlSubset(text), { a: { b: { c: { d: 1, e: ['x'] }, f: 2 }, g: 3 }, h: 4 })
  })

  it('accepts a different indent width per block', () => {
    assert.deepEqual(parseYamlSubset('a:\n    b: 1\nc:\n  d: 2'), { a: { b: 1 }, c: { d: 2 } })
  })

  it('handles CRLF line endings, a BOM and a leading document marker', () => {
    assert.deepEqual(parseYamlSubset('\uFEFF---\r\na: 1\r\nb:\r\n  c: [x, y]\r\n'), { a: 1, b: { c: ['x', 'y'] } })
  })

  it('keeps a __proto__ key as plain data', () => {
    const value = parseYamlSubset('__proto__:\n  polluted: true') as Record<string, unknown>
    assert.deepEqual(Object.keys(value), ['__proto__'])
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
  })
})

describe('parseYamlSubset: errors carry the line number', () => {
  it('rejects tab indentation', () => {
    assertParseError('a:\n  b: 1\n\tc: 2', 3, /tab characters are not allowed/)
    assertParseError('a:\n \tb: 1', 2, /tab characters are not allowed/)
  })

  it('rejects inconsistent indentation', () => {
    assertParseError('a: 1\n  b: 2', 2, /inconsistent indentation/)
    assertParseError('a:\n    b: 1\n  c: 2', 3, /inconsistent indentation/)
    assertParseError('a:\n  b: 1\n   c: 2', 3, /inconsistent indentation/)
    assertParseError('  a: 1\nb: 2', 2, /inconsistent indentation/)
    assertParseError('l:\n  - x\n    - y', 3, /inconsistent indentation/)
  })

  it('rejects an unterminated quote', () => {
    assertParseError('a: 1\nb: "never closed', 2, /unterminated double-quoted string/)
    assertParseError("a: 'never closed\nb: 1", 1, /unterminated single-quoted string/)
    assertParseError('"key: 1', 1, /unterminated double-quoted string/)
  })

  it('rejects a list item where a map is expected', () => {
    assertParseError('policies:\n  external_network: allow\n  - oops', 3, /list item .* where a "key: value" entry was expected/)
    assertParseError('a: 1\n- b', 2, /list item .* where a "key: value" entry was expected/)
  })

  it('rejects a map entry where a list is expected', () => {
    assertParseError('models:\n  - lead\n  search: haiku', 3, /"key: value" entry where a list item/)
    assertParseError('- a\nb: 1', 2, /"key: value" entry where a list item/)
  })

  it('rejects lines that are not "key: value"', () => {
    assertParseError('a: 1\njust some text', 2, /expected "key: value"/)
    assertParseError('a: 1\n: no key', 2, /missing key/)
    assertParseError('a: 1\nnot a key # c: x', 2, /expected "key: value"/)
  })

  it('rejects duplicate keys', () => {
    assertParseError('a: 1\nb: 2\na: 3', 3, /duplicate key "a"/)
  })

  it('rejects unsupported YAML features instead of misreading them', () => {
    assertParseError('a: &anchor 1', 1, /anchors, aliases and tags/)
    assertParseError('a: *alias', 1, /anchors, aliases and tags/)
    assertParseError('a: !!str 1', 1, /anchors, aliases and tags/)
    assertParseError('a: {b: 1}', 1, /flow maps/)
    assertParseError('a: |\n  text', 1, /multi-line strings/)
    assertParseError('a: >\n  text', 1, /multi-line strings/)
    assertParseError('l:\n  - name: x', 2, /maps inside lists/)
  })

  it('rejects text after a closing quote and unknown escapes', () => {
    assertParseError(`a: "x" y`, 1, /unexpected text/)
    assertParseError(`a: 'x' 'y'`, 1, /unexpected text/)
    assertParseError('a: "bad \\q escape"', 1, /unknown escape sequence "\\q"/)
    assertParseError('a: "\\u12"', 1, /unknown escape sequence "\\u"/)
  })

  it('reports the real line number after blank and comment lines', () => {
    assertParseError('# c\n\na: 1\n\n# d\nb: "oops', 6, /unterminated/)
  })
})

describe('normalizeProfile', () => {
  it('returns the defaults for empty input without warnings', () => {
    for (const raw of [undefined, null, {}]) {
      const result = normalizeProfile(raw)
      assert.deepEqual(result.profile, makeProfile())
      assert.deepEqual(result.warnings, [])
    }
  })

  it('DEFAULT_PROFILE equals the fixture profile', () => {
    assert.deepEqual(DEFAULT_PROFILE, makeProfile())
  })

  it('merges over the defaults field by field', () => {
    const { profile, warnings } = normalizeProfile({
      name: 'Mine',
      models: { lead: 'sonnet' },
      budgets: { max_findings_per_scout: 5 },
      validation: { commands: ['npm test', 'npm run lint'] },
      policies: { allowed_mcp_tools: ['mcp__docs__*'] },
    })
    assert.deepEqual(warnings, [])
    assert.deepEqual(
      profile,
      makeProfile({
        name: 'Mine',
        models: { lead: 'sonnet', search: 'haiku', reviewer: 'sonnet' },
        budgets: { max_parallel_researchers: 3, max_research_rounds_without_user_update: 2, max_findings_per_scout: 5 },
        validation: { commands: ['npm test', 'npm run lint'], timeout_ms: 300000 },
        policies: { external_network: 'deny_by_default', require_plan_approval: true, allow_write_in_explore: false, allowed_mcp_tools: ['mcp__docs__*'], allowed_commands: { read_only: [], implement: [], validate: [] } },
      }),
    )
  })

  it('falls back to the default with a warning naming the dotted field when a type is wrong', () => {
    const cases: { raw: Record<string, unknown>; field: string; check: (p: ReturnType<typeof makeProfile>) => unknown; expected: unknown }[] = [
      { raw: { profile_id: 42 }, field: 'profile_id', check: p => p.profile_id, expected: 'default' },
      { raw: { name: '' }, field: 'name', check: p => p.name, expected: 'Default' },
      { raw: { domains: 'axi' }, field: 'domains', check: p => p.domains, expected: [] },
      { raw: { entrypoints: ['ok', 3] }, field: 'entrypoints', check: p => p.entrypoints, expected: ['README.md', 'docs/'] },
      { raw: { policies: { require_plan_approval: 'yes' } }, field: 'policies.require_plan_approval', check: p => p.policies.require_plan_approval, expected: true },
      { raw: { policies: { allow_write_in_explore: 1 } }, field: 'policies.allow_write_in_explore', check: p => p.policies.allow_write_in_explore, expected: false },
      { raw: { policies: { allowed_mcp_tools: { a: 1 } } }, field: 'policies.allowed_mcp_tools', check: p => p.policies.allowed_mcp_tools, expected: [] },
      { raw: { models: { lead: 7 } }, field: 'models.lead', check: p => p.models.lead, expected: 'opus' },
      { raw: { budgets: { max_parallel_researchers: '3' } }, field: 'budgets.max_parallel_researchers', check: p => p.budgets.max_parallel_researchers, expected: 3 },
      { raw: { budgets: { max_parallel_researchers: 0 } }, field: 'budgets.max_parallel_researchers', check: p => p.budgets.max_parallel_researchers, expected: 3 },
      { raw: { budgets: { max_findings_per_scout: 2.5 } }, field: 'budgets.max_findings_per_scout', check: p => p.budgets.max_findings_per_scout, expected: 8 },
      { raw: { budgets: { max_research_rounds_without_user_update: -1 } }, field: 'budgets.max_research_rounds_without_user_update', check: p => p.budgets.max_research_rounds_without_user_update, expected: 2 },
      { raw: { validation: { timeout_ms: 'slow' } }, field: 'validation.timeout_ms', check: p => p.validation.timeout_ms, expected: 300000 },
      { raw: { validation: { commands: 'npm test' } }, field: 'validation.commands', check: p => p.validation.commands, expected: [] },
    ]
    for (const { raw, field, check, expected } of cases) {
      const { profile, warnings } = normalizeProfile(raw)
      assert.deepEqual(check(profile), expected, field)
      assert.equal(warnings.length, 1, `${field}: ${warnings.join(' | ')}`)
      assert.ok(warnings[0]?.startsWith(`${field}:`), `warning should start with "${field}:" but was "${warnings[0]}"`)
    }
  })

  it('falls back to the defaults when a whole section is not a mapping', () => {
    const { profile, warnings } = normalizeProfile({ policies: 'strict', models: ['opus'] })
    assert.deepEqual(profile, makeProfile())
    assert.equal(warnings.length, 2)
    assert.match(warnings[0] ?? '', /^policies: expected a mapping, got a string/)
    assert.match(warnings[1] ?? '', /^models: expected a mapping, got a list/)
  })

  it('warns when the top level is not a mapping', () => {
    for (const raw of [['a'], 'text', 5, true]) {
      const { profile, warnings } = normalizeProfile(raw)
      assert.deepEqual(profile, makeProfile())
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /^profile: expected a mapping/)
    }
  })

  it('warns about unknown keys at every level and still honours the known ones', () => {
    const { profile, warnings } = normalizeProfile({
      polices: {},
      name: 'Kept',
      policies: { extra: 1, require_plan_approval: false },
      models: { fast: 'haiku' },
      budgets: { max_parallel: 9 },
      validation: { retries: 2 },
    })
    assert.equal(profile.name, 'Kept')
    assert.equal(profile.policies.require_plan_approval, false)
    assert.deepEqual(warnings.slice().sort(), [
      'budgets.max_parallel: unknown field, ignored',
      'models.fast: unknown field, ignored',
      'polices: unknown field, ignored',
      'policies.extra: unknown field, ignored',
      'validation.retries: unknown field, ignored',
    ])
  })

  it('validates enum values', () => {
    assert.equal(normalizeProfile({ policies: { external_network: 'allow' } }).profile.policies.external_network, 'allow')
    assert.equal(normalizeProfile({ policies: { external_network: 'deny_by_default' } }).profile.policies.external_network, 'deny_by_default')
    for (const bad of ['maybe', 'ALLOW', true, 3, ['allow']]) {
      const { profile, warnings } = normalizeProfile({ policies: { external_network: bad } })
      assert.equal(profile.policies.external_network, 'deny_by_default', `value ${JSON.stringify(bad)}`)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /^policies\.external_network: expected one of deny_by_default, allow/)
    }
  })

  it('treats null values as unset, without warnings', () => {
    const { profile, warnings } = normalizeProfile({ name: null, policies: null, models: { lead: null }, domains: null })
    assert.deepEqual(profile, makeProfile())
    assert.deepEqual(warnings, [])
  })

  it('does not mutate its input or share arrays with it', () => {
    const raw = deepFreeze({ domains: ['axi'], validation: { commands: ['npm test'] } })
    const { profile } = normalizeProfile(raw)
    profile.domains.push('apb')
    profile.validation.commands.push('npm run lint')
    assert.deepEqual(raw, { domains: ['axi'], validation: { commands: ['npm test'] } })
  })

  it('returns a profile independent from DEFAULT_PROFILE', () => {
    const { profile } = normalizeProfile({})
    profile.domains.push('x')
    profile.models.lead = 'changed'
    assert.deepEqual(DEFAULT_PROFILE.domains, [])
    assert.equal(DEFAULT_PROFILE.models.lead, 'opus')
  })
})

describe('loadProfile', () => {
  it('returns the defaults with source null when no profile file exists', async () => {
    const io = createMemoryIo()
    const result = await loadProfile(io, ROOT)
    assert.deepEqual(result, { profile: makeProfile(), source: null, warnings: [] })
    assert.notEqual(result.profile, DEFAULT_PROFILE)
  })

  it('reads project.yaml', async () => {
    const io = createMemoryIo({ '/repo/.ewm/project.yaml': SPEC_EXAMPLE })
    const { profile, source, warnings } = await loadProfile(io, ROOT)
    assert.equal(source, '.ewm/project.yaml')
    assert.deepEqual(warnings, [])
    assert.equal(profile.profile_id, 'silicon-dv')
    assert.equal(profile.models.lead, 'opus')
  })

  it('reads project.json when there is no project.yaml', async () => {
    const io = createMemoryIo({ '/repo/.ewm/project.json': JSON.stringify({ profile_id: 'from-json', models: { lead: 'sonnet' } }) })
    const { profile, source, warnings } = await loadProfile(io, ROOT)
    assert.equal(source, '.ewm/project.json')
    assert.deepEqual(warnings, [])
    assert.equal(profile.profile_id, 'from-json')
    assert.equal(profile.models.lead, 'sonnet')
    assert.equal(profile.models.search, 'haiku')
  })

  it('prefers project.yaml over project.json, which prefers the defaults', async () => {
    const io = createMemoryIo({
      '/repo/.ewm/project.yaml': 'profile_id: from-yaml\n',
      '/repo/.ewm/project.json': JSON.stringify({ profile_id: 'from-json' }),
    })
    const both = await loadProfile(io, ROOT)
    assert.equal(both.source, '.ewm/project.yaml')
    assert.equal(both.profile.profile_id, 'from-yaml')

    io.files.delete('/repo/.ewm/project.yaml')
    const jsonOnly = await loadProfile(io, ROOT)
    assert.equal(jsonOnly.source, '.ewm/project.json')
    assert.equal(jsonOnly.profile.profile_id, 'from-json')

    io.files.delete('/repo/.ewm/project.json')
    const neither = await loadProfile(io, ROOT)
    assert.equal(neither.source, null)
    assert.equal(neither.profile.profile_id, 'default')
  })

  it('does not fall back to project.json when project.yaml is broken', async () => {
    const io = createMemoryIo({
      '/repo/.ewm/project.yaml': 'profile_id: ok\nbroken: "open',
      '/repo/.ewm/project.json': JSON.stringify({ profile_id: 'from-json' }),
    })
    await assert.rejects(loadProfile(io, ROOT), (error: unknown) => {
      assert.ok(error instanceof EwmError)
      assert.equal(error.code, 'parse_error')
      assert.match(error.message, /^ewm: project\.yaml line 2: unterminated/)
      return true
    })
  })

  it('throws a parse_error for invalid JSON', async () => {
    const io = createMemoryIo({ '/repo/.ewm/project.json': '{ "profile_id": ' })
    await assert.rejects(loadProfile(io, ROOT), (error: unknown) => {
      assert.ok(error instanceof EwmError)
      assert.equal(error.code, 'parse_error')
      assert.match(error.message, /^ewm: project\.json is not valid JSON/)
      return true
    })
  })

  it('treats an empty project.yaml as the defaults but still reports the source', async () => {
    const io = createMemoryIo({ '/repo/.ewm/project.yaml': '# nothing configured yet\n' })
    const result = await loadProfile(io, ROOT)
    assert.deepEqual(result, { profile: makeProfile(), source: '.ewm/project.yaml', warnings: [] })
  })

  it('passes normalization warnings through', async () => {
    const io = createMemoryIo({ '/repo/.ewm/project.yaml': 'budgets:\n  max_parallel_researchers: many\nmystery: 1\n' })
    const { profile, warnings } = await loadProfile(io, ROOT)
    assert.equal(profile.budgets.max_parallel_researchers, 3)
    assert.equal(warnings.length, 2)
    assert.ok(warnings.some(w => w.startsWith('budgets.max_parallel_researchers:')))
    assert.ok(warnings.some(w => w.startsWith('mystery:')))
  })

  it('reads relative to the given root', async () => {
    const io = createMemoryIo({ '/other/.ewm/project.yaml': 'profile_id: other\n' })
    assert.equal((await loadProfile(io, '/other')).profile.profile_id, 'other')
    assert.equal((await loadProfile(io, ROOT)).source, null)
  })
})
