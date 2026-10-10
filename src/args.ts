// /ewm argument parsing: a shell-like splitter and the command grammar.
// Pure: no Io, no clock.

import { EwmError, TASK_ID_PATTERN } from './types.ts'

export type EwmCommand =
  | { name: 'new'; title: string; goal?: string } // /ewm new "title" [--goal "text"]
  | { name: 'resume'; id?: string } // /ewm resume [TASK-001]
  | { name: 'status' }
  | { name: 'map' }
  | { name: 'questions' }
  | { name: 'plan' }
  | { name: 'pause' }
  | { name: 'reset' } // /ewm reset: back up the gate ledger and start an empty one (recovery from a malformed ledger, or a fresh start)
  | { name: 'list' }
  | { name: 'help' }
  | { name: 'approve'; note?: string; plan?: string } // /ewm approve [--plan <hash>] [note...]
  | { name: 'reject'; note: string } // /ewm reject <reason...>  (note required)

export const USAGE = [
  '/ewm new "<title>" [--goal "<text>"]   start a task',
  '/ewm resume [TASK-001]                 continue a task (default: the active or latest one)',
  '/ewm status                            show phase, counts, models and the next action',
  '/ewm map                               show the system map',
  '/ewm questions                         show open and resolved questions',
  '/ewm plan                              move to PLAN once understood, or show the plan',
  '/ewm pause                             save a checkpoint and leave the workflow',
  '/ewm reset                             back up the gate ledger and start an empty one (fixes a malformed ledger; gates must be approved again)',
  '/ewm approve [--plan <hash>] [note]    approve the pending gate (plan or final acceptance); --plan refuses if the plan is not the one with that hash',
  '/ewm reject <reason>                   send the pending gate back with a reason',
  '/ewm list                              list tasks',
  '/ewm help                              show this list',
].join('\n')

const GOAL_FLAG = '--goal'

function isSpace(char: string): boolean {
  return /\s/.test(char)
}

/** Shell-like split: whitespace separates; '...' and "..." group; backslash escapes inside "..." and outside quotes. Throws EwmError('invalid_input') on an unterminated quote. */
export function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  // True once a token has begun, so an empty quoted string ("") still yields a token.
  let inToken = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i)

    if (quote === "'") {
      // Single quotes are literal until the closing quote.
      if (char === "'") quote = null
      else current += char
      continue
    }

    if (char === '\\' && i + 1 < input.length) {
      i++
      current += input.charAt(i)
      inToken = true
      continue
    }

    if (quote === '"') {
      if (char === '"') quote = null
      else current += char
      continue
    }

    if (isSpace(char)) {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
      continue
    }

    inToken = true
    if (char === '"' || char === "'") quote = char
    else current += char
  }

  if (quote !== null) {
    throw new EwmError('invalid_input', `ewm: unterminated ${quote} quote in the arguments; close it, or remove it (put a title with an apostrophe in double quotes).`)
  }
  if (inToken) tokens.push(current)
  return tokens
}

type ParseResult = EwmCommand | { error: string }

/** An error result that always carries the command list, so the person sees how to proceed. */
function fail(message: string): { error: string } {
  return { error: `${message}\n${USAGE}` }
}

/** Collapses runs of whitespace; free-text notes keep their words, not their layout. */
function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Removes one pair of quotes wrapping the whole note, so `reject "needs tests"` records `needs tests`. */
function unwrapQuotes(note: string): string {
  const first = note.charAt(0)
  if (note.length >= 2 && (first === '"' || first === "'") && note.endsWith(first) && !note.slice(1, -1).includes(first)) {
    return note.slice(1, -1).trim()
  }
  return note
}

/**
 * Approval notes are free text ("don't ship this"), so they are taken as typed
 * instead of being split like shell words, which would choke on an apostrophe.
 */
function parseNote(rest: string): string {
  return unwrapQuotes(collapseSpaces(rest))
}

