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

/** Lines like "haiku [claude-haiku-5-5] (ewm:repo-scout x2)" (CR16): grouped by the family of the model the engine RESOLVED (`model`, else the requested alias),
 *  then agent type, in first-seen order. The resolved id is shown in brackets when it is not just the alias. One line per family; several agent types in
 *  a family are joined: "haiku [claude-haiku-5-5] (ewm:repo-scout x2, ewm:docs-scout x1)". When the engine resolved a different family than the router
 *  asked for, the line says so: "opus [claude-opus-4-1] (ewm:repo-scout x1) - asked for haiku". */
export function summarizeModels(uses: readonly AgentUse[]): string[] {
  // Map keeps insertion order, which is the first-seen order we want at both levels.
  const families = new Map<string, { types: Map<string, number>; ids: Set<string>; asked: Set<string> }>()
  for (const use of uses) {
    const resolved = use.model || use.routed_model || ''
    const family = modelFamily(resolved)
    const entry = families.get(family) ?? { types: new Map<string, number>(), ids: new Set<string>(), asked: new Set<string>() }
    entry.types.set(use.agent_type, (entry.types.get(use.agent_type) ?? 0) + 1)
    if (resolved !== '' && resolved !== family) entry.ids.add(resolved)
    if (use.routed_model && modelFamily(use.routed_model) !== family) entry.asked.add(use.routed_model)
    families.set(family, entry)
  }
  return [...families].map(([family, entry]) => {
    const ids = entry.ids.size === 0 ? '' : ` [${[...entry.ids].join(', ')}]`
    const asked = entry.asked.size === 0 ? '' : ` - asked for ${[...entry.asked].join(', ')}`
    return `${family}${ids} (${[...entry.types].map(([agentType, count]) => `${agentType} x${count}`).join(', ')})${asked}`
  })
}
