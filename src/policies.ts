// Tool-call policy: the verdict for every tool call while a task is active, and the
// Bash classifier behind it (D4-D8, D14-D16, F2).
//
// Pure: no IO, no clock. The classifier is an allowlist parser. Whenever it is not sure
// what a command does, the answer is 'other', never 'read_only'. Destructive and network
// detection is best effort on top of that: an obfuscated command (variables, scripts
// written and then run) can still evade it, and the gate ledger keeps the workflow's
// gates intact regardless (D14).

import type { Phase, Profile, ToolVerdict } from './types.ts'

// ---------------------------------------------------------------------------
// Tool lists
// ---------------------------------------------------------------------------

export const WRITE_TOOLS: readonly string[] = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Allowed in every active phase. */
export const SAFE_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'LSP',
  'NotebookRead',
  'ToolSearch',
  'Agent',
  'Task',
  'Skill',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListAgents',
])

/** Tools that send data out of the machine; denied under external_network: deny_by_default. */
export const OUTBOUND_TOOLS: readonly string[] = Object.freeze([
  'WebFetch',
  'WebSearch',
  'Artifact',
  'ArtifactData',
  'ArtifactComments',
  'SendFile',
  'SendUserFile',
  'SendMessage',
  'PushNotification',
  'RemoteTrigger',
  'PublishPlugin',
  'DesignSync',
])

/** They move the session away from the pinned workspace root (D16). */
export const ALWAYS_DENIED_TOOLS: readonly string[] = Object.freeze(['EnterWorktree', 'ExitWorktree'])

export const OWN_TOOL_PREFIX = 'mcp__ewm__'

/** The only own tool the read-only agents may call. */
export const READONLY_OWN_TOOLS: readonly string[] = Object.freeze(['mcp__ewm__status'])

export const READONLY_AGENT_TYPES: readonly string[] = Object.freeze(['ewm:repo-scout', 'ewm:docs-scout', 'ewm:reviewer'])

export const NETWORK_PROGRAMS: readonly string[] = Object.freeze([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'telnet',
  'ftp',
  'socat',
])

// ---------------------------------------------------------------------------
// Shell scanner
//
// Splits a command string into simple commands (segments of unquoted words) the way
// the shell would, and records the constructs whose effect cannot be seen from the
// text. Command substitutions, backtick bodies and heredoc bodies are scanned too, so
// that a command hidden in them is still classified.
// ---------------------------------------------------------------------------

type Scan = {
  /** One entry per simple command: its words with quotes and escapes removed. Includes the commands inside substitutions. */
  segments: string[][]
  /** True when the text contains an expansion, substitution, subshell, redirection or an unterminated quote: such a command is never 'read_only'. */
  opaque: boolean
  /** Lines of heredoc bodies. A heredoc can feed a shell, so each line is also checked as a command. */
  heredocLines: string[]
  /** An unquoted glob with no directory in front of it (`*`, `*.ts`, `?x`): it can expand to a file named like an option. */
  leadingGlob: boolean
}

/** Substitutions nested deeper than MAX_SUBSTITUTION_DEPTH: the scanner gives up and the command is 'other'. */
class Unparseable extends Error {}

const MAX_SUBSTITUTION_DEPTH = 8

// Sticky patterns: always set lastIndex before exec.
const REDIRECT_OPERATOR = /<<<|<<-|<<|<&|<>|<|>>|>\||>&|>/y
/** The only redirections a read-only command may carry, written right after the fd `2`. */
const SAFE_STDERR_REDIRECT = />(?:[ \t]*\/dev\/null|&1)(?=$|[\s;&|)])/y
const FD_PREFIX = /^(?:\d+|\{[A-Za-z_]\w*\})$/

type Redirection = { heredoc: false } | { heredoc: true; stripTabs: boolean }
type PendingHeredoc = { delimiter: string; stripTabs: boolean }

function isHexDigit(ch: string): boolean {
  return /^[0-9a-fA-F]$/.test(ch)
}

const ANSI_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}

/** Decodes one escape of a $'...' string starting at src[pos] === '\\'. Returns the text and how many characters it used. */
function decodeAnsiEscape(src: string, pos: number): [string, number] {
  if (pos + 1 >= src.length) return ['\\', 1]
  const letter = src.charAt(pos + 1)
  const simple = ANSI_SIMPLE_ESCAPES[letter]
  if (simple !== undefined) return [simple, 2]
  const hexLimit = letter === 'x' ? 2 : letter === 'u' ? 4 : letter === 'U' ? 8 : 0
  if (hexLimit > 0) {
    let digits = ''
    while (digits.length < hexLimit && isHexDigit(src.charAt(pos + 2 + digits.length))) digits += src.charAt(pos + 2 + digits.length)
    if (digits === '') return ['\\' + letter, 2]
    const code = parseInt(digits, 16)
    return [code <= 0x10ffff ? String.fromCodePoint(code) : '', 2 + digits.length]
  }
  if (letter >= '0' && letter <= '7') {
    let digits = letter
    while (digits.length < 3 && src.charAt(pos + 1 + digits.length) >= '0' && src.charAt(pos + 1 + digits.length) <= '7') {
      digits += src.charAt(pos + 1 + digits.length)
    }
    return [String.fromCharCode(parseInt(digits, 8) & 0xff), 1 + digits.length]
  }
  return ['\\' + letter, 2]
}

/** Scans one command list: the whole command, or the body of a `$(...)`. */
class ListScanner {
  private readonly src: string
  private readonly nesting: number
  private readonly inSubstitution: boolean
  private readonly out: Scan
  private pos: number
  private words: string[] = []
  /** The word being built; null between words. */
  private word: string | null = null
  private quoted = false
  /** The word has an unquoted `{`: a later `,` or `..` makes it a brace expansion, which turns one word into several. */
  private braceOpen = false
  /** Set after a redirection operator: the next word is its target, not an argument. */
  private redirection: Redirection | null = null
  private heredocs: PendingHeredoc[] = []
  private parenDepth = 0

