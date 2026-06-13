import type { Project, Scope } from '@/ontology'

export interface HierarchyNode {
  scope: Scope
  name: string
  path: string
  children: HierarchyNode[]
  depth: number // 0 = direct child of global
}

/**
 * Builds a tree from the flat project list using path containment.
 *
 * A project P is a direct child of Q if:
 *   - P.path starts with Q.path + '/'
 *   - No other project R exists where P.path starts with R.path+'/' and R.path starts with Q.path+'/'
 *     (i.e. Q is the closest ancestor)
 *
 * global is always the root. Projects with no ancestor project become
 * direct children of global.
 */
export function buildHierarchy(projects: Project[]): HierarchyNode[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

  // Sort by path depth ascending so parents are processed before children
  const sorted = [...projects].sort((a, b) => {
    const da = norm(a.path).split('/').length
    const db = norm(b.path).split('/').length
    return da - db
  })

  const nodeMap = new Map<string, HierarchyNode>()

  // Create all nodes first
  for (const p of sorted) {
    nodeMap.set(norm(p.path), {
      scope: { type: 'project', projectId: p.id },
      name: p.name,
      path: norm(p.path),
      children: [],
      depth: 0,
    })
  }

  const roots: HierarchyNode[] = []

  for (const p of sorted) {
    const pPath = norm(p.path)
    const node = nodeMap.get(pPath)!

    // Find closest ancestor: the project whose path is the longest prefix of pPath
    let bestAncestorPath = ''
    for (const [otherPath] of nodeMap) {
      if (otherPath === pPath) continue
      if (pPath.startsWith(otherPath + '/') && otherPath.length > bestAncestorPath.length) {
        bestAncestorPath = otherPath
      }
    }

    if (bestAncestorPath) {
      const parent = nodeMap.get(bestAncestorPath)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      // No ancestor project — direct child of global
      node.depth = 0
      roots.push(node)
    }
  }

  return roots
}

/**
 * Finds the direct parent scope of a given scope in the hierarchy.
 * Returns null if already at global (no parent above global).
 */
export function parentScope(
  scope: Scope,
  projects: Project[],
): Scope | null {
  if (scope.type === 'user') return null // global has no parent

  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const project = projects.find((p) => p.id === scope.projectId)
  if (!project) return null

  const pPath = norm(project.path)
  let bestAncestorPath = ''
  let bestAncestorId = ''

  for (const other of projects) {
    if (other.id === project.id) continue
    const oPath = norm(other.path)
    if (pPath.startsWith(oPath + '/') && oPath.length > bestAncestorPath.length) {
      bestAncestorPath = oPath
      bestAncestorId = other.id
    }
  }

  if (bestAncestorId) {
    return { type: 'project', projectId: bestAncestorId }
  }
  // No ancestor project — parent is global
  return { type: 'user' }
}

/**
 * Returns all direct child scopes of a given scope.
 */
export function childScopes(
  scope: Scope,
  projects: Project[],
): Array<{ scope: Scope; name: string }> {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

  if (scope.type === 'user') {
    // Children of global = projects with no ancestor project
    return projects
      .filter((p) => {
        const pPath = norm(p.path)
        return !projects.some(
          (other) => other.id !== p.id && pPath.startsWith(norm(other.path) + '/'),
        )
      })
      .map((p) => ({ scope: { type: 'project' as const, projectId: p.id }, name: p.name }))
  }

  const parent = projects.find((p) => p.id === scope.projectId)
  if (!parent) return []
  const parentPath = norm(parent.path)

  return projects
    .filter((p) => {
      if (p.id === parent.id) return false
      const pPath = norm(p.path)
      if (!pPath.startsWith(parentPath + '/')) return false
      // Must be a DIRECT child: no intermediate project between parent and p
      return !projects.some((mid) => {
        if (mid.id === parent.id || mid.id === p.id) return false
        const mPath = norm(mid.path)
        return pPath.startsWith(mPath + '/') && mPath.startsWith(parentPath + '/')
      })
    })
    .map((p) => ({ scope: { type: 'project' as const, projectId: p.id }, name: p.name }))
}
