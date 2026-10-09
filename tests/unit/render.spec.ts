import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatEvidence,
  paneModel,
  renderDecisions,
  renderExploration,
  renderHandoff,
  renderPhaseRail,
  renderPlan,
  renderQuestions,
  renderResumeBrief,
  renderStatus,
  renderSystemMap,
  renderTaskList,
  renderValidation,
} from '../../src/render.ts'
import type { GateState } from '../../src/render.ts'
import { PHASES } from '../../src/types.ts'
import type { Approval, Decision, Finding, Plan, Question, Staleness, Task, ValidationRun } from '../../src/types.ts'
import { AT, deepFreeze, makeProfile, makeTask } from '../support/fixtures.ts'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NO_GATE: GateState = { pending: null, planApproved: false, models: [] }

function makeFinding(n: number, overrides: Partial<Finding> = {}): Finding {
  const id = `F-${String(n).padStart(3, '0')}`
  return {
    id,
    claim: `Claim number ${n}`,
    evidence: [{ path: `src/file${n}.ts`, line_start: n, line_end: n + 5 }],
    confidence: 'medium',
    open_questions: [],
    last_verified_commit: 'abc1234',
    source: 'ewm:repo-scout',
    stale: false,
    recorded_at: AT,
    ...overrides,
  }
}

function makeQuestion(n: number, overrides: Partial<Question> = {}): Question {
  return { id: `Q-${String(n).padStart(3, '0')}`, text: `Question number ${n}?`, status: 'open', raised_at: AT, ...overrides }
}

function makeDecision(n: number, overrides: Partial<Decision> = {}): Decision {
  return {
    id: `D-${String(n).padStart(3, '0')}`,
    title: `Decision ${n}`,
    choice: `Choice ${n}`,
    rationale: `Because ${n}`,
    phase: 'UNDERSTAND',
    decided_by: 'user',
    at: AT,
    ...overrides,
  }
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    summary: 'Fix the accumulator',
    steps: [
      { id: 'S-1', text: 'Change the reducer', files: ['src/sum.ts', 'src/util.ts'], status: 'done' },
      { id: 'S-2', text: 'Add a regression test', files: [], status: 'todo' },
    ],
    risks: ['Callers rely on the old rounding'],
    tests: ['npm test'],
    alternatives: ['Rewrite sum() with BigInt'],
    hash: 'deadbeef',
    updated_at: AT,
    ...overrides,
  }
}

function makeRun(n: number, overrides: Partial<ValidationRun> = {}): ValidationRun {
  return {
    id: `V-${String(n).padStart(3, '0')}`,
    command: 'npm test',
    exit_code: 0,
    ok: true,
    duration_ms: 1234,
    output_tail: 'all green',
    commit: 'abc1234',
    at: AT,
    ...overrides,
  }
}

function makeStaleness(overrides: Partial<Staleness> = {}): Staleness {
  return {
    checked: true,
    branch_changed: false,
    head_changed: false,
    previous: { branch: 'main', commit: 'aaaaaaa' },
    current: { branch: 'main', commit: 'aaaaaaa' },
    changed_paths: [],
    stale_findings: [],
    ...overrides,
  }
}

/** A rich task that exercises every section of every renderer. */
function makeRichTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    phase: 'PLAN',
    title: 'AXI coverage bin investigation',
    goal: 'Find why the coverage bin never fires',
    success_criteria: ['Identify the root cause', 'Prove it with evidence'],
    constraints: ['No changes outside tb/'],
    findings: [
      makeFinding(1, { claim: 'The bin needs a back-to-back burst', evidence: [{ path: 'tb/cov.sv', line_start: 40, line_end: 52, note: 'bin definition' }, { path: 'docs/axi.md', doc_id: 'ADR-3' }], open_questions: ['Is the burst ever generated?'] }),
      makeFinding(2, { claim: 'Sequences never issue bursts', stale: true, confidence: 'low', last_verified_commit: null }),
    ],
    open_questions: [makeQuestion(1), makeQuestion(2, { status: 'resolved', answer: 'Yes', resolved_at: AT })],
    decisions: [makeDecision(1)],
    approvals: [{ gate: 'plan_approval', decision: 'rejected', by: 'user', via: 'command', at: AT, note: 'needs a test step' }],
    transitions: [{ from: 'INTAKE', to: 'EXPLORE', actor: 'model', reason: 'intake done', at: AT }],
    plan: makePlan(),
    validations: [makeRun(1), makeRun(2, { exit_code: 1, ok: false, output_tail: 'FAIL src/sum.test.ts' })],
    system_map: {
      mermaid: 'flowchart TB\n  A[Driver] --> B[Monitor]',
      text_map: 'Driver -> Monitor\n  Monitor -> Scoreboard',
      components: ['Driver', 'Monitor', 'Scoreboard'],
      updated_at: AT,
    },
    ...overrides,
  })
}

