/**
 * Stage 2 of recall — typed-edge expansion, stopped by an ADMISSIBLE BOUND.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT STOPS THE TRAVERSAL
 *
 * Not a tuned depth cap. Depth stops when no candidate at the next depth could
 * possibly enter the result — see `scoreCeiling` / `shouldExpand` in rank.ts.
 * That is lossless: the output equals what unbounded traversal would return, so
 * the saving costs no recall.
 *
 * Breadth is still bounded, because a single hub can have thousands of edges and
 * one pathological node would otherwise dominate a query. THAT bound IS lossy,
 * so unlike the depth rule it is REPORTED whenever it bites. Two different kinds
 * of limit with two different honesty obligations, kept distinct on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFECTS FROM V1 FIXED RATHER THAN CARRIED
 *
 *   - `recallForFile` full-scans every MENTIONS_FILE edge on the per-edit hot
 *     path, unbounded, then path-matches in JS. Here every hop is an indexed
 *     lookup from a known id, and the frontier is bounded.
 *   - V1 has two ranking regimes: `recallForFile` ignores cosine yet still runs
 *     the cosine-weighted composite, and gates decay off with a comment
 *     admitting the cost was never measured. There is one scorer here and
 *     everything goes through it.
 *   - Hubs are structurally distinct from memories, so expansion can hop
 *     THROUGH a hub (file, session, tool) without ever returning one as a
 *     result. V1 re-derived that distinction with a filter at each call site.
 */

import { shouldExpand, type Weights } from './rank.js'
import type { MemoryStore } from './store.js'
import type { Memory } from './types.js'

export type Reached = {
  memory: Memory
  hops: number
  /** The relation traversed on the LAST hop that reached it. */
  relation: string
}

export type ExpandReport = {
  reached: Reached[]
  /** Depth actually explored. Lower than `maxDepth` means the bound stopped it. */
  depthExplored: number
  /**
   * Nodes whose edges were NOT fully followed because the breadth cap bit.
   *
   * Lossy and therefore reported — a traversal that silently stopped early reads
   * as "nothing else was relevant", which is the one thing it does not mean.
   */
  breadthTruncatedAt: string[]
  /** True when depth ended because deeper hops provably could not matter. */
  stoppedByBound: boolean
}

export type ExpandOptions = {
  store: MemoryStore
  weights?: Weights
  /** Edges followed per node. Lossy cap; bites on hub-like nodes. */
  maxEdgesPerNode?: number
  /** Hard ceiling, a backstop only — the bound should stop first. */
  maxDepth?: number
  /** Total distinct memories to reach. A budget, reported when hit. */
  maxNodes?: number
  /**
   * The k-th best score currently held, AFTER collapse.
   *
   * After collapse and not before: collapse removes candidates, so the surviving
   * k-th is lower, and thresholding on the pre-collapse number would stop the
   * traversal too early and silently lose results.
   */
  kthBest?: number
  /**
   * Recompute the threshold from everything reached so far, after each depth.
   *
   * THIS IS THE HALF THAT MAKES THE RULE "DERIVED FROM THE RESULTS JUST READ"
   * rather than merely bounded. Without it the threshold is whatever the seeds
   * scored, fixed for the whole traversal.
   *
   * A static seed-derived threshold is still SOUND — the k-th best can only rise
   * as candidates arrive, so an early value is an under-estimate and the bound
   * merely stops later than it could. It is conservative, never lossy. But it
   * leaves most of the saving on the table, because the strongest evidence for
   * stopping is exactly the evidence the traversal just produced.
   */
  onDepth?: (reached: Reached[]) => number | undefined
}

export const DEFAULT_MAX_EDGES_PER_NODE = 32
export const DEFAULT_MAX_DEPTH = 6
export const DEFAULT_MAX_NODES = 200

/**
 * Walk out from the seeds, one depth at a time.
 *
 * Breadth-first rather than depth-first, and that is required rather than
 * stylistic: the stopping rule compares a whole depth's ceiling against what is
 * held, so depths must complete in order for the bound to mean anything.
 */
export const expand = (seeds: Memory[], opts: ExpandOptions): ExpandReport => {
  const {
    store,
    weights,
    maxEdgesPerNode = DEFAULT_MAX_EDGES_PER_NODE,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES,
    kthBest,
  } = opts
  let threshold = kthBest

  const seen = new Set(seeds.map((m) => m.id))
  const reached: Reached[] = []
  const breadthTruncatedAt: string[] = []
  let frontier = seeds.map((m) => m.id)
  let depth = 0
  let stoppedByBound = false

  while (frontier.length && depth < maxDepth && reached.length < maxNodes) {
    const next = depth + 1

    // THE STOPPING RULE. Ask before paying for the hop, not after.
    if (!shouldExpand(next, threshold, weights)) {
      stoppedByBound = true
      break
    }

    const nextFrontier: string[] = []

    for (const id of frontier) {
      const edges = [
        ...store.declaredEdges(id).map((e) => ({ dst: e.dst, rel: e.rel as string })),
        ...store.observedEdges(id).map((e) => ({ dst: e.dst, rel: e.rel as string })),
        ...store.derivedEdges(id).map((e) => ({ dst: e.dst, rel: e.rel as string })),
        // A facet hub is reached from its memories; from it, the other memories that share it, and the
        // spine both ways. That is how a query by concern finds work from other projects.
        ...(id.startsWith('facet:') ? store.derivedInto(id, ['focus', 'about', 'part_of']).map((e) => ({ dst: e.src, rel: e.rel as string })) : []),
      ]

      if (edges.length > maxEdgesPerNode) breadthTruncatedAt.push(id)

      for (const e of edges.slice(0, maxEdgesPerNode)) {
        if (seen.has(e.dst)) continue
        seen.add(e.dst)

        // A hub is a legitimate WAYPOINT and never a result. Hopping through a
        // file or session node is how two memories that touch the same thing
        // find each other; returning the file itself would be a category error.
        const m = store.get(e.dst)
        if (m) {
          reached.push({ memory: m, hops: next, relation: e.rel })
          if (reached.length >= maxNodes) break
        }
        nextFrontier.push(e.dst)
      }
      if (reached.length >= maxNodes) break
    }

    frontier = nextFrontier
    depth = next

    // Tighten from what this depth actually returned. Monotone: the k-th best
    // only rises, so the threshold only gets stricter and the bound stays
    // admissible.
    const tightened = opts.onDepth?.(reached)
    if (tightened !== undefined) threshold = Math.max(threshold ?? -Infinity, tightened)
  }

  return { reached, depthExplored: depth, breadthTruncatedAt, stoppedByBound }
}
