// Project profile: a YAML-subset parser (the hooks environment has no YAML
// library), normalization onto DEFAULT_PROFILE, and loading from <root>/.ewm.

import { EwmError } from './types.ts'
import type { Io, Profile } from './types.ts'
import { EWM_DIR, joinPath } from './store.ts'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Frozen, so a stray mutation fails loudly instead of changing every session's defaults. */
export const DEFAULT_PROFILE: Profile = deepFreeze({
  profile_id: 'default',
  name: 'Default',
  repositories: ['.'],
  domains: [],
  entrypoints: ['README.md', 'docs/'],
  policies: {
    external_network: 'deny_by_default',
    require_plan_approval: true,
    allow_write_in_explore: false,
    allowed_mcp_tools: [],
    allowed_commands: { read_only: [], implement: [], validate: [] },
  },
  models: { lead: 'opus', search: 'haiku', reviewer: 'sonnet' },
  budgets: { max_parallel_researchers: 3, max_research_rounds_without_user_update: 2, max_findings_per_scout: 8 },
  validation: { commands: [], timeout_ms: 300000 },
})

// ---------------------------------------------------------------------------
// YAML subset
// ---------------------------------------------------------------------------

type SourceLine = { no: number; indent: number; text: string }

function fail(no: number, message: string): never {
  throw new EwmError('parse_error', `ewm: project.yaml line ${no}: ${message}`)
}

/** Drops blank and comment-only lines; rejects tab indentation; a leading `---` marker is ignored. */
function toSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((row, index) => {
      const no = index + 1
      const leading = /^[ \t]*/.exec(row)?.[0] ?? ''
      const content = row.slice(leading.length).trimEnd()
      if (content === '' || content.startsWith('#')) return
      if (leading.includes('\t')) fail(no, 'tab characters are not allowed for indentation; indent with spaces')
      if (content === '---' && lines.length === 0) return
      lines.push({ no, indent: leading.length, text: content })
    })
  return lines
}

function isListItem(text: string): boolean {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t')
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** Own-property assignment, so a key such as `__proto__` stays plain data. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

const SIMPLE_ESCAPES = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['0', '\0'],
  ['b', '\b'],
  ['f', '\f'],
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  [' ', ' '],
])

/** Reads the escape that starts at text[at] (a backslash) inside a double-quoted string. */
function readEscape(text: string, at: number, no: number): { char: string; next: number } {
  const code = text.charAt(at + 1)
  const simple = SIMPLE_ESCAPES.get(code)
  if (simple !== undefined) return { char: simple, next: at + 2 }
  const digits = code === 'x' ? 2 : code === 'u' ? 4 : 0
  const hex = text.slice(at + 2, at + 2 + digits)
  if (digits > 0 && hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
    return { char: String.fromCharCode(parseInt(hex, 16)), next: at + 2 + digits }
  }
  return fail(no, `unknown escape sequence "\\${code}" in a double-quoted string`)
}

/** Reads the quoted string that starts at text[start]; `end` is the index just past the closing quote. */
function readQuoted(text: string, start: number, no: number): { value: string; end: number } {
  const quote = text.charAt(start)
  let value = ''
  let i = start + 1
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === quote) {
      // '' is an escaped quote in single-quoted strings.
      if (quote === "'" && text.charAt(i + 1) === "'") {
        value += "'"
        i += 2
        continue
      }
      return { value, end: i + 1 }
    }
    if (quote === '"' && ch === '\\' && i + 1 < text.length) {
      const escape = readEscape(text, i, no)
      value += escape.char
      i = escape.next
      continue
    }
    value += ch
    i += 1
  }
  return fail(no, `unterminated ${quote === '"' ? 'double' : 'single'}-quoted string (quoted text must close on the same line)`)
}

function expectLineEnd(after: string, no: number): void {
  const rest = after.trim()
  if (rest !== '' && !rest.startsWith('#')) fail(no, `unexpected text after the closing quote or bracket: ${JSON.stringify(rest.slice(0, 40))}`)
}

function rejectUnsupportedStart(first: string, no: number): void {
  if (first === '{') fail(no, 'flow maps ("{...}") are not supported; use nested, indented keys')
  if (first === '|' || first === '>') fail(no, 'multi-line strings are not supported; put the text on one line')
  if (first === '&' || first === '*' || first === '!') {
    fail(no, `anchors, aliases and tags are not supported (put the text in quotes if "${first}" is literal)`)
  }
}

