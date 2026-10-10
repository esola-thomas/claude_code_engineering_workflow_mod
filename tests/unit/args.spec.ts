import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { USAGE, parseCommand, splitArgs } from '../../src/args.ts'
import { EwmError } from '../../src/types.ts'

function assertInvalidInput(call: () => unknown): EwmError {
  let caught: unknown
  try {
    call()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof EwmError, `expected an EwmError but got ${String(caught)}`)
  assert.equal(caught.code, 'invalid_input')
  assert.ok(caught.message.startsWith('ewm: '), caught.message)
  return caught
}

/** Asserts a parse failure: an "ewm: " message that also carries the usage list. */
function assertParseError(input: string, mention?: string): string {
  const result = parseCommand(input)
  assert.ok('error' in result, `expected an error for ${JSON.stringify(input)} but got ${JSON.stringify(result)}`)
  assert.ok(result.error.startsWith('ewm: '), result.error)
  assert.ok(result.error.includes(USAGE), 'error must include USAGE')
  if (mention !== undefined) assert.ok(result.error.includes(mention), `expected ${JSON.stringify(mention)} in ${result.error}`)
  return result.error
}

describe('splitArgs', () => {
  it('splits on runs of whitespace and ignores the edges', () => {
    assert.deepEqual(splitArgs('  a   b\tc\nd  '), ['a', 'b', 'c', 'd'])
    assert.deepEqual(splitArgs(''), [])
    assert.deepEqual(splitArgs('   '), [])
  })

  it('groups words inside double and single quotes', () => {
    assert.deepEqual(splitArgs('new "Fix the login" next'), ['new', 'Fix the login', 'next'])
    assert.deepEqual(splitArgs("new 'Fix the login' next"), ['new', 'Fix the login', 'next'])
  })

  it('keeps the other quote character literal inside a quote', () => {
    assert.deepEqual(splitArgs(`"it's fine"`), ["it's fine"])
    assert.deepEqual(splitArgs(`'say "hi"'`), ['say "hi"'])
  })

  it('joins adjacent quoted and bare parts into one token', () => {
    assert.deepEqual(splitArgs('a"b c"d'), ['ab cd'])
    assert.deepEqual(splitArgs(`pre'fix 1'"post fix"`), ['prefix 1post fix'])
  })

  it('yields an empty token for an empty quoted string', () => {
    assert.deepEqual(splitArgs('a "" b'), ['a', '', 'b'])
    assert.deepEqual(splitArgs("''"), [''])
  })

  it('lets a backslash escape the next character outside quotes', () => {
    assert.deepEqual(splitArgs('a\\ b c'), ['a b', 'c'])
    assert.deepEqual(splitArgs('\\"quoted\\"'), ['"quoted"'])
    assert.deepEqual(splitArgs("it\\'s"), ["it's"])
    assert.deepEqual(splitArgs('a\\\\b'), ['a\\b'])
  })

  it('lets a backslash escape inside double quotes', () => {
    assert.deepEqual(splitArgs('"say \\"hi\\" now"'), ['say "hi" now'])
    assert.deepEqual(splitArgs('"back\\\\slash"'), ['back\\slash'])
  })

  it('keeps a backslash literal inside single quotes', () => {
    assert.deepEqual(splitArgs("'a\\b' 'c\\'"), ['a\\b', 'c\\'])
  })

  it('keeps a trailing backslash outside quotes as a literal backslash', () => {
    assert.deepEqual(splitArgs('path\\'), ['path\\'])
  })

  it('throws invalid_input on an unterminated quote', () => {
    assertInvalidInput(() => splitArgs('new "oops'))
    assertInvalidInput(() => splitArgs("new 'oops"))
    assertInvalidInput(() => splitArgs('"ends with escape\\'))
  })

  it('names the quote and how to proceed in the unterminated-quote message', () => {
    assert.match(assertInvalidInput(() => splitArgs('x "y')).message, /unterminated " quote/)
    assert.match(assertInvalidInput(() => splitArgs("x 'y")).message, /unterminated ' quote/)
  })
})

describe('parseCommand: simple commands', () => {
  it('treats empty or blank input as status', () => {
    assert.deepEqual(parseCommand(''), { name: 'status' })
    assert.deepEqual(parseCommand('   \n '), { name: 'status' })
  })

  for (const name of ['status', 'map', 'questions', 'plan', 'pause', 'reset', 'list', 'help'] as const) {
    it(`parses ${name}`, () => {
      assert.deepEqual(parseCommand(name), { name })
      assert.deepEqual(parseCommand(`  ${name}  `), { name })
    })

    it(`rejects arguments after ${name}`, () => {
      assertParseError(`${name} extra`, `${name} takes no arguments`)
    })
  }

  it('accepts the sub-command in any letter case', () => {
    assert.deepEqual(parseCommand('STATUS'), { name: 'status' })
    assert.deepEqual(parseCommand('Resume task-002'), { name: 'resume', id: 'TASK-002' })
  })
})

describe('parseCommand: new', () => {
  it('parses a quoted title', () => {
    assert.deepEqual(parseCommand('new "Fix the login test"'), { name: 'new', title: 'Fix the login test' })
  })

  it('omits goal when none is given', () => {
    const result = parseCommand('new "Fix it"')
    assert.ok(!('goal' in result))
  })

  it('joins unquoted words into the title', () => {
    assert.deepEqual(parseCommand('new Fix   the login'), { name: 'new', title: 'Fix the login' })
  })

  it('parses --goal with a quoted value', () => {
    assert.deepEqual(parseCommand('new "Fix login" --goal "Users stay signed in"'), {
      name: 'new',
      title: 'Fix login',
      goal: 'Users stay signed in',
    })
  })

  it('parses --goal before the title and in --goal=value form', () => {
    assert.deepEqual(parseCommand('new --goal "Be fast" "Speed up CI"'), { name: 'new', title: 'Speed up CI', goal: 'Be fast' })
    assert.deepEqual(parseCommand('new "Speed up CI" --goal=Be-fast'), { name: 'new', title: 'Speed up CI', goal: 'Be-fast' })
  })

  it('handles escapes and the other quote type in titles', () => {
    assert.deepEqual(parseCommand(`new "Don't panic" --goal 'say "hi"'`), { name: 'new', title: "Don't panic", goal: 'say "hi"' })
    assert.deepEqual(parseCommand('new "Say \\"hi\\""'), { name: 'new', title: 'Say "hi"' })
  })

  it('rejects a missing title', () => {
    assertParseError('new', 'new needs a title')
    assertParseError('new   ', 'new needs a title')
    assertParseError('new ""', 'new needs a title')
    assertParseError('new --goal "only a goal"', 'new needs a title')
  })

  it('rejects an unterminated quote', () => {
    assertParseError('new "Fix login', 'unterminated')
    assertParseError("new 'Fix login", 'unterminated')
  })

  it('rejects a --goal without a usable value', () => {
    assertParseError('new "Fix" --goal', '--goal needs a value')
    assertParseError('new "Fix" --goal ""', '--goal must not be empty')
    assertParseError('new "Fix" --goal=', '--goal must not be empty')
  })

  it('rejects a repeated --goal and unknown options', () => {
    assertParseError('new "Fix" --goal a --goal b', 'twice')
    assertParseError('new "Fix" --priority high', 'unknown option --priority')
  })
})

describe('parseCommand: resume', () => {
  it('parses resume without an id', () => {
    assert.deepEqual(parseCommand('resume'), { name: 'resume' })
  })

  it('upper-cases the task id', () => {
    assert.deepEqual(parseCommand('resume task-001'), { name: 'resume', id: 'TASK-001' })
    assert.deepEqual(parseCommand('resume TASK-0042'), { name: 'resume', id: 'TASK-0042' })
    assert.deepEqual(parseCommand('resume Task-123'), { name: 'resume', id: 'TASK-123' })
  })

  it('rejects ids that are not TASK-NNN with three or more digits', () => {
    assertParseError('resume ../x', 'invalid task id')
    assertParseError('resume TASK-1', 'invalid task id')
    assertParseError('resume TASK-001/../../x', 'invalid task id')
    assertParseError('resume 001', 'invalid task id')
  })

  it('rejects extra arguments', () => {
    assertParseError('resume TASK-001 TASK-002', 'at most one')
  })

  it('rejects an unterminated quote', () => {
    assertParseError('resume "TASK-001', 'unterminated')
  })
})

describe('parseCommand: approve and reject', () => {
  it('parses approve with and without a note', () => {
    assert.deepEqual(parseCommand('approve'), { name: 'approve' })
    assert.deepEqual(parseCommand('approve looks good to me'), { name: 'approve', note: 'looks good to me' })
    assert.deepEqual(parseCommand('approve "ship it, with the follow-up"'), { name: 'approve', note: 'ship it, with the follow-up' })
  })

  it('parses reject with a reason', () => {
    assert.deepEqual(parseCommand('reject the plan skips the migration'), { name: 'reject', note: 'the plan skips the migration' })
    assert.deepEqual(parseCommand('reject "needs tests"'), { name: 'reject', note: 'needs tests' })
  })

  it('takes notes as typed, so apostrophes do not need quoting', () => {
    assert.deepEqual(parseCommand("reject I don't like it and can't ship it"), {
      name: 'reject',
      note: "I don't like it and can't ship it",
    })
    assert.deepEqual(parseCommand("approve it's fine"), { name: 'approve', note: "it's fine" })
  })

  it('collapses whitespace inside a note', () => {
    assert.deepEqual(parseCommand('reject   too    risky \n now'), { name: 'reject', note: 'too risky now' })
  })

  it('rejects reject without a reason', () => {
    assertParseError('reject', 'reject needs a reason')
    assertParseError('reject   ', 'reject needs a reason')
    assertParseError('reject ""', 'reject needs a reason')
  })
})

describe('parseCommand: unknown input', () => {
  it('returns an error that includes USAGE for an unknown sub-command', () => {
    const message = assertParseError('frobnicate now', 'unknown command "frobnicate"')
    assert.ok(message.endsWith(USAGE))
  })

  it('does not treat a quoted sub-command as a command', () => {
    assertParseError('"status"', 'unknown command')
  })
})

describe('USAGE', () => {
  const lines = USAGE.split('\n')

  it('has one line per command', () => {
    assert.equal(lines.length, 12)
    for (const line of lines) assert.ok(line.startsWith('/ewm '), line)
  })

  it('mentions every command exactly once', () => {
    for (const name of ['new', 'resume', 'status', 'map', 'questions', 'plan', 'pause', 'reset', 'approve', 'reject', 'list', 'help']) {
      assert.equal(lines.filter(line => line.startsWith(`/ewm ${name}`)).length, 1, name)
    }
  })

  it('is plain ASCII', () => {
    assert.match(USAGE, /^[\x20-\x7e\n]+$/)
  })
})

describe('parseCommand: approve --plan <hash> (the approval carries the plan the person read)', () => {
  it('parses the hash prefix, lower-cased, with or without a note', () => {
    assert.deepEqual(parseCommand('approve --plan 6EC3494E'), { name: 'approve', plan: '6ec3494e' })
    assert.deepEqual(parseCommand('approve --plan 6ec3494e looks right'), { name: 'approve', plan: '6ec3494e', note: 'looks right' })
    assert.deepEqual(parseCommand('approve --plan=6ec3494e'), { name: 'approve', plan: '6ec3494e' })
    const full = 'a'.repeat(64)
    assert.deepEqual(parseCommand(`approve --plan ${full}`), { name: 'approve', plan: full })
  })

  it('rejects a missing or malformed hash with an explanation', () => {
    for (const input of ['approve --plan', 'approve --plan nothex', 'approve --plan 123', `approve --plan ${'a'.repeat(65)}`]) {
      assertParseError(input, '--plan needs')
    }
  })

  it('keeps an ordinary note that merely mentions a hash', () => {
    assert.deepEqual(parseCommand('approve plan 6ec3494e is fine'), { name: 'approve', note: 'plan 6ec3494e is fine' })
  })

  it('does not apply to reject', () => {
    assert.deepEqual(parseCommand('reject --plan 6ec3494e'), { name: 'reject', note: '--plan 6ec3494e' })
  })
})
