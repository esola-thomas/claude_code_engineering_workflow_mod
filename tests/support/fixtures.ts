// Shared builders for tests. Pure TypeScript: no node:* imports.

import type { Profile, Task } from '../../src/types.ts'

export const AT = '2026-10-09T17:00:00.000Z'

/** A profile equal to the contract's DEFAULT_PROFILE (docs/ARCHITECTURE.md), as a fresh copy. */
export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  const base: Profile = {
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
    },
    models: { lead: 'opus', search: 'haiku', reviewer: 'sonnet' },
    budgets: { max_parallel_researchers: 3, max_research_rounds_without_user_update: 2, max_findings_per_scout: 8 },
    validation: { commands: [], timeout_ms: 300000 },
  }
  return {
    ...base,
    ...overrides,
    policies: { ...base.policies, ...(overrides.policies ?? {}) },
    models: { ...base.models, ...(overrides.models ?? {}) },
    budgets: { ...base.budgets, ...(overrides.budgets ?? {}) },
    validation: { ...base.validation, ...(overrides.validation ?? {}) },
  }
}

/** A fresh INTAKE task; override any field. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    schema_version: 1,
    id: 'TASK-001',
    project_profile: 'default',
    title: 'Investigate sum()',
    goal: 'Find why sum() is wrong',
    phase: 'INTAKE',
    paused_from: null,
    mode: 'deep',
    repo: { root: '.', branch: 'main', base_commit: 'aaaaaaa' },
    success_criteria: [],
    constraints: [],
    artifacts: [],
    findings: [],
    open_questions: [],
    decisions: [],
    approvals: [],
    transitions: [],
    agent_usage: [],
    validations: [],
    plan: null,
    system_map: null,
    usage_by_phase: {},
    next_action: 'Confirm problem, goal and success criteria with the user.',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  }
}

/** Recursively freezes a value so tests can prove functions do not mutate inputs. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}
