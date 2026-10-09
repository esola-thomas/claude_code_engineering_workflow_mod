// In-memory implementation of the Io port for unit tests (node --test) and
// mod tests (claude plugin test). Pure TypeScript: no node:* imports.

import type { DirEntry, Io, RunResult } from '../../src/types.ts'

export type RunHandler = (argv: readonly string[], opts?: { cwd?: string; timeoutMs?: number }) => RunResult | Promise<RunResult>

export type MemoryIo = Io & {
  /** Current file contents by normalized path. */
  files: Map<string, string>
  /** The mod-private key-value store behind kvGet/kvSet. */
  kv: Map<string, unknown>
  /** Every argv passed to run(), in order. */
  runs: (readonly string[])[]
  /** Replace how run() answers (default: exit 127, "not found"). */
  onRun(handler: RunHandler): void
  /** Set the clock (ms since epoch). */
  setNow(ms: number): void
  /** Move the clock forward. */
  advance(ms: number): void
}

/** Normalize 'a//b/./c/' and './x' to 'a/b/c' and 'x'; keeps a leading '/' for absolute paths. */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return (isAbsolute ? '/' : '') + parts.join('/')
}

export function createMemoryIo(initial: Record<string, string> = {}, startMs = Date.UTC(2026, 9, 9, 17, 0, 0)): MemoryIo {
  const files = new Map<string, string>()
  for (const [path, text] of Object.entries(initial)) files.set(normalizePath(path), text)
  const runs: (readonly string[])[] = []
  const kv = new Map<string, unknown>()
  let now = startMs
  let handler: RunHandler = () => ({ exitCode: 127, stdout: '', stderr: 'command not found' })

  const isDir = (dir: string): boolean => {
    const prefix = dir === '' ? '' : dir + '/'
    for (const key of files.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  return {
    files,
    kv,
    runs,
    onRun(next) {
      handler = next
    },
    setNow(ms) {
      now = ms
    },
    advance(ms) {
      now += ms
    },
    async readText(path) {
      const key = normalizePath(path)
      const text = files.get(key)
      if (text === undefined) throw new Error(`ENOENT: no such file '${key}'`)
      return text
    },
    async writeText(path, text) {
      files.set(normalizePath(path), text)
    },
    async exists(path) {
      const key = normalizePath(path)
      return files.has(key) || isDir(key)
    },
    async list(path) {
      const dir = normalizePath(path)
      if (!isDir(dir)) throw new Error(`ENOENT: no such directory '${dir}'`)
      const prefix = dir === '' ? '' : dir + '/'
      const seen = new Map<string, DirEntry['kind']>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) seen.set(rest, 'file')
        else seen.set(rest.slice(0, slash), 'dir')
      }
      return [...seen].map(([name, kind]) => ({ name, kind }))
    },
    async run(argv, opts) {
      runs.push([...argv])
      return handler(argv, opts)
    },
    async now() {
      return now
    },
    async kvGet(key) {
      const value = kv.get(key)
      // Round-trip through JSON like $.store does, so callers cannot share references.
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    async kvSet(key, value) {
      kv.set(key, JSON.parse(JSON.stringify(value)))
    },
  }
}

/**
 * A run handler that answers git the way a clean repo at `commit` on `branch` would,
 * with `changed` listing paths reported by `git diff --name-only <x> HEAD`
 * and `dirty` listing paths reported by `git status --porcelain`.
 */
export function fakeGit(state: { branch: string; commit: string; changed?: string[]; dirty?: string[] }): RunHandler {
  return argv => {
    if (argv[0] !== 'git') return { exitCode: 127, stdout: '', stderr: 'command not found' }
    const sub = argv.slice(1).join(' ')
    if (sub === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: state.branch + '\n', stderr: '' }
    if (sub === 'rev-parse HEAD') return { exitCode: 0, stdout: state.commit + '\n', stderr: '' }
    if (sub.startsWith('diff --name-only')) return { exitCode: 0, stdout: (state.changed ?? []).join('\n') + '\n', stderr: '' }
    if (sub.startsWith('status --porcelain'))
      return { exitCode: 0, stdout: (state.dirty ?? []).map(p => ` M ${p}`).join('\n') + '\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}
