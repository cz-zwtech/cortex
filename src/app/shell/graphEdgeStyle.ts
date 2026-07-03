/**
 * #126 — pure edge-styling helpers for the graph view.
 *
 * getAllForGraph now exports every entries<->entries edge carrying its `rel`
 * (not just LINKS_TO), so the force graph can colour edges by relation type and
 * offer an OPT-IN per-rel filter — the edge analogue of the highlightedKinds
 * cluster filter. Per Corey's intent the default view shows EVERYTHING; the filter
 * is a declutter tool, never a hiding default.
 *
 * No imports — dependency-free so it stays trivially testable via tsx, mirroring
 * graphHighlight.ts.
 */

/** Uniform colour for any rel without an explicit mapping (the pre-#126 edge tone). */
export const DEFAULT_REL_COLOR = '#2a3158'

/** Distinct hues per known relation. Memory-connecting rels are warm/cool-spread so
 *  the relation type is legible at a glance; unknown rels fall back to the default. */
const REL_COLORS: Record<string, string> = {
  LINKS_TO: '#5b6cff',      // explicit wikilink — indigo
  MENTIONS_FILE: '#3fb6a8', // memory -> file — teal
  MENTIONS_TOOL: '#c98bdb', // memory -> tool — orchid
  EDITED_IN: '#e0a458',     // file -> session — amber
  SURFACED_IN: '#6aa9e9',   // memory -> session (recall hit) — sky
  OCCURRED_IN: '#8a93a8',   // memory -> session — slate
  CONTRADICTS: '#e06c75',   // supersession (new -> old) — red
  EVOLVED_INTO: '#98c379',  // supersession (old -> new) — green
  RESOLVES: '#56b6c2',      // memory -> error/ticket — cyan
  AUTHORED_BY: '#7f8caa',   // memory -> agent — muted
  GROUPS: '#d19a66',        // thread -> member — ochre
  SIMILAR_TO: '#b58cff',    // #127 kNN similarity — violet (reserved)
}

/** Stroke colour for an edge of the given relation. */
export const relColor = (rel: string): string => REL_COLORS[rel] ?? DEFAULT_REL_COLOR

/** An edge's rel is visible when there is no rel filter, or its rel is in it.
 *  Mirrors isKindHighlighted: an empty filter means "show all". */
export const relVisible = (rel: string, highlightedRels: Set<string>): boolean =>
  highlightedRels.size === 0 || highlightedRels.has(rel)
