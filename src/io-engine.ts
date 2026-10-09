// Adapts the Claude Code hooks environment's `$` to the Io port the services use.

import type { Io } from './types.ts'

/**
 * The part of the engine's `$` the adapter uses, spelled out structurally so this file also
 * type-checks under plain Node (where the 'claude-code' declarations are not loaded).
 * The hooks module cannot pass `$` itself across an import (the engine refuses such a module):
 * it builds this object from wrappers written as `$.noun.event(...)`.
 */
export type EngineIoSource = {
  fs: {
    read(path: string): Promise<string | { base64: string }>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    list(path?: string): Promise<readonly { name: string; kind: 'file' | 'dir' | 'other' }[]>
  }
  process: {
    run(
      argv: readonly string[],
      init?: { cwd?: string; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
  clock: { now(): Promise<number> }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
}

/** Adapts the engine's `$` (as an EngineIoSource) to Io. Every call goes through `$`, so the engine's hooks and permissions apply to it. */
export function engineIo($: EngineIoSource): Io {
  return {
    async readText(path) {
      const content = await $.fs.read(path)
      if (typeof content !== 'string') throw new Error(`ewm: expected text from ${path}`)
      return content
    },
    writeText: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    async list(path) {
      const entries = await $.fs.list(path)
      return entries.map(({ name, kind }) => ({ name, kind }))
    },
    async run(argv, opts) {
      const { exitCode, stdout, stderr } = await $.process.run(argv, {
        ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      })
      return { exitCode, stdout, stderr }
    },
    now: () => $.clock.now(),
    kvGet: key => $.store.get(key),
    kvSet: (key, value) => $.store.set(key, value),
  }
}
