/**
 * #128 — pure helpers for the persisted/baked graph layout.
 *
 * The graph view bakes node positions once and opens FROZEN at them (no force-settle
 * radiate). It re-settles only when the graph actually changed — detected by an
 * EDGE-AWARE signature: edges drive force positions, and batch #2 is about richer
 * edges (#126 exports all typed edges, #127 adds SIMILAR_TO), so a node-set-only
 * signature would keep a stale layout exactly when connectivity changes. No imports —
 * dependency-free, unit-testable via tsx, mirroring graphHighlight.ts / graphEdgeStyle.ts.
 */

export interface SavedPos {
  id: string
  x: number
  y: number
  // Reserved for #129's 3D renderer; the 2D bake does not compute these.
  x3?: number
  y3?: number
  z3?: number
}

export interface SavedLayout {
  sig: string
  nodes: SavedPos[]
}

export interface Pos {
  x: number
  y: number
  x3?: number
  y3?: number
  z3?: number
}

/** djb2 string hash -> base36. Small + stable; a collision merely means we skip a
 *  re-settle we didn't strictly need, which is harmless. */
const hash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** EDGE-AWARE change signature: node count + sorted node-id hash + edge count +
 *  sorted edge-key hash (the edge key includes `rel`, so typed edges from #126/#127
 *  invalidate the layout). Order-independent via sorting. */
export const layoutSignature = (
  nodes: { id: string }[],
  edges: { from: string; to: string; rel?: string }[],
): string => {
  const nodeKey = nodes.map((n) => n.id).sort().join(',')
  const edgeKey = edges.map((e) => `${e.from}>${e.to}:${e.rel ?? ''}`).sort().join(',')
  return `${nodes.length}.${hash(nodeKey)}.${edges.length}.${hash(edgeKey)}`
}

/** Map saved positions onto the current node ids. Only ids present in BOTH are
 *  returned; a current node with no saved position is omitted (the caller lets the
 *  sim place it). A null/absent saved layout yields an empty map. */
export const restoreLayout = (
  saved: SavedLayout | null | undefined,
  currentIds: string[],
): Map<string, Pos> => {
  const out = new Map<string, Pos>()
  if (!saved) return out
  const byId = new Map(saved.nodes.map((n) => [n.id, n]))
  for (const id of currentIds) {
    const p = byId.get(id)
    if (p) {
      out.set(id, p.x3 !== undefined ? { x: p.x, y: p.y, x3: p.x3, y3: p.y3, z3: p.z3 } : { x: p.x, y: p.y })
    }
  }
  return out
}

/** True only when EVERY current node has a saved position — i.e. the layout restores
 *  fully frozen with nothing left for the sim to place. */
export const layoutCovers = (saved: SavedLayout | null | undefined, currentIds: string[]): boolean => {
  if (!saved) return false
  const ids = new Set(saved.nodes.map((n) => n.id))
  return currentIds.every((id) => ids.has(id))
}