/** 30 findings, 10 questions, 5 models: the "large task" of the contract. */
function makeLargeTask(): Task {
  const findings = Array.from({ length: 30 }, (_, i) => makeFinding(i + 1, { stale: i % 3 === 0 }))
  const questions = Array.from({ length: 10 }, (_, i) =>
    makeQuestion(i + 1, { text: `Does module ${i + 1} still honour the legacy contract when the retry budget is exhausted and the queue is full?` }),
  )
  const decisions = Array.from({ length: 12 }, (_, i) =>
    makeDecision(i + 1, {
      title: `Adopt approach ${i + 1} for the shared retry policy across every worker`,
      choice: `Use exponential backoff with jitter capped at ${i + 1} seconds everywhere`,
    }),
  )
  return makeTask({
    phase: 'PLAN',
    title: 'Rework the retry policy across all background workers and document it',
    findings,
    open_questions: questions,
    decisions,
    plan: makePlan({ risks: ['r1', 'r2', 'r3'] }),
    system_map: { mermaid: 'flowchart TB', text_map: 'a\nb', components: ['a', 'b', 'c', 'd', 'e', 'f'], updated_at: AT },
    next_action: 'Review the proposed plan with the person and ask them to approve it or to request changes before any code is written anywhere.',
  })
}

const LARGE_MODELS = [
  'haiku (ewm:repo-scout x4)',
  'haiku (ewm:docs-scout x2)',
  'sonnet (ewm:reviewer x1)',
  'opus (ewm:lead x1)',
  'fable (ewm:planner x1)',
]

function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}

function lineCount(text: string): number {
  return text.split('\n').length
}

// ---------------------------------------------------------------------------
// formatEvidence
// ---------------------------------------------------------------------------

describe('formatEvidence', () => {
  it('formats a path alone', () => {
    assert.equal(formatEvidence({ path: 'README.md' }), 'README.md')
  })

  it('formats a line range', () => {
    assert.equal(formatEvidence({ path: 'src/a.ts', line_start: 10, line_end: 20 }), 'src/a.ts:10-20')
  })

  it('formats a single line, including when the range starts and ends on it', () => {
    assert.equal(formatEvidence({ path: 'src/a.ts', line_start: 10 }), 'src/a.ts:10')
    assert.equal(formatEvidence({ path: 'src/a.ts', line_start: 10, line_end: 10 }), 'src/a.ts:10')
  })

  it('formats a doc id', () => {
    assert.equal(formatEvidence({ path: 'docs/x.md', doc_id: 'ADR-3' }), 'docs/x.md#ADR-3')
  })

  it('combines lines and a doc id, and ignores the note', () => {
    assert.equal(formatEvidence({ path: 'docs/x.md', line_start: 3, line_end: 9, doc_id: 'ADR-3', note: 'n' }), 'docs/x.md:3-9#ADR-3')
  })

  it('ignores a line_end without a line_start', () => {
    assert.equal(formatEvidence({ path: 'src/a.ts', line_end: 9 }), 'src/a.ts')
  })
})

// ---------------------------------------------------------------------------
// renderPhaseRail
// ---------------------------------------------------------------------------

describe('renderPhaseRail', () => {
  const cases: [Parameters<typeof renderPhaseRail>[0], string][] = [
    ['INTAKE', 'Explore > Understand > Plan > Build > Test (intake)'],
    ['EXPLORE', '[EXPLORE] > Understand > Plan > Build > Test'],
    ['UNDERSTAND', 'Explore > [UNDERSTAND] > Plan > Build > Test'],
    ['PLAN', 'Explore > Understand > [PLAN] > Build > Test'],
    ['IMPLEMENT', 'Explore > Understand > Plan > [BUILD] > Test'],
    ['VALIDATE', 'Explore > Understand > Plan > Build > [TEST]'],
    ['DONE', 'Explore > Understand > Plan > Build > Test (done)'],
  ]
  for (const [phase, expected] of cases) {
    it(`renders ${phase}`, () => {
      assert.equal(renderPhaseRail(phase), expected)
    })
  }

  it('marks the stage a paused task will return to, and says paused', () => {
    assert.equal(renderPhaseRail('PAUSED', 'PLAN'), 'Explore > Understand > [PLAN] > Build > Test (paused)')
    assert.equal(renderPhaseRail('PAUSED', 'VALIDATE'), 'Explore > Understand > Plan > Build > [TEST] (paused)')
  })

  it('renders a paused task without a known origin, or paused before the rail started', () => {
    assert.equal(renderPhaseRail('PAUSED'), 'Explore > Understand > Plan > Build > Test (paused)')
    assert.equal(renderPhaseRail('PAUSED', null), 'Explore > Understand > Plan > Build > Test (paused)')
    assert.equal(renderPhaseRail('PAUSED', 'INTAKE'), 'Explore > Understand > Plan > Build > Test (paused)')
  })

  it('ignores pausedFrom when the phase is not PAUSED', () => {
    assert.equal(renderPhaseRail('PLAN', 'EXPLORE'), 'Explore > Understand > [PLAN] > Build > Test')
  })

  it('is ASCII only for every phase', () => {
    for (const phase of PHASES) assert.match(renderPhaseRail(phase, 'PLAN'), /^[\x20-\x7e]+$/)
  })
})

// ---------------------------------------------------------------------------
// paneModel
// ---------------------------------------------------------------------------

