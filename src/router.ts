// Model routing for subagents: which model each ewm agent type runs on, and how the
// models actually used are summarized for the pane and /ewm status.
//
// Pure: no IO. The router has no escalation logic in v0.0.0 (D11): an ewm agent always
// runs on the profile's model for its role, which keeps research cheap by construction.

import type { AgentUse, Profile } from './types.ts'

export type Role = 'search' | 'reviewer' | 'lead'

export const AGENT_ROLES: Readonly<Record<string, Role>> = Object.freeze({
  'ewm:repo-scout': 'search',
  'ewm:docs-scout': 'search',
  'ewm:reviewer': 'reviewer',
})

/** The role of an ewm agent type, or null for any other type. Own properties only, so 'constructor' is not a role. */
function roleOf(agentType: string): Role | null {
  return Object.prototype.hasOwnProperty.call(AGENT_ROLES, agentType) ? (AGENT_ROLES[agentType] ?? null) : null
}

/** For ewm agent types: the profile's model for the role, always (cost discipline), rule 'profile.models.<role>'.
 *  For other types: { model: requested, rule: requested ? 'requested' : 'unrouted' } (untouched). */
export function routeModel(
  agentType: string,
  requested: string | undefined,
  profile: Profile,
): { model: string | undefined; rule: string } {
  const role = roleOf(agentType)
  if (role === null) return { model: requested, rule: requested ? 'requested' : 'unrouted' }
  return { model: profile.models[role], rule: `profile.models.${role}` }
}

const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const

/** 'haiku' | 'sonnet' | 'opus' | 'fable' when the id or alias contains that word (case-insensitive), else the input unchanged. */
export function modelFamily(model: string): string {
  const lower = model.toLowerCase()
  return MODEL_FAMILIES.find((family) => lower.includes(family)) ?? model
}

/** "haiku (ewm:repo-scout x2)" lines: grouped by modelFamily(routed_model ?? model) then agent type, in first-seen order.
 *  One line per family; several agent types in a family are joined: "haiku (ewm:repo-scout x2, ewm:docs-scout x1)". */
export function summarizeModels(uses: readonly AgentUse[]): string[] {
  // Map keeps insertion order, which is the first-seen order we want at both levels.
  const families = new Map<string, Map<string, number>>()
  for (const use of uses) {
    const family = modelFamily(use.routed_model || use.model)
    const types = families.get(family) ?? new Map<string, number>()
    types.set(use.agent_type, (types.get(use.agent_type) ?? 0) + 1)
    families.set(family, types)
  }
  return [...families].map(
    ([family, types]) => `${family} (${[...types].map(([agentType, count]) => `${agentType} x${count}`).join(', ')})`,
  )
}
