// Renderers for the person and the model: terminal text, markdown artifacts,
// the pane view model and the resume brief. Pure and deterministic: no Io, no
// clock, no mutation of inputs. Gate state and model lines arrive in GateState,
// so this module needs neither controller.ts nor router.ts.
//
// Output is shown in terminals and in markdown viewers, so structure uses plain
// ASCII ('>', '-', '#'): no emoji and no ANSI codes.

import type { ActivePhase, Approval, Evidence, Finding, GateName, PaneModel, Phase, Profile, Question, Staleness, Task, TaskSummary, ValidationRun } from './types.ts'

/** Computed by the caller (service): pendingGate/hasValidApproval on the trusted task, and summarizeModels(task.agent_usage).
 *  `plan` is the plan the person is being asked to approve (set only while plan_approval is pending); hash is the full SHA-256. */
export type GateState = { pending: GateName | null; planApproved: boolean; models: string[]; plan?: { hash: string; steps: number; summary: string } | null }

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** ANSI escape sequences (CSI and OSC) and every other C0/C1 control character except \n and \t. Model-written text must not drive the terminal (CR16). */
export function stripControls(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

function oneLine(text: string): string {
  return stripControls(text.replace(/[\r\v\f]/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** At most `max` whitespace-separated words, with "..." attached to the last one when cut. */
function clipWords(text: string, max: number): string {
  const words = oneLine(text).split(' ').filter(word => word !== '')
  return words.length <= max ? words.join(' ') : `${words.slice(0, max).join(' ')}...`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

function heading(artifact: string, task: Task): string {
  return `# ${artifact} - ${task.id}: ${oneLine(task.title)}`
}

/** Blocks separated by blank lines, ending with a single newline. */
function document(...blocks: string[]): string {
  return `${stripControls(blocks.join('\n\n'))}\n`
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`
}

/** A list item whose continuation lines stay inside the item. */
function bullet(text: string, indent = ''): string {
  const [first = '', ...rest] = text.trim().split(/\r?\n/)
  return [`${indent}- ${first}`, ...rest.map(line => `${indent}  ${line}`.trimEnd())].join('\n')
}

function bulletList(items: readonly string[], whenEmpty: string): string {
  return items.length === 0 ? whenEmpty : items.map(item => bullet(item)).join('\n')
}

function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

/** A fenced block that cannot be closed early by backticks inside the body. */
function fence(body: string, info = ''): string {
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length))
  const marks = '`'.repeat(Math.max(3, longestRun + 1))
  return `${marks}${info}\n${body.replace(/\s+$/, '')}\n${marks}`
}

// ---------------------------------------------------------------------------
// Evidence, phase rail, pane model
// ---------------------------------------------------------------------------

/** "src/a.ts:10-20", "src/a.ts:10", "docs/x.md#ADR-3", "README.md" (lines and doc id combine as "path:10-20#id"). */
export function formatEvidence(e: Evidence): string {
  let text = e.path
  if (e.line_start !== undefined) {
    text += `:${e.line_start}`
    if (e.line_end !== undefined && e.line_end !== e.line_start) text += `-${e.line_end}`
  }
  if (e.doc_id !== undefined && e.doc_id !== '') text += `#${e.doc_id}`
  return text
}

const RAIL_LABELS: PaneModel['rail'][number]['label'][] = ['Explore', 'Understand', 'Plan', 'Build', 'Test']

const RAIL_STAGE_OF_PHASE: Partial<Record<Phase, number>> = {
  EXPLORE: 0,
  UNDERSTAND: 1,
  PLAN: 2,
  IMPLEMENT: 3,
  VALIDATE: 4,
}

/** INTAKE precedes the rail (nothing current, nothing done); DONE completes it; PAUSED shows the phase it was paused from. */
function railOf(phase: Phase, pausedFrom: ActivePhase | null): PaneModel['rail'] {
  const effective: Phase | null = phase === 'PAUSED' ? pausedFrom : phase
  if (effective === 'DONE') return RAIL_LABELS.map(label => ({ label, state: 'done' }))
  const current = effective === null ? -1 : (RAIL_STAGE_OF_PHASE[effective] ?? -1)
  return RAIL_LABELS.map((label, index) => ({
    label,
    state: index < current ? 'done' : index === current ? 'current' : 'todo',
  }))
}

function railText(rail: PaneModel['rail'], phase: Phase): string {
  const stages = rail.map(stage => (stage.state === 'current' ? `[${stage.label.toUpperCase()}]` : stage.label)).join(' > ')
  if (phase === 'PAUSED') return `${stages} (paused)`
  if (phase === 'DONE') return `${stages} (done)`
  if (phase === 'INTAKE') return `${stages} (intake)`
  return stages
}

/** "Explore > [UNDERSTAND] > Plan > Build > Test", plus " (paused)" while paused. INTAKE and DONE mark no stage and add " (intake)" / " (done)". */
export function renderPhaseRail(phase: Phase, pausedFrom?: ActivePhase | null): string {
  return railText(railOf(phase, pausedFrom ?? null), phase)
}

function countsOf(task: Task): PaneModel['counts'] {
  return {
    components: task.system_map === null ? 0 : task.system_map.components.length,
    sources: unique(task.findings.flatMap(finding => finding.evidence.map(evidence => evidence.path))).length,
    open_questions: openQuestions(task).length,
    risks: task.plan === null ? 0 : task.plan.risks.length,
    findings: task.findings.length,
    stale: task.findings.filter(finding => finding.stale).length,
  }
}

function openQuestions(task: Task): Question[] {
  return task.open_questions.filter(question => question.status === 'open')
}

/** The text-map lines (blank lines dropped), else the component names. */
function mapLinesOf(task: Task): string[] {
  const map = task.system_map
  if (map === null) return []
  const lines = map.text_map.split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.length > 0 ? lines.map(line => line.trimEnd()) : [...map.components]
}

/** What to do next in the words of the pending gate (F3), else the task's stored next_action. With a plan or the validation results waiting
 *  for the person, "write the plan" would be wrong: the next step is theirs. `gate` is the trusted GateState; without it the stored sentence stands. */
export function nextActionOf(task: Task, gate?: GateState): string {
  if (gate?.pending === 'plan_approval') return 'Review the plan and run /ewm approve (or /ewm reject <reason>)'
  if (gate?.pending === 'done_acceptance') return 'Review the validation results and run /ewm approve to accept closure (or /ewm reject <reason>)'
  return task.next_action
}

/** counts.components = task.system_map.components.length (0 when null); sources = distinct evidence paths; risks = plan risks; stale = stale findings. map_lines = text_map lines (else components); question_lines = open questions "Q-001 text"; models = gate.models. */
export function paneModel(task: Task, profile: Profile, gate: GateState): PaneModel {
  return {
    project: oneLine(profile.profile_id),
    task_id: task.id,
    title: oneLine(task.title),
    phase: task.phase,
    paused_from: task.paused_from,
    rail: railOf(task.phase, task.paused_from),
    counts: countsOf(task),
    models: gate.models.map(oneLine),
    pending_gate: gate.pending,
    plan: gate.pending === 'plan_approval' && gate.plan != null ? { hash: gate.plan.hash, steps: gate.plan.steps, summary: oneLine(gate.plan.summary) } : null,
    next_action: oneLine(nextActionOf(task, gate)),
    map_lines: mapLinesOf(task).map(stripControls),
    question_lines: openQuestions(task).map(question => `${question.id} ${oneLine(question.text)}`),
  }
}

// ---------------------------------------------------------------------------
// Terminal text: status and task list
// ---------------------------------------------------------------------------

const MAX_MODEL_LINES = 5

function modelLines(models: readonly string[]): string[] {
  if (models.length === 0) return ['Models: none used yet']
  const hidden = models.length - MAX_MODEL_LINES
  return [
    'Models used:',
    ...models.slice(0, MAX_MODEL_LINES).map(model => `  - ${oneLine(model)}`),
    ...(hidden > 0 ? [`  - +${hidden} more`] : []),
  ]
}

/** First characters of a plan hash: what the person is shown and can type back. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

function gateLine(gate: GateState): string {
  if (gate.pending === 'plan_approval') {
    const plan = gate.plan == null ? '' : ` (plan ${shortHash(gate.plan.hash)}, ${plural(gate.plan.steps, 'step')})`
    return `Gate: plan approval pending${plan}. Run /ewm approve to start building, or /ewm reject <reason> to revise the plan.`
  }
  if (gate.pending === 'done_acceptance') {
    return 'Gate: final acceptance pending. Run /ewm approve to finish the task, or /ewm reject <reason> to keep working.'
  }
  return gate.planApproved ? 'Gate: none pending (plan approved)' : 'Gate: none pending'
}

const NO_ACTIVE_TASK = 'No active task. Start one with /ewm new "<title>", or run /ewm list to see existing tasks.'

/** The text fallback of the pane (SPEC section 2 panel as plain text, <= 20 lines): project, task, phase rail, counts, models, pending gate + how to act, next action. */
export function renderStatus(task: Task | null, profile: Profile, gate: GateState): string {
  if (task === null) return NO_ACTIVE_TASK
  const pane = paneModel(task, profile, gate)
  const { counts } = pane
  const phase = task.phase === 'PAUSED' && task.paused_from !== null ? `PAUSED (from ${task.paused_from})` : task.phase
  return [
    `Project: ${pane.project}`,
    `Task: ${task.id} - ${oneLine(task.title)}`,
    `Phase: ${phase}`,
    `Stage: ${railText(pane.rail, task.phase)}`,
    `Components: ${counts.components} | Sources: ${counts.sources} | Open questions: ${counts.open_questions} | Risks: ${counts.risks} | Findings: ${counts.findings} | Stale: ${counts.stale}`,
    ...modelLines(pane.models),
    gateLine(gate),
    `Next: ${oneLine(nextActionOf(task, gate))}`,
  ].join('\n')
}

export function renderTaskList(tasks: readonly TaskSummary[], activeId: string | null): string {
  if (tasks.length === 0) return 'No tasks yet. Start one with /ewm new "<title>".'
  const rows = tasks.map(
    task => `- ${task.id} [${task.phase}] ${oneLine(task.title)} (updated ${task.updated_at})${task.id === activeId ? ' (active)' : ''}`,
  )
  return [`Tasks (${tasks.length}):`, ...rows, 'Continue one with /ewm resume <id>.'].join('\n')
}

// ---------------------------------------------------------------------------
// Markdown artifacts
// ---------------------------------------------------------------------------

function describeFinding(finding: Finding): string {
  const verified = finding.last_verified_commit === null ? 'not recorded' : finding.last_verified_commit
  const evidence = finding.evidence.map(item => {
    const where = codeSpan(formatEvidence(item))
    return item.note === undefined || item.note.trim() === '' ? where : `${where} - ${oneLine(item.note)}`
  })
  const questions = finding.open_questions.map(text => bullet(text, '  '))
  return [
    `## ${finding.id}${finding.stale ? ' [STALE]' : ''} - ${oneLine(finding.claim)}`,
    [
      `- Confidence: ${finding.confidence}`,
      `- Source: ${finding.source}`,
      `- Verified at commit: ${verified}`,
      `- Recorded: ${finding.recorded_at}`,
      '- Evidence:',
      ...evidence.map(item => bullet(item, '  ')),
      questions.length === 0 ? '- Open questions: none' : ['- Open questions:', ...questions].join('\n'),
    ].join('\n'),
  ].join('\n\n')
}

export function renderExploration(task: Task): string {
  const stale = task.findings.filter(finding => finding.stale).length
  const blocks = [
    heading('Exploration', task),
    `Phase: ${task.phase} | Findings: ${task.findings.length} | Stale: ${stale}`,
  ]
  if (stale > 0) {
    blocks.push(`${plural(stale, 'finding')} marked STALE: the repository changed after the evidence was verified. Re-verify before relying on ${stale === 1 ? 'it' : 'them'}.`)
  }
  if (task.findings.length === 0) blocks.push('No findings recorded yet.')
  else blocks.push(...task.findings.map(describeFinding))
  return document(...blocks)
}

export function renderQuestions(task: Task): string {
  const open = openQuestions(task)
  const resolved = task.open_questions.filter(question => question.status === 'resolved')
  const openItems = open.map(question => `${question.id}: ${question.text} (raised ${question.raised_at})`)
  const resolvedItems = resolved.map(question => {
    const answer = question.answer === undefined ? 'no answer recorded' : question.answer
    const when = question.resolved_at === undefined ? '' : ` (resolved ${question.resolved_at})`
    return `${question.id}: ${question.text}\nAnswer: ${answer}${when}`
  })
  return document(
    heading('Questions', task),
    `Phase: ${task.phase} | Open: ${open.length} | Resolved: ${resolved.length}`,
    section('Open', bulletList(openItems, 'None.')),
    section('Resolved', bulletList(resolvedItems, 'None.')),
  )
}

function describeApproval(approval: Approval): string {
  const note = approval.note === undefined || approval.note.trim() === '' ? '' : ` - ${approval.note}`
  return `${approval.gate}: ${approval.decision} via ${approval.via} at ${approval.at}${note}`
}

/** goal, success criteria, constraints, decisions, approvals (gate, decision, via, at, note), transitions */
export function renderDecisions(task: Task): string {
  const decisions = task.decisions.map(decision =>
    [
      bullet(`${decision.id} ${oneLine(decision.title)} (${decision.phase}, by ${decision.decided_by}, ${decision.at})`),
      bullet(`Choice: ${decision.choice}`, '  '),
      bullet(`Rationale: ${decision.rationale}`, '  '),
    ].join('\n'),
  )
  const transitions = task.transitions.map(
    item => `${item.from} -> ${item.to} by ${item.actor} at ${item.at}: ${oneLine(item.reason)}`,
  )
  return document(
    heading('Decisions', task),
    `Phase: ${task.phase}`,
    section('Goal', task.goal.trim() === '' ? 'Not set.' : task.goal.trim()),
    section('Success criteria', bulletList(task.success_criteria, 'None recorded yet.')),
    section('Constraints', bulletList(task.constraints, 'None recorded yet.')),
    section('Decisions', decisions.length === 0 ? 'None recorded yet.' : decisions.join('\n')),
    section('Approvals', bulletList(task.approvals.map(describeApproval), 'None recorded yet.')),
    section('Transitions', bulletList(transitions, 'None recorded yet.')),
  )
}

export function renderPlan(task: Task, gate: GateState): string {
  const hash = gate.plan == null ? '' : ` | Plan: ${shortHash(gate.plan.hash)}`
  const blocks = [heading('Plan', task), `Phase: ${task.phase} | Approval: ${gate.planApproved ? 'approved' : 'not approved'}${hash}`]
  if (gate.pending === 'plan_approval') {
    blocks.push('Waiting for you: run /ewm approve to approve this plan, or /ewm reject <reason> to send it back.')
  }
  const plan = task.plan
  if (plan === null) {
    blocks.push('No plan recorded yet. The lead records one with mcp__ewm__set_plan while in PLAN.')
    return document(...blocks)
  }
  const steps = plan.steps.map(step => {
    const files = step.files.length === 0 ? '' : `\n${bullet(`Files: ${step.files.map(codeSpan).join(', ')}`, '  ')}`
    return `${bullet(`${step.id} [${step.status}] ${step.text}`)}${files}`
  })
  blocks.push(
    section('Summary', plan.summary.trim() === '' ? 'Not set.' : plan.summary.trim()),
    section('Steps', steps.length === 0 ? 'None.' : steps.join('\n')),
    section('Risks', bulletList(plan.risks, 'None recorded.')),
    section('Tests', bulletList(plan.tests, 'None recorded.')),
    section('Alternatives', bulletList(plan.alternatives, 'None recorded.')),
    `Updated: ${plan.updated_at}`,
  )
  return document(...blocks)
}

function describeRun(run: ValidationRun): string {
  const output = run.output_tail.trim() === '' ? 'Output: none.' : `Output tail:\n\n${fence(run.output_tail, 'text')}`
  return [
    `## ${run.id} - ${run.ok ? 'PASS' : 'FAIL'}`,
    [
      `- Command: ${codeSpan(run.command)}`,
      `- Exit code: ${run.exit_code}`,
      `- Result: ${run.ok ? 'ok' : 'failed'}`,
      `- Duration: ${run.duration_ms} ms`,
      `- Commit: ${run.commit === null ? 'unknown' : run.commit}`,
      `- At: ${run.at}`,
    ].join('\n'),
    output,
  ].join('\n\n')
}

export function renderValidation(task: Task): string {
  const passed = task.validations.filter(run => run.ok).length
  const blocks = [
    heading('Validation', task),
    `Phase: ${task.phase} | Runs: ${task.validations.length} (${passed} passed, ${task.validations.length - passed} failed)`,
  ]
  if (task.validations.length === 0) {
    blocks.push('No validation runs recorded yet. In VALIDATE, run a command from the profile\'s validation list with mcp__ewm__run_validation.')
  } else {
    blocks.push(...task.validations.map(describeRun))
  }
  return document(...blocks)
}

/** system-map.md: heading, text map, components list, ```mermaid block; a placeholder line when task.system_map is null. */
export function renderSystemMap(task: Task): string {
  const map = task.system_map
  if (map === null) {
    return document(heading('System map', task), 'No system map recorded yet. The lead records one with mcp__ewm__write_map during EXPLORE or UNDERSTAND.')
  }
  return document(
    heading('System map', task),
    `Updated: ${map.updated_at}`,
    section('Text map', map.text_map.trim() === '' ? 'None.' : fence(map.text_map, 'text')),
    section('Components', bulletList(map.components, 'None.')),
    section('Diagram', fence(map.mermaid, 'mermaid')),
  )
}

/** Plan steps still open at DONE, stale evidence and a failing last validation: what the next person may need to pick up. */
function followUpsOf(task: Task): string[] {
  const items: string[] = []
  for (const step of task.plan?.steps ?? []) {
    if (step.status !== 'done') items.push(`${step.id} [${step.status}] ${step.text}`)
  }
  const stale = task.findings.filter(finding => finding.stale)
  if (stale.length > 0) items.push(`Re-verify stale evidence before reuse: ${stale.map(finding => finding.id).join(', ')}`)
  const last = task.validations[task.validations.length - 1]
  if (last !== undefined && !last.ok) items.push(`The last validation run ${last.id} failed (exit ${last.exit_code}): ${codeSpan(last.command)}`)
  return items
}

/** DONE handoff: summary, goal, success criteria, decisions, files changed (given), validations, open questions, follow-ups. */
export function renderHandoff(task: Task, changedFiles: readonly string[]): string {
  const steps = task.plan?.steps ?? []
  const stepsDone = steps.filter(step => step.status === 'done').length
  const passed = task.validations.filter(run => run.ok).length
  const reviews = task.agent_usage.filter(use => use.agent_type === 'ewm:reviewer')
  const review =
    reviews.length === 0
      ? 'Diff review: no ewm:reviewer run was recorded for this task'
      : `Diff review: ewm:reviewer ran ${plural(reviews.length, 'time')} (last in ${reviews[reviews.length - 1]?.phase ?? 'unknown phase'})`
  const summary = [
    `Final phase: ${task.phase}`,
    review,
    `Plan: ${task.plan === null || task.plan.summary.trim() === '' ? 'none recorded' : oneLine(task.plan.summary)}`,
    `Steps done: ${stepsDone} of ${steps.length}`,
    `Validation runs: ${task.validations.length} (${passed} passed)`,
    `Findings: ${task.findings.length} (${task.findings.filter(finding => finding.stale).length} stale)`,
    `Created: ${task.created_at}; last update: ${task.updated_at}`,
  ]
  const decisions = task.decisions.map(decision => `${decision.id} ${oneLine(decision.title)}: ${decision.choice} (${decision.rationale})`)
  const validations = task.validations.map(
    run => `${run.id} ${run.ok ? 'PASS' : 'FAIL'}: ${codeSpan(run.command)} (exit ${run.exit_code}, ${run.duration_ms} ms, commit ${run.commit === null ? 'unknown' : run.commit})`,
  )
  const open = openQuestions(task).map(question => `${question.id}: ${question.text}`)
  return document(
    heading('Handoff', task),
    section('Summary', bulletList(summary, 'None.')),
    section('Goal', task.goal.trim() === '' ? 'Not set.' : task.goal.trim()),
    section('Success criteria', bulletList(task.success_criteria, 'None recorded.')),
    section('Decisions', bulletList(decisions, 'None recorded.')),
    section('Files changed', bulletList(changedFiles.map(codeSpan), 'No changed files detected.')),
    section('Validation', bulletList(validations, 'No validation runs recorded.')),
    section('Open questions', bulletList(open, 'None.')),
    section('Follow-ups', bulletList(followUpsOf(task), 'None.')),
  )
}

// ---------------------------------------------------------------------------
// Resume brief (M12: readable in 60 s, at most 180 words)
// ---------------------------------------------------------------------------

// Every list is capped and every item clipped, so the brief stays far below
// 180 words however large the task grows.
const BRIEF_TITLE_WORDS = 10
const BRIEF_ITEM_WORDS = 9
const BRIEF_NEXT_WORDS = 22
const BRIEF_NOTE_WORDS = 8
const BRIEF_MAX_DECISIONS = 3
const BRIEF_MAX_QUESTIONS = 5
const BRIEF_MAX_PATHS = 4

const GATE_LABELS: Record<GateName, string> = { plan_approval: 'plan', done_acceptance: 'acceptance' }

/** Gates the ledger says are approved now (CR16): the caller computes them on the trusted task with the plan hash recomputed. task.json's own approvals are never read. */
function approvedGates(gate: GateState | undefined): string[] {
  return gate !== undefined && gate.planApproved ? [GATE_LABELS.plan_approval] : []
}

function changeNote(staleness: Staleness): string {
  if (staleness.branch_changed && staleness.head_changed) return ' (branch and HEAD changed)'
  if (staleness.branch_changed) return ' (branch changed)'
  if (staleness.head_changed) return ' (HEAD changed)'
  return ''
}

function stalenessLine(task: Task, staleness: Staleness): string {
  if (!staleness.checked) {
    const why = staleness.note === undefined || staleness.note.trim() === '' ? '' : ` (${clipWords(staleness.note, BRIEF_NOTE_WORDS)})`
    return `Staleness could not be checked${why}: re-verify evidence before relying on it.`
  }
  // Findings already flagged on the task plus those this check reports.
  const reported = new Set(staleness.stale_findings)
  const stale = task.findings.filter(finding => finding.stale || reported.has(finding.id))
  if (stale.length === 0) return `Stale evidence: none${changeNote(staleness)}`
  const changed = new Set(staleness.changed_paths)
  const evidencePaths = unique(stale.flatMap(finding => finding.evidence.map(item => item.path)))
  const touched = evidencePaths.filter(path => changed.has(path))
  const paths = touched.length > 0 ? touched : evidencePaths
  const more = paths.length - BRIEF_MAX_PATHS
  const shown = paths.slice(0, BRIEF_MAX_PATHS).join(', ') + (more > 0 ? ` (+${more} more)` : '')
  return `Stale evidence: ${plural(stale.length, 'finding')}${changeNote(staleness)}: ${shown}`
}

function decisionLines(task: Task): string[] {
  if (task.decisions.length === 0) return ['Decisions: none recorded yet.']
  const recent = task.decisions.slice(-BRIEF_MAX_DECISIONS)
  const earlier = task.decisions.length - recent.length
  return [
    `Decisions (${task.decisions.length}):`,
    ...recent.map(decision => `  ${decision.id} ${clipWords(`${decision.title}: ${decision.choice}`, BRIEF_ITEM_WORDS)}`),
    ...(earlier > 0 ? [`  +${earlier} more in decisions.md`] : []),
  ]
}

function questionLines(task: Task): string[] {
  const open = openQuestions(task)
  if (open.length === 0) return ['Open questions: none.']
  const more = open.length - BRIEF_MAX_QUESTIONS
  return [
    `Open questions (${open.length}):`,
    ...open.slice(0, BRIEF_MAX_QUESTIONS).map(question => `  ${question.id} ${clipWords(question.text, BRIEF_ITEM_WORDS)}`),
    ...(more > 0 ? [`  +${more} more`] : []),
  ]
}

/** Resume brief readable in <= 60 s: <= 180 words. Where we were (phase), approved decisions, open questions (max 5), stale evidence, next action. */
export function renderResumeBrief(task: Task, staleness: Staleness, gate?: GateState): string {
  const where = task.phase === 'PAUSED' ? `PAUSED${task.paused_from === null ? '' : ` (was ${task.paused_from})`}` : task.phase
  const gates = approvedGates(gate)
  return [
    `Resuming ${task.id}: ${clipWords(task.title, BRIEF_TITLE_WORDS)}`,
    `Where we were: ${where}`,
    ...(gates.length > 0 ? [`Approved gates: ${gates.join(', ')}`] : []),
    ...decisionLines(task),
    ...questionLines(task),
    stalenessLine(task, staleness),
    `Next: ${clipWords(nextActionOf(task, gate), BRIEF_NEXT_WORDS)}`,
  ].join('\n')
}