describe('paneModel', () => {
  it('copies the identity fields', () => {
    const pane = paneModel(deepFreeze(makeTask({ phase: 'EXPLORE', next_action: 'Do X' })), makeProfile({ profile_id: 'silicon-dv' }), NO_GATE)
    assert.equal(pane.project, 'silicon-dv')
    assert.equal(pane.task_id, 'TASK-001')
    assert.equal(pane.title, 'Investigate sum()')
    assert.equal(pane.phase, 'EXPLORE')
    assert.equal(pane.paused_from, null)
    assert.equal(pane.next_action, 'Do X')
    assert.equal(pane.pending_gate, null)
  })

  it('counts components from the map and is 0 without one', () => {
    const profile = makeProfile()
    assert.equal(paneModel(makeRichTask(), profile, NO_GATE).counts.components, 3)
    assert.equal(paneModel(makeTask(), profile, NO_GATE).counts.components, 0)
  })

  it('counts sources as distinct evidence paths', () => {
    const task = makeTask({
      findings: [
        makeFinding(1, { evidence: [{ path: 'a.ts', line_start: 1 }, { path: 'b.ts' }] }),
        makeFinding(2, { evidence: [{ path: 'a.ts', line_start: 9 }, { path: 'a.ts', doc_id: 'x' }] }),
        makeFinding(3, { evidence: [{ path: 'c.md', doc_id: 'ADR-1' }] }),
      ],
    })
    assert.equal(paneModel(task, makeProfile(), NO_GATE).counts.sources, 3)
  })

  it('counts open questions, plan risks, findings and stale findings', () => {
    const task = makeRichTask()
    const { counts } = paneModel(task, makeProfile(), NO_GATE)
    assert.deepEqual(counts, { components: 3, sources: 3, open_questions: 1, risks: 1, findings: 2, stale: 1 })
  })

  it('counts risks as 0 without a plan', () => {
    assert.equal(paneModel(makeTask(), makeProfile(), NO_GATE).counts.risks, 0)
  })

  it('takes the rail from the phase, or from paused_from while paused', () => {
    const profile = makeProfile()
    const understand = paneModel(makeTask({ phase: 'UNDERSTAND' }), profile, NO_GATE)
    assert.deepEqual(
      understand.rail.map(stage => `${stage.label}:${stage.state}`),
      ['Explore:done', 'Understand:current', 'Plan:todo', 'Build:todo', 'Test:todo'],
    )
    const paused = paneModel(makeTask({ phase: 'PAUSED', paused_from: 'IMPLEMENT' }), profile, NO_GATE)
    assert.deepEqual(
      paused.rail.map(stage => stage.state),
      ['done', 'done', 'done', 'current', 'todo'],
    )
    assert.equal(paused.paused_from, 'IMPLEMENT')
    assert.ok(paneModel(makeTask({ phase: 'DONE' }), profile, NO_GATE).rail.every(stage => stage.state === 'done'))
    assert.ok(paneModel(makeTask({ phase: 'INTAKE' }), profile, NO_GATE).rail.every(stage => stage.state === 'todo'))
  })

  it('takes models and the pending gate from the GateState, as a copy', () => {
    const models = ['haiku (ewm:repo-scout x2)']
    const pane = paneModel(makeTask(), makeProfile(), { pending: 'plan_approval', planApproved: false, models })
    assert.deepEqual(pane.models, models)
    assert.notEqual(pane.models, models)
    assert.equal(pane.pending_gate, 'plan_approval')
  })

  it('uses the text map lines for map_lines, else the components, else nothing', () => {
    const profile = makeProfile()
    assert.deepEqual(paneModel(makeRichTask(), profile, NO_GATE).map_lines, ['Driver -> Monitor', '  Monitor -> Scoreboard'])
    const noText = makeTask({ system_map: { mermaid: 'flowchart TB', text_map: '  \n', components: ['A', 'B'], updated_at: AT } })
    assert.deepEqual(paneModel(noText, profile, NO_GATE).map_lines, ['A', 'B'])
    assert.deepEqual(paneModel(makeTask(), profile, NO_GATE).map_lines, [])
  })

  it('lists only open questions as "Q-001 text"', () => {
    const pane = paneModel(makeRichTask(), makeProfile(), NO_GATE)
    assert.deepEqual(pane.question_lines, ['Q-001 Question number 1?'])
  })

  it('does not mutate a frozen task', () => {
    assert.doesNotThrow(() => paneModel(deepFreeze(makeRichTask()), deepFreeze(makeProfile()), deepFreeze({ ...NO_GATE, models: ['x'] })))
  })

  it('does not share arrays with the task', () => {
    const task = makeRichTask()
    const pane = paneModel(task, makeProfile(), NO_GATE)
    pane.map_lines.push('extra')
    assert.equal(task.system_map?.components.length, 3)
  })
})

// ---------------------------------------------------------------------------
// renderStatus
// ---------------------------------------------------------------------------