  constructor(src: string, start: number, nesting: number, inSubstitution: boolean, out: Scan) {
    if (nesting > MAX_SUBSTITUTION_DEPTH) throw new Unparseable()
    this.src = src
    this.pos = start
    this.nesting = nesting
    this.inSubstitution = inSubstitution
    this.out = out
  }

  /** Scans to the end of the input, or past the `)` that closes a substitution. Returns the index after what was consumed. */
  run(): number {
    const src = this.src
    while (this.pos < src.length) {
      const ch = src.charAt(this.pos)
      switch (ch) {
        case ' ':
        case '\t':
          this.endWord()
          this.pos++
          break
        case '\n':
          this.endSegment()
          this.pos++
          this.readHeredocBodies()
          break
        case '|':
        case '&':
        case ';':
          this.endSegment()
          this.pos++
          break
        case '(':
          // A subshell or group: its commands are scanned as ordinary segments, but the command is never read-only.
          this.endSegment()
          this.parenDepth++
          this.out.opaque = true
          this.pos++
          break
        case ')':
          if (this.inSubstitution && this.parenDepth === 0) {
            this.endSegment()
            return this.pos + 1
          }
          this.endSegment()
          this.parenDepth = Math.max(0, this.parenDepth - 1)
          this.out.opaque = true
          this.pos++
          break
        case '<':
        case '>':
          this.readRedirection(ch)
          break
        case '\\':
          this.readEscape()
          break
        case "'":
          this.readSingleQuoted()
          break
        case '"':
          this.readDoubleQuoted()
          break
        case '`':
          this.readBacktick()
          break
        case '$':
          this.readDollar(false)
          break
        case '{':
          this.braceOpen = true
          this.append(ch, false)
          this.pos++
          break
        case ',':
        case '.':
          // Brace expansion (`{a,b}`, `{1..3}`) makes the shell pass more words than the text shows, so no argument rule can be trusted.
          if (this.braceOpen && (ch === ',' || src.charAt(this.pos + 1) === '.')) this.out.opaque = true
          this.append(ch, false)
          this.pos++
          break
        case '*':
        case '?':
        case '[':
          if (!(this.word ?? '').includes('/')) this.out.leadingGlob = true
          this.append(ch, false)
          this.pos++
          break
        case '#':
          // A comment starts at the beginning of a word and runs to the end of the line.
          if (this.word === null) {
            const newline = src.indexOf('\n', this.pos)
            this.pos = newline < 0 ? src.length : newline
          } else {
            this.append(ch, false)
            this.pos++
          }
          break
        default:
          this.append(ch, false)
          this.pos++
      }
    }
    // Input that ends inside a substitution is a syntax error, but the shell may already have run what came before it.
    if (this.inSubstitution) this.out.opaque = true
    this.endSegment()
    return this.pos
  }

  private append(text: string, quote: boolean): void {
    this.word = (this.word ?? '') + text
    if (quote) this.quoted = true
  }

  private endWord(): void {
    if (this.word === null) return
    const text = this.word
    this.word = null
    this.quoted = false
    this.braceOpen = false
    const redirection = this.redirection
    if (redirection === null) {
      this.words.push(text)
      return
    }
    this.redirection = null
    if (redirection.heredoc) this.heredocs.push({ delimiter: text, stripTabs: redirection.stripTabs })
  }

  private endSegment(): void {
    this.endWord()
    this.redirection = null
    if (this.words.length > 0) this.out.segments.push(this.words)
    this.words = []
  }

  /** The input ended inside a quote. The shell would report a syntax error, but it may already have run the commands before it,
   *  so the scan keeps what it has (the rest of the input becomes the quoted text) and the command can never be read-only. */
  private endInsideQuote(rest: string): void {
    this.append(rest, true)
    this.pos = this.src.length
    this.out.opaque = true
  }

  private readEscape(): void {
    if (this.pos + 1 >= this.src.length) {
      // bash takes a backslash at the very end as a literal one; other shells may wait for more input. Never read-only.
      this.append('\\', true)
      this.out.opaque = true
      this.pos++
      return
    }
    const next = this.src.charAt(this.pos + 1)
    this.pos += 2
    if (next === '\n') return // line continuation
    this.append(next, true)
  }

  private readSingleQuoted(): void {
    const end = this.src.indexOf("'", this.pos + 1)
    if (end < 0) return this.endInsideQuote(this.src.slice(this.pos + 1))
    this.append(this.src.slice(this.pos + 1, end), true)
    this.pos = end + 1
  }

  private readDoubleQuoted(): void {
    const src = this.src
    this.append('', true)
    this.pos++ // opening quote
    for (;;) {
      if (this.pos >= src.length) return this.endInsideQuote('')
      const ch = src.charAt(this.pos)
      if (ch === '"') {
        this.pos++
        return
      }
      if (ch === '\\') {
        if (this.pos + 1 >= src.length) return this.endInsideQuote('\\')
        const next = src.charAt(this.pos + 1)
        if (next === '\n') {
          this.pos += 2
        } else if ('$`"\\'.includes(next)) {
          this.append(next, true)
          this.pos += 2
        } else {
          this.append('\\', true) // any other backslash stays literal
          this.pos++
        }
      } else if (ch === '$') {
        this.readDollar(true)
      } else if (ch === '`') {
        this.readBacktick()
      } else {
        this.append(ch, true)
        this.pos++
      }
    }
  }

