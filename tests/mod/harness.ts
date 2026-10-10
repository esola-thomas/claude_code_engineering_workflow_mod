// Test harness for the ewm mod: answers every `$` call the mod makes from a MemoryIo,
// so tests run the real hooks module against the real engine, offline.
//
// Usage: build the harness first (it registers hooks on `on`), add any hooks of the test's own,
// then `await harness.start()`; the first call on `$` loads the plugin.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import type { Ledger, PaneModel as PaneView, Task } from '../../src/types.ts'
import { createMemoryIo, fakeGit, normalizePath } from '../support/memory-io.ts'
import type { MemoryIo } from '../support/memory-io.ts'

export const ROOT = '/repo'
export const TASK_DIR = `${ROOT}/.ewm/tasks/TASK-001`
export const SOURCE_FILE = `${ROOT}/src/a.ts`
export const AT_MS = Date.UTC(2026, 9, 9, 17, 0, 0)

export type Harness = {
  io: MemoryIo
  clock: MockClock
  /** Tool names that reached the bottom of tool.call (the engine's own tool runner), in order. */
  reached: string[]
  /** Prompts that reached prompt.submit. */
  submitted: string[]
  /** Status line texts, in order (undefined = cleared). */
  statuses: (string | undefined)[]
  /** isDeferred of each registered tool, by short name. */
  tools: Map<string, boolean | undefined>
  /** Slash commands registered. */
  commands: string[]
  /** Paths read or stat'ed through $.fs since the last reset. */
  fsTouched: string[]
  /** Ids of the panes the mod opened. */
  opened: string[]
  /** The last value the mod wrote to each $.state key, as 'ewm.view'. */
  state: Map<string, unknown>
  /** The pane view the mod last published, or undefined before the first write. */
  view(): PaneView | null | undefined
  /** What $.agent.list() answers. */
  agents: AgentInfo[]
  /** Fires session.start with the repo root as cwd. */
  start(): Promise<void>
  /** Runs `/ewm <args>` as typed in the composer (or another origin). */
  ewm(args: string, origin?: { kind: 'composer' | 'bridge' | 'sdk' | 'scheduled-trigger' | 'task-notification' } | { kind: 'plugin'; name: string }): Promise<{ text?: string; context?: readonly string[] }>
  /** Spawns a subagent through the engine (`$.agent.spawn`); the kit fills in the fields the engine stamps. */
  spawn(input: { subagentType: string; prompt: string; description: string; model?: string }): Promise<{ model?: string; agentId?: string; deny?: string }>
  /** Raises a tool call as a subagent's loop would (the event carries its agentId). */
  callAs(agentId: string, input: { tool: string } & Record<string, unknown>): Promise<{ deny?: string; text?: string }>
  /** Calls an mcp__ewm__ tool. */
  tool(name: string, input?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  task(): Task
  /** The gate ledger the mod keeps in $.store. */
  ledger(): Ledger
  /** Moves the task through the phases with the model's own `advance` tool (UNDERSTAND > PLAN goes through `/ewm plan`, as only the person may do it). */
  advanceTo(...phases: string[]): Promise<void>
}

export type HarnessOptions = {
  files?: Record<string, string>
  /** Answer $.ui.open as a pane that waits undrawn (a narrow terminal). */
  isPaneUnplaced?: boolean
}

export const SOURCE_TEXT = ['export function sum(a: number, b: number) {', '  return a - b', '}', '', 'export const ZERO = 0', ''].join('\n')

export function createHarness($: Engine, on: On, options: HarnessOptions = {}): Harness {
  const io = createMemoryIo(
    { [SOURCE_FILE]: SOURCE_TEXT, [`${ROOT}/README.md`]: '# repo\n', ...(options.files ?? {}) },
    AT_MS,
  )
  io.onRun(fakeGit({ branch: 'main', commit: 'abc1234' }))
  const clock = mock.clock(on, { now: AT_MS })

  const reached: string[] = []
  const submitted: string[] = []
  const statuses: (string | undefined)[] = []
  const tools = new Map<string, boolean | undefined>()
  const commands: string[] = []
  const fsTouched: string[] = []
  const agents: AgentInfo[] = []
  const state = new Map<string, unknown>()
  const opened: string[] = []

  const key = (path: string): string => normalizePath(path)

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // The test kit keeps $.state itself; this only watches what the mod writes.
  on('state.set', (_$, e, next) => {
    state.set(`${e.plugin}.${e.key}`, e.value)
    return next(e)
  })
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    tools.set(e.name, e.isDeferred)
    return { value: { tool: `mcp__ewm__${e.name}` } }
  })
  on('agent.list', () => ({ value: agents }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: options.isPaneUnplaced === true ? { isPlaced: false as const, reason: 'no room for a pane' } : { isPlaced: true as const } }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('process.run', async (_$, e) => {
    const result = await io.run(e.argv, e.init)
    return { value: { ...result, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // $.store is answered from io.kv, so tests can read the ledger back (mock.store keeps its entries to itself).
  on('store.get', async (_$, e) => ({ value: await io.kvGet(e.key) }))
  on('store.set', async (_$, e) => {
    await io.kvSet(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    io.kv.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...io.kv.keys()] }))

  on('fs.read', async (_$, e) => {
    fsTouched.push(key(e.path))
    try {
      return { value: await io.readText(e.path) }
    } catch (error) {
      return { deny: String(error) }
    }
  })
  on('fs.write', async (_$, e) => {
    await io.writeText(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: await io.exists(e.path) }))
  on('fs.list', async (_$, e) => {
    try {
      const entries = await io.list(e.path)
      return { value: entries.map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })) }
    } catch (error) {
      return { deny: String(error) }
    }
  })
  on('fs.stat', async (_$, e) => {
    const path = key(e.path)
    fsTouched.push(path)
    const text = io.files.get(path)
    if (text !== undefined) {
      return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
    }
    if (await io.exists(path)) {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
    }
    return { deny: `ENOENT: no such file or directory, stat '${path}'` }
  })

  // The bottom of tool.call stands for the engine running the tool.
  on('tool.call', (_$, e) => {
    reached.push(String(e.tool))
    return { result: 'ran', text: 'ran' }
  })

  const harness: Harness = {
    io,
    clock,
    reached,
    submitted,
    statuses,
    tools,
    commands,
    fsTouched,
    agents,
    opened,
    state,
    view() {
      return state.get('ewm.view') as PaneView | null | undefined
    },
    async start() {
      await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
    },
    async ewm(args, origin = { kind: 'composer' }) {
      return $.command.run({ command: 'ewm', args, origin, presentation: { isFullscreen: false, columns: 80 } })
    },
    spawn(input) {
      return $.agent.spawn(input as never)
    },
    callAs(agentId, input) {
      return $.tool.call({ ...input, agentId } as never)
    },
    async tool(name, input = {}) {
      const result = await $.tool.call({ tool: `mcp__ewm__${name}`, ...input })
      if (result.deny !== undefined) return { text: result.deny, isError: true }
      return { text: result.text ?? '', isError: result.isError === true }
    },
    ledger() {
      return io.kv.get(`ledger:${ROOT}`) as Ledger
    },
    task() {
      const text = io.files.get(`${TASK_DIR}/task.json`)
      if (text === undefined) throw new Error('no task.json yet')
      return JSON.parse(text) as Task
    },
    async advanceTo(...phases) {
      for (const to of phases) {
        // CR10: UNDERSTAND > PLAN is the person's call, so it goes through /ewm plan.
        if (to === 'PLAN' && harness.task().phase === 'UNDERSTAND') {
          const planned = await harness.ewm('plan')
          if (!(planned.text ?? '').includes('UNDERSTAND > PLAN')) throw new Error(`/ewm plan failed: ${planned.text}`)
          continue
        }
        const out = await harness.tool('advance', { to, reason: `moving to ${to}` })
        if (out.isError) throw new Error(`advance to ${to} failed: ${out.text}`)
      }
    },
  }
  return harness
}
