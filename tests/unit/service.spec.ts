import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_SPECS,
  activeContext,
  currentView,
  recordAgentSpawn,
  recordDenial,
  recordUsage,
  runCommand,
  runTool,
  statusLine,
} from '../../src/service.ts'
import type { Ctx } from '../../src/service.ts'
import { evaluateToolCall } from '../../src/policies.ts'
import { DEFAULT_PROFILE } from '../../src/profile.ts'
import { ledgerKey, loadLedger, loadTask, saveLedger } from '../../src/store.ts'
import { splitArgs } from '../../src/args.ts'
import type { Approval, CommandOutput, Task, ToolOutput, ValidationRun } from '../../src/types.ts'
import { createMemoryIo, fakeGit } from '../support/memory-io.ts'
import type { MemoryIo } from '../support/memory-io.ts'
import { AT } from '../support/fixtures.ts'

const ROOT = '/repo'
const TASK_DIR = '/repo/.ewm/tasks/TASK-001'

/** `count` numbered lines, newline-terminated. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
}

const SOURCES: Record<string, string> = {
  '/repo/src/math.ts': lines(30),
  '/repo/src/a.ts': lines(40),
  '/repo/src/b.ts': lines(40),
  '/repo/src/c.ts': lines(40),
  '/repo/README.md': lines(10),
  '/repo/docs/design.md': lines(20),
}

const PROJECT_YAML = ['validation:', '  commands:', '    - npm test', ''].join('\n')

type GitState = { branch: string; commit: string; changed: string[]; dirty: string[] }
type Call = { argv: readonly string[]; opts?: { cwd?: string; timeoutMs?: number } }

type Env = {
  io: MemoryIo
  ctx: Ctx
  git: GitState
  /** Non-git commands the service ran. */
  calls: Call[]
  /** What non-git commands answer. */
  answer: { exitCode: number; stdout: string; stderr: string } | Error
}

function setup(files: Record<string, string> = {}): Env {
  const io = createMemoryIo({ ...SOURCES, ...files })
  const env: Env = {
    io,
    ctx: { io, root: ROOT },
    git: { branch: 'main', commit: 'a1b2c3d', changed: [], dirty: [] },
    calls: [],
    answer: { exitCode: 0, stdout: 'ok\n', stderr: '' },
  }
  const gitAnswers = fakeGit(env.git)
  io.onRun((argv, opts) => {
    if (argv[0] === 'git') return gitAnswers(argv, opts)
    env.calls.push({ argv, opts })
    if (env.answer instanceof Error) throw env.answer
    return env.answer
  })
  return env
}

/** A new process over the same files and store: fresh objects, as after a restart. */
function restart(previous: Env, git: Partial<GitState> | 'unavailable' = {}): Env {
  const io = createMemoryIo(Object.fromEntries(previous.io.files))
  for (const [key, value] of previous.io.kv) io.kv.set(key, JSON.parse(JSON.stringify(value)))
  const env: Env = {
    io,
    ctx: { io, root: ROOT },
    git: { ...previous.git, ...(git === 'unavailable' ? {} : git) },
    calls: [],
    answer: previous.answer,
  }
  const gitAnswers = fakeGit(env.git)
  io.onRun((argv, opts) => {
    if (argv[0] !== 'git') return { exitCode: 127, stdout: '', stderr: 'not found' }
    if (git === 'unavailable') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
    return gitAnswers(argv, opts)
  })
  return env
}

const cmd = (env: Env, args: string, via: 'command' | 'pane' = 'command'): Promise<CommandOutput> => runCommand(env.ctx, args, via)
const tool = (env: Env, name: string, input: Record<string, unknown> = {}): Promise<ToolOutput> => runTool(env.ctx, name, input)

async function expectOk(result: ToolOutput | Promise<ToolOutput>): Promise<ToolOutput> {
  const out = await result
  assert.equal(out.ok, true, out.text)
  return out
}

async function expectRefused(result: ToolOutput | Promise<ToolOutput>, pattern: RegExp): Promise<ToolOutput> {
  const out = await result
  assert.equal(out.ok, false, `expected a refusal but got: ${out.text}`)
  assert.equal(out.changed, false)
  assert.match(out.text, /^ewm: /)
  assert.match(out.text, pattern)
  return out
}

const taskOf = (env: Env, id = 'TASK-001'): Promise<Task> => loadTask(env.io, ROOT, id)

const PLAN_INPUT = {
  summary: 'Fix the loop bound in sum()',
  steps: [{ text: 'Use <= in the loop', files: ['src/math.ts'] }],
  risks: ['off by one elsewhere'],
  tests: ['npm test'],
  alternatives: ['rewrite with reduce'],
}

async function startTask(env: Env, title = 'Fix sum'): Promise<void> {
  const out = await cmd(env, `new "${title}"`)
  assert.equal(out.changed, true, out.text)
}

async function advance(env: Env, to: string): Promise<void> {
  await expectOk(tool(env, 'advance', { to, reason: `ready for ${to}` }))
}

async function toPlan(env: Env): Promise<void> {
  await startTask(env)
  await expectOk(tool(env, 'set_intake', { success_criteria: ['sum() is right'], constraints: [] }))
  for (const to of ['EXPLORE', 'UNDERSTAND']) await advance(env, to)
  // CR10: the person decides when to plan.
  const planned = await cmd(env, 'plan')
  assert.match(planned.text, /UNDERSTAND > PLAN/)
}

async function toImplement(env: Env): Promise<void> {
  await toPlan(env)
  await expectOk(tool(env, 'set_plan', PLAN_INPUT))
  const approved = await cmd(env, 'approve')
  assert.match(approved.text, /IMPLEMENT/)
}

async function toValidate(env: Env): Promise<void> {
  await toImplement(env)
  await advance(env, 'VALIDATE')
}