  /** `$` at pos. Substitutions are scanned so their commands are classified; every expansion makes the command opaque. */
  private readDollar(inDoubleQuotes: boolean): void {
    const src = this.src
    const next = src.charAt(this.pos + 1)
    if (next === '(') {
      const begin = this.pos
      this.pos = new ListScanner(src, this.pos + 2, this.nesting + 1, true, this.out).run()
      this.out.opaque = true
      this.append(src.slice(begin, this.pos), true)
      return
    }
    if (!inDoubleQuotes && next === "'") {
      this.readAnsiCQuoted()
      return
    }
    if (!inDoubleQuotes && next === '"') {
      this.out.opaque = true
      this.pos++ // drop the `$`: a locale string is a double-quoted string
      this.readDoubleQuoted()
      return
    }
    const literal = next === '' || next === ' ' || next === '\t' || next === '\n' || (inDoubleQuotes && next === '"')
    if (!literal) this.out.opaque = true
    this.append('$', false)
    this.pos++
  }

  /** `$'...'`: backslash escapes are decoded so that `$'\x70ush'` reads as `push`. */
  private readAnsiCQuoted(): void {
    const src = this.src
    this.pos += 2
    let text = ''
    for (;;) {
      if (this.pos >= src.length) return this.endInsideQuote(text)
      const ch = src.charAt(this.pos)
      if (ch === "'") {
        this.pos++
        break
      }
      if (ch === '\\') {
        const [decoded, used] = decodeAnsiEscape(src, this.pos)
        text += decoded
        this.pos += used
      } else {
        text += ch
        this.pos++
      }
    }
    this.out.opaque = true
    this.append(text, true)
  }

  /** A backtick substitution ends at the next unescaped backtick (inside double quotes too). */
  private readBacktick(): void {
    const src = this.src
    const begin = this.pos
    let body = ''
    let i = this.pos + 1
    for (;;) {
      if (i >= src.length) break // unterminated: the rest is the body
      const ch = src.charAt(i)
      if (ch === '`') break
      if (ch === '\\' && i + 1 < src.length && '`\\$'.includes(src.charAt(i + 1))) {
        body += src.charAt(i + 1)
        i += 2
      } else {
        body += ch
        i++
      }
    }
    this.pos = Math.min(i + 1, src.length)
    new ListScanner(body, 0, this.nesting + 1, false, this.out).run()
    this.out.opaque = true
    this.append(src.slice(begin, this.pos), true)
  }

  private readRedirection(ch: string): void {
    const src = this.src
    // A word waiting for a pending redirection is its target, even a number right before the next operator (`<& 2>&1`).
    if (this.redirection !== null) this.endWord()
    if (ch === '>' && this.word === '2' && !this.quoted) {
      SAFE_STDERR_REDIRECT.lastIndex = this.pos
      const safe = SAFE_STDERR_REDIRECT.exec(src)
      if (safe !== null) {
        this.word = null
        this.pos += safe[0].length
        return
      }
    }
    this.out.opaque = true
    // A file descriptor number or {name} right before the operator belongs to the redirection.
    if (this.word !== null && !this.quoted && FD_PREFIX.test(this.word)) {
      this.word = null
    } else {
      this.endWord()
    }
    REDIRECT_OPERATOR.lastIndex = this.pos
    const operator = (REDIRECT_OPERATOR.exec(src) as RegExpExecArray)[0]
    this.pos += operator.length
    this.redirection =
      operator === '<<' || operator === '<<-' ? { heredoc: true, stripTabs: operator === '<<-' } : { heredoc: false }
  }

  /** After a newline: consumes the bodies of the heredocs started on the line just ended. */
  private readHeredocBodies(): void {
    if (this.heredocs.length === 0) return
    const src = this.src
    for (const heredoc of this.heredocs) {
      while (this.pos < src.length) {
        const newline = src.indexOf('\n', this.pos)
        const lineEnd = newline < 0 ? src.length : newline
        const line = src.slice(this.pos, lineEnd)
        this.pos = newline < 0 ? src.length : newline + 1
        if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
        this.out.heredocLines.push(line)
      }
    }
    this.heredocs = []
  }
}

/** Null only when substitutions nest too deep to follow. */
function scanCommand(src: string): Scan | null {
  const out: Scan = { segments: [], opaque: false, heredocLines: [], leadingGlob: false }
  try {
    new ListScanner(src, 0, 0, false, out).run()
  } catch (error) {
    if (error instanceof Unparseable) return null
    throw error
  }
  return out
}

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

function at(words: readonly string[], index: number): string {
  return words[index] ?? ''
}

function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/** The letters of a short-option cluster ("-rf" -> "rf"); '' for anything else, including long options. */
function shortCluster(arg: string): string {
  return arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--') ? arg.slice(1) : ''
}

/** The name of a long option without dashes or value ("--output=x" -> "output"); null for anything else. */
function longName(arg: string): string | null {
  if (!arg.startsWith('--') || arg.length < 3) return null
  const equals = arg.indexOf('=')
  return arg.slice(2, equals < 0 ? undefined : equals)
}

/** The argument is the long option `name`, an option it prefixes (`--output-indicator-new`) or an abbreviation of it (`--out`): getopt-style parsers accept all three. */
function isLongOption(arg: string, name: string): boolean {
  const given = longName(arg)
  return given !== null && given.length > 0 && (given.startsWith(name) || name.startsWith(given))
}

type OptionSpec = {
  /** Short options that take a value, glued or as the next word. */
  shortArg: string
  /** Short options whose value can only be glued (`-e[EOF]`). */
  shortOptional: string
  /** Long options that take a value (`--opt value` or `--opt=value`). Abbreviations count. */
  longArg: readonly string[]
  /** Positional words that come before the wrapped command (the duration of `timeout`). */
  positionals: number
}

const NO_OPTION_ARGS: OptionSpec = { shortArg: '', shortOptional: '', longArg: [], positionals: 0 }

