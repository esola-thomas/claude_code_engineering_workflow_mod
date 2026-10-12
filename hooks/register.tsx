// Wiring of the ewm mod: the /ewm command, the model tools, the policy guard,
// subagent routing, usage metering and the pane. All logic lives in ../src;
// this file only connects it to the engine's events.

import { update } from 'claude-code'
import type { EngineInterface, PluginState, Register } from 'claude-code'

import { parseCommand } from '../src/args.ts'
import { adjacencyLines, drawSvg, drawText, parseFlowchart, splitMermaid, undrawnNote } from '../src/graph.ts'
import type { NodeMark } from '../src/graph.ts'
import { engineIo } from '../src/io-engine.ts'
import type { EngineIoSource } from '../src/io-engine.ts'
import { evaluateToolCall, OWN_TOOL_PREFIX, WRITE_TOOLS } from '../src/policies.ts'
import type { PolicyCall } from '../src/policies.ts'
import { DEFAULT_PROFILE } from '../src/profile.ts'
import { AGENT_ROLES, routeModel } from '../src/router.ts'
import {
  activeContext,
  activeTaskId,
  currentView,
  recordAgentSpawn,
  recordDenial,
  recordUsage,
  runCommand,
  runTool,
  statusLine,
  TOOL_SPECS,
} from '../src/service.ts'
import type { Ctx } from '../src/service.ts'
import { joinPath } from '../src/store.ts'
import { EwmError, unprefixed } from '../src/types.ts'
import type { CommandOutput } from '../src/types.ts'

type View = PluginState['ewm']['view']
type Section = PluginState['ewm']['section']

// State references: `plugin` and `key` must be literals for $.state.
const VIEW = { plugin: 'ewm', key: 'view' } as const
const SECTION = { plugin: 'ewm', key: 'section' } as const
const NOTICE = { plugin: 'ewm', key: 'notice' } as const
const ROOT = { plugin: 'ewm', key: 'root' } as const

const PANE_ID = 'ewm'
const PANE_TITLE = 'Engineering Workflow'
const COMMAND_HINT = '<new|resume|status|map|questions|plan|pause|approve|reject|reset|list|help> [args]'

/** D13, D19: only a person (or the script that drives a headless run) may change workflow state. */
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

/** CR6: the /ewm commands that change state. status, map, questions, list and help are read-only and work from any origin. */
const STATE_CHANGING_COMMANDS: readonly string[] = ['new', 'resume', 'pause', 'plan', 'approve', 'reject', 'reset']

const GATE_LABELS: Record<string, string> = { plan_approval: 'plan approval', done_acceptance: 'done acceptance' }

// Module variables are caches only; a hot reload resets them and everything is re-read from $.state or the ledger.
let pinnedRoot: string | null = null
let toolsDeferred: boolean | null = null

/** Runs a side effect whose failure must never break the event that triggered it. */
async function safely(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // The text the person or model reads already carries the outcome; a failed refresh is invisible by design.
  }
}

/** The pinned workspace root (D16), or null before session.start has run. */
async function rootOf($: EngineInterface): Promise<string | null> {
  if (pinnedRoot !== null) return pinnedRoot
  const { value } = await $.state.get(ROOT)
  pinnedRoot = value ?? null
  return pinnedRoot
}

/**
 * The engine refuses a module that hands `$` to a function imported from another file, so the
 * adapter of src/io-engine.ts receives these thin wrappers, each spelled as `$.noun.event(...)`.
 */
function ioSource($: EngineInterface): EngineIoSource {
  return {
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    clock: { now: () => $.clock.now() },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
  }
}

async function ctxOf($: EngineInterface): Promise<Ctx | null> {
  const root = await rootOf($)
  return root === null ? null : { io: engineIo(ioSource($)), root }
}

/** (Re-)declares the model tools. They are deferred behind ToolSearch unless a task is running (D8). */
async function syncTools($: EngineInterface, isRunning: boolean, force = false): Promise<void> {
  const isDeferred = !isRunning
  if (!force && toolsDeferred === isDeferred) return
  for (const spec of TOOL_SPECS) {
    await $.tool.register({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema, isDeferred })
  }
  toolsDeferred = isDeferred
}

/** Brings the pane view, the status line and the tool deferral in line with the active task. */
async function refresh($: EngineInterface, ctx: Ctx, force = false): Promise<void> {
  await safely(async () => {
    const [view, line] = [await currentView(ctx), await statusLine(ctx)]
    await $.state.set(VIEW, view)
    await $.ui.status(line ?? undefined)
    await syncTools($, line !== null, force)
  })
}

async function openPane($: EngineInterface): Promise<void> {
  await safely(() => $.ui.open({ id: PANE_ID, title: PANE_TITLE }))
}