async function auditKinds(env: Env, id = 'TASK-001'): Promise<string[]> {
  const text = await env.io.readText(`/repo/.ewm/tasks/${id}/audit.jsonl`)
  return text
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

describe('TOOL_SPECS', () => {
  it('describes the ten tools with strict schemas', () => {
    assert.deepEqual(
      TOOL_SPECS.map(spec => spec.name),
      ['status', 'set_intake', 'advance', 'record_finding', 'question', 'decision', 'set_plan', 'update_step', 'write_map', 'run_validation'],
    )
    for (const spec of TOOL_SPECS) {
      assert.ok(spec.description.length > 60, `${spec.name} needs a real description`)
      assert.equal(spec.inputSchema.type, 'object')
      assert.equal(spec.inputSchema.additionalProperties, false, spec.name)
    }
  })
})

describe('acceptance criteria at service level', () => {
  it('AC1 new -> intake -> explore -> 5 sourced findings -> map', async () => {
    const env = setup()
    const created = await cmd(env, 'new "Fix sum" --goal "Find why sum() is wrong"')
    assert.equal(created.changed, true)
    assert.equal(created.openPane, true)
    assert.match(created.text, /TASK-001/)
    assert.match(created.kickoff ?? '', /ewm:intake/)

    await expectOk(tool(env, 'set_intake', { success_criteria: ['sum() returns the total'], constraints: ['no new dependencies'] }))
    await advance(env, 'EXPLORE')

    const evidence = [
      { path: 'src/a.ts', line_start: 3, line_end: 5 },
      { path: 'src/b.ts', line_start: 10 },
      { path: 'src/c.ts', line_start: 1, line_end: 40 },
      { path: 'docs/design.md', doc_id: 'ADR-3' },
      { path: 'README.md', line_start: 2, line_end: 4 },
    ]
    for (const [index, item] of evidence.entries()) {
      await expectOk(tool(env, 'record_finding', { claim: `Claim number ${index + 1}`, evidence: [item], confidence: 'high', source: 'ewm:repo-scout' }))
    }
    await expectOk(
      tool(env, 'write_map', {
        mermaid: 'flowchart LR\n  A[a.ts] --> B[b.ts]\n  B --> C[c.ts]',
        text_map: 'a.ts calls b.ts\nb.ts calls c.ts',
        components: ['a.ts', 'b.ts', 'c.ts'],
      }),
    )

    const exploration = await env.io.readText(`${TASK_DIR}/exploration.md`)
    for (const id of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005']) assert.match(exploration, new RegExp(id))
    assert.match(exploration, /src\/a\.ts:3-5/)
    assert.match(exploration, /src\/b\.ts:10/)
    assert.match(exploration, /docs\/design\.md#ADR-3/)
    const map = await env.io.readText(`${TASK_DIR}/system-map.md`)
    assert.match(map, /```mermaid\nflowchart LR/)

    const status = (await cmd(env, 'status')).text
    assert.match(status, /Findings: 5/)
    assert.match(status, /Components: 3/)
    const task = await taskOf(env)
    assert.equal(task.findings.length, 5)
    assert.equal(task.findings[0]?.last_verified_commit, 'a1b2c3d')
    assert.deepEqual(task.artifacts, ['exploration.md', 'system-map.md', 'questions.md', 'plan.md', 'validation.md', 'decisions.md'])
  })

  it('AC2 implementation is unreachable without a human approval', async () => {
    const env = setup()
    await startTask(env)
    await advance(env, 'EXPLORE')
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'skip ahead' }), /EXPLORE to IMPLEMENT/)
    await expectRefused(tool(env, 'set_plan', PLAN_INPUT), /only in PLAN/)
    const nothing = await cmd(env, 'approve')
    assert.equal(nothing.changed, false)
    assert.match(nothing.text, /nothing to approve in EXPLORE/)

    await advance(env, 'UNDERSTAND')
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'skip ahead' }), /UNDERSTAND to IMPLEMENT/)
    // CR10: planning starts when the person says so.
    await expectRefused(tool(env, 'advance', { to: 'PLAN', reason: 'I think we are ready' }), /\/ewm plan/)
    assert.equal((await taskOf(env)).phase, 'UNDERSTAND')
    assert.match((await cmd(env, 'plan')).text, /UNDERSTAND > PLAN/)
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'no plan yet' }), /at least one step/)
    assert.match((await cmd(env, 'approve')).text, /no steps/)

    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'trust me' }), /\/ewm approve/)
    assert.equal((await taskOf(env)).phase, 'PLAN')

    const approved = await cmd(env, 'approve')
    assert.equal(approved.changed, true)
    assert.match(approved.kickoff ?? '', /ewm:implement/)
    assert.equal((await taskOf(env)).phase, 'IMPLEMENT')

    // Back in PLAN the old approval still matches the unchanged plan, but not a changed one.
    await advance(env, 'VALIDATE')
    await advance(env, 'PLAN')
    await expectOk(tool(env, 'set_plan', { ...PLAN_INPUT, steps: [{ text: 'Use <= and add a test', files: ['src/math.ts'] }] }))
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'plan changed' }), /approved plan/)
    assert.match((await cmd(env, 'status')).text, /plan approval pending/)
    await cmd(env, 'approve')
    assert.equal((await taskOf(env)).phase, 'IMPLEMENT')
  })

  it('AC3 pause and resume in a new process restore the task and mark stale evidence', async () => {
    const env = setup()
    await toPlan(env)
    await expectOk(tool(env, 'record_finding', { claim: 'sum loops to length - 1', evidence: [{ path: 'src/a.ts', line_start: 3 }], confidence: 'high' }))
    await expectOk(tool(env, 'record_finding', { claim: 'b.ts is unrelated', evidence: [{ path: 'src/b.ts', line_start: 1, line_end: 2 }], confidence: 'medium' }))
    await expectOk(tool(env, 'question', { action: 'add', text: 'Is the old behaviour relied on?' }))
    await expectOk(tool(env, 'decision', { title: 'Keep the API', choice: 'sum(xs) stays', rationale: 'callers exist' }))
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    const rejected = await cmd(env, 'reject needs a test step')
    assert.equal(rejected.changed, true)
    await advance(env, 'UNDERSTAND')

    const before = await taskOf(env)
    assert.equal(before.approvals.length, 1)
    const paused = await cmd(env, 'pause')
    assert.equal(paused.changed, true)
    assert.equal((await taskOf(env)).phase, 'PAUSED')

    // Restart 1: nothing changed in git.
    const second = restart(env)
    const resumed = await runCommand(second.ctx, 'resume TASK-001', 'command')
    assert.equal(resumed.changed, true)
    assert.match(resumed.text, /UNDERSTAND/)
    assert.match(resumed.kickoff ?? '', /ewm:understand/)
    assert.ok((resumed.context ?? []).some(line => /re-verify stale evidence/.test(line)))
    const after = await taskOf(second)
    assert.equal(after.phase, 'UNDERSTAND')
    assert.deepEqual(after.decisions, before.decisions)
    assert.deepEqual(after.approvals, before.approvals)
    assert.deepEqual(after.open_questions, before.open_questions)
    assert.deepEqual(after.findings, before.findings)
    assert.equal((await loadLedger(second.io, ROOT)).active_task, 'TASK-001')

    // Restart 2: src/a.ts changed since the evidence was verified.
    await runCommand(second.ctx, 'pause', 'command')
    const third = restart(second, { changed: ['src/a.ts'] })
    const stale = await runCommand(third.ctx, 'resume', 'command')
    assert.match(stale.text, /Stale evidence: 1 finding/)
    assert.match(stale.text, /src\/a\.ts/)
    const staleTask = await taskOf(third)
    assert.deepEqual(staleTask.findings.map(finding => finding.stale), [true, false])
    assert.match(await third.io.readText(`${TASK_DIR}/exploration.md`), /\[STALE\]/)

    // Restart 3: git is down, so nothing can be checked and the brief says so.
    await runCommand(third.ctx, 'pause', 'command')
    const fourth = restart(third, 'unavailable')
    const unchecked = await runCommand(fourth.ctx, 'resume', 'command')
    assert.match(unchecked.text, /could not be checked/)
    assert.equal((await taskOf(fourth)).phase, 'UNDERSTAND')
  })

  it('AC4 records which model each agent ran on', async () => {
    const env = setup()
    await startTask(env)
    await advance(env, 'EXPLORE')
    await recordAgentSpawn(env.ctx, {
      agent_type: 'ewm:repo-scout',
      model: 'claude-haiku-4-5-20251001',
      routed_model: 'haiku',
      agent_id: 'agent-1',
      description: 'map the loop',
      rule: 'profile.models.search',
    })
    const task = await taskOf(env)
    assert.equal(task.agent_usage.length, 1)
    assert.deepEqual(task.agent_usage[0], {
      agent_type: 'ewm:repo-scout',
      model: 'claude-haiku-4-5-20251001',
      routed_model: 'haiku',
      agent_id: 'agent-1',
      description: 'map the loop',
      phase: 'EXPLORE',
      rule: 'profile.models.search',
      at: new Date(await env.io.now()).toISOString(),
    })
    assert.match((await cmd(env, 'status')).text, /haiku \[claude-haiku-4-5-20251001\] \(ewm:repo-scout x1\)/)
    assert.ok((await auditKinds(env)).includes('agent_spawn'))
    assert.deepEqual((await currentView(env.ctx))?.models, ['haiku [claude-haiku-4-5-20251001] (ewm:repo-scout x1)'])
  })

  it('AC5 validates through the allowlist and hands off at DONE', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    env.answer = { exitCode: 0, stdout: 'ok 12 tests\nAPI_TOKEN=hunter2value\n', stderr: '' }
    await toImplement(env)
    await expectRefused(tool(env, 'run_validation', { command: 'npm test' }), /only in VALIDATE/)
    await advance(env, 'VALIDATE')

    await expectRefused(tool(env, 'run_validation', { command: 'npm run lint' }), /not an allowed validation command/)
    await expectRefused(tool(env, 'run_validation', { command: 'npm test; rm -rf x' }), /not an allowed validation command/)
    assert.equal(env.calls.length, 0)

    const ran = await expectOk(tool(env, 'run_validation', { command: 'npm test' }))
    assert.match(ran.text, /V-001 PASS/)
    assert.match(ran.text, /\/ewm approve/)
    assert.equal(env.calls.length, 1)
    assert.deepEqual(env.calls[0]?.argv, splitArgs('npm test'))
    assert.equal(env.calls[0]?.opts?.cwd, '/repo')
    assert.equal(env.calls[0]?.opts?.timeoutMs, 300000)

    const task = await taskOf(env)
    const run = task.validations[0] as ValidationRun
    assert.equal(run.exit_code, 0)
    assert.equal(run.ok, true)
    assert.equal(run.commit, 'a1b2c3d')
    assert.match(run.output_tail, /ok 12 tests/)
    assert.doesNotMatch(run.output_tail, /hunter2value/)
    const validationMd = await env.io.readText(`${TASK_DIR}/validation.md`)
    assert.match(validationMd, /V-001 - PASS/)
    assert.match(validationMd, /npm test/)
    assert.ok((await auditKinds(env)).includes('validation_run'))
    const ledger = await loadLedger(env.io, ROOT)
    assert.equal(ledger.tasks['TASK-001']?.validations[0]?.id, 'V-001')

    env.git.changed = ['src/math.ts', '.ewm/tasks/TASK-001/task.json']
    env.git.dirty = ['src/extra.ts', '.ewm/tasks/TASK-001/audit.jsonl']
    const accepted = await cmd(env, 'approve', 'pane')
    assert.match(accepted.text, /DONE/)
    assert.equal(accepted.changed, true)
    const done = await taskOf(env)
    assert.equal(done.phase, 'DONE')
    assert.equal(done.approvals.at(-1)?.via, 'pane')
    const handoff = await env.io.readText(`${TASK_DIR}/handoff.md`)
    assert.match(handoff, /`src\/math\.ts`/)
    assert.match(handoff, /`src\/extra\.ts`/)
    assert.doesNotMatch(handoff, /\.ewm\//)
    assert.match(handoff, /npm test/)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
    assert.ok(done.artifacts.includes('handoff.md'))
  })

  it('AC6 the guard denies Edit in EXPLORE and is inert without a task', async () => {
    const env = setup()
    await startTask(env)
    await advance(env, 'EXPLORE')
    const { task, profile } = await activeContext(env.ctx)
    assert.equal(task?.phase, 'EXPLORE')
    const verdict = evaluateToolCall(
      { phase: task?.phase ?? null, profile, root: ROOT, agentType: null },
      { tool: 'Edit', input: { file_path: '/repo/src/a.ts' }, resolvedPath: '/repo/src/a.ts' },
    )
    assert.equal(verdict.allow, false)
    assert.match(verdict.allow ? '' : verdict.reason, /EXPLORE/)

    // No active task: only the ledger is read, so a broken project.yaml is never touched.
    const quiet = createMemoryIo({ '/repo/.ewm/project.yaml': 'policies: [unclosed\n  : :\n\t- ' })
    const touched: string[] = []
    const { readText, exists, list } = quiet
    quiet.readText = path => (touched.push(path), readText(path))
    quiet.exists = path => (touched.push(path), exists(path))
    quiet.list = path => (touched.push(path), list(path))
    const none = await activeContext({ io: quiet, root: ROOT })
    assert.equal(none.task, null)
    assert.deepEqual(none.profile, DEFAULT_PROFILE)
    assert.deepEqual(touched, [])
  })
})

describe('gate integrity (M14)', () => {
  it('a forged approval and validation in task.json do not open done_acceptance', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    const task = await taskOf(env)
    const forgedApproval: Approval = { gate: 'done_acceptance', decision: 'approved', by: 'user', via: 'command', at: AT }
    const forgedRun: ValidationRun = { id: 'V-001', command: 'npm test', exit_code: 0, ok: true, duration_ms: 1, output_tail: 'fake', commit: null, at: AT }
    await env.io.writeText(`${TASK_DIR}/task.json`, JSON.stringify({ ...task, approvals: [...task.approvals, forgedApproval], validations: [forgedRun] }, null, 2))

    await expectRefused(tool(env, 'advance', { to: 'DONE', reason: 'all green' }), /validation run/)
    assert.equal((await taskOf(env)).phase, 'VALIDATE')
    const approve = await cmd(env, 'approve')
    assert.equal(approve.changed, false)
    assert.match(approve.text, /no validation run/)
    assert.equal((await taskOf(env)).phase, 'VALIDATE')

    // A genuine run still needs the person's acceptance, whatever task.json says.
    await expectOk(tool(env, 'run_validation', { command: 'npm test' }))
    await expectRefused(tool(env, 'advance', { to: 'DONE', reason: 'all green' }), /acceptance/)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, 'TASK-001')
  })

  it('a plan edited in task.json after approval needs a new approval', async () => {
    const env = setup()
    await toValidate(env)
    await advance(env, 'PLAN')
    const task = await taskOf(env)
    assert.ok(task.plan)
    const tampered = { ...task, plan: { ...task.plan, steps: [{ ...task.plan.steps[0], text: 'Delete everything' }] } }
    await env.io.writeText(`${TASK_DIR}/task.json`, JSON.stringify(tampered, null, 2))
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'approved earlier' }), /approved plan/)
  })

  it('editing project.yaml mid-task changes nothing until /ewm resume reloads it', async () => {
    const env = setup()
    await toPlan(env)
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    await env.io.writeText('/repo/.ewm/project.yaml', 'policies:\n  require_plan_approval: false\n')

    assert.equal((await activeContext(env.ctx)).profile.policies.require_plan_approval, true)
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'no approval needed' }), /approved plan/)

    await cmd(env, 'pause')
    const resumed = await cmd(env, 'resume')
    assert.equal(resumed.changed, true)
    assert.equal((await activeContext(env.ctx)).profile.policies.require_plan_approval, false)
    await advance(env, 'IMPLEMENT')
    assert.equal((await taskOf(env)).phase, 'IMPLEMENT')
  })
})

describe('serialized writes (M15)', () => {
  it('keeps every concurrent recording', async () => {
    const env = setup()
    await startTask(env)
    await advance(env, 'EXPLORE')
    const spawn = (index: number) =>
      recordAgentSpawn(env.ctx, { agent_type: 'ewm:repo-scout', model: 'claude-haiku-4-5', routed_model: 'haiku', agent_id: `agent-${index}`, rule: 'profile.models.search' })
    const results = await Promise.all([
      spawn(1),
      spawn(2),
      spawn(3),
      tool(env, 'record_finding', { claim: 'Concurrent claim', evidence: [{ path: 'src/a.ts', line_start: 1 }], confidence: 'low' }),
      recordUsage(env.ctx, { input_tokens: 120, output_tokens: 30 }),
    ])
    assert.equal((results[3] as ToolOutput).ok, true)
    const task = await taskOf(env)
    assert.deepEqual(task.agent_usage.map(use => use.agent_id).sort(), ['agent-1', 'agent-2', 'agent-3'])
    assert.equal(task.findings.length, 1)
    assert.deepEqual(task.usage_by_phase.EXPLORE, {
      turns: 1,
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    const kinds = await auditKinds(env)
    assert.equal(kinds.filter(kind => kind === 'agent_spawn').length, 3)
  })
})

describe('record_finding', () => {
  const rejections: [string, Record<string, unknown>, RegExp][] = [
    ['zero evidence', { claim: 'c', evidence: [], confidence: 'high' }, /evidence/],
    ['missing evidence', { claim: 'c', confidence: 'high' }, /evidence/],
    ['an absolute path', { claim: 'c', evidence: [{ path: '/etc/passwd' }], confidence: 'high' }, /relative/],
    ['a parent segment', { claim: 'c', evidence: [{ path: '../secret.txt' }], confidence: 'high' }, /"\.\."/],
    ['a buried parent segment', { claim: 'c', evidence: [{ path: 'src/../../x' }], confidence: 'high' }, /"\.\."/],
    ['a path under .ewm', { claim: 'c', evidence: [{ path: '.ewm/tasks/TASK-001/task.json' }], confidence: 'high' }, /\.ewm\//],
    ['a dotted path under .ewm', { claim: 'c', evidence: [{ path: './.ewm/project.yaml' }], confidence: 'high' }, /\.ewm\//],
    ['a missing file', { claim: 'c', evidence: [{ path: 'src/nope.ts' }], confidence: 'high' }, /does not exist/],
    ['line_start beyond the file', { claim: 'c', evidence: [{ path: 'src/math.ts', line_start: 31 }], confidence: 'high' }, /30 lines/],
    ['line_end beyond the file', { claim: 'c', evidence: [{ path: 'src/math.ts', line_start: 1, line_end: 31 }], confidence: 'high' }, /30 lines/],
    ['line_end before line_start', { claim: 'c', evidence: [{ path: 'src/math.ts', line_start: 9, line_end: 8 }], confidence: 'high' }, /before line_start/],
    ['line_end without line_start', { claim: 'c', evidence: [{ path: 'src/math.ts', line_end: 8 }], confidence: 'high' }, /needs line_start/],
    ['line 0', { claim: 'c', evidence: [{ path: 'src/math.ts', line_start: 0 }], confidence: 'high' }, />= 1/],
    ['a bad confidence', { claim: 'c', evidence: [{ path: 'src/math.ts' }], confidence: 'certain' }, /confidence/],
    ['an empty claim', { claim: '  ', evidence: [{ path: 'src/math.ts' }], confidence: 'high' }, /claim/],
  ]
  for (const [name, input, pattern] of rejections) {
    it(`rejects ${name}`, async () => {
      const env = setup()
      await startTask(env)
      await expectRefused(tool(env, 'record_finding', input), pattern)
      assert.equal((await taskOf(env)).findings.length, 0)
    })
  }

  it('accepts the last line of a file and normalizes ./ paths', async () => {
    const env = setup()
    await startTask(env)
    await expectOk(tool(env, 'record_finding', { claim: 'Edge', evidence: [{ path: './src/math.ts', line_start: 30, line_end: 30 }], confidence: 'high' }))
    assert.equal((await taskOf(env)).findings[0]?.evidence[0]?.path, 'src/math.ts')
  })

  it('updates a duplicate claim instead of adding one', async () => {
    const env = setup()
    await startTask(env)
    await expectOk(tool(env, 'record_finding', { claim: 'Sum skips the last item', evidence: [{ path: 'src/a.ts', line_start: 1 }], confidence: 'low' }))
    const again = await expectOk(tool(env, 'record_finding', { claim: '  sum SKIPS   the last item ', evidence: [{ path: 'src/b.ts', line_start: 2 }], confidence: 'high' }))
    assert.match(again.text, /Updated F-001/)
    const { findings } = await taskOf(env)
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.confidence, 'high')
    assert.equal(findings[0]?.evidence[0]?.path, 'src/b.ts')
  })
})

describe('commands', () => {
  it('new while another task is running pauses the old one', async () => {
    const env = setup()
    await startTask(env, 'First')
    await advance(env, 'EXPLORE')
    const second = await cmd(env, 'new "Second"')
    assert.match(second.text, /Paused TASK-001 \(was in EXPLORE\)/)
    const first = await taskOf(env, 'TASK-001')
    assert.equal(first.phase, 'PAUSED')
    assert.equal(first.paused_from, 'EXPLORE')
    assert.equal((await taskOf(env, 'TASK-002')).phase, 'INTAKE')
    assert.equal((await loadLedger(env.io, ROOT)).active_task, 'TASK-002')
    assert.match((await cmd(env, 'list')).text, /TASK-002 .*\(active\)/)

    const back = await cmd(env, 'resume TASK-001')
    assert.match(back.text, /Paused TASK-002/)
    assert.equal((await taskOf(env, 'TASK-001')).phase, 'EXPLORE')
    assert.equal((await taskOf(env, 'TASK-002')).phase, 'PAUSED')
  })

  it('writes the workspace files and records the repo', async () => {
    const env = setup()
    await startTask(env)
    assert.equal(await env.io.readText('/repo/.ewm/.gitignore'), 'tasks/\n')
    const task = await taskOf(env)
    assert.deepEqual(task.repo, { root: '.', branch: 'main', base_commit: 'a1b2c3d' })
    assert.equal(task.goal, 'Fix sum')
    assert.deepEqual(await auditKinds(env), ['task_created'])
  })

  it('reports usage for unknown input and help without throwing', async () => {
    const env = setup()
    const unknown = await runCommand(env.ctx, 'frobnicate', 'command')
    assert.equal(unknown.changed, false)
    assert.match(unknown.text, /unknown command/)
    assert.match(unknown.text, /\/ewm new/)
    assert.match((await cmd(env, 'help')).text, /\/ewm approve/)
    assert.match((await cmd(env, '')).text, /No active task/)
    assert.match((await cmd(env, 'plan')).text, /No active task/)
  })

  it('reject keeps the phase and asks the lead to revise', async () => {
    const env = setup()
    await toPlan(env)
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    const rejected = await cmd(env, 'reject "add a rollback step"')
    assert.equal(rejected.changed, true)
    assert.match(rejected.kickoff ?? '', /add a rollback step/)
    const task = await taskOf(env)
    assert.equal(task.phase, 'PLAN')
    assert.equal(task.approvals.at(-1)?.decision, 'rejected')
    assert.equal((await loadLedger(env.io, ROOT)).tasks['TASK-001']?.approvals.length, 1)
    await expectRefused(tool(env, 'advance', { to: 'IMPLEMENT', reason: 'try' }), /approved plan/)
  })

  it('plan moves UNDERSTAND to PLAN, explains earlier phases and shows the plan later', async () => {
    const env = setup()
    await startTask(env)
    assert.match((await cmd(env, 'plan')).text, /INTAKE/)
    await advance(env, 'EXPLORE')
    assert.match((await cmd(env, 'plan')).text, /finish exploring/)
    await advance(env, 'UNDERSTAND')
    const moved = await cmd(env, 'plan')
    assert.equal(moved.changed, true)
    assert.match(moved.kickoff ?? '', /ewm:plan/)
    assert.equal((await taskOf(env)).phase, 'PLAN')
    assert.match((await cmd(env, 'plan')).text, /No plan recorded yet/)
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    assert.match((await cmd(env, 'plan')).text, /Use <= in the loop/)
  })

  it('map and questions show the artifacts', async () => {
    const env = setup()
    await startTask(env)
    assert.match((await cmd(env, 'map')).text, /No system map/)
    await expectOk(tool(env, 'write_map', { mermaid: 'flowchart LR\n A-->B', text_map: 'A to B', components: ['A', 'B'] }))
    const map = await cmd(env, 'map')
    assert.match(map.text, /│ A │─▶│ B │/)
    assert.match(map.text, /Notes:\n {2}A to B/)
    assert.doesNotMatch(map.text, /```mermaid/)
    assert.match(map.text, /system-map\.md/)
    assert.equal(map.section, 'map')
    assert.equal(map.openPane, true)
    await expectOk(tool(env, 'question', { action: 'add', text: 'Who owns B?' }))
    assert.match((await cmd(env, 'questions')).text, /Q-001: Who owns B\?/)
  })

  it('resume without an id picks the latest unfinished task', async () => {
    const env = setup()
    await startTask(env, 'First')
    env.io.advance(60_000)
    await startTask(env, 'Second')
    await cmd(env, 'pause')
    const ledger = await loadLedger(env.io, ROOT)
    await saveLedger(env.io, ROOT, { ...ledger, active_task: null })
    const out = await cmd(env, 'resume')
    assert.match(out.text, /Resuming TASK-002/)
    assert.equal((await taskOf(env, 'TASK-002')).phase, 'INTAKE')
    assert.match((await cmd(env, 'resume TASK-009')).text, /not found/)
  })

  it('list clears a dangling active pointer', async () => {
    const env = setup()
    await startTask(env)
    env.io.files.delete(`${TASK_DIR}/task.json`)
    const out = await cmd(env, 'list')
    assert.equal(out.changed, true)
    assert.match(out.text, /could not be read/)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
  })

  it('pause with an unreadable active task clears the pointer', async () => {
    const env = setup()
    await startTask(env)
    env.io.files.set(`${TASK_DIR}/task.json`, '{ broken')
    const out = await cmd(env, 'pause')
    assert.equal(out.changed, true)
    assert.match(out.text, /deactivated/)
    assert.equal((await loadLedger(env.io, ROOT)).active_task, null)
  })

  it('surfaces a malformed ledger as text, never as a throw', async () => {
    const env = setup()
    await startTask(env)
    env.io.kv.set(ledgerKey(ROOT), { version: 7 })
    const out = await cmd(env, 'status')
    assert.equal(out.changed, false)
    assert.match(out.text, /ledger/)
    await expectRefused(tool(env, 'status'), /ledger/)
    await assert.rejects(activeContext(env.ctx), /ledger/)
  })

  it('honours validation.commands from project.yaml: the exact entry, whitespace-normalized (CR11)', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    const ledger = await loadLedger(env.io, ROOT)
    assert.deepEqual(ledger.tasks['TASK-001']?.profile.validation.commands, ['npm test'])
    await expectOk(tool(env, 'run_validation', { command: '  npm   test ' }))
    assert.deepEqual(env.calls[0]?.argv, ['npm', 'test'])
    assert.equal((await taskOf(env)).validations[0]?.command, 'npm test')
  })

  it('refuses arguments after a listed command: a PASS must come from the command the person listed (CR11)', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    for (const command of ['npm test --help', 'npm test -- -t nothing', 'npm test --version', 'npm test -u']) {
      await expectRefused(tool(env, 'run_validation', { command }), /not an allowed validation command/)
    }
    assert.equal(env.calls.length, 0, 'nothing ran')
    assert.deepEqual((await taskOf(env)).validations, [])
  })

  it('without validation commands in the profile nothing can be run', async () => {
    const env = setup()
    await toValidate(env)
    await expectRefused(tool(env, 'run_validation', { command: 'npm test' }), /none configured/)
  })
})

describe('tools', () => {
  const MINIMAL_INPUT: Record<string, Record<string, unknown>> = {
    status: {},
    set_intake: { success_criteria: ['x'], constraints: [] },
    advance: { to: 'EXPLORE', reason: 'go' },
    record_finding: { claim: 'c', evidence: [{ path: 'src/a.ts' }], confidence: 'high' },
    question: { action: 'add', text: 'q' },
    decision: { title: 't', choice: 'c', rationale: 'r' },
    set_plan: PLAN_INPUT,
    update_step: { id: 'S-1', status: 'done' },
    write_map: { mermaid: 'flowchart LR', text_map: 't', components: [] },
    run_validation: { command: 'npm test' },
  }

  it('every tool refuses without an active task, when paused, and when DONE', async () => {
    const env = setup()
    for (const spec of TOOL_SPECS) await expectRefused(tool(env, spec.name, MINIMAL_INPUT[spec.name]), /no active task/)

    await startTask(env)
    await cmd(env, 'pause')
    for (const spec of TOOL_SPECS) await expectRefused(tool(env, spec.name, MINIMAL_INPUT[spec.name]), /paused/)

    await cmd(env, 'resume')
    await advance(env, 'EXPLORE')
    // The phase is the ledger's (CR5): a DONE task that is still the active one.
    const ledger = await loadLedger(env.io, ROOT)
    const entry = ledger.tasks['TASK-001']
    assert.ok(entry)
    await saveLedger(env.io, ROOT, { ...ledger, tasks: { ...ledger.tasks, 'TASK-001': { ...entry, phase: 'DONE' } } })
    for (const spec of TOOL_SPECS) await expectRefused(tool(env, spec.name, MINIMAL_INPUT[spec.name]), /DONE/)
  })

  it('refuses unknown tools and accepts the registered prefix', async () => {
    const env = setup()
    await expectRefused(tool(env, 'frobnicate'), /unknown tool/)
    await expectRefused(tool(env, 'constructor'), /unknown tool/)
    await startTask(env)
    await expectOk(tool(env, 'mcp__ewm__status'))
  })

  it('status returns the facts the model needs', async () => {
    const env = setup()
    await toPlan(env)
    await expectOk(tool(env, 'question', { action: 'add', text: 'Open one' }))
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    const out = await expectOk(tool(env, 'status'))
    assert.equal(out.changed, false)
    const facts = JSON.parse(out.text.slice(out.text.indexOf('{'))) as Record<string, unknown>
    assert.deepEqual(facts, {
      id: 'TASK-001',
      phase: 'PLAN',
      pending_gate: 'plan_approval',
      open_question_ids: ['Q-001'],
      plan_step_ids: ['S-1'],
      success_criteria: ['sum() is right'],
    })
  })

  it('set_intake replaces the lists in INTAKE through PLAN only', async () => {
    const env = setup()
    await startTask(env)
    await expectRefused(tool(env, 'set_intake', { success_criteria: [], constraints: [] }), /success_criteria/)
    await expectRefused(tool(env, 'set_intake', { success_criteria: ['a'] }), /constraints/)
    await expectOk(tool(env, 'set_intake', { goal: 'New goal', success_criteria: ['a', 'b'], constraints: ['c'] }))
    await expectOk(tool(env, 'set_intake', { success_criteria: ['only'], constraints: [] }))
    const task = await taskOf(env)
    assert.equal(task.goal, 'New goal')
    assert.deepEqual(task.success_criteria, ['only'])
    assert.match(await env.io.readText(`${TASK_DIR}/decisions.md`), /only/)
    await toImplementFrom(env)
    await expectRefused(tool(env, 'set_intake', { success_criteria: ['late'], constraints: [] }), /works only in/)
  })

  async function toImplementFrom(env: Env): Promise<void> {
    for (const to of ['EXPLORE', 'UNDERSTAND']) await advance(env, to)
    await cmd(env, 'plan')
    await expectOk(tool(env, 'set_plan', PLAN_INPUT))
    await cmd(env, 'approve')
  }

  it('questions and decisions get ids and re-render their artifacts', async () => {
    const env = setup()
    await startTask(env)
    await expectOk(tool(env, 'question', { action: 'add', text: 'Is X safe?' }))
    const duplicate = await expectOk(tool(env, 'question', { action: 'add', text: ' is x   SAFE? ' }))
    assert.equal(duplicate.changed, false)
    await expectOk(tool(env, 'question', { action: 'add', text: 'Second?' }))
    await expectRefused(tool(env, 'question', { action: 'resolve', id: 'Q-009', answer: 'a' }), /Q-001, Q-002/)
    await expectOk(tool(env, 'question', { action: 'resolve', id: 'Q-001', answer: 'Yes' }))
    await expectRefused(tool(env, 'question', { action: 'resolve', id: 'Q-001', answer: 'again' }), /already resolved/)
    await expectRefused(tool(env, 'question', { action: 'close' }), /"action"/)
    const questions = await env.io.readText(`${TASK_DIR}/questions.md`)
    assert.match(questions, /Answer: Yes/)
    assert.equal(await statusLine(env.ctx), 'ewm TASK-001 · INTAKE · 1 open question')

    await expectOk(tool(env, 'decision', { title: 'Scope', choice: 'Only sum()', rationale: 'time' }))
    const task = await taskOf(env)
    assert.equal(task.decisions[0]?.id, 'D-001')
    assert.equal(task.decisions[0]?.decided_by, 'model')
    assert.equal(task.decisions[0]?.phase, 'INTAKE')
    assert.match(await env.io.readText(`${TASK_DIR}/decisions.md`), /D-001 Scope/)
    await expectRefused(tool(env, 'decision', { title: 't', choice: 'c' }), /rationale/)
  })

  it('set_plan checks phase and size; update_step works while building', async () => {
    const env = setup()
    await toPlan(env)
    await expectRefused(tool(env, 'set_plan', { ...PLAN_INPUT, steps: [] }), /steps/)
    const many = Array.from({ length: 31 }, (_, index) => ({ text: `step ${index}`, files: [] }))
    await expectRefused(tool(env, 'set_plan', { ...PLAN_INPUT, steps: many }), /steps/)
    await expectRefused(tool(env, 'update_step', { id: 'S-1', status: 'done' }), /IMPLEMENT, VALIDATE/)
    const saved = await expectOk(tool(env, 'set_plan', { ...PLAN_INPUT, steps: [{ text: 'one', files: ['a'] }, { text: 'two', files: [] }] }))
    assert.match(saved.text, /2 step/)
    assert.deepEqual((await taskOf(env)).plan?.steps.map(step => step.id), ['S-1', 'S-2'])
    await cmd(env, 'approve')

    await expectRefused(tool(env, 'update_step', { id: 'S-9', status: 'done' }), /S-1, S-2/)
    await expectRefused(tool(env, 'update_step', { id: 'S-1', status: 'finished' }), /"status"/)
    await expectOk(tool(env, 'update_step', { id: 'S-1', status: 'done' }))
    assert.match(await env.io.readText(`${TASK_DIR}/plan.md`), /S-1 \[done\]/)
    // Step status does not change the plan hash, so the approval stands.
    await advance(env, 'VALIDATE')
    await advance(env, 'PLAN')
    await advance(env, 'IMPLEMENT')
  })

  it('write_map checks sizes', async () => {
    const env = setup()
    await startTask(env)
    await expectRefused(tool(env, 'write_map', { mermaid: '', text_map: 't', components: [] }), /mermaid/)
    await expectRefused(tool(env, 'write_map', { mermaid: 'x'.repeat(20001), text_map: 't', components: [] }), /too long/)
    const long = `flowchart LR\n  A["${'x'.repeat(19960)}"] --> B`
    await expectOk(tool(env, 'write_map', { mermaid: long, text_map: 't', components: [] }))
  })

  it('write_map refuses Mermaid that does not parse, with the line and column, and derives the components', async () => {
    const env = setup()
    await startTask(env)
    await expectRefused(tool(env, 'write_map', { mermaid: 'x'.repeat(100) }), /first line/)
    await expectRefused(tool(env, 'write_map', { mermaid: 'sequenceDiagram\n  A->>B: hi' }), /"sequenceDiagram" diagrams are not supported/)
    await expectRefused(tool(env, 'write_map', { mermaid: 'flowchart LR\n  A --> B\n  B -> C' }), /line 3, column \d+: expected an arrow/)
    await expectRefused(tool(env, 'write_map', { mermaid: 'flowchart LR\n  subgraph api\n  A --> B' }), /subgraph "api" is not closed/)
    await expectOk(tool(env, 'write_map', { mermaid: 'flowchart LR\n  A[src/a.ts] -->|calls| B[src/b.ts]' }))
    const task = await taskOf(env)
    assert.deepEqual(task.system_map?.components, ['src/a.ts', 'src/b.ts'])
    assert.equal(task.system_map?.text_map, '')
  })

  it('records a command that could not start as a failed run', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    env.answer = new Error('ENOENT npm')
    const out = await expectOk(tool(env, 'run_validation', { command: 'npm test' }))
    assert.match(out.text, /V-001 FAIL/)
    const run = (await taskOf(env)).validations[0]
    assert.equal(run?.exit_code, -1)
    assert.equal(run?.ok, false)
    assert.match(run?.output_tail ?? '', /ENOENT npm/)
  })

  it('does not hold the write queue while a validation command runs', async () => {
    const env = setup({ '/repo/.ewm/project.yaml': PROJECT_YAML })
    await toValidate(env)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const gitAnswers = fakeGit(env.git)
    env.io.onRun(async (argv, opts) => {
      if (argv[0] === 'git') return gitAnswers(argv, opts)
      await gate
      return { exitCode: 0, stdout: 'ok\n', stderr: '' }
    })
    const running = tool(env, 'run_validation', { command: 'npm test' })
    await recordUsage(env.ctx, { input_tokens: 5 }) // would hang if the command held the queue
    assert.equal((await taskOf(env)).usage_by_phase.VALIDATE?.input_tokens, 5)
    release()
    assert.equal((await running).ok, true)
    const task = await taskOf(env)
    assert.equal(task.validations.length, 1)
    assert.equal(task.usage_by_phase.VALIDATE?.input_tokens, 5)
  })
})