function parseNew(rest: string): ParseResult {
  let tokens: string[]
  try {
    tokens = splitArgs(rest)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  const titleWords: string[] = []
  let goal: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    let value: string | undefined
    if (token === GOAL_FLAG) {
      value = tokens[++i]
      if (value === undefined) return fail(`ewm: ${GOAL_FLAG} needs a value, e.g. /ewm new "Fix login" ${GOAL_FLAG} "Users stay signed in".`)
    } else if (token.startsWith(`${GOAL_FLAG}=`)) {
      value = token.slice(GOAL_FLAG.length + 1)
    } else if (token.startsWith('--')) {
      return fail(`ewm: unknown option ${token} for new; the only option is ${GOAL_FLAG} "<text>".`)
    } else {
      titleWords.push(token)
      continue
    }
    if (goal !== undefined) return fail(`ewm: ${GOAL_FLAG} was given twice; pass it once.`)
    goal = collapseSpaces(value)
    if (goal === '') return fail(`ewm: ${GOAL_FLAG} must not be empty; describe the goal or drop the option.`)
  }

  const title = collapseSpaces(titleWords.join(' '))
  if (title === '') return fail('ewm: new needs a title, e.g. /ewm new "Investigate the flaky login test".')
  return goal === undefined ? { name: 'new', title } : { name: 'new', title, goal }
}

/** `--plan <hash>`: the hex prefix (8-64 digits) of the plan hash the person reviewed; the approval is refused when the plan has changed since. */
const PLAN_FLAG = /^--plan(?=$|=|\s)=?\s*(\S*)\s*([\s\S]*)$/

function parseApprove(rest: string): ParseResult {
  let plan: string | undefined
  let remaining = rest.trim()
  const flag = PLAN_FLAG.exec(remaining)
  if (flag !== null) {
    const hash = flag[1] ?? ''
    if (!/^[0-9a-fA-F]{8,64}$/.test(hash)) {
      return fail('ewm: --plan needs the first 8 or more hex digits of the plan hash shown in /ewm status, e.g. /ewm approve --plan 6ec3494e.')
    }
    plan = hash.toLowerCase()
    remaining = flag[2] ?? ''
  }
  const note = parseNote(remaining)
  const command: Extract<EwmCommand, { name: 'approve' }> = { name: 'approve' }
  if (note !== '') command.note = note
  if (plan !== undefined) command.plan = plan
  return command
}

function parseResume(rest: string): ParseResult {
  let tokens: string[]
  try {
    tokens = splitArgs(rest)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (tokens.length > 1) return fail('ewm: resume takes at most one task id, e.g. /ewm resume TASK-001.')
  const raw = tokens[0]
  if (raw === undefined) return { name: 'resume' }
  const id = raw.toUpperCase()
  if (!TASK_ID_PATTERN.test(id)) {
    return fail(`ewm: invalid task id ${JSON.stringify(raw)}; ids look like TASK-001. Run /ewm list to see the existing tasks.`)
  }
  return { name: 'resume', id }
}

const NO_ARGUMENT_COMMANDS = ['status', 'map', 'questions', 'plan', 'pause', 'reset', 'list', 'help'] as const
type NoArgumentName = (typeof NO_ARGUMENT_COMMANDS)[number]

function isNoArgumentCommand(name: string): name is NoArgumentName {
  return (NO_ARGUMENT_COMMANDS as readonly string[]).includes(name)
}

/** Empty input -> status. Unknown sub-command or bad args -> { error } including USAGE. Ids are upper-cased and validated with TASK_ID_PATTERN. */
export function parseCommand(input: string): EwmCommand | { error: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(input.trim())
  if (match === null) return { name: 'status' }
  const name = (match[1] ?? '').toLowerCase()
  const rest = match[2] ?? ''

  if (name === 'new') return parseNew(rest)
  if (name === 'resume') return parseResume(rest)
  if (name === 'approve') return parseApprove(rest)
  if (name === 'reject') {
    const note = parseNote(rest)
    if (note === '') return fail('ewm: reject needs a reason, e.g. /ewm reject "the plan skips the migration".')
    return { name: 'reject', note }
  }
  if (isNoArgumentCommand(name)) {
    if (rest.trim() !== '') return fail(`ewm: ${name} takes no arguments.`)
    return { name }
  }
  return fail(`ewm: unknown command ${JSON.stringify(match[1])}.`)
}
