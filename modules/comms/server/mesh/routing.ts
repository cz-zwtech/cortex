/**
 * Routes: how this node reaches every other, from the links each node
 * announces (link-state routing; PM's point 2 in the mesh design).
 *
 *   - An edge between two other nodes counts only when BOTH announce it, so
 *     a node that went offline (and so cannot withdraw its own announcement)
 *     drops out as soon as its neighbours stop listing it.
 *   - This node's own edges are its live, ready links: first-hand, never stale.
 *   - Breadth-first from here gives the fewest hops. Neighbours are explored in
 *     node-id order, so among equal paths the one through the lowest next hop
 *     wins, and every node computing from the same announcements agrees.
 *
 * A node absent from the result is unreachable: its roles are unavailable.
 */
export type Route = { node: string; nextHop: string; hops: number; path: string[] }

/**
 * Shortest paths from self over the links both ends announce. Nodes in `avoid`
 * are neither passed through nor reached: home-only traffic is routed on a
 * table that avoids every gateway (private mind, D15).
 */
export const computeRoutes = (self: string, selfLinks: Iterable<string>, announced: Map<string, string[]>, avoid: ReadonlySet<string> = new Set()): Map<string, Route> => {
  const adj = new Map<string, Set<string>>()
  const edge = (u: string, v: string) => {
    if (u === v || avoid.has(u) || avoid.has(v)) return
    if (!adj.has(u)) adj.set(u, new Set())
    if (!adj.has(v)) adj.set(v, new Set())
    adj.get(u)!.add(v)
    adj.get(v)!.add(u)
  }
  for (const v of selfLinks) edge(self, v)
  for (const [u, links] of announced) {
    if (u === self) continue
    for (const v of links) {
      if (v === self) continue // our side of an edge is only what we hold live
      if ((announced.get(v) ?? []).includes(u)) edge(u, v)
    }
  }

  const routes = new Map<string, Route>()
  const queue: string[][] = [[self]]
  const seen = new Set([self])
  while (queue.length) {
    const path = queue.shift()!
    const at = path[path.length - 1]!
    for (const next of [...(adj.get(at) ?? [])].sort()) {
      if (seen.has(next)) continue
      seen.add(next)
      const p = [...path, next]
      routes.set(next, { node: next, nextHop: p[1]!, hops: p.length - 1, path: p.slice(1) })
      queue.push(p)
    }
  }
  return routes
}

/**
 * Flap damping: a link that dropped 3 times in 5 minutes is not announced
 * again until it has stayed up for a minute, so one unstable link cannot keep
 * every route in the mesh churning.
 */
export const FLAP_DROPS = 3
export const FLAP_WINDOW_MS = 5 * 60_000
export const FLAP_HOLD_MS = 60_000

export const isFlapping = (drops: number[], now: number): boolean => drops.filter((t) => now - t < FLAP_WINDOW_MS).length >= FLAP_DROPS

export const announceable = (drops: number[], openedAt: number, now: number): boolean =>
  !isFlapping(drops, now) || now - openedAt >= FLAP_HOLD_MS

/**
 * Whether a closed link counts as a drop for damping: it carried a validated
 * peer, and no other live link to that node remains. The duplicate a
 * tie-break closes is not a drop; losing the node is.
 */
export const isDrop = (peerValidated: boolean, stillLinked: boolean): boolean => peerValidated && !stillLinked