describe('renderStatus', () => {
  const profile = makeProfile({ profile_id: 'silicon-dv' })

  it('explains how to start when there is no task', () => {
    const text = renderStatus(null, profile, NO_GATE)
    assert.match(text, /No active task/)
    assert.match(text, /\/ewm new/)
    assert.match(text, /\/ewm list/)
  })

  it('shows project, task, phase, rail, counts, models and next action', () => {
    const task = makeRichTask({ phase: 'UNDERSTAND', next_action: 'Compare sequences with the coverage definition' })
    const text = renderStatus(deepFreeze(task), deepFreeze(profile), deepFreeze({ pending: null, planApproved: false, models: ['haiku (ewm:repo-scout x2)', 'sonnet (ewm:reviewer x1)'] }))
    assert.match(text, /Project: silicon-dv/)
    assert.match(text, /Task: TASK-001 - AXI coverage bin investigation/)
    assert.match(text, /Phase: UNDERSTAND/)
    assert.match(text, /Explore > \[UNDERSTAND\] > Plan > Build > Test/)
    assert.match(text, /Components: 3 \| Sources: 3 \| Open questions: 1 \| Risks: 1 \| Findings: 2 \| Stale: 1/)
    assert.match(text, /haiku \(ewm:repo-scout x2\)/)
    assert.match(text, /sonnet \(ewm:reviewer x1\)/)
    assert.match(text, /Next: Compare sequences with the coverage definition/)
  })

  it('says no models were used yet when there are none', () => {
    assert.match(renderStatus(makeTask(), profile, NO_GATE), /Models: none used yet/)
  })

  it('tells the person how to act on a pending plan gate', () => {
    const text = renderStatus(makeRichTask(), profile, { pending: 'plan_approval', planApproved: false, models: [] })
    assert.match(text, /plan approval pending/)
    assert.match(text, /\/ewm approve/)
    assert.match(text, /\/ewm reject <reason>/)
  })

  it('tells the person how to act on a pending acceptance gate', () => {
    const text = renderStatus(makeRichTask({ phase: 'VALIDATE' }), profile, { pending: 'done_acceptance', planApproved: true, models: [] })
    assert.match(text, /final acceptance pending/)
    assert.match(text, /\/ewm approve/)
    assert.match(text, /\/ewm reject <reason>/)
  })

  it('does not ask for approval when no gate is pending', () => {
    const text = renderStatus(makeRichTask({ phase: 'EXPLORE' }), profile, NO_GATE)
    assert.match(text, /Gate: none pending/)
    assert.doesNotMatch(text, /\/ewm approve/)
    assert.match(renderStatus(makeRichTask({ phase: 'IMPLEMENT' }), profile, { ...NO_GATE, planApproved: true }), /plan approved/)
  })

  it('shows where a paused task will resume', () => {
    const text = renderStatus(makeTask({ phase: 'PAUSED', paused_from: 'PLAN' }), profile, NO_GATE)
    assert.match(text, /Phase: PAUSED \(from PLAN\)/)
    assert.match(text, /\[PLAN\].*\(paused\)/)
  })

  it('stays within 20 lines for a large task with a pending gate', () => {
    const text = renderStatus(deepFreeze(makeLargeTask()), profile, { pending: 'plan_approval', planApproved: false, models: LARGE_MODELS })
    assert.ok(lineCount(text) <= 20, `${lineCount(text)} lines:\n${text}`)
    assert.match(text, /Findings: 30/)
    assert.match(text, /Open questions: 10/)
    assert.match(text, /Stale: 10/)
    for (const model of LARGE_MODELS) assert.ok(text.includes(model), model)
    assert.match(text, /\/ewm approve/)
    assert.match(text, /\/ewm reject <reason>/)
  })

  it('caps the model list and keeps multi-line titles and next actions on one line each', () => {
    const many = Array.from({ length: 40 }, (_, i) => `model-${i} (ewm:agent x1)`)
    const task = makeLargeTask()
    const messy = { ...task, title: 'A title\nwith\nbreaks', next_action: 'Line one\n\nline two' }
    const text = renderStatus(messy, profile, { pending: 'done_acceptance', planApproved: true, models: many })
    assert.ok(lineCount(text) <= 20, `${lineCount(text)} lines`)
    assert.match(text, /\+35 more/)
    assert.match(text, /Task: TASK-001 - A title with breaks/)
    assert.match(text, /Next: Line one line two/)
  })
})

// ---------------------------------------------------------------------------
// renderTaskList
// ---------------------------------------------------------------------------

describe('renderTaskList', () => {
  it('says there are no tasks', () => {
    assert.match(renderTaskList([], null), /No tasks yet/)
  })

  it('lists id, phase and title, and marks the active task', () => {
    const text = renderTaskList(
      [
        { id: 'TASK-001', title: 'First', phase: 'DONE', updated_at: '2026-10-01T10:00:00.000Z' },
        { id: 'TASK-002', title: 'Second', phase: 'PLAN', updated_at: AT },
      ],
      'TASK-002',
    )
    const lines = text.split('\n')
    assert.equal(lines[0], 'Tasks (2):')
    assert.match(lines[1] ?? '', /TASK-001 \[DONE\] First/)
    assert.doesNotMatch(lines[1] ?? '', /active/)
    assert.match(lines[2] ?? '', /TASK-002 \[PLAN\] Second/)
    assert.match(lines[2] ?? '', /\(active\)/)
    assert.match(text, /\/ewm resume/)
  })

  it('does not mark a task when the active id is unknown or null', () => {
    const tasks = [{ id: 'TASK-001', title: 'First', phase: 'EXPLORE' as const, updated_at: AT }]
    assert.doesNotMatch(renderTaskList(tasks, null), /active/)
    assert.doesNotMatch(renderTaskList(tasks, 'TASK-009'), /active/)
  })
})

// ---------------------------------------------------------------------------
// Markdown artifacts
// ---------------------------------------------------------------------------

