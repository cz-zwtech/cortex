import {
  claudeProjectEncoding,
  kindTargetableScopes,
  type Entity,
  type Project,
  type Scope,
} from '@/ontology'
import { parentScope, childScopes } from '@/engine/hierarchy'

export interface ScopeTarget {
  name: string
  scope: Scope
  relation: 'promote' | 'demote' | 'lateral'
}

const effectiveSourceScope = (entity: Entity<any>, projects: Project[]): Scope => {
  if (entity.kind === 'conversation') {
    const dir = (entity.value as { projectDir?: string }).projectDir
    if (dir) {
      const match = projects.find((p) => claudeProjectEncoding(p.path) === dir)
      if (match) return { type: 'project', projectId: match.id }
    }
  }
  return entity.scope
}

const scopeName = (scope: Scope, projects: Project[]): string => {
  if (scope.type === 'user') return 'global'
  return projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId
}

const scopesEqual = (a: Scope, b: Scope): boolean => {
  if (a.type !== b.type) return false
  if (a.type === 'project' && b.type === 'project') return a.projectId === b.projectId
  return true
}

/**
 * Returns all valid copy/move targets for an entity, tagged with their
 * directional relationship to the entity's current scope:
 *
 *   promote  — direct parent in the project hierarchy (one step up)
 *   demote   — direct children in the project hierarchy (one step down)
 *   lateral  — same level, different branch (any other valid scope)
 */
export const buildScopeTargets = (
  entity: Entity<any>,
  projects: Project[],
): ScopeTarget[] => {
  const source = effectiveSourceScope(entity, projects)
  const targetable = kindTargetableScopes(entity.kind)
  const out: ScopeTarget[] = []

  // Promote: direct parent
  const parent = parentScope(source, projects)
  if (parent !== null) {
    const parentType = parent.type === 'user' ? 'user' : 'project'
    if (targetable.includes(parentType) && !scopesEqual(parent, source)) {
      out.push({ name: scopeName(parent, projects), scope: parent, relation: 'promote' })
    }
  }

  // Demote: direct children
  const children = childScopes(source, projects)
  for (const { scope: childScope, name } of children) {
    const childType = childScope.type === 'user' ? 'user' : 'project'
    if (targetable.includes(childType) && !scopesEqual(childScope, source)) {
      out.push({ name, scope: childScope, relation: 'demote' })
    }
  }

  // Lateral: everything else that isn't source, parent, or a direct child
  const promotedAndDemoted = [parent, ...children.map((c) => c.scope)].filter(Boolean) as Scope[]

  if (targetable.includes('user') && source.type !== 'user' && !promotedAndDemoted.some((s) => s.type === 'user')) {
    out.push({ name: 'global', scope: { type: 'user' }, relation: 'lateral' })
  }
  if (targetable.includes('project')) {
    for (const p of projects) {
      const ps: Scope = { type: 'project', projectId: p.id }
      if (scopesEqual(ps, source)) continue
      if (promotedAndDemoted.some((s) => scopesEqual(s, ps))) continue
      out.push({ name: p.name, scope: ps, relation: 'lateral' })
    }
  }

  return out
}

/** @deprecated use buildScopeTargets */
export const copyMoveTargets = (entity: Entity<any>, projects: Project[]) =>
  buildScopeTargets(entity, projects)
