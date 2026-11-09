/**
 * Memory's public shapes.
 *
 * Consumers of memory's capabilities declare the shapes they need STRUCTURALLY
 * at their own call sites rather than importing from here — a type-only import
 * still has to resolve at compile time, so an OPTIONAL dependency whose provider
 * is absent would fail to build. These types are the reference such a consumer
 * writes against; they are not the coupling.
 */

/** What shape of memory this is. Axis 2 of the taxonomy. */
export const SHAPES = [
  'decision',
  'error',
  'workflow',
  'reference',
  'feedback',
  'pattern',
  'observation',
  'thread',
] as const
export type Shape = (typeof SHAPES)[number]

/** Who authored it. Axis 3. An enum, not V1's free-text column. */
export const AUTHORSHIPS = ['authored', 'derived', 'extracted'] as const
export type Authorship = (typeof AUTHORSHIPS)[number]

/**
 * Hubs exist so edges have somewhere to land. They carry no authored content,
 * never decay, and are never a search result. Structurally distinct from
 * memories — this is the distinction V1 kept re-deriving with a filter.
 */
export const HUB_KINDS = ['file', 'tool', 'session', 'agent', 'facet'] as const
export type HubKind = (typeof HUB_KINDS)[number]

export type Memory = {
  id: string
  /**
   * PROVENANCE — where this text most recently arrived from. NEVER identity.
   *
   * Held the "stable identity" claim until the first-class-memory charter
   * un-earned it: an inbox that empties has no stable path-to-memory mapping,
   * so the next write to a path is a different memory.
   */
  source: string
  /** The declared slug. Kebab-case, one fact per memory. A matching SIGNAL. */
  name: string
  description: string
  content: string
  shape: Shape
  authorship: Authorship
  scope: string
  pinned: boolean
  /** Generic decay exemption. Other modules write it through a capability. */
  protected: boolean
  contentHash: string
  machine: string
  /** When it was written. Recency ranks on this. */
  authoredAt: number
  /** When we indexed it. Not the same clock. */
  ingestedAt: number
  outcome: string
  outcomeText: string
}

export type Hub = { id: string; kind: HubKind; name: string }

export type DeclaredRel =
  | 'mentions_file'
  | 'mentions_tool'
  | 'resolves'
  | 'contradicts'
  | 'occurred_in'
  | 'evolved_into'
  | 'authored_by'
  | 'groups'

/**
 * Observed relations. All of these must survive re-ingest.
 *
 * `surfaced_in` carries TWO independent reasons to survive, not one: it is a
 * ranking signal AND identity evidence — rung 0 corroborates a declared id by
 * asking whether the graph actually showed that node to the writing session. A
 * rule with two reasons survives a refactor that a rule with one does not.
 *
 * `concurrent_with` marks a settleable pair — a slug collision, or two machines
 * writing concurrently. Durable BY POLICY rather than underivable: journal
 * replay carries machine, authored_at and slug, so it could be recomputed; we
 * simply never discard it, because it also accumulates settlement state.
 *
 * `also_ingested_in` records that a folded duplicate arrived under another
 * scope. Without it a global content-hash fold silently narrows relevance.
 */
export type ObservedRel = 'surfaced_in' | 'used_in' | 'edited_in' | 'concurrent_with' | 'also_ingested_in' | 'origin_scope'
/**
 * Derived relations, written by passes. `focus` and `about` link a memory to
 * its facet hubs (its one focus, and the other facets it touches); `part_of`
 * links a work facet to the work above it, which is the spine (design 4.5).
 */
export type DerivedRel = 'similar_to' | 'focus' | 'about' | 'part_of' | 'contradicts' | 'evolved_into'

export type DeclaredEdge = { src: string; dst: string; rel: DeclaredRel; label?: string }
export type ObservedEdge = {
  src: string
  dst: string
  rel: ObservedRel
  count: number
  firstAt: number
  lastAt: number
}
export type DerivedEdge = { src: string; dst: string; rel: DerivedRel; score: number }

/** What a memory-module event carries. */
export type MemoryUpserted = { id: string; source: string; contentHash: string; at: number }
export type MemoryDeleted = { id: string; source: string; at: number }

/**
 * Event names. `memory.deleted` exists from the first commit, before any
 * transport subscribes — V1's tombstone origination was never wired, so
 * deleting a memory on one machine silently returned it from another. An
 * upsert-only vocabulary would rebuild that gap behind a cleaner architecture,
 * where it is harder to notice because the design looks right.
 */
export const MEMORY_UPSERTED = 'memory.upserted'
export const MEMORY_DELETED = 'memory.deleted'
/** After every ingest: what was captured, and its sync class (private mind, design 3.1). */
export const MEMORY_CAPTURED = 'memory.captured'
export type CapturedPayload = { id: string; machine: string; seq: number; slug?: string; shape: string; syncClass?: string; session?: string }