/** true/false, null/~, integers, floats, else the text itself. */
function resolveScalar(text: string): unknown {
  if (text === '~' || /^(null|Null|NULL)$/.test(text)) return null
  if (/^(true|True|TRUE)$/.test(text)) return true
  if (/^(false|False|FALSE)$/.test(text)) return false
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) {
    const number = Number(text)
    // Integers beyond 2^53 would lose digits; keep them as text.
    return /^[-+]?\d+$/.test(text) && !Number.isSafeInteger(number) ? text : number
  }
  return text
}

function skipSpaces(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1
  return i
}

/** Parses `[a, "b, c", 3]` (single line, no nesting). `text` starts at the opening bracket. */
function parseFlowList(text: string, no: number): unknown[] {
  const unterminated = 'unterminated flow list: close it with "]" on the same line, or use a block list ("- item" lines)'
  const items: unknown[] = []
  let i = 1
  for (;;) {
    i = skipSpaces(text, i)
    if (i >= text.length) fail(no, unterminated)
    const first = text.charAt(i)
    if (first === ']') {
      i += 1
      break
    }
    if (first === '[') fail(no, 'nested flow lists are not supported')
    rejectUnsupportedStart(first, no)
    if (first === '"' || first === "'") {
      const quoted = readQuoted(text, i, no)
      items.push(quoted.value)
      i = quoted.end
    } else {
      let end = i
      while (end < text.length && text.charAt(end) !== ',' && text.charAt(end) !== ']') end += 1
      if (end >= text.length) fail(no, unterminated)
      const bare = text.slice(i, end).trim()
      if (bare === '') fail(no, 'empty item in a flow list')
      items.push(resolveScalar(bare))
      i = end
    }
    i = skipSpaces(text, i)
    if (i >= text.length) fail(no, unterminated)
    const separator = text.charAt(i)
    i += 1
    if (separator === ']') break
    if (separator !== ',') fail(no, 'expected "," or "]" after a flow list item')
  }
  expectLineEnd(text.slice(i), no)
  return items
}

/**
 * Parses the text after `key:` or `- `. Returns undefined when there is no inline value
 * (empty, or only a comment), meaning a nested block may follow.
 */
function parseInlineValue(text: string, no: number, inList: boolean): unknown {
  if (text === '' || text.startsWith('#')) return undefined
  const first = text.charAt(0)
  if (first === '"' || first === "'") {
    const quoted = readQuoted(text, 0, no)
    expectLineEnd(text.slice(quoted.end), no)
    return quoted.value
  }
  if (first === '[') return parseFlowList(text, no)
  rejectUnsupportedStart(first, no)
  // A '#' starts a comment only after whitespace.
  const comment = /\s#/.exec(text)
  const plain = (comment === null ? text : text.slice(0, comment.index)).trimEnd()
  if (inList && /:(\s|$)/.test(plain)) {
    fail(no, 'maps inside lists are not supported; put the item in quotes if the colon is literal')
  }
  return resolveScalar(plain)
}

/** Splits `key: rest` (the key may be quoted). The separator is the first colon followed by whitespace or the end of the line. */
function splitEntry(line: SourceLine): { key: string; rest: string } {
  const { text, no } = line
  const first = text.charAt(0)
  if (first === '"' || first === "'") {
    const quoted = readQuoted(text, 0, no)
    const after = text.slice(quoted.end).trimStart()
    if (after !== ':' && !/^:\s/.test(after)) fail(no, 'expected ":" after the quoted key')
    return { key: quoted.value, rest: after.slice(1).trim() }
  }
  const match = /^(.*?):(?:\s+(.*))?$/.exec(text)
  const key = match?.[1]?.trim() ?? ''
  if (match === null || /(^|\s)#/.test(key)) {
    fail(no, `expected "key: value" but found ${JSON.stringify(text.length > 40 ? text.slice(0, 40) + '...' : text)}`)
  }
  if (key === '') fail(no, 'missing key before ":"')
  return { key, rest: (match[2] ?? '').trim() }
}

/**
 * YAML subset: '#' comments (full-line and trailing; '#' inside quotes is kept), `key: scalar`, `key: [a, "b c", 3]` flow lists, block lists (`- item`),
 * nested maps by indentation (spaces only), scalars: single/double-quoted strings, true/false, null/~, integers, floats, bare strings.
 * No anchors, tags, multi-line strings, or flow maps. An empty document is null.
 * Throws EwmError('parse_error', 'ewm: project.yaml line N: ...').
 */
