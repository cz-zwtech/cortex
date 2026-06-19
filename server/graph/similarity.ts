/**
 * #127 — pure similarity helpers for kNN connectivity-enrichment edges.
 *
 * Dependency-free: topKSimilar takes the vector store as input (the sync-time Pass D
 * supplies it from the embedding sidecar) and capInDegree bounds hub over-linking.
 * No I/O, no graph/embedding imports — trivially unit-testable via tsx, mirroring
 * graphEdgeStyle.ts / graphHighlight.ts.
 */

/** Cosine similarity of two vectors. Guards a zero-norm operand => 0 (never NaN).
 *  bge embeddings are L2-normalised so this reduces to a dot product, but the full
 *  form keeps the helper correct for arbitrary test vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface SimHit {
  id: string
  score: number
}

/** Top-K nearest neighbours of `targetId` by cosine over `store`, excluding self and
 *  any neighbour scoring below `minScore`, sorted by score descending. A negative `k`
 *  returns all qualifying neighbours. */
export function topKSimilar(
  targetId: string,
  targetVec: Float32Array,
  store: Iterable<readonly [string, Float32Array]>,
  k: number,
  minScore: number,
): SimHit[] {
  const hits: SimHit[] = []
  for (const [id, vec] of store) {
    if (id === targetId) continue
    const score = cosine(targetVec, vec)
    if (score >= minScore) hits.push({ id, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return k >= 0 ? hits.slice(0, k) : hits
}

export interface SimEdgeRow {
  src: string
  dst: string
  weight: number
}

/** Bound hub over-linking: keep at most `m` inbound edges per `dst`, the highest by
 *  weight. Targets with <= m inbound are returned unchanged; input order is otherwise
 *  preserved for deterministic output. A negative `m` disables the cap. */
export function capInDegree<E extends SimEdgeRow>(edges: E[], m: number): E[] {
  if (m < 0) return edges
  const byDst = new Map<string, E[]>()
  for (const e of edges) {
    const list = byDst.get(e.dst)
    if (list) list.push(e)
    else byDst.set(e.dst, [e])
  }
  const keep = new Set<E>()
  for (const list of byDst.values()) {
    if (list.length <= m) {
      for (const e of list) keep.add(e)
      continue
    }
    // Strongest M by weight; Array.sort is stable so equal weights keep input order.
    const sorted = [...list].sort((a, b) => b.weight - a.weight)
    for (const e of sorted.slice(0, m)) keep.add(e)
  }
  return edges.filter((e) => keep.has(e))
}

// ── env-tunable knobs (condition C: behind CKN_SIMILARITY_*, off-able) ──────────

/** Master switch. Similarity requires embeddings, so it is inherently off when
 *  embeddings are off; CKN_SIMILARITY=off disables it even when embeddings are on. */
export const similarityEnabled = (embedMode: string): boolean =>
  embedMode !== 'off' && process.env.CKN_SIMILARITY !== 'off'

const posIntEnv = (name: string, def: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : def
}

/** Neighbours kept per source. */
export const simK = (): number => posIntEnv('CKN_SIMILARITY_K', 5)

/** Minimum cosine for a similarity edge. */
export const simThreshold = (): number => {
  const n = Number(process.env.CKN_SIMILARITY_THRESHOLD)
  return Number.isFinite(n) && n > -1 && n <= 1 ? n : 0.55
}

/** Max inbound SIMILAR_TO per target — bounds hub over-linking. */
export const simMaxIndegree = (): number => posIntEnv('CKN_SIMILARITY_MAX_INDEGREE', 15)

/** Brute-force ceiling: above this many embedded entries the O(n^2) pass is skipped
 *  (ANN deferred). */
export const simMaxN = (): number => posIntEnv('CKN_SIMILARITY_MAX_N', 20000)
