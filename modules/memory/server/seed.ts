/**
 * Stage 1 of recall — seeding, and SAYING WHICH SEED RAN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROVENANCE IS THE POINT, NOT AN EXTRA
 *
 * The design calls for a vector seed. The vector half depends on an embedding
 * backend that does not exist yet, so today the lexical seed does the work.
 *
 * That is fine. What is NOT fine is the two being indistinguishable from
 * outside. A system running lexical-only because embeddings are OFF and one
 * running lexical-only because embeddings are BROKEN must not produce the same
 * result: that is the exact shape that lets a store sit with hundreds of
 * unembedded memories for months unnoticed, and the shape that had the dedupe reflex answering
 * "no duplicates" against an empty graph forever.
 *
 * So every seed result carries `via` and, when a better seed was available but
 * declined to run, `degradedFrom` with the reason. Silence is never the report.
 */

import { queryTerms } from './relevance.js'
import type { EmbeddingEstimator } from './embedding.js'
import type { MemoryStore } from './store.js'
import type { Memory } from './types.js'

export type SeedKind = 'vector' | 'lexical' | 'none'

export type SeedResult = {
  memories: Memory[]
  via: SeedKind
  /**
   * Set when a stronger seed COULD have run and did not, with why.
   *
   * Never omitted on a degrade. A caller that cannot tell a deliberate
   * configuration from a broken backend will report both as healthy.
   */
  degradedFrom?: { kind: SeedKind; reason: string }
  /** True when the seed hit its bound — coverage was reduced, so it is said. */
  truncated: boolean
}

export type Seed = {
  kind: SeedKind
  /** Ready to do its job right now? A backend that cannot embed says so here. */
  available(): { ok: true } | { ok: false; reason: string }
  seed(query: string, k: number): Memory[]
}

/**
 * Term-based lexical search. The honest placeholder, and labelled as one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT `store.search(query)` DIRECTLY — IT IS WEAKER THAN IT SOUNDS
 *
 * `MemoryStore.search` is a LIKE over name/description/content, and it matches
 * THE WHOLE QUERY AS ONE SUBSTRING. Passing a real query — a sentence, a
 * session's prompt — therefore only matches memories containing that sentence
 * near-verbatim, which is approximately never. Measured while testing recall:
 * two memories about the same subject in different words produced zero seeds.
 *
 * "Substring search" reads like a weak-but-working baseline. Whole-query
 * substring search is not a baseline, it is a near-guarantee of no results, and
 * the difference is invisible from the call site.
 *
 * So the query is split into terms and each is searched, results unioned in
 * first-hit order. Still not semantic, still labelled `via: 'lexical'` — but it
 * is a placeholder that actually places.
 *
 * Very short tokens are dropped: they match everything and would return the
 * corpus in arbitrary order, which is worse than returning nothing because it
 * looks like a result.
 */
export const MIN_TERM_LENGTH = 3

export const lexicalSeed = (store: MemoryStore): Seed => ({
  kind: 'lexical',
  available: () => ({ ok: true }),
  seed: (query, k) => {
    const terms = [...queryTerms(query)].filter((t) => t.length >= MIN_TERM_LENGTH)
    if (!terms.length) return store.search(query, k).filter((m) => m.authorship !== 'extracted')
    return store.searchTerms(terms, k)
  },
})

/**
 * Vector seed — present when an embedding backend is READY, absent loudly
 * otherwise.
 *
 * NOT BUILT BEYOND THE SEAM: no backend loads a model yet, so `available()`
 * reports unavailable and the pipeline degrades to lexical WITH THAT REASON
 * ATTACHED. When the backend lands this becomes live without any caller
 * changing, and — more importantly — without any caller having silently
 * believed it was live all along.
 */
export const vectorSeed = (store: MemoryStore, estimator: EmbeddingEstimator): Seed => ({
  kind: 'vector',
  available: () => {
    const why = estimator.unavailable()
    return why ? { ok: false, reason: why } : { ok: true }
  },
  seed: (query, k) => {
    // Placeholder shape: with a live backend this ranks the corpus by cosine
    // against the query vector. Deliberately not faked with lexical results —
    // a vector seed that silently returns lexical hits is the lie this whole
    // file exists to prevent.
    void query
    void k
    void store
    return []
  },
})

/**
 * Run the best available seed, and report the degrade.
 *
 * Order is preference order. The first seed whose `available()` says yes runs;
 * every seed skipped before it is recorded as the thing we degraded FROM.
 */
export const runSeed = (seeds: Seed[], query: string, k: number): SeedResult => {
  let degradedFrom: SeedResult['degradedFrom']

  for (const s of seeds) {
    const avail = s.available()
    if (!avail.ok) {
      // Only the FIRST (most-preferred) refusal is worth reporting — that is the
      // capability the caller thought they had.
      degradedFrom ??= { kind: s.kind, reason: avail.reason }
      continue
    }
    const memories = s.seed(query, k)
    return { memories, via: s.kind, degradedFrom, truncated: memories.length >= k }
  }

  return { memories: [], via: 'none', degradedFrom, truncated: false }
}