/** True when the option word takes the following word as its value. */
function consumesNextWord(arg: string, spec: OptionSpec): boolean {
  if (arg.startsWith('--')) {
    const name = longName(arg)
    return name !== null && name.length > 0 && !arg.includes('=') && spec.longArg.some((long) => long.startsWith(name))
  }
  const cluster = arg.slice(1)
  for (let k = 0; k < cluster.length; k++) {
    const letter = cluster.charAt(k)
    if (spec.shortOptional.includes(letter)) return false
    if (spec.shortArg.includes(letter)) return k === cluster.length - 1
  }
  return false
}

/** Index of the first word after the leading options (after `--` when present). */
function skipOptions(args: readonly string[], spec: OptionSpec): number {
  let i = 0
  while (i < args.length) {
    const arg = at(args, i)
    if (arg === '--') return i + 1
    if (!arg.startsWith('-') || arg === '-') return i
    i += consumesNextWord(arg, spec) ? 2 : 1
  }
  return i
}

/** Number of positional words, not counting option values. */
function countPositionals(args: readonly string[], spec: OptionSpec): number {
  let count = 0
  let i = 0
  let optionsEnded = false
  while (i < args.length) {
    const arg = at(args, i)
    if (optionsEnded || !arg.startsWith('-') || arg === '-') {
      count++
      i++
    } else if (arg === '--') {
      optionsEnded = true
      i++
    } else {
      i += consumesNextWord(arg, spec) ? 2 : 1
    }
  }
  return count
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'))
}

// ---------------------------------------------------------------------------
// Destructive and network detection
//
// Every simple command is unwrapped (assignments, shell keywords, env/timeout/xargs/...,
// sh -c, eval) until the real program is found, then inspected.
// ---------------------------------------------------------------------------

type Facts = { destructive: boolean; network: boolean; mentionsEwm: boolean }

/** Nesting limit for `sh -c`, `eval` and heredoc scripts; deeper commands are left as 'other'. */
const MAX_SHELL_DEPTH = 3
const MAX_UNWRAP_HOPS = 16

const EWM_MENTION = /\.ewm/i
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELL_KEYWORDS = new Set([
  '!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'case', 'esac', 'for', 'select', 'function', 'coproc',
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const SHELL_LONG_OPTIONS_WITH_VALUE = ['--rcfile', '--init-file']
const FIND_EXEC_OPTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const WHOLE_TREE_PATHSPECS = new Set(['.', './', ':/'])
const NETWORK_GIT_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote'])

/** Wrappers that run the rest of the words as a command. */
const WRAPPERS = new Map<string, OptionSpec>([
  ['env', { shortArg: 'uCSa', shortOptional: '', longArg: ['unset', 'chdir', 'split-string', 'argv0'], positionals: 0 }],
  ['command', NO_OPTION_ARGS],
  ['exec', { ...NO_OPTION_ARGS, shortArg: 'a' }],
  ['nohup', NO_OPTION_ARGS],
  ['nice', { ...NO_OPTION_ARGS, shortArg: 'n', longArg: ['adjustment'] }],
  ['time', { ...NO_OPTION_ARGS, shortArg: 'fo', longArg: ['format', 'output'] }],
  ['timeout', { ...NO_OPTION_ARGS, shortArg: 'sk', longArg: ['signal', 'kill-after'], positionals: 1 }],
  [
    'xargs',
    {
      shortArg: 'adEILnPs',
      shortOptional: 'eil',
      longArg: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'],
      positionals: 0,
    },
  ],
])

/** A word that starts with an expansion (`$X`, `$(...)`, a backtick) may expand to nothing and let the next word become the program. */
function startsWithExpansion(word: string): boolean {
  return word.startsWith('$') || word.startsWith('`')
}

function skipPrefixes(argv: readonly string[]): readonly string[] {
  let i = 0
  while (i < argv.length) {
    const word = at(argv, i)
    if (!ASSIGNMENT.test(word) && !SHELL_KEYWORDS.has(word) && !startsWithExpansion(word)) break
    i++
  }
  return argv.slice(i)
}

/** The command string of `sh -c <string>` (any option cluster containing c), or null when the shell runs a script or stdin. */
function shellPayload(args: readonly string[]): string | null {
  let hasCommandFlag = false
  let i = 0
  while (i < args.length) {
    const arg = at(args, i)
    if (arg === '--') {
      i++
      break
    }
    if ((!arg.startsWith('-') && !arg.startsWith('+')) || arg === '-' || arg === '+') break
    if (arg.startsWith('--')) {
      i += SHELL_LONG_OPTIONS_WITH_VALUE.includes(arg) ? 2 : 1
      continue
    }
    if (arg.startsWith('-') && arg.includes('c')) hasCommandFlag = true
    const last = arg.charAt(arg.length - 1)
    i += last === 'o' || last === 'O' ? 2 : 1 // -o NAME / -O NAME
  }
  return hasCommandFlag ? (args[i] ?? null) : null
}

/** `env -S "git push"` runs the string as a command line: returns that line (string plus the remaining words), else null. */
function envSplitString(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = at(args, i)
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) return null
    if (arg === '--split-string') return args.slice(i + 1).join(' ')
    if (arg.startsWith('--split-string=')) return [arg.slice('--split-string='.length), ...args.slice(i + 1)].join(' ')
    if (!arg.startsWith('--')) {
      const letter = arg.indexOf('S')
      if (letter > 0) return [arg.slice(letter + 1), ...args.slice(i + 1)].join(' ')
      if (arg === '-u' || arg === '-C' || arg === '-a') i++ // takes the next word
    }
  }
  return null
}

function isRecursiveForceRm(args: readonly string[]): boolean {
  let recursive = false
  let force = false
  for (const arg of args) {
    const cluster = shortCluster(arg)
    if (cluster !== '') {
      if (/[rR]/.test(cluster)) recursive = true
      if (cluster.includes('f')) force = true
    } else {
      if (isLongOption(arg, 'recursive')) recursive = true
      if (isLongOption(arg, 'force')) force = true
    }
  }
  return recursive && force
}