export function parseYamlSubset(text: string): unknown {
  const lines = toSourceLines(text)
  let index = 0

  const parseBlock = (indent: number, parentIndent: number): unknown => {
    const first = lines[index]
    return first !== undefined && isListItem(first.text) ? parseList(indent, parentIndent) : parseMapping(indent)
  }

  /** The value of `key:` with nothing after the colon: an indented block, a list at the key's own indent, or null. */
  const parseChild = (parent: SourceLine): unknown => {
    const next = lines[index]
    if (next === undefined) return null
    if (next.indent > parent.indent) return parseBlock(next.indent, parent.indent)
    if (next.indent === parent.indent && isListItem(next.text)) return parseList(parent.indent, parent.indent)
    return null
  }

  const parseMapping = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {}
    for (let line = lines[index]; line !== undefined && line.indent >= indent; line = lines[index]) {
      if (line.indent > indent) {
        fail(line.no, `inconsistent indentation: expected ${indent} spaces but found ${line.indent}`)
      }
      if (isListItem(line.text)) fail(line.no, 'found a list item ("- ...") where a "key: value" entry was expected')
      const { key, rest } = splitEntry(line)
      if (hasOwn(map, key)) fail(line.no, `duplicate key ${JSON.stringify(key)}`)
      index += 1
      const inline = parseInlineValue(rest, line.no, false)
      setOwn(map, key, inline === undefined ? parseChild(line) : inline)
    }
    return map
  }

  const parseList = (indent: number, parentIndent: number): unknown[] => {
    const items: unknown[] = []
    for (let line = lines[index]; line !== undefined && line.indent >= indent; line = lines[index]) {
      if (line.indent > indent) {
        fail(line.no, `inconsistent indentation: expected ${indent} spaces but found ${line.indent} (nested structures inside lists are not supported)`)
      }
      if (!isListItem(line.text)) {
        // A list at the same indent as its key ends where the next key starts; any other list must be followed by a dedent.
        if (indent > parentIndent) fail(line.no, 'found a "key: value" entry where a list item ("- ...") was expected')
        break
      }
      index += 1
      const inline = parseInlineValue(line.text.slice(1).trim(), line.no, true)
      items.push(inline === undefined ? null : inline)
    }
    return items
  }

  const first = lines[0]
  if (first === undefined) return null
  const document = parseBlock(first.indent, -1)
  const stray = lines[index]
  if (stray !== undefined) fail(stray.no, `inconsistent indentation: expected ${first.indent} spaces but found ${stray.indent}`)
  return document
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'a list'
  if (isRecord(value)) return 'a mapping'
  if (typeof value === 'string') return 'a string'
  if (typeof value === 'number') return 'a number'
  if (typeof value === 'boolean') return 'a boolean'
  return String(value)
}

type FieldType<T> = { expected: string; accepts: (value: unknown) => value is T }

