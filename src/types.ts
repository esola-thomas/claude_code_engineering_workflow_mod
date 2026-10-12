// Shared domain contract for the Engineering Workflow Mod (ewm).
//
// Every module under src/ is pure TypeScript that runs in two places: inside
// the Claude Code hooks environment (no Node, no DOM) and under `node --test`.
// So: no `node:*` imports, no npm packages, explicit `.ts` import suffixes,
// erasable syntax only (no enums, namespaces or parameter properties).
// All IO goes through the `Io` port below.

export const PHASES = [
  'INTAKE',
  'EXPLORE',
  'UNDERSTAND',
  'PLAN',
  'IMPLEMENT',
  'VALIDATE',
  'DONE',
  'PAUSED',
] as const
export type Phase = (typeof PHASES)[number]

/** Phases a task can be working in (and therefore be paused from). */
export const ACTIVE_PHASES = ['INTAKE', 'EXPLORE', 'UNDERSTAND', 'PLAN', 'IMPLEMENT', 'VALIDATE'] as const
export type ActivePhase = (typeof ACTIVE_PHASES)[number]

export type Mode = 'deep'
export type Confidence = 'high' | 'medium' | 'low'
export type Actor = 'user' | 'model' | 'system'

/** `^TASK-\d{3,}$`. Validate every id that comes from outside before using it in a path. */
export const TASK_ID_PATTERN = /^TASK-\d{3,}$/

// ---------------------------------------------------------------------------
// Profile (.ewm/project.yaml or .ewm/project.json): configuration, not state.
// ---------------------------------------------------------------------------

export type Profile = {
  profile_id: string
  name: string
  repositories: string[]
  domains: string[]
  entrypoints: string[]
  policies: {
    external_network: 'deny_by_default' | 'allow'
    require_plan_approval: boolean
    allow_write_in_explore: boolean
    /** Third-party MCP tool names (exact, or prefix ending in `*`) allowed while a task is active under deny_by_default. */
    allowed_mcp_tools: string[]
  }
  models: {
    lead: string
    search: string
    reviewer: string
  }
  budgets: {
    max_parallel_researchers: number
    max_research_rounds_without_user_update: number
    /** Max findings a scout returns per delegation. */
    max_findings_per_scout: number
  }
  validation: {
    /** Allowlisted validation commands, e.g. "npm test". Run without a shell. */
    commands: string[]
    timeout_ms: number
  }
}

// ---------------------------------------------------------------------------
// Task (.ewm/tasks/TASK-NNN/task.json): durable instance state.
// ---------------------------------------------------------------------------

export type Evidence = {
  /** Repo-relative path of a file or doc. Must exist when recorded. */
  path: string
  line_start?: number
  line_end?: number
  /** Optional doc/section identifier (ADR number, spec section, heading). */
  doc_id?: string
  note?: string
  /** Git blob id of the file when the finding was recorded (`git hash-object`); absent for directories or without git. Staleness compares it (CR14). */
  fingerprint?: string
}

export type Finding = {
  id: string // F-001
  claim: string
  evidence: Evidence[] // length >= 1
  confidence: Confidence
  open_questions: string[]
  last_verified_commit: string | null
  /** Who produced it: 'lead' or an agent type such as 'ewm:repo-scout'. */
  source: string
  stale: boolean
  recorded_at: string // ISO-8601
}

export type Question = {
  id: string // Q-001
  text: string
  status: 'open' | 'resolved'
  answer?: string
  raised_at: string
  resolved_at?: string
}

export type Decision = {
  id: string // D-001
  title: string
  choice: string
  rationale: string
  phase: Phase
  decided_by: Actor
  at: string
}

export type GateName = 'plan_approval' | 'done_acceptance'

export type Approval = {
  gate: GateName
  decision: 'approved' | 'rejected'
  by: 'user'
  via: 'command' | 'pane'
  at: string
  note?: string
  /** For plan_approval: Plan.hash at approval time. */
  plan_hash?: string
}

export type Transition = {
  from: Phase
  to: Phase
  actor: Actor
  reason: string
  at: string
}

export type AgentUse = {
  agent_type: string
  /** The model the engine resolved for the spawn (usually a full id such as claude-haiku-...). */
  model: string
  /** The alias the router asked for (e.g. 'haiku'), when it routed this spawn. */
  routed_model?: string
  agent_id?: string
  description?: string
  phase: Phase
  /** How the model was chosen, e.g. 'profile.models.search' or 'unrouted'. */
  rule: string
  at: string
}

export type PlanStep = {
  id: string // S-1
  text: string
  files: string[]
  status: 'todo' | 'doing' | 'done' | 'skipped'
}