describe('markdown artifacts', () => {
  const task = deepFreeze(makeRichTask())
  const gate: GateState = deepFreeze({ pending: null, planApproved: false, models: [] })
  const renderers: [string, (t: Task) => string][] = [
    ['Exploration', renderExploration],
    ['Questions', renderQuestions],
    ['Decisions', renderDecisions],
    ['Plan', t => renderPlan(t, gate)],
    ['Validation', renderValidation],
    ['System map', renderSystemMap],
    ['Handoff', t => renderHandoff(t, ['src/sum.ts'])],
  ]

  for (const [name, render] of renderers) {
    it(`${name} starts with the "# ${name} - TASK-NNN: title" heading`, () => {
      assert.ok(render(task).startsWith(`# ${name} - TASK-001: AXI coverage bin investigation\n`), render(task).split('\n')[0])
    })

    it(`${name} is deterministic and ends with one newline`, () => {
      const first = render(task)
      assert.equal(render(structuredClone(task)), first)
      assert.ok(first.endsWith('\n') && !first.endsWith('\n\n'))
    })

    it(`${name} is plain text without ANSI codes or emoji`, () => {
      assert.match(render(task), /^[\x20-\x7e\n]+$/)
    })

    it(`${name} keeps a multi-line title on the heading line`, () => {
      const heading = render({ ...task, title: 'Two\nlines' }).split('\n')[0]
      assert.equal(heading, `# ${name} - TASK-001: Two lines`)
    })
  }

  it('renders empty tasks without throwing', () => {
    const empty = deepFreeze(makeTask())
    for (const [, render] of renderers) assert.ok(render(empty).startsWith('# '))
  })
})