/** Queues model work to start after the current hook returns: the host refuses $.prompt.submit inside command.run. */
function queueKickoff($: EngineInterface, text: string | undefined): void {
  if (text === undefined) return
  $.clock.after(0, () => void $.prompt.submit({ text }))
}

/** The agent type of the subagent running a tool call, or null for the main loop (D7). */
async function agentTypeOf($: EngineInterface, agentId: string | undefined): Promise<string | null> {
  if (agentId === undefined) return null
  const agents = await $.agent.list()
  return agents.find(agent => agent.id === agentId)?.type ?? null
}

/**
 * Where a write tool would really land (D14, CR17): the real path of the nearest ancestor that exists, plus the segments below it
 * (so `mkdir -p`-style writes of new nested files resolve too, and `..` below the existing part is folded). Undefined when nothing
 * resolves (a dangling link, no ancestor), which the guard treats as a denial.
 */
async function resolveWritePath($: EngineInterface, root: string, input: Record<string, unknown>): Promise<string | undefined> {
  const raw = input.file_path ?? input.notebook_path
  if (typeof raw !== 'string' || raw === '') return undefined
  let current = raw.startsWith('/') ? raw : joinPath(root, raw)
  const below: string[] = []
  for (;;) {
    const stat = await $.fs.stat(current, { resolve: true }).catch(() => undefined)
    if (stat !== undefined) {
      if (stat.realPath === undefined) return undefined
      const parts = stat.realPath.split('/').filter(part => part !== '')
      for (const segment of below) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') parts.pop()
        else parts.push(segment)
      }
      return `/${parts.join('/')}`
    }
    if (current === '/' || current === '') return undefined
    const cut = current.lastIndexOf('/')
    below.unshift(current.slice(cut + 1))
    current = cut <= 0 ? '/' : current.slice(0, cut)
  }
}

/** Appended to every deny reason while the ledger names an active task whose files are gone (F1): the policy still applies, and this says how to get out. */
async function missingFilesNote(ctx: Ctx): Promise<string> {
  const id = await activeTaskId(ctx).catch(() => null)
  return `${id ?? 'The active task'}'s files are missing: run /ewm status to see options (/ewm list deactivates it)`
}

/** The deny reason for a tool call, or null to let it through. Throws when the guard cannot decide (the caller fails closed). */
async function judgeToolCall($: EngineInterface, e: { tool: string; agentId?: string | undefined }): Promise<string | null> {
  const ctx = await ctxOf($)
  if (ctx === null) return null
  let context: Awaited<ReturnType<typeof activeContext>>
  try {
    context = await activeContext(ctx)
  } catch (error) {
    // A malformed ledger: nothing can be decided, so everything is denied, but with the way out (/ewm reset) instead of a bare "guard failed".
    if (error instanceof EwmError) return error.message
    throw error
  }
  // The LEDGER's phase decides (F1): task.json may be missing, and is never the authority anyway.
  const { task, profile, phase } = context
  if (phase === null || phase === 'PAUSED' || phase === 'DONE') return null

  const input = e as unknown as Record<string, unknown>
  const call: PolicyCall = { tool: e.tool, input }
  if (WRITE_TOOLS.includes(e.tool)) {
    const resolvedPath = await resolveWritePath($, ctx.root, input)
    if (resolvedPath !== undefined) call.resolvedPath = resolvedPath
  }
  const agentType = await agentTypeOf($, e.agentId)
  const verdict = evaluateToolCall({ phase, profile, root: ctx.root, agentType }, call)
  if (verdict.allow) return null
  const reason = task === null ? `${verdict.reason} ${await missingFilesNote(ctx)}` : verdict.reason
  await safely(() => recordDenial(ctx, e.tool, reason))
  return reason
}

function refusedCommand(command: string): string {
  return `ewm: /ewm ${command} is refused from this origin. Only a person decides gates and changes the workflow state: ask them to type /ewm ${command} in their prompt.`
}

/**
 * The text of a command reply. The engine shows a command's output under the plugin's name ("ewm: <text>"), so a message that starts
 * with "ewm: " itself would read "ewm: ewm: ..." (F4). The prefix is dropped here, once, for every reply this module returns.
 */
function replyText(text: string): string {
  return unprefixed(text)
}

/** Finishes a command: refresh the views, open the pane, queue the kickoff and shape the reply. */
async function settle($: EngineInterface, ctx: Ctx, out: CommandOutput): Promise<{ text: string; context?: readonly string[] }> {
  if (out.changed) await refresh($, ctx)
  await safely(() => $.state.set(NOTICE, null))
  if (out.openPane === true) await openPane($)
  queueKickoff($, out.kickoff)
  if (out.section !== undefined) {
    const section = out.section
    await safely(() => $.state.set(SECTION, section))
  }
  const text = replyText(out.text)
  return out.context === undefined ? { text } : { text, context: out.context }
}