describe('hooks support', () => {
  it('statusLine shows the running task and goes quiet when paused', async () => {
    const env = setup()
    assert.equal(await statusLine(env.ctx), null)
    await startTask(env)
    assert.equal(await statusLine(env.ctx), 'ewm TASK-001 · INTAKE')
    await advance(env, 'EXPLORE')
    await expectOk(tool(env, 'question', { action: 'add', text: 'One?' }))
    await expectOk(tool(env, 'question', { action: 'add', text: 'Two?' }))
    assert.equal(await statusLine(env.ctx), 'ewm TASK-001 · EXPLORE · 2 open questions')
    await cmd(env, 'pause')
    assert.equal(await statusLine(env.ctx), null)
    assert.equal((await currentView(env.ctx))?.phase, 'PAUSED')
  })

  it('recordings are no-ops without a running task', async () => {
    const env = setup()
    await recordAgentSpawn(env.ctx, { agent_type: 'ewm:repo-scout', model: 'haiku', rule: 'x' })
    await recordUsage(env.ctx, { turns: 1 })
    await recordDenial(env.ctx, 'Edit', 'no')
    assert.equal(await currentView(env.ctx), null)
    assert.equal(env.io.files.size, Object.keys(SOURCES).length)

    await startTask(env)
    await cmd(env, 'pause')
    await recordUsage(env.ctx, { turns: 1 })
    await recordAgentSpawn(env.ctx, { agent_type: 'ewm:repo-scout', model: 'haiku', rule: 'x' })
    const task = await taskOf(env)
    assert.deepEqual(task.usage_by_phase, {})
    assert.deepEqual(task.agent_usage, [])
  })

  it('recordDenial appends a tool_denied audit line with a redacted reason', async () => {
    const env = setup()
    await startTask(env)
    await advance(env, 'EXPLORE')
    await recordDenial(env.ctx, 'Edit', 'ewm: Edit is not allowed in EXPLORE (API_KEY=abc123)')
    const last = (await env.io.readText(`${TASK_DIR}/audit.jsonl`)).trim().split('\n').at(-1) ?? ''
    const entry = JSON.parse(last) as { kind: string; tool: string; phase: string; detail: string }
    assert.equal(entry.kind, 'tool_denied')
    assert.equal(entry.tool, 'Edit')
    assert.equal(entry.phase, 'EXPLORE')
    assert.doesNotMatch(entry.detail, /abc123/)
  })

  it('recordUsage accumulates per phase', async () => {
    const env = setup()
    await startTask(env)
    await recordUsage(env.ctx, { input_tokens: 10, output_tokens: 2 })
    await recordUsage(env.ctx, { input_tokens: 5, cache_read_input_tokens: 7, turns: 2 })
    await advance(env, 'EXPLORE')
    await recordUsage(env.ctx, { output_tokens: 1 })
    const { usage_by_phase } = await taskOf(env)
    assert.deepEqual(usage_by_phase.INTAKE, { turns: 3, input_tokens: 15, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 })
    assert.equal(usage_by_phase.EXPLORE?.turns, 1)
  })
})