const nonEmptyString: FieldType<string> = {
  expected: 'a non-empty string',
  accepts: (value): value is string => typeof value === 'string' && value.trim() !== '',
}
const boolean: FieldType<boolean> = {
  expected: 'true or false',
  accepts: (value): value is boolean => typeof value === 'boolean',
}
const positiveInteger: FieldType<number> = {
  expected: 'a positive integer',
  accepts: (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
}
const stringList: FieldType<string[]> = {
  expected: 'a list of strings (quote items that are not plain text)',
  accepts: (value): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string'),
}

function oneOf<T extends string>(...values: T[]): FieldType<T> {
  return {
    expected: `one of ${values.join(', ')}`,
    accepts: (value): value is T => typeof value === 'string' && (values as string[]).includes(value),
  }
}

/** A mapping being read field by field. Null/absent values are "unset" (default, no warning); every key never asked for is reported as unknown. */
type Scope = {
  field<T>(key: string, fallback: T, type: FieldType<T>): T
  strings(key: string, fallback: readonly string[]): string[]
  section(key: string): Scope
  /** Reports unknown keys of this scope and of its sections. */
  finish(): void
}

function openScope(raw: unknown, path: string, warnings: string[]): Scope {
  const label = (key: string): string => (path === '' ? key : `${path}.${key}`)
  let record: Record<string, unknown> = {}
  if (isRecord(raw)) record = raw
  else if (raw !== undefined && raw !== null) {
    warnings.push(`${path === '' ? 'profile' : path}: expected a mapping, got ${describe(raw)}; using the defaults`)
  }
  const asked = new Set<string>()
  const sections: Scope[] = []

  const scope: Scope = {
    field(key, fallback, type) {
      asked.add(key)
      const value = hasOwn(record, key) ? record[key] : undefined
      if (value === undefined || value === null) return fallback
      if (type.accepts(value)) return value
      warnings.push(`${label(key)}: expected ${type.expected}, got ${describe(value)}; using the default ${JSON.stringify(fallback)}`)
      return fallback
    },
    strings(key, fallback) {
      return [...scope.field<string[]>(key, [...fallback], stringList)]
    },
    section(key) {
      asked.add(key)
      const child = openScope(hasOwn(record, key) ? record[key] : undefined, label(key), warnings)
      sections.push(child)
      return child
    },
    finish() {
      for (const key of Object.keys(record)) if (!asked.has(key)) warnings.push(`${label(key)}: unknown field, ignored`)
      for (const child of sections) child.finish()
    },
  }
  return scope
}

/** Deep-merges raw over DEFAULT_PROFILE with type checks per field; wrong types or unknown enum values fall back to the default and add a warning naming the dotted field. Unknown keys warn, never error. */
export function normalizeProfile(raw: unknown): { profile: Profile; warnings: string[] } {
  const warnings: string[] = []
  const defaults = DEFAULT_PROFILE
  const top = openScope(raw, '', warnings)
  const policies = top.section('policies')
  const models = top.section('models')
  const budgets = top.section('budgets')
  const validation = top.section('validation')
  const allowedCommands = policies.section('allowed_commands')

  const profile: Profile = {
    profile_id: top.field('profile_id', defaults.profile_id, nonEmptyString),
    name: top.field('name', defaults.name, nonEmptyString),
    repositories: top.strings('repositories', defaults.repositories),
    domains: top.strings('domains', defaults.domains),
    entrypoints: top.strings('entrypoints', defaults.entrypoints),
    policies: {
      external_network: policies.field('external_network', defaults.policies.external_network, oneOf('deny_by_default', 'allow')),
      require_plan_approval: policies.field('require_plan_approval', defaults.policies.require_plan_approval, boolean),
      allow_write_in_explore: policies.field('allow_write_in_explore', defaults.policies.allow_write_in_explore, boolean),
      allowed_mcp_tools: policies.strings('allowed_mcp_tools', defaults.policies.allowed_mcp_tools),
      allowed_commands: {
        read_only: allowedCommands.strings('read_only', defaults.policies.allowed_commands.read_only),
        implement: allowedCommands.strings('implement', defaults.policies.allowed_commands.implement),
        validate: allowedCommands.strings('validate', defaults.policies.allowed_commands.validate),
      },
    },
    models: {
      lead: models.field('lead', defaults.models.lead, nonEmptyString),
      search: models.field('search', defaults.models.search, nonEmptyString),
      reviewer: models.field('reviewer', defaults.models.reviewer, nonEmptyString),
    },
    budgets: {
      max_parallel_researchers: budgets.field('max_parallel_researchers', defaults.budgets.max_parallel_researchers, positiveInteger),
      max_research_rounds_without_user_update: budgets.field(
        'max_research_rounds_without_user_update',
        defaults.budgets.max_research_rounds_without_user_update,
        positiveInteger,
      ),
      max_findings_per_scout: budgets.field('max_findings_per_scout', defaults.budgets.max_findings_per_scout, positiveInteger),
    },
    validation: {
      commands: validation.strings('commands', defaults.validation.commands),
      timeout_ms: validation.field('timeout_ms', defaults.validation.timeout_ms, positiveInteger),
    },
  }
  top.finish()
  return { profile, warnings }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function parseJsonProfile(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new EwmError('parse_error', `ewm: project.json is not valid JSON (${reason}). Fix the file, or delete it to use the default profile.`)
  }
}

/** In precedence order. */
const PROFILE_FILES = [
  { file: 'project.yaml', parse: parseYamlSubset },
  { file: 'project.json', parse: parseJsonProfile },
] as const

/** Reads <root>/.ewm/project.yaml, else project.json, else DEFAULT_PROFILE (source null). Parse errors throw. `source` is the workspace-relative path used. */
export async function loadProfile(io: Io, root: string): Promise<{ profile: Profile; source: string | null; warnings: string[] }> {
  for (const { file, parse } of PROFILE_FILES) {
    const path = joinPath(root, EWM_DIR, file)
    if (!(await io.exists(path))) continue
    let text: string
    try {
      text = await io.readText(path)
    } catch (cause) {
      throw new EwmError('io_error', `ewm: cannot read ${EWM_DIR}/${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const { profile, warnings } = normalizeProfile(parse(text))
    return { profile, source: `${EWM_DIR}/${file}`, warnings }
  }
  return { profile: normalizeProfile(undefined).profile, source: null, warnings: [] }
}