/** The Approve button: same use case as /ewm approve, recorded as `via: 'pane'`. It carries the hash of the plan that was drawn, so a plan replaced since is refused. */
async function approveFromPane($: EngineInterface, planHash: string | undefined): Promise<void> {
  await safely(async () => {
    const ctx = await ctxOf($)
    if (ctx === null) return
    const out = await runCommand(ctx, planHash === undefined ? 'approve' : `approve --plan ${planHash}`, 'pane')
    if (out.changed) await refresh($, ctx)
    await update($, NOTICE, () => out.text.split('\n')[0] ?? '')
    queueKickoff($, out.kickoff)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await safely(async () => {
      pinnedRoot = e.cwd
      await $.state.set(ROOT, e.cwd)
      await $.command.register({ name: 'ewm', description: 'Engineering workflow: explore, plan, implement and validate with gates', argumentHint: COMMAND_HINT })
      const ctx: Ctx = { io: engineIo(ioSource($)), root: e.cwd }
      const isRunning = await statusLine(ctx).then(line => line !== null, () => false)
      await syncTools($, isRunning, true)
      await refresh($, ctx)
    })
    return next(e)
  })

  on('command.run', { command: 'ewm' }, async ($, e) => {
    const ctx = await ctxOf($)
    if (ctx === null) return { text: replyText('ewm: the workspace root is not known yet. Start a new session in the project folder and try again.') }
    const parsed = parseCommand(e.args)
    if ('name' in parsed && STATE_CHANGING_COMMANDS.includes(parsed.name) && !HUMAN_ORIGINS.includes(e.origin.kind)) {
      return { text: replyText(refusedCommand(parsed.name)) }
    }
    return settle($, ctx, await runCommand(ctx, e.args, 'command', { columns: e.presentation.columns }))
  }).catch(() => ({ text: replyText('ewm: the command failed unexpectedly. Run /ewm status to see where the task stands.') }))

  // Guard first: hooks registered earlier sit outside later ones, so a denial never reaches the tools below.
  on('tool.call', async ($, e, next) => {
    const reason = await judgeToolCall($, e)
    return reason === null ? next(e) : { deny: reason }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'ewm: policy guard failed; denied to stay safe. Run /ewm pause to work outside the workflow.' }))

  for (const spec of TOOL_SPECS) {
    on('tool.call', { tool: `${OWN_TOOL_PREFIX}${spec.name}` as `mcp__${string}__${string}` }, async ($, e) => {
      const ctx = await ctxOf($)
      if (ctx === null) return { result: 'ewm: the workspace root is not known yet.', text: 'ewm: the workspace root is not known yet.', isError: true }
      const input = e as unknown as Record<string, unknown>
      const out = await runTool(ctx, spec.name, input)
      if (out.changed) await refresh($, ctx)
      return out.ok ? { result: out.text, text: out.text } : { result: out.text, text: out.text, isError: true }
    }).catch(() => ({ result: 'ewm: the tool failed unexpectedly.', text: 'ewm: the tool failed unexpectedly.', isError: true }))
  }

  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType.startsWith('ewm:')) return next(e)
    const ctx = await ctxOf($)
    const active = ctx === null ? null : await activeContext(ctx).catch(() => null)
    const profile = active?.profile ?? DEFAULT_PROFILE

    if (active?.phase != null && AGENT_ROLES[e.subagentType] === 'search') {
      const limit = profile.budgets.max_parallel_researchers
      const agents = await $.agent.list()
      const busy = agents.filter(a => AGENT_ROLES[a.type] === 'search' && (a.status === 'running' || a.status === 'pending')).length
      if (busy >= limit) {
        return { deny: `ewm: ${busy} scouts are already running (budgets.max_parallel_researchers is ${limit}). Wait for their reports, then delegate again.` }
      }
    }

    const routed = routeModel(e.subagentType, e.model, profile)
    const spawned = await next(routed.model === undefined ? e : { ...e, model: routed.model })
    if (spawned.deny === undefined && ctx !== null) {
      await safely(async () => {
        await recordAgentSpawn(ctx, {
          agent_type: e.subagentType,
          model: spawned.model,
          ...(routed.model === undefined ? {} : { routed_model: routed.model }),
          ...(spawned.agentId === undefined ? {} : { agent_id: spawned.agentId }),
          description: e.description,
          rule: routed.rule,
        })
        await refresh($, ctx)
      })
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage !== undefined) {
      await safely(async () => {
        const ctx = await ctxOf($)
        if (ctx === null) return
        // A subagent's tokens count towards the phase; only the lead's turns count as turns.
        await recordUsage(ctx, {
          turns: e.agentId === undefined ? 1 : 0,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        })
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Code } = elements
    const view: View = (await $.state.get(VIEW)).value ?? null
    const section: Section = (await $.state.get(SECTION)).value ?? 'overview'
    const notice = (await $.state.get(NOTICE)).value ?? null

    if (view === null) {
      return (
        <Box flexDirection="column">
          <Text bold>Engineering Workflow</Text>
          <Text dimColor>No active task. Start one with /ewm new "title", or list tasks with /ewm list.</Text>
        </Box>
      )
    }

    // A diagram: SVG where the surface draws vector images, box-drawing text sized to the pane in the terminal,
    // the links as a list when it does not fit, and the source as code when it does not parse.
    const columns = Math.max(20, e.props.bodyColumns - 1)
    const diagram = (source: string, key: string, marks: Readonly<Record<string, NodeMark>>) => {
      const parsed = parseFlowchart(source)
      if (!parsed.ok) return <Code key={key} source={source} language="text" />
      const alt = adjacencyLines(parsed.graph).join('\n') || 'An empty diagram.'
      // The terminal's table answers Svg with an empty fragment, so the surface decides, not the table.
      if (e.surface !== 'terminal' && 'Svg' in elements) {
        const svg = drawSvg(parsed.graph, { marks, title: view.title })
        if (svg !== null) {
          const { Svg } = elements
          return <Svg key={key} source={svg} alt={alt} isInteractive />
        }
      }
      const lines = drawText(parsed.graph, { columns, marks }) ?? [undrawnNote(parsed.graph, columns), ...alt.split('\n').map(line => `  ${line}`)]
      return (
        <Box key={key} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={`${key}-${i}`} wrap="truncate-end">
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </Box>
      )
    }
    const doc = (markdown: string, marks: Readonly<Record<string, NodeMark>>) =>
      splitMermaid(markdown).map((segment, i) =>
        segment.kind === 'mermaid' ? diagram(segment.source, `diagram-${i}`, marks) : <Markdown key={`doc-${i}`} text={segment.text} />,
      )

    const rail = view.rail.map(stage => (stage.state === 'current' ? `[${stage.label}]` : stage.label)).join(' > ')
    const { counts } = view
    const body =
      section === 'overview'
        ? [
            `${counts.components} components · ${counts.sources} sources · ${counts.findings} findings · ${counts.stale} stale`,
            `${counts.open_questions} open questions · ${counts.risks} risks`,
            view.models.length > 0 ? `Models: ${view.models.join(', ')}` : 'Models: none used yet',
            `Next: ${view.next_action}`,
          ].map((line, i) => <Text key={`overview-${i}`}>{line}</Text>)
        : doc(view.docs[section], section === 'map' ? view.map_marks : {})

    const shownPlan = view.plan
    const approvePlanHash = shownPlan === null || shownPlan === undefined ? undefined : shownPlan.hash
    const show = (next: Section) => () => update($, SECTION, () => next)
    return (
      <Box flexDirection="column">
        <Text dimColor>Project: {view.project}</Text>
        <Text bold>
          {view.task_id} · {view.phase} · {view.title}
        </Text>
        <Text>
          {rail}
          {view.phase === 'PAUSED' ? ' (paused)' : ''}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {body}
        </Box>
        {shownPlan != null && (
          <Text>
            Plan {shownPlan.hash.slice(0, 8)} · {shownPlan.steps} step{shownPlan.steps === 1 ? '' : 's'}: {shownPlan.summary}
          </Text>
        )}
        {view.pending_gate !== null && (
          <Text color="warning">
            Waiting for your {GATE_LABELS[view.pending_gate] ?? view.pending_gate}: press Approve or run /ewm approve.
          </Text>
        )}
        {notice !== null && <Text dimColor>{notice}</Text>}
        <Box gap={1} marginTop={1}>
          <Button key="overview" label="Overview" hotkey="o" onPress={show('overview')} />
          <Button key="map" label="Map" hotkey="m" onPress={show('map')} />
          <Button key="plan" label="Plan" hotkey="p" onPress={show('plan')} />
          <Button key="questions" label="Questions" hotkey="q" onPress={show('questions')} />
          <Button key="findings" label="Findings" hotkey="f" onPress={show('findings')} />
          {view.pending_gate !== null && <Button key="approve" label="Approve" hotkey="a" variant="primary" onPress={() => approveFromPane($, approvePlanHash)} />}
        </Box>
      </Box>
    )
  })
}