describe('renderExploration', () => {
  const text = renderExploration(deepFreeze(makeRichTask()))

  it('shows each finding with id, claim, confidence, source and evidence', () => {
    assert.match(text, /## F-001 - The bin needs a back-to-back burst/)
    assert.match(text, /Confidence: medium/)
    assert.match(text, /Source: ewm:repo-scout/)
    assert.match(text, /`tb\/cov\.sv:40-52` - bin definition/)
    assert.match(text, /`docs\/axi\.md#ADR-3`/)
    assert.match(text, /Verified at commit: abc1234/)
  })

  it('lists the open questions of a finding, or says there are none', () => {
    assert.match(text, /Open questions:\n {2}- Is the burst ever generated\?/)
    assert.match(text, /Open questions: none/)
  })

  it('marks stale findings STALE and only those', () => {
    assert.match(text, /## F-002 \[STALE\] - Sequences never issue bursts/)
    assert.doesNotMatch(text, /## F-001 \[STALE\]/)
    assert.match(text, /Verified at commit: not recorded/)
    assert.match(text, /1 finding marked STALE/)
  })

  it('has no STALE marker when nothing is stale', () => {
    assert.doesNotMatch(renderExploration(makeTask({ findings: [makeFinding(1)] })), /STALE/)
  })

  it('says when there are no findings', () => {
    assert.match(renderExploration(makeTask()), /No findings recorded yet/)
  })

  it('protects evidence paths that contain backticks', () => {
    const odd = makeTask({ findings: [makeFinding(1, { evidence: [{ path: 'weird`name.ts' }] })] })
    assert.match(renderExploration(odd), /`` weird`name\.ts ``/)
  })
})

describe('renderQuestions', () => {
  it('separates open and resolved questions with answers', () => {
    const text = renderQuestions(deepFreeze(makeRichTask()))
    assert.match(text, /Open: 1 \| Resolved: 1/)
    assert.match(text, /## Open\n\n- Q-001: Question number 1\?/)
    assert.match(text, /## Resolved\n\n- Q-002: Question number 2\?\n {2}Answer: Yes/)
  })

  it('says None when a section is empty', () => {
    const text = renderQuestions(makeTask())
    assert.match(text, /## Open\n\nNone\./)
    assert.match(text, /## Resolved\n\nNone\./)
  })
})

describe('renderDecisions', () => {
  const text = renderDecisions(deepFreeze(makeRichTask()))

  it('includes the goal, success criteria and constraints', () => {
    assert.match(text, /## Goal\n\nFind why the coverage bin never fires/)
    assert.match(text, /## Success criteria\n\n- Identify the root cause\n- Prove it with evidence/)
    assert.match(text, /## Constraints\n\n- No changes outside tb\//)
  })

  it('lists decisions with choice, rationale, phase and author', () => {
    assert.match(text, /D-001 Decision 1 \(UNDERSTAND, by user, /)
    assert.match(text, /Choice: Choice 1/)
    assert.match(text, /Rationale: Because 1/)
  })

  it('lists approvals with gate, decision, via, time and note', () => {
    const approval: Approval = { gate: 'plan_approval', decision: 'rejected', by: 'user', via: 'command', at: AT, note: 'needs a test step' }
    assert.ok(text.includes(`- ${approval.gate}: ${approval.decision} via ${approval.via} at ${approval.at} - ${approval.note}`), text)
  })

  it('lists transitions', () => {
    assert.match(text, /INTAKE -> EXPLORE by model at .*: intake done/)
  })

  it('shows placeholders for an empty task', () => {
    const empty = renderDecisions(makeTask({ goal: '' }))
    assert.match(empty, /## Goal\n\nNot set\./)
    assert.match(empty, /## Success criteria\n\nNone recorded yet\./)
    assert.match(empty, /## Decisions\n\nNone recorded yet\./)
    assert.match(empty, /## Approvals\n\nNone recorded yet\./)
  })

  it('keeps multi-line rationale inside its list item', () => {
    const multi = renderDecisions(makeTask({ decisions: [makeDecision(1, { rationale: 'first\nsecond' })] }))
    assert.match(multi, /Rationale: first\n {4}second/)
  })
})

describe('renderPlan', () => {
  const task = deepFreeze(makeRichTask())

  it('shows not approved from the GateState', () => {
    const text = renderPlan(task, { pending: null, planApproved: false, models: [] })
    assert.match(text, /Approval: not approved/)
  })

  it('shows approved from the GateState, whatever the stored approvals say', () => {
    const text = renderPlan(task, { pending: null, planApproved: true, models: [] })
    assert.match(text, /Approval: approved/)
    assert.doesNotMatch(text, /not approved/)
  })

  it('tells the person how to act when approval is pending', () => {
    const text = renderPlan(task, { pending: 'plan_approval', planApproved: false, models: [] })
    assert.match(text, /\/ewm approve/)
    assert.match(text, /\/ewm reject <reason>/)
    assert.doesNotMatch(renderPlan(task, { pending: null, planApproved: true, models: [] }), /\/ewm approve/)
  })

  it('shows summary, steps with status and files, risks, tests and alternatives', () => {
    const text = renderPlan(task, NO_GATE)
    assert.match(text, /## Summary\n\nFix the accumulator/)
    assert.match(text, /- S-1 \[done\] Change the reducer\n {2}- Files: `src\/sum\.ts`, `src\/util\.ts`/)
    assert.match(text, /- S-2 \[todo\] Add a regression test\n\n/)
    assert.match(text, /## Risks\n\n- Callers rely on the old rounding/)
    assert.match(text, /## Tests\n\n- npm test/)
    assert.match(text, /## Alternatives\n\n- Rewrite sum\(\) with BigInt/)
  })

  it('explains that there is no plan yet', () => {
    const text = renderPlan(makeTask(), NO_GATE)
    assert.match(text, /No plan recorded yet/)
    assert.match(text, /Approval: not approved/)
    assert.doesNotMatch(text, /## Steps/)
  })
})

describe('renderValidation', () => {
  const text = renderValidation(deepFreeze(makeRichTask()))

  it('shows each run with command, exit code, result, duration, commit and output tail', () => {
    assert.match(text, /Runs: 2 \(1 passed, 1 failed\)/)
    assert.match(text, /## V-001 - PASS/)
    assert.match(text, /## V-002 - FAIL/)
    assert.match(text, /- Command: `npm test`/)
    assert.match(text, /- Exit code: 0/)
    assert.match(text, /- Exit code: 1/)
    assert.match(text, /- Result: failed/)
    assert.match(text, /- Duration: 1234 ms/)
    assert.match(text, /- Commit: abc1234/)
    assert.match(text, /```text\nall green\n```/)
    assert.match(text, /```text\nFAIL src\/sum\.test\.ts\n```/)
  })

  it('uses a longer fence when the output contains a fence', () => {
    const noisy = renderValidation(makeTask({ validations: [makeRun(1, { output_tail: 'before\n```\ninside\n```\nafter' })] }))
    assert.match(noisy, /````text\nbefore\n```\ninside\n```\nafter\n````/)
  })

  it('handles empty output and an unknown commit', () => {
    const quiet = renderValidation(makeTask({ validations: [makeRun(1, { output_tail: '', commit: null })] }))
    assert.match(quiet, /Output: none\./)
    assert.match(quiet, /- Commit: unknown/)
  })

  it('explains that nothing ran yet', () => {
    assert.match(renderValidation(makeTask()), /No validation runs recorded yet/)
  })
})

describe('renderSystemMap', () => {
  it('shows the text map, components and a mermaid block', () => {
    const text = renderSystemMap(deepFreeze(makeRichTask()))
    assert.match(text, /## Text map\n\n```text\nDriver -> Monitor\n {2}Monitor -> Scoreboard\n```/)
    assert.match(text, /## Components\n\n- Driver\n- Monitor\n- Scoreboard/)
    assert.match(text, /## Diagram\n\n```mermaid\nflowchart TB\n {2}A\[Driver\] --> B\[Monitor\]\n```/)
  })

  it('shows a placeholder line when there is no map', () => {
    const text = renderSystemMap(makeTask())
    assert.match(text, /^# System map - TASK-001: Investigate sum\(\)\n\nNo system map recorded yet/)
    assert.doesNotMatch(text, /mermaid\n/)
  })
})

describe('renderHandoff', () => {
  const done = makeRichTask({
    phase: 'DONE',
    approvals: [{ gate: 'done_acceptance', decision: 'approved', by: 'user', via: 'command', at: AT }],
  })
  const text = renderHandoff(deepFreeze(done), ['src/sum.ts', 'tests/sum.test.ts'])

  it('has the summary, goal, criteria, decisions, files, validations, questions and follow-ups', () => {
    for (const title of ['Summary', 'Goal', 'Success criteria', 'Decisions', 'Files changed', 'Validation', 'Open questions', 'Follow-ups']) {
      assert.ok(text.includes(`## ${title}\n`), title)
    }
    assert.match(text, /Final phase: DONE/)
    assert.match(text, /Plan: Fix the accumulator/)
    assert.match(text, /Steps done: 1 of 2/)
    assert.match(text, /Find why the coverage bin never fires/)
    assert.match(text, /- Identify the root cause/)
    assert.match(text, /D-001 Decision 1: Choice 1 \(Because 1\)/)
  })

  it('lists the given changed files in order', () => {
    assert.match(text, /## Files changed\n\n- `src\/sum\.ts`\n- `tests\/sum\.test\.ts`/)
  })

  it('lists validation runs and still-open questions', () => {
    assert.match(text, /V-001 PASS: `npm test` \(exit 0, 1234 ms, commit abc1234\)/)
    assert.match(text, /V-002 FAIL: `npm test` \(exit 1/)
    assert.match(text, /## Open questions\n\n- Q-001: Question number 1\?/)
  })

  it('lists follow-ups: unfinished steps, stale evidence and a failing last run', () => {
    assert.match(text, /## Follow-ups\n\n- S-2 \[todo\] Add a regression test/)
    assert.match(text, /Re-verify stale evidence before reuse: F-002/)
    assert.match(text, /The last validation run V-002 failed \(exit 1\)/)
  })

  it('says so when there is nothing to report', () => {
    const bare = renderHandoff(makeTask({ phase: 'DONE' }), [])
    assert.match(bare, /## Files changed\n\nNo changed files detected\./)
    assert.match(bare, /## Follow-ups\n\nNone\./)
    assert.match(bare, /## Validation\n\nNo validation runs recorded\./)
  })

  it('does not mutate the given file list', () => {
    const files = Object.freeze(['b.ts', 'a.ts'])
    renderHandoff(makeTask(), files)
    assert.deepEqual([...files], ['b.ts', 'a.ts'])
  })
})

// ---------------------------------------------------------------------------
// renderResumeBrief
// ---------------------------------------------------------------------------

describe('renderResumeBrief', () => {
  it('says where we were, with the decisions, questions and next action', () => {
    const task = makeRichTask({ phase: 'UNDERSTAND', next_action: 'Compare sequences against the coverage definition' })
    const text = renderResumeBrief(deepFreeze(task), makeStaleness())
    assert.match(text, /^Resuming TASK-001: AXI coverage bin investigation/)
    assert.match(text, /Where we were: UNDERSTAND/)
    assert.match(text, /Decisions \(1\):\n {2}D-001 Decision 1: Choice 1/)
    assert.match(text, /Open questions \(1\):\n {2}Q-001 Question number 1\?/)
    assert.match(text, /Next: Compare sequences against the coverage definition/)
  })

  it('names the phase a paused task came from', () => {
    const text = renderResumeBrief(makeTask({ phase: 'PAUSED', paused_from: 'PLAN' }), makeStaleness())
    assert.match(text, /Where we were: PAUSED \(was PLAN\)/)
  })

  it('lists the approved gates, but not a plan approval that no longer matches the plan', () => {
    const approved: Approval = { gate: 'plan_approval', decision: 'approved', by: 'user', via: 'pane', at: AT, plan_hash: 'deadbeef' }
    const task = makeRichTask({ approvals: [approved, { gate: 'done_acceptance', decision: 'rejected', by: 'user', via: 'command', at: AT }] })
    assert.match(renderResumeBrief(task, makeStaleness()), /Approved gates: plan$/m)
    const edited = { ...task, plan: makePlan({ hash: 'changed' }) }
    assert.doesNotMatch(renderResumeBrief(edited, makeStaleness()), /Approved gates/)
    const rejectedLater = { ...task, approvals: [approved, { ...approved, decision: 'rejected' as const }] }
    assert.doesNotMatch(renderResumeBrief(rejectedLater, makeStaleness()), /Approved gates/)
  })

  it('says when there are no decisions or open questions', () => {
    const text = renderResumeBrief(makeTask(), makeStaleness())
    assert.match(text, /Decisions: none recorded yet/)
    assert.match(text, /Open questions: none/)
  })

  it('lists at most 5 open questions and counts the rest', () => {
    const questions = Array.from({ length: 8 }, (_, i) => makeQuestion(i + 1))
    const text = renderResumeBrief(makeTask({ open_questions: questions }), makeStaleness())
    assert.match(text, /Open questions \(8\):/)
    assert.match(text, /Q-005 /)
    assert.doesNotMatch(text, /Q-006/)
    assert.match(text, /\+3 more/)
  })

  it('does not list resolved questions', () => {
    const text = renderResumeBrief(makeTask({ open_questions: [makeQuestion(1, { status: 'resolved', answer: 'x' }), makeQuestion(2)] }), makeStaleness())
    assert.match(text, /Open questions \(1\):/)
    assert.doesNotMatch(text, /Q-001/)
  })

  it('reports the stale evidence count and the changed paths when staleness was checked', () => {
    const task = makeTask({
      findings: [
        makeFinding(1, { stale: true, evidence: [{ path: 'src/a.ts', line_start: 1 }] }),
        makeFinding(2, { stale: true, evidence: [{ path: 'src/b.ts', line_start: 1 }, { path: 'src/untouched.ts' }] }),
        makeFinding(3),
      ],
    })
    const staleness = makeStaleness({ head_changed: true, changed_paths: ['src/a.ts', 'src/b.ts', 'README.md'], stale_findings: ['F-001', 'F-002'] })
    const text = renderResumeBrief(deepFreeze(task), deepFreeze(staleness))
    assert.match(text, /Stale evidence: 2 findings \(HEAD changed\): src\/a\.ts, src\/b\.ts$/m)
    assert.doesNotMatch(text, /untouched/)
    assert.doesNotMatch(text, /README/)
  })

  it('counts findings that this check reports even when the task is not flagged yet', () => {
    const task = makeTask({ findings: [makeFinding(1), makeFinding(2)] })
    const text = renderResumeBrief(task, makeStaleness({ branch_changed: true, changed_paths: ['src/file1.ts'], stale_findings: ['F-001'] }))
    assert.match(text, /Stale evidence: 1 finding \(branch changed\): src\/file1\.ts/)
  })

  it('caps the stale paths shown', () => {
    const findings = Array.from({ length: 9 }, (_, i) => makeFinding(i + 1, { stale: true }))
    const text = renderResumeBrief(makeTask({ findings }), makeStaleness({ changed_paths: findings.map(f => f.evidence[0]?.path ?? '') }))
    assert.match(text, /Stale evidence: 9 findings: src\/file1\.ts, src\/file2\.ts, src\/file3\.ts, src\/file4\.ts \(\+5 more\)/)
  })

  it('says none are stale when staleness was checked and nothing changed', () => {
    assert.match(renderResumeBrief(makeTask({ findings: [makeFinding(1)] }), makeStaleness()), /Stale evidence: none/)
  })

  it('says staleness could not be checked, with the reason, when it was not checked', () => {
    const text = renderResumeBrief(makeTask(), makeStaleness({ checked: false, note: 'git is not available here' }))
    assert.match(text, /Staleness could not be checked \(git is not available here\)/)
    assert.match(text, /re-verify evidence/)
    assert.doesNotMatch(text, /Stale evidence/)
    assert.match(renderResumeBrief(makeTask(), makeStaleness({ checked: false })), /Staleness could not be checked:/)
  })

  it('stays within 180 words for a large task', () => {
    const task = deepFreeze({ ...makeLargeTask(), phase: 'PAUSED' as const, paused_from: 'PLAN' as const })
    const findings = task.findings
    const staleness = makeStaleness({
      head_changed: true,
      branch_changed: true,
      changed_paths: findings.map(f => f.evidence[0]?.path ?? ''),
      stale_findings: findings.filter(f => f.stale).map(f => f.id),
    })
    const text = renderResumeBrief(task, staleness)
    assert.ok(wordCount(text) <= 180, `${wordCount(text)} words:\n${text}`)
    assert.match(text, /Open questions \(10\):/)
    assert.match(text, /\+5 more/)
    assert.match(text, /Stale evidence: 10 findings/)
  })

  it('stays within 180 words even with very long titles, notes, paths and approvals', () => {
    const words = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')
    const base = makeLargeTask()
    const task = deepFreeze({
      ...base,
      title: words(80, 'title'),
      next_action: words(200, 'next'),
      open_questions: base.open_questions.map(q => ({ ...q, text: words(60, 'q') })),
      decisions: base.decisions.map(d => ({ ...d, title: words(30, 'dt'), choice: words(30, 'dc') })),
      approvals: [
        { gate: 'plan_approval' as const, decision: 'approved' as const, by: 'user' as const, via: 'command' as const, at: AT },
        { gate: 'done_acceptance' as const, decision: 'approved' as const, by: 'user' as const, via: 'pane' as const, at: AT },
      ],
      plan: null,
    })
    const text = renderResumeBrief(task, makeStaleness({ head_changed: true, branch_changed: true, changed_paths: task.findings.map(f => f.evidence[0]?.path ?? ''), stale_findings: task.findings.map(f => f.id) }))
    assert.ok(wordCount(text) <= 180, `${wordCount(text)} words:\n${text}`)
    const unchecked = renderResumeBrief(task, makeStaleness({ checked: false, note: words(50, 'note') }))
    assert.ok(wordCount(unchecked) <= 180, `${wordCount(unchecked)} words:\n${unchecked}`)
  })

  it('is far shorter than the limit for a small task', () => {
    assert.ok(wordCount(renderResumeBrief(makeTask(), makeStaleness())) < 60)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe('plain output', () => {
  it('uses only printable ASCII in the text renderers', () => {
    const task = makeRichTask({ phase: 'PAUSED', paused_from: 'PLAN' })
    const gate: GateState = { pending: 'plan_approval', planApproved: false, models: ['haiku (ewm:repo-scout x2)'] }
    const outputs = [
      renderStatus(task, makeProfile(), gate),
      renderStatus(null, makeProfile(), gate),
      renderTaskList([{ id: 'TASK-001', title: 'x', phase: 'PLAN', updated_at: AT }], 'TASK-001'),
      renderResumeBrief(task, makeStaleness()),
      renderResumeBrief(task, makeStaleness({ checked: false })),
    ]
    for (const text of outputs) assert.match(text, /^[\x20-\x7e\n]+$/, text)
  })
})