export type Plan = {
  summary: string
  steps: PlanStep[]
  risks: string[]
  tests: string[]
  alternatives: string[]
  /** Stable hash of summary+steps(text,files)+risks+tests+alternatives; see controller.planHash. */
  hash: string
  updated_at: string
}

export type ValidationRun = {
  id: string // V-001
  command: string
  exit_code: number
  ok: boolean
  duration_ms: number
  /** Last ~4000 chars of combined stdout/stderr, secrets redacted. */
  output_tail: string
  commit: string | null
  at: string
}

export type SystemMap = {
  mermaid: string
  text_map: string
  components: string[]
  updated_at: string
}

export type PhaseUsage = {
  turns: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type Task = {
  schema_version: 1
  id: string
  project_profile: string
  title: string
  goal: string
  phase: Phase
  /** Set while PAUSED: the phase to return to on resume. */
  paused_from: ActivePhase | null
  mode: Mode
  repo: { root: string; branch: string | null; base_commit: string | null }
  success_criteria: string[]
  constraints: string[]
  /** Artifact file names present in the task dir (e.g. 'exploration.md'). */
  artifacts: string[]
  findings: Finding[]
  open_questions: Question[]
  decisions: Decision[]
  approvals: Approval[]
  transitions: Transition[]
  agent_usage: AgentUse[]
  validations: ValidationRun[]
  plan: Plan | null
  /** Written only by the write_map tool; rendered to system-map.md. */
  system_map: SystemMap | null
  usage_by_phase: Partial<Record<Phase, PhaseUsage>>
  next_action: string
  created_at: string
  updated_at: string
}

/**
 * A Task as the gates see it (`store.trustedTask`): phase, approvals and validations from the ledger, plus `validating_since`, the ISO time
 * of the latest entry into VALIDATE as the LEDGER recorded it (F5). It is never read from task.json, where the model could rewrite
 * `transitions`; absent or null means "no validation counts as fresh yet". Plain Tasks are assignable (the field is optional).
 */
export type TrustedTask = Task & { validating_since?: string | null }

export type TaskSummary = {
  id: string
  title: string
  phase: Phase
  updated_at: string
}

export const ARTIFACT_NAMES = [
  'exploration.md',
  'system-map.md',
  'questions.md',
  'plan.md',
  'validation.md',
  'decisions.md',
  'handoff.md',
] as const
export type ArtifactName = (typeof ARTIFACT_NAMES)[number]

/** One line of .ewm/tasks/TASK-NNN/audit.jsonl. Never holds credentials. */
export type AuditEntry = {
  at: string
  kind:
    | 'task_created'
    | 'transition'
    | 'approval'
    | 'tool_denied'
    | 'validation_run'
    | 'agent_spawn'
    | 'tool_effect'
    | 'resume'
    | 'pause'
    | 'error'
  phase: Phase | null
  detail: string
  tool?: string
  commit?: string | null
}

// ---------------------------------------------------------------------------
// Gate ledger: mod-private state in $.store (Io.kvGet/kvSet), out of the model's
// reach. The model can edit files in IMPLEMENT; it cannot edit the ledger. Gate
// checks, the active-task pointer and the policy profile come from here, never
// from files the model can write (D14).
// ---------------------------------------------------------------------------

export type LedgerValidation = { id: string; command: string; exit_code: number; ok: boolean; at: string }

export type LedgerEntry = {
  /** Source of truth for the task's phase (task.json's phase is a mirror the model could edit). */
  phase: Phase
  /** Source of truth for where a PAUSED task resumes. */
  paused_from: ActivePhase | null
  /** ISO time of the latest transition into VALIDATE (set by the mod); validation runs count for done_acceptance only from then on. */
  validating_since?: string | null
  /** Every approval a human recorded for the task (copy of the trusted record). */
  approvals: Approval[]
  /** Every validation run the mod itself executed for the task. */
  validations: LedgerValidation[]
  /** Profile snapshot taken by a human command (/ewm new, /ewm resume). The guard and tools use it. */
  profile: Profile
  profile_source: string | null
}

export type Ledger = {
  version: 1
  /** The workspace root this ledger belongs to (absolute). */
  root: string
  active_task: string | null
  tasks: Record<string, LedgerEntry>
}

// ---------------------------------------------------------------------------
// Policy verdicts and staleness.
// ---------------------------------------------------------------------------

export type ToolVerdict = { allow: true } | { allow: false; reason: string }

export type Staleness = {
  /** False when git was unavailable or the recorded commit is unknown. */
  checked: boolean
  branch_changed: boolean
  head_changed: boolean
  previous: { branch: string | null; commit: string | null }
  current: { branch: string | null; commit: string | null }
  /** Repo-relative paths changed since the evidence was verified (committed or not). */
  changed_paths: string[]
  /** Finding ids newly marked stale by this check. */
  stale_findings: string[]
  note?: string
}

// ---------------------------------------------------------------------------
// Pane view model (plain JSON; lives in $.state and is drawn by the mod).
// ---------------------------------------------------------------------------

export type PaneSection = 'overview' | 'map' | 'plan' | 'questions' | 'findings'

export type PaneModel = {
  project: string
  task_id: string
  title: string
  phase: Phase
  paused_from: ActivePhase | null
  /** The five-stage rail of SPEC §2, current one marked. */
  rail: { label: 'Explore' | 'Understand' | 'Plan' | 'Build' | 'Test'; state: 'done' | 'current' | 'todo' }[]
  counts: { components: number; sources: number; open_questions: number; risks: number; findings: number; stale: number }
  /** e.g. ["haiku (ewm:repo-scout x2)", "sonnet (ewm:reviewer x1)"] */
  models: string[]
  pending_gate: GateName | null
  /** The plan awaiting approval, as the person is shown it (hash = full SHA-256: the Approve button carries it back); null when no plan gate is pending. */
  plan: { hash: string; steps: number; summary: string } | null
  next_action: string
  /** Text lines for the 'map' section (from system-map.md's text map or components). */
  map_lines: string[]
  /** "Q-001 text" lines for the 'questions' section. */
  question_lines: string[]
  /** Overlays for the map's nodes by node id: stale evidence and the findings that cite the node. */
  map_marks: Record<string, { stale?: boolean; note?: string }>
  /** Markdown per section; ```mermaid fences in it are drawn as diagrams by the pane. */
  docs: { map: string; plan: string; questions: string; findings: string }
}

// ---------------------------------------------------------------------------
// Command and tool outputs (service layer -> hooks module).
// ---------------------------------------------------------------------------

export type CommandOutput = {
  /** The transcript row the person sees (and the model reads). */
  text: string
  /** Hidden notes only the model reads, recorded after the row. */
  context?: string[]
  /** When set, the hooks module queues this as a prompt ($.prompt.submit) to start model work. */
  kickoff?: string
  /** True when the command changed task state (the mod refreshes pane/status). */
  changed: boolean
  /** True when the pane should be opened/focused for this output. */
  openPane?: boolean
  /** The pane section to show with this output (e.g. 'map' for /ewm map). */
  section?: PaneSection
}

export type ToolOutput = {
  ok: boolean
  /** What the model reads. On failure, a precise reason and how to fix the call. */
  text: string
  changed: boolean
}

// ---------------------------------------------------------------------------
// The IO port. The hooks module implements it over `$`; tests use an in-memory one.
// Paths are workspace-relative ('.ewm/state.json') or absolute; '/' separators.
// ---------------------------------------------------------------------------

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other' }

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export interface Io {
  /** Rejects when the file is missing. */
  readText(path: string): Promise<string>
  /** Writes the whole file, creating parent directories. */
  writeText(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Rejects when the directory is missing. */
  list(path: string): Promise<DirEntry[]>
  /** Runs argv without a shell. Resolves with any exit code; rejects only if it cannot start or times out. */
  run(argv: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>
  /** Milliseconds since the epoch. */
  now(): Promise<number>
  /** Mod-private key-value store ($.store): survives sessions, not writable by the model's tools. Undefined when unset. */
  kvGet(key: string): Promise<unknown>
  /** Stores JSON data under key. */
  kvSet(key: string, value: unknown): Promise<void>
}

/** Error with a stable code; messages are shown to the person or model as-is. */
export class EwmError extends Error {
  readonly code: EwmErrorCode
  constructor(code: EwmErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'EwmError'
  }
}

/** The prefix every message to the person or model starts with, exactly once. */
export const EWM_PREFIX = 'ewm: '

/** `text` without a leading "ewm: " (any number of them), for wrapping a message in another one or for a host that prefixes the plugin name itself (F4). */
export function unprefixed(text: string): string {
  let rest = text
  while (rest.startsWith(EWM_PREFIX)) rest = rest.slice(EWM_PREFIX.length)
  return rest
}

export type EwmErrorCode =
  | 'not_found'
  | 'invalid_id'
  | 'invalid_input'
  | 'invalid_transition'
  | 'gate_required'
  | 'no_active_task'
  | 'parse_error'
  | 'io_error'