type GitCall = {
  globals: string[]
  sub: string | null
  rest: string[]
  /** A word before the subcommand started with an expansion and was skipped: what git really sees is unknown. */
  skippedExpansion: boolean
}

/** The subcommand of a git command line and the words after it, with git's global options skipped. */
function parseGit(args: readonly string[]): GitCall {
  const globals: string[] = []
  let skippedExpansion = false
  let i = 0
  while (i < args.length) {
    const arg = at(args, i)
    if (startsWithExpansion(arg)) {
      skippedExpansion = true // may expand to nothing or to an option
      i++
      continue
    }
    if (!arg.startsWith('-')) return { globals, sub: arg, rest: args.slice(i + 1), skippedExpansion }
    if (arg === '--') break
    globals.push(arg)
    const takesValue =
      arg === '-C' ||
      arg === '-c' ||
      ['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source'].includes(arg)
    i += takesValue ? 2 : 1
  }
  return { globals, sub: null, rest: [], skippedExpansion }
}

function inspectGit(args: readonly string[], facts: Facts): void {
  const { sub, rest } = parseGit(args)
  if (sub === null) return
  if (sub === 'push') facts.destructive = true
  else if (sub === 'reset' && rest.some((arg) => isLongOption(arg, 'hard'))) facts.destructive = true
  else if (sub === 'clean' && rest.some((arg) => /[fdxX]/.test(shortCluster(arg)) || isLongOption(arg, 'force'))) facts.destructive = true
  else if ((sub === 'checkout' || sub === 'restore') && rest.some((arg) => WHOLE_TREE_PATHSPECS.has(arg))) facts.destructive = true
  else if (NETWORK_GIT_SUBCOMMANDS.has(sub)) facts.network = true
  else if ((sub === 'submodule' || sub === 'remote') && firstPositional(rest) === 'update') facts.network = true
}

function inspectFind(args: readonly string[], depth: number, facts: Facts): void {
  if (args.includes('-delete')) facts.destructive = true
  // `find -exec <command> ;` runs a command like xargs does.
  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXEC_OPTIONS.has(at(args, i))) continue
    let end = i + 1
    while (end < args.length && at(args, end) !== ';' && at(args, end) !== '+') end++
    inspectSegment(args.slice(i + 1, end), depth, facts)
    i = end
  }
}

function inspectProgram(program: string, args: readonly string[], depth: number, facts: Facts): void {
  if (NETWORK_PROGRAMS.includes(program)) facts.network = true
  if (program.startsWith('mkfs') || program === 'shred') facts.destructive = true
  switch (program) {
    case 'git':
      inspectGit(args, facts)
      break
    case 'rm':
      if (isRecursiveForceRm(args)) facts.destructive = true
      break
    case 'find':
      inspectFind(args, depth, facts)
      break
    case 'dd':
      if (args.some((arg) => arg.startsWith('of='))) facts.destructive = true
      break
  }
}

