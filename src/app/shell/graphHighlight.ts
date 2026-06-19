/**
 * #122(c) — pure highlight-decision helpers for the graph view.
 *
 * The selection/cluster-filter styling of the force graph is data-driven: given a
 * node/edge and the current (activeId, highlightedKinds), what opacity / radius /
 * stroke should it get? Extracting these as pure functions makes them unit-testable
 * (GraphCanvas has no render harness) and lets the component apply them to RETAINED
 * d3 selections scoped to the affected elements — instead of a full-DOM
 * `svg.selectAll(...)` re-query and restyle on every selection/filter change.
 *
 * No imports — keep this dependency-free so it stays trivially testable via tsx.
 */

/** A node is "highlighted" when there is no cluster filter, or its kind is in it. */
const isKindHighlighted = (kind: string, highlightedKinds: Set<string>): boolean =>
  highlightedKinds.size === 0 || highlightedKinds.has(kind)

export interface NodeHighlight {
  active: boolean
  strokeWidth: number
  fillOpacity: number
  r: number
  opacity: number
}

/** Per-node circle styling for the current selection + cluster filter. The active
 *  node always wins (full styling) even if a filter would otherwise dim its kind. */
export const nodeHighlight = (
  id: string,
  kind: string,
  activeId: string | null,
  highlightedKinds: Set<string>,
): NodeHighlight => {
  const active = id === activeId
  const highlighted = isKindHighlighted(kind, highlightedKinds)
  return {
    active,
    strokeWidth: active ? 2.5 : 1.4,
    fillOpacity: active ? 0.4 : highlighted ? 0.18 : 0.05,
    r: active ? 9 : 7,
    opacity: highlighted ? 1 : 0.25,
  }
}

/** Per-node label opacity — driven purely by the cluster filter. */
export const textOpacity = (kind: string, highlightedKinds: Set<string>): number =>
  isKindHighlighted(kind, highlightedKinds) ? 0.95 : 0.2

export interface EdgeHighlight {
  touchesActive: boolean
  strokeOpacity: number
  strokeWidth: number
}

/** Per-edge styling. An edge touching the active node is emphasized; with a cluster
 *  filter, an edge touching no in-filter kind is dimmed. */
export const edgeHighlight = (
  srcId: string,
  dstId: string,
  srcKind: string,
  dstKind: string,
  activeId: string | null,
  highlightedKinds: Set<string>,
): EdgeHighlight => {
  const touchesActive = !!activeId && (srcId === activeId || dstId === activeId)
  const hasFilter = highlightedKinds.size > 0
  const touchesFilter = hasFilter && (highlightedKinds.has(srcKind) || highlightedKinds.has(dstKind))
  const strokeOpacity = touchesActive ? 0.9 : hasFilter && !touchesFilter ? 0.1 : 0.55
  return { touchesActive, strokeOpacity, strokeWidth: touchesActive ? 1.4 : 1 }
}

/** Shallow set equality — used to detect whether the cluster filter changed (which
 *  needs a full restyle) vs a selection-only change (scoped restyle). */
export const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