/** Unwraps one simple command and records what it can do in `facts`. */
function inspectSegment(words: readonly string[], depth: number, facts: Facts): void {
  if (words.some((word) => EWM_MENTION.test(word))) facts.mentionsEwm = true
  let argv: readonly string[] = words
  for (let hop = 0; hop < MAX_UNWRAP_HOPS; hop++) {
    argv = skipPrefixes(argv)
    if (argv.length === 0) return
    // Lower-cased: on a case-insensitive filesystem `GIT push` runs git. Cut at an expansion: `curl$X` may run curl.
    const head = at(argv, 0)
    const expansion = head.search(/[$`]/)
    const program = baseName(expansion < 0 ? head : head.slice(0, expansion)).toLowerCase()
    const args = argv.slice(1)
    if (program === 'sudo' || program === 'doas') {
      facts.destructive = true
      return
    }
    const wrapper = WRAPPERS.get(program)
    if (wrapper !== undefined) {
      const commandLine = program === 'env' ? envSplitString(args) : null
      if (commandLine !== null) {
        inspectSource(commandLine, depth + 1, facts)
        return
      }
      argv = args.slice(skipOptions(args, wrapper) + wrapper.positionals)
      continue
    }
    if (SHELLS.has(program)) {
      const payload = shellPayload(args)
      if (payload !== null) inspectSource(payload, depth + 1, facts)
      return
    }
    if (program === 'eval') {
      inspectSource(args.join(' '), depth + 1, facts)
      return
    }
    inspectProgram(program, args, depth, facts)
    return
  }
}

/** Scans a command string and inspects every command in it (and in its heredoc bodies). Null when it nests too deep to follow. */
function inspectSource(src: string, depth: number, facts: Facts): Scan | null {
  if (depth > MAX_SHELL_DEPTH) return null
  const scan = scanCommand(src)
  if (scan === null) return null
  for (const segment of scan.segments) inspectSegment(segment, depth, facts)
  for (const line of scan.heredocLines) inspectSource(line, depth + 1, facts)
  return scan
}

// ---------------------------------------------------------------------------
// Read-only allowlist
// ---------------------------------------------------------------------------

type ArgRule = (args: readonly string[]) => boolean

const anyArgs: ArgRule = () => true

/** Programs that cannot write, execute or send anything whatever their arguments. */
const UNRESTRICTED_READ_ONLY = [
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'stat', 'du', 'df', 'which', 'type', 'basename', 'dirname', 'realpath',
  'readlink', 'cut', 'tr', 'diff', 'cmp', 'comm', 'nl', 'column', 'true', 'false', 'test', 'grep', 'egrep', 'fgrep', 'jq',
]

const FIND_UNSAFE_PREFIXES = ['-exec', '-ok', '-delete', '-fprint', '-fls']
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'grep', 'rev-parse', 'describe', 'shortlog', 'cat-file',
])
const GIT_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'])
/** Global options a read-only git command may carry. Everything else (-c, --git-dir, --exec-path, ...) can redirect git or run programs. */
const GIT_SAFE_GLOBALS = new Set(['--no-pager', '-P', '--no-optional-locks', '-C'])
const GIT_CONFIG_READ_ACTIONS = new Set(['--get', '--get-all', '--list'])
const GIT_CONFIG_READ_FLAGS = new Set([
  ...GIT_CONFIG_READ_ACTIONS,
  '--local', '--global', '--system', '--show-origin', '--show-scope', '--name-only', '--null', '-z',
])
/** Long options that write a file or run a program, for any git subcommand. */
const GIT_UNSAFE_LONG_OPTIONS = ['output', 'open-files-in-pager', 'ext-diff', 'textconv', 'exec', 'upload-pack']
const UNIQ_OPTIONS: OptionSpec = { ...NO_OPTION_ARGS, shortArg: 'fsw', longArg: ['skip-fields', 'skip-chars', 'check-chars'] }

function isUnsafeGitOption(arg: string): boolean {
  return shortCluster(arg).includes('O') || GIT_UNSAFE_LONG_OPTIONS.some((name) => isLongOption(arg, name))
}

function isReadOnlyGitConfig(rest: readonly string[]): boolean {
  const flags = rest.filter((arg) => arg.startsWith('-'))
  const positionals = rest.length - flags.length
  if (!flags.every((flag) => GIT_CONFIG_READ_FLAGS.has(flag))) return false
  if (!flags.some((flag) => GIT_CONFIG_READ_ACTIONS.has(flag))) return false
  return flags.includes('--list') ? positionals === 0 : positionals <= 2
}

const isReadOnlyGit: ArgRule = (args) => {
  const { globals, sub, rest, skippedExpansion } = parseGit(args)
  if (sub === null || skippedExpansion || !globals.every((global) => GIT_SAFE_GLOBALS.has(global))) return false
  if (rest.some(isUnsafeGitOption)) return false
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true
  switch (sub) {
    case 'branch':
      return rest.every((arg) => GIT_BRANCH_FLAGS.has(arg))
    case 'remote':
      return rest.length === 0 || (rest.length === 1 && at(rest, 0) === '-v')
    case 'tag':
      return rest.length === 0 || (rest.length === 1 && (at(rest, 0) === '-l' || at(rest, 0) === '--list'))
    case 'config':
      return isReadOnlyGitConfig(rest)
    default:
      return false
  }
}

const READ_ONLY_PROGRAMS = new Map<string, ArgRule>([
  ...UNRESTRICTED_READ_ONLY.map((name): [string, ArgRule] => [name, anyArgs]),
  ['rg', (args) => !args.some((arg) => isLongOption(arg, 'pre') || isLongOption(arg, 'hostname-bin'))],
  ['find', (args) => !args.some((arg) => FIND_UNSAFE_PREFIXES.some((prefix) => arg.startsWith(prefix)))],
  ['tree', (args) => !args.some((arg) => shortCluster(arg).includes('o') || isLongOption(arg, 'output'))],
  ['file', (args) => !args.some((arg) => shortCluster(arg).includes('C') || isLongOption(arg, 'compile'))],
  [
    'sort',
    (args) => !args.some((arg) => shortCluster(arg).includes('o') || isLongOption(arg, 'output') || isLongOption(arg, 'compress-program')),
  ],
  ['uniq', (args) => countPositionals(args, UNIQ_OPTIONS) <= 1], // a second positional is the output file
  ['git', isReadOnlyGit],
])

/** Programs whose read-only status rests on denying some options: a glob must not be able to supply one (`rg foo *` with a file named `--pre=x`). */
const OPTION_SENSITIVE_PROGRAMS = new Set(['rg', 'find', 'tree', 'file', 'sort', 'uniq', 'git'])

/** One simple command, exactly as written (no unwrapping): a bare allowlisted program name whose arguments pass its rule. */
function isReadOnlySegment(words: readonly string[], leadingGlob: boolean): boolean {
  // Looked up by exact name: a path (`./ls`, `/tmp/x/cat`) may be anything and is never trusted.
  const program = at(words, 0)
  const rule = READ_ONLY_PROGRAMS.get(program)
  if (rule === undefined || (leadingGlob && OPTION_SENSITIVE_PROGRAMS.has(program))) return false
  return rule(words.slice(1))
}

// ---------------------------------------------------------------------------
// Validation commands
// ---------------------------------------------------------------------------

// Shell metacharacters, control characters and grouping: a validation command is plain words.
const VALIDATION_FORBIDDEN = /[|&;<>$`\\'"()\u0000-\u0008\u000a-\u001f\u007f]/

function normalizeSpaces(text: string): string {
  return text.trim().replace(/[ \t]+/g, ' ')
}

function matchesValidationCommand(command: string, profile: Profile): boolean {
  if (VALIDATION_FORBIDDEN.test(command)) return false
  const normalized = normalizeSpaces(command)
  return profile.validation.commands.some((allowed) => {
    const expected = normalizeSpaces(allowed)
    return expected !== '' && (normalized === expected || normalized.startsWith(expected + ' '))
  })
}

// ---------------------------------------------------------------------------
// classifyBash
// ---------------------------------------------------------------------------

export type BashClass = 'read_only' | 'validation' | 'destructive' | 'network' | 'other'

type BashAnalysis = { cls: BashClass; mentionsEwm: boolean }

function analyzeBash(command: string, profile: Profile): BashAnalysis {
  const facts: Facts = { destructive: false, network: false, mentionsEwm: EWM_MENTION.test(command) }
  const scan = inspectSource(command, 0, facts)
  const result = (cls: BashClass): BashAnalysis => ({ cls, mentionsEwm: facts.mentionsEwm })
  if (scan === null) return result('other')
  if (facts.destructive) return result('destructive')
  if (facts.network) return result('network')
  const everyCommandReadOnly =
    scan.segments.length > 0 && scan.segments.every((segment) => isReadOnlySegment(segment, scan.leadingGlob))
  if (!scan.opaque && everyCommandReadOnly) return result('read_only')
  if (matchesValidationCommand(command, profile)) return result('validation')
  return result('other')
}

/** Classifies a shell command string. Precedence: 'destructive' > 'network' > 'read_only' > 'validation' > 'other'.
 *  'read_only' needs every command allowlisted and no expansion, substitution, brace expansion, subshell, env assignment,
 *  wrapper or redirection (other than `2>/dev/null` and `2>&1`); anything the parser is unsure about is 'other'. */
export function classifyBash(command: string, profile: Profile): BashClass {
  return analyzeBash(command, profile).cls
}

// ---------------------------------------------------------------------------
// evaluateToolCall
// ---------------------------------------------------------------------------

export type PolicyContext = {
  /** Phase of the active task, or null when there is none. */
  phase: Phase | null
  profile: Profile
  /** Absolute pinned workspace root. */
  root: string
  /** Agent type of the calling loop when it is a subagent (from $.agent.list() by agentId), else null for the main loop. */
  agentType: string | null
}

export type PolicyCall = {
  tool: string
  input: Record<string, unknown>
  /** For WRITE_TOOLS: the absolute real path the call would write (resolved by the mod with $.fs.stat realPath, or the parent's realPath + name for a new file);
   *  undefined when it could not be resolved (then the raw file_path/notebook_path is checked, and an unresolvable path counts as inside .ewm -> deny). */
  resolvedPath?: string
}

const PAUSE_HINT = '/ewm pause to work outside the workflow'
const EWM_SEGMENT = /(?:^|\/)\.ewm(?:\/|$)/i
/** Tools that read-only agents may not use even though the lead may. */
const NOT_FOR_READONLY_AGENTS: readonly string[] = ['Skill', 'Agent', 'Task']

function allow(): ToolVerdict {
  return { allow: true }
}

function deny(reason: string): ToolVerdict {
  return { allow: false, reason }
}

function isShellTool(tool: string): boolean {
  return tool === 'Bash' || tool === 'Monitor'
}

function hasEwmSegment(path: string): boolean {
  return EWM_SEGMENT.test(path.replace(/\\/g, '/'))
}

/** Whether a write tool targets the workflow's own state. Both the resolved path and the raw one are checked, so a
 *  symlinked .ewm or a root that is itself a symlink cannot hide it; without any usable path the target counts as inside. */
function writesWorkflowState(call: PolicyCall): { protectedTarget: boolean; target: string } {
  const rawPath = call.input.file_path ?? call.input.notebook_path
  const raw = typeof rawPath === 'string' && rawPath !== '' ? rawPath : null
  const resolved = typeof call.resolvedPath === 'string' && call.resolvedPath !== '' ? call.resolvedPath : null
  if (resolved === null && raw === null) return { protectedTarget: true, target: '(unresolved path)' }
  const protectedTarget = (resolved !== null && hasEwmSegment(resolved)) || (raw !== null && hasEwmSegment(raw))
  return { protectedTarget, target: resolved ?? raw ?? '' }
}

function mcpToolAllowed(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern))
}

/** Rule 2: read-only agents read, search and report; they never write, delegate or call the mod's recording tools (D7). */
function evaluateReadOnlyAgent(call: PolicyCall, phase: Phase, agentType: string, command: BashAnalysis | null): ToolVerdict {
  const { tool } = call
  if (command !== null) {
    if (command.cls === 'read_only' && !(tool === 'Monitor' && call.input.ws)) return allow()
    return deny(
      `ewm: ${tool} is limited to read-only commands for ${agentType} in ${phase} (read-only agent rule). Use Read, Grep or Glob, a read-only command (ls, cat, rg, git status/log/diff), or return what you found to the lead.`,
    )
  }
  if (SAFE_TOOLS.includes(tool) && !NOT_FOR_READONLY_AGENTS.includes(tool)) return allow()
  if (READONLY_OWN_TOOLS.includes(tool)) return allow()
  return deny(
    `ewm: ${tool} is denied for ${agentType} in ${phase} (read-only agent rule): scouts and reviewers may only read, search and call ${READONLY_OWN_TOOLS.join(', ')}. Return what you found to the lead, who records it.`,
  )
}

function isEwmCommandSkill(input: Record<string, unknown>): boolean {
  const name = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '').toLowerCase() : ''
  return name === 'ewm' || name === 'ewm:ewm'
}

function describeWriteDenial(tool: string, phase: Phase, allowWriteInExplore: boolean): string {
  if (phase === 'EXPLORE' && !allowWriteInExplore) {
    return `ewm: ${tool} is denied in EXPLORE (rule: repository writes start in IMPLEMENT). Get the plan approved (ask the person to run /ewm approve), set policies.allow_write_in_explore in .ewm/project.yaml and run /ewm resume, or ${PAUSE_HINT}.`
  }
  if (phase === 'VALIDATE') {
    return `ewm: ${tool} is denied in VALIDATE (rule: repository writes happen only in IMPLEMENT). Go back with mcp__ewm__advance to IMPLEMENT to change files, or ${PAUSE_HINT}.`
  }
  return `ewm: ${tool} is denied in ${phase} (rule: repository writes happen only in IMPLEMENT). Get the plan approved (ask the person to run /ewm approve), or ${PAUSE_HINT}.`
}

/** The verdict for one tool call. Matrix (first match wins):
 *  1 inert (no task, PAUSED, DONE); 2 read-only agents; 3 own tools; 4 always-denied tools; 5 the /ewm skill;
 *  6 writes to .ewm/; 7 Bash/Monitor (destructive, network, .ewm); 8 outbound and third-party MCP tools;
 *  9 IMPLEMENT allows the rest; 10 the other phases allow only SAFE_TOOLS, allowed MCP tools and read-only commands. */
export function evaluateToolCall(ctx: PolicyContext, call: PolicyCall): ToolVerdict {
  const { phase, profile, root, agentType } = ctx
  const { tool, input } = call

  // 1. Inert outside a running task (D8).
  if (phase === null || phase === 'PAUSED' || phase === 'DONE') return allow()

  const command =
    isShellTool(tool) ? analyzeBash(typeof input.command === 'string' ? input.command : '', profile) : null

  // 2. Read-only agents (D7).
  if (agentType !== null && READONLY_AGENT_TYPES.includes(agentType)) {
    return evaluateReadOnlyAgent(call, phase, agentType, command)
  }

  // 3. The mod's own tools enforce their own rules.
  if (tool.startsWith(OWN_TOOL_PREFIX)) return allow()

  // 4. Tools that move the session away from the pinned root (D15, D16).
  if (ALWAYS_DENIED_TOOLS.includes(tool)) {
    return deny(
      `ewm: ${tool} is denied in ${phase} (rule: it would move the session away from the workspace root the workflow is pinned to). Stay in the current directory, or ${PAUSE_HINT}.`,
    )
  }

  // 5. The model must not run /ewm commands (approvals are human, D2, D13).
  if (tool === 'Skill' && isEwmCommandSkill(input)) {
    return deny(
      `ewm: ${tool} cannot run the /ewm command in ${phase} (rule: only the person runs /ewm commands). Ask the person to run it, or use the mcp__ewm__* tools and the ewm:<stage> skills.`,
    )
  }

  // 6. Workflow state is written only through the mod's tools (D14).
  if (WRITE_TOOLS.includes(tool)) {
    const target = writesWorkflowState(call)
    if (target.protectedTarget) {
      return deny(
        `ewm: ${tool} cannot write ${target.target} in ${phase} (rule: ${root}/.ewm/ holds the workflow state and is protected). Change task state with the mcp__ewm__* tools, or ${PAUSE_HINT}.`,
      )
    }
  }

  // 7. Shell commands.
  if (command !== null) {
    if (tool === 'Monitor' && input.ws) {
      return deny(
        `ewm: Monitor with ws opens a network connection and is denied in ${phase} (rule: Monitor is classified like Bash and websockets are outbound). Use a read-only command instead, or ${PAUSE_HINT}.`,
      )
    }
    if (command.cls === 'destructive') {
      return deny(
        `ewm: ${tool} command is destructive and denied in ${phase} (rule: git push, git reset --hard, git clean, git checkout ., rm -rf, find -delete, sudo and similar never run during a task). Ask the person to run it themselves, or ${PAUSE_HINT}.`,
      )
    }
    if (command.cls === 'network' && profile.policies.external_network !== 'allow') {
      return deny(
        `ewm: ${tool} command uses the network and is denied in ${phase} (rule: policies.external_network is deny_by_default). Set policies.external_network: allow in .ewm/project.yaml and run /ewm resume, or ${PAUSE_HINT}.`,
      )
    }
    if (command.mentionsEwm && command.cls !== 'read_only') {
      return deny(
        `ewm: ${tool} command mentions .ewm and is not read-only, so it is denied in ${phase} (rule: ${root}/.ewm/ holds the workflow state and is protected). Change task state with the mcp__ewm__* tools, or ${PAUSE_HINT}.`,
      )
    }
  }

  // 8. Network-facing tools (D6).
  if (profile.policies.external_network !== 'allow') {
    if (OUTBOUND_TOOLS.includes(tool)) {
      return deny(
        `ewm: ${tool} sends data outside the machine and is denied in ${phase} (rule: policies.external_network is deny_by_default). Set policies.external_network: allow in .ewm/project.yaml and run /ewm resume, or ${PAUSE_HINT}.`,
      )
    }
    if (tool.startsWith('mcp__')) {
      if (!mcpToolAllowed(tool, profile.policies.allowed_mcp_tools)) {
        return deny(
          `ewm: ${tool} is a third-party MCP tool and is denied in ${phase} (rule: policies.external_network is deny_by_default). Add it to policies.allowed_mcp_tools in .ewm/project.yaml and run /ewm resume, or ${PAUSE_HINT}.`,
        )
      }
    }
  }

  // 9. IMPLEMENT: Claude Code's own permissions still apply.
  if (phase === 'IMPLEMENT') return allow()

  // 10. The other phases are an allowlist (F2, D4). An mcp__ tool that got here passed rule 8.
  if (SAFE_TOOLS.includes(tool) || tool.startsWith('mcp__')) return allow()
  if (WRITE_TOOLS.includes(tool)) {
    if (phase === 'EXPLORE' && profile.policies.allow_write_in_explore) return allow()
    return deny(describeWriteDenial(tool, phase, profile.policies.allow_write_in_explore))
  }
  if (command !== null) {
    if (command.cls === 'read_only' || (phase === 'VALIDATE' && command.cls === 'validation')) return allow()
    const validateHint =
      phase === 'VALIDATE' ? " Run the profile's validation commands with mcp__ewm__run_validation." : ''
    return deny(
      `ewm: ${tool} command is not read-only and is denied in ${phase} (rule: only read-only commands run before IMPLEMENT).${validateHint} Use Read, Grep or Glob, a read-only command (ls, cat, rg, git status/log/diff; quote globs such as '*.ts'), or ${PAUSE_HINT}.`,
    )
  }
  return deny(
    `ewm: ${tool} is not allowed in ${phase} (rule: tools not on the allowlist are denied before IMPLEMENT). Use an allowed tool, move on to IMPLEMENT once the plan is approved (ask the person to run /ewm approve), or ${PAUSE_HINT}.`,
  )
}
