/**
 * Cortex graph-augmented recall — Phase 4.
 *
 * Combines Phase 2's typed edges with Phase 3's vector embeddings into
 * proper graph-RAG. The recall pipeline:
 *
 *   1. Embed the query (semantic seeds)
 *   2. Vector top-K → seed set
 *   3. From seeds, expand 1 hop along typed edges (:RESOLVES,
 *      :MENTIONS_FILE, :MENTIONS_TOOL, :OCCURRED_IN, :CONTRADICTS,
 *      :EVOLVED_INTO). The expanded set is the candidate pool.
 *   4. JS-side rescore by composite: cosine + recency + edge-context
 *      bonuses. No PageRank yet — at our scale (≤10K nodes) the
 *      bonuses are enough signal.
 *   5. Return top N hits with provenance (cosine score, hops, edge
 *      that brought it in) so the recall hook can tell Claude WHY a
 *      memory surfaced.
 *
 * Deterministic + observable: every score component is exposed in the
 * `signals` field of each hit. Makes ranking decisions debuggable
 * after the fact.
 */
import { all } from './db.js'
import { rowToEntry } from './_rows.js'
import { embedText } from '../embeddings.js'
import { searchSimilar } from '../embeddingStore.js'
import { usageBonuses } from '../usageScores.js'
import { fileMentionMatches } from './fileMatch.js'
import { decayScore } from './decay.js'

const SEED_K = 20
const MIN_COSINE = 0.3
const RECENCY_HALFLIFE_DAYS = 30
// s4: how hard a fully-decayed memory (score 1) is docked in recall ranking. A
// de-prioritization comparable to the pin boost — enough to sink stale memories
// below fresh ones, never enough to remove them (MARK never delete). Tunable.
const DECAY_RANK_PENALTY = Number(process.env.CKN_DECAY_RANK_PENALTY) || 0.3
// recallForFile is the tier-1 PER-EDIT path (the hottest), and decayScore →
// reinforcementFor is a per-candidate cost that is ~0 today (live SURFACED_IN=0)
// but GROWS with the corpus. This morning's tail-parse lesson — don't accept an
// unmeasured, corpus-growing cost on the hottest path by assumption — applies, so
// decay on recallForFile is GATED default-OFF until measured. graphRecall
// (per-prompt) ships ON. Flip with CKN_DECAY_RECALLFORFILE=1 once profiled.
const DECAY_ON_RECALLFORFILE = process.env.CKN_DECAY_RECALLFORFILE === '1'
// Scope prior (now-slice): a CONSERVATIVE additive nudge so same-project /
// same-objective memories edge out equally-relevant ones — it must NEVER
// override a meaningfully better cosine match. Labeled tuning knob; revisit
// only on a quality eyeball, do not raise into override territory.
export const SCOPE_PRIOR_WEIGHT = Number(process.env.CKN_SCOPE_PRIOR_WEIGHT) || 0.05
// #121: how hard a SUPERSEDED memory (the OLD endpoint of a CONTRADICTS/EVOLVED_INTO
// relation) is docked in recall ranking. Supersession is a HARD signal — an explicit
// "this replaced that" from frontmatter/heuristic — so the penalty is >= the decay
// penalty: enough to sink the stale memory below its replacement, never enough to
// remove it (MARK never delete). Tunable.
const SUPERSEDE_RANK_PENALTY = Number(process.env.CKN_SUPERSEDE_PENALTY) || 0.4

/** Build a `(?, ?, …)` placeholder list of length `n` for an `IN (…)` clause. */
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

export interface RecallContext {
  /** Free-text query — what is the user/agent asking about? */
  query: string
  /** Optional tool context — the tool the recall was triggered by */
  tool?: string
  /** Optional verbatim error text — drives :RESOLVES traversal */
  errorText?: string
  /** File paths mentioned in the current context — drives :MENTIONS_FILE traversal */
  files?: string[]
  /** In-play scopes for the soft scope PRIOR (ancestor project scopes of the
   *  caller's cwd). No longer a hard filter — recall stays folder-transcending. */
  scopes?: string[]
  /** Ids to exclude from the result set — useful when callers already
   *  have one entry and want "similar but not this one" */
  excludeIds?: string[]
  /** Maximum hits to return after rescoring. Defaults to 5. */
  limit?: number
  /** Optional inclusive lower bound on entry.updatedAt (ms epoch).
   *  Entries older than this are dropped before composite scoring.
   *  Temporal queries also shift weight toward recency in the score. */
  since?: number
  /** Optional inclusive upper bound on entry.updatedAt (ms epoch). */
  until?: number
}

export interface RecallSignals {
  /** Cosine similarity to the query embedding. Null when the entry
   *  came in through traversal but never had a vector match. */
  cosine: number | null
  /** Hops from the original seed set — 0 for vector seeds, 1 for
   *  edge-expanded neighbors. */
  hops: number
  /** Recency score in [0, 1]. Tie-breaker only — Phase 5 leaves
   *  pattern memories useful indefinitely; recency just nudges
   *  ordering when other signals tie. */
  recency: number
  /** Edge label that brought this entry in via traversal, if any
   *  ("RESOLVES", "MENTIONS_FILE", etc) — null for direct cosine seeds. */
  viaEdge: string | null
  /** #127: for a SIMILAR_TO neighbour, the stored cosine — scales edgeBonus. */
  viaWeight?: number
  /** Phase 5 use signal — log-normalized surface count in [0, 1].
   *  Saturates at 10 surfaces. New entries (shown=0) score 0 and
   *  are ranked by cosine alone; well-used memories get a bonus. */
  usage: number
  /** s4 decay: ordinal staleness [0,1] of this memory AS OF recall time. The
   *  composite is docked by DECAY_RANK_PENALTY × decay; exempt/acted-on memories
   *  score 0 (zero penalty). A de-prioritization, NEVER a filter — a high-decay
   *  memory still returns. */
  decay: number
  /** #121 supersession: true when this memory is the SUPERSEDED (old) endpoint of a
   *  CONTRADICTS (new→old) or EVOLVED_INTO (old→new) relation. The composite is
   *  docked by SUPERSEDE_RANK_PENALTY — a de-prioritization, NEVER a filter. */
  superseded: boolean
  /** Composite final score (the value used for ranking). */
  composite: number
}

export interface RecallHit {
  id: string
  name: string
  kind: string
  description: string
  content: string
  scope: string
  source: 'pattern' | 'shared' | 'memory' | 'concept' | 'session' | 'other'
  syncedAt: number
  signals: RecallSignals
}

interface CandidateState {
  hops: number
  cosine: number | null
  viaEdge: string | null
  /** #127: the SIMILAR_TO edge's stored cosine, so the bonus scales with closeness. */
  viaWeight?: number
}

/**
 * Build the canonical query text for embedding. Prepends tool + error
 * context when present so the cosine query has more signal than the
 * bare user query.
 */
const buildEmbedQuery = (ctx: RecallContext): string => {
  const parts = [ctx.query]
  if (ctx.tool) parts.push(`tool:${ctx.tool}`)
  if (ctx.errorText) parts.push(ctx.errorText.slice(0, 500))
  return parts.filter(Boolean).join(' — ').slice(0, 1500)
}

/** Map our `kind` discriminator into the bucket the recall hook renders. */
const kindToSource = (kind: string, scope: string): RecallHit['source'] => {
  if (kind === 'pattern') return 'pattern'
  if (scope.startsWith('shared:')) return 'shared'
  if (kind === 'concept') return 'concept'
  if (kind === 'session') return 'session'
  if (
    kind === 'memory' || kind === 'decision' || kind === 'reference' ||
    kind === 'workflow' || kind === 'error' || kind === 'topic' || kind === 'note'
  ) return 'memory'
  return 'other'
}

const recencyScore = (updatedAt: number): number => {
  if (!updatedAt) return 0
  const ageDays = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24)
  if (ageDays < 0) return 1
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS)
}

/**
 * Soft scope proximity in [0,1]. Mirrors the matching the OLD hard filter used
 * (exact id or descendant) but as a RANKING signal, never an exclusion:
 * in-play project scope → 1, user-wide → 0.5, anything else → 0. With no
 * in-play scopes (the common case) it returns 0 and recall is fully
 * scope-agnostic, exactly as today. Boundary-aware: '-' is the encoded path
 * separator, so an exact scope or a true DESCENDANT matches, never a sibling
 * whose encoded name is a mere string-prefix (…-personal vs …-personalish).
 */
export const scopeProximity = (rowScope: string, inPlayScopes: string[] | undefined): number => {
  if (!inPlayScopes || inPlayScopes.length === 0) return 0
  if (inPlayScopes.some((s) => rowScope === s || rowScope.startsWith(`${s}-`))) return 1
  if (rowScope === 'user') return 0.5
  return 0
}

/**
 * Bonus for edge-context: when the query carries an error string and
 * we found this entry via :RESOLVES, that's a strong signal — bump it.
 * Same for :MENTIONS_FILE when files are in the query, etc.
 */
const edgeBonus = (ctx: RecallContext, viaEdge: string | null, viaWeight?: number): number => {
  if (!viaEdge) return 0
  if (viaEdge === 'RESOLVES' && ctx.errorText) return 0.12
  if (viaEdge === 'MENTIONS_FILE' && ctx.files && ctx.files.length > 0) return 0.10
  if (viaEdge === 'MENTIONS_TOOL' && ctx.tool) return 0.08
  // #127: similarity edge — scale by the stored cosine so a 0.9 neighbour outweighs a
  // 0.56 one. Bounded (<= 0.08) so a semantic neighbour nudges ranking without
  // overpowering a direct query/seed hit; decay + supersession still compose on top.
  if (viaEdge === 'SIMILAR_TO') return 0.08 * (viaWeight ?? 0)
  if (viaEdge === 'CONTRADICTS') return 0.05
  if (viaEdge === 'OCCURRED_IN') return 0.03
  // Co-thread sibling (now-slice 2-hop): must beat the flat 0.05 hop penalty so
  // a cosine-less sibling still clears the bar.
  if (viaEdge === 'GROUPS') return 0.08
  return 0.01
}

const composite = (sig: Omit<RecallSignals, 'composite' | 'decay' | 'superseded'>, ctx: RecallContext): number => {
  const cosineScore = sig.cosine ?? 0
  // Direct-seed bonus — we trust vector seeds slightly more than 1-hop
  // expansions because the embedding match is direct evidence of relevance.
  const hopPenalty = sig.hops === 0 ? 0 : 0.05
  // Temporal queries (since/until set) re-weight toward recency: the
  // caller has expressed time-bounded intent ("what did I do last week")
  // so cosine matters less than where-in-time the hit falls.
  const isTemporal = ctx.since !== undefined || ctx.until !== undefined
  const cosineW = isTemporal ? 0.35 : 0.55
  const recencyW = isTemporal ? 0.35 : 0.10
  // Phase 5: usage bonus is positive-only — well-used memories get a
  // boost; never-used memories are NOT penalized. New entries surface
  // by cosine alone; once they prove useful, the bonus accumulates.
  return (
    cosineW * cosineScore +
    0.20 * sig.usage +
    recencyW * sig.recency +
    edgeBonus(ctx, sig.viaEdge, sig.viaWeight) -
    hopPenalty
  )
}

// ── traversal helpers ──────────────────────────────────────────────────────

const fileEntryId = (filePath: string): string =>
  `file:${filePath.replace(/\//g, '_').replace(/\\/g, '_')}`

const toolEntryId = (toolName: string): string =>
  `tool:${toolName.toLowerCase()}`

/**
 * Add an entry to the candidate pool, keeping the strongest signal
 * (lowest hops + highest cosine + best edge context) on collisions.
 */
const addCandidate = (
  pool: Map<string, CandidateState>,
  id: string,
  state: CandidateState,
): void => {
  const existing = pool.get(id)
  if (!existing) {
    pool.set(id, state)
    return
  }
  // Prefer the entry with lower hops; tie-break by cosine.
  if (state.hops < existing.hops) {
    pool.set(id, state)
    return
  }
  if (state.hops === existing.hops) {
    const newScore = state.cosine ?? 0
    const oldScore = existing.cosine ?? 0
    if (newScore > oldScore) {
      pool.set(id, state)
    }
  }
}

/**
 * 1-hop traversal: from a list of seed ids, follow outgoing typed edges
 * (and incoming for symmetric ones). Returns expanded ids tagged with
 * the edge label that brought them in.
 *
 * The 14 rel tables are now one `edges` table with a `rel`
 * discriminator, so the six per-edge MATCHes collapse to a single UNION
 * ALL: outbound rels match on `src`, the "both"-direction rels also match
 * on `dst`. CONTRADICTS is symmetric so only its inbound half is added
 * here (its outbound half rides the first branch); EVOLVED_INTO is bumped
 * in both directions, matching the old `direction: 'both'` semantics.
 */
export const expandFromSeeds = async (
  seedIds: string[],
  pool: Map<string, CandidateState>,
): Promise<void> => {
  if (seedIds.length === 0) return

  // Outbound: a seed is the source, the neighbor is the destination. #127: SIMILAR_TO
  // (kNN semantic neighbours) rides this list so recall traverses the enriched edges.
  const outRels = ['RESOLVES', 'MENTIONS_FILE', 'MENTIONS_TOOL', 'OCCURRED_IN', 'CONTRADICTS', 'EVOLVED_INTO', 'SIMILAR_TO']
  // Inbound (the "both"-direction rels): a seed is the destination, the
  // neighbor is the source — picks up the reverse leg of the symmetric edges.
  const inRels = ['CONTRADICTS', 'EVOLVED_INTO']

  const seedPh = placeholders(seedIds.length)
  const outPh = placeholders(outRels.length)
  const inPh = placeholders(inRels.length)

  // `weight` carries the SIMILAR_TO cosine (1.0 default for the other rels, unused by
  // their flat edgeBonus) so the composite can scale the similarity bonus by closeness.
  const rows = all<{ id: string; viaEdge: string; viaWeight: number }>(
    `SELECT dst AS id, rel AS viaEdge, weight AS viaWeight FROM edges ` +
      `WHERE src IN (${seedPh}) AND rel IN (${outPh}) ` +
      `UNION ALL ` +
      `SELECT src AS id, rel AS viaEdge, weight AS viaWeight FROM edges ` +
      `WHERE dst IN (${seedPh}) AND rel IN (${inPh})`,
    ...seedIds,
    ...outRels,
    ...seedIds,
    ...inRels,
  )
  for (const row of rows) {
    addCandidate(pool, row.id, { hops: 1, cosine: null, viaEdge: row.viaEdge, viaWeight: row.viaWeight })
  }
}

/**
 * From file paths in the query context, find entries that mention them.
 * This is "incoming MENTIONS_FILE" — we're asking: "what memories
 * touched this file?". Adds to the candidate pool with hops=1.
 */
const expandFromFiles = async (
  files: string[],
  pool: Map<string, CandidateState>,
): Promise<void> => {
  if (files.length === 0) return
  const fileIds = files.map(fileEntryId)
  const rows = all<{ id: string }>(
    `SELECT src AS id FROM edges ` +
      `WHERE rel = 'MENTIONS_FILE' AND dst IN (${placeholders(fileIds.length)})`,
    ...fileIds,
  )
  for (const row of rows) {
    addCandidate(pool, row.id, { hops: 1, cosine: null, viaEdge: 'MENTIONS_FILE' })
  }
}

// now-slice co-thread expansion: max sibling members pulled per thread hub.
const COTHREAD_K = Number(process.env.CKN_COTHREAD_K) || 5

/**
 * Bounded co-thread expansion (now-slice): from seed MEMBER memories, hop
 * INBOUND to their thread hubs (a seed is the dst of a GROUPS edge), then
 * OUTBOUND from each hub to its OTHER members (src=thread of GROUPS), capped at
 * COTHREAD_K per thread. The thread hub itself is never added (rankCandidates
 * also drops kind='thread'). Siblings enter at hops=2; edgeBonus('GROUPS')=0.08
 * beats the flat 0.05 hop penalty so a cosine-less sibling still clears the bar.
 */
const expandCoThread = async (
  seedIds: string[],
  pool: Map<string, CandidateState>,
): Promise<void> => {
  if (seedIds.length === 0) return
  const seedPh = placeholders(seedIds.length)
  const threadRows = all<{ threadId: string }>(
    `SELECT DISTINCT src AS threadId FROM edges WHERE dst IN (${seedPh}) AND rel = 'GROUPS'`,
    ...seedIds,
  )
  if (threadRows.length === 0) return
  const seedSet = new Set(seedIds)
  for (const { threadId } of threadRows) {
    const members = all<{ memId: string }>(
      `SELECT dst AS memId FROM edges WHERE src = ? AND rel = 'GROUPS'`,
      threadId,
    )
    let added = 0
    for (const { memId } of members) {
      if (seedSet.has(memId) || added >= COTHREAD_K) continue
      addCandidate(pool, memId, { hops: 2, cosine: null, viaEdge: 'GROUPS' })
      added++
    }
  }
}

/**
 * From a tool context, find entries that mention this tool. Same
 * incoming-edge pattern as expandFromFiles.
 */
const expandFromTool = async (
  tool: string,
  pool: Map<string, CandidateState>,
): Promise<void> => {
  if (!tool) return
  const tid = toolEntryId(tool)
  const rows = all<{ id: string }>(
    `SELECT src AS id FROM edges WHERE rel = 'MENTIONS_TOOL' AND dst = ?`,
    tid,
  )
  for (const row of rows) {
    addCandidate(pool, row.id, { hops: 1, cosine: null, viaEdge: 'MENTIONS_TOOL' })
  }
}

/**
 * Hydrate candidate ids → full entry rows. Coercion (epoch-ms → Number,
 * pinned 0/1 → boolean) goes through the canonical `rowToEntry` mapper so
 * this stays byte-identical to the other entry-projecting endpoints.
 */
const hydrate = async (
  ids: string[],
): Promise<Map<string, {
  id: string
  name: string
  kind: string
  description: string
  content: string
  scope: string
  updatedAt: number
  syncedAt: number
  pinned: boolean
}>> => {
  const out = new Map<string, any>()
  if (ids.length === 0) return out
  const rows = all<Record<string, any>>(
    `SELECT id, name, kind, description, content, scope, updatedAt, syncedAt, pinned ` +
      `FROM entries WHERE id IN (${placeholders(ids.length)})`,
    ...ids,
  )
  for (const row of rows) {
    const e = rowToEntry(row)
    out.set(e.id, {
      id: e.id,
      name: e.name,
      kind: e.kind,
      description: e.description,
      content: e.content,
      scope: e.scope,
      updatedAt: e.updatedAt,
      syncedAt: e.syncedAt,
      pinned: e.pinned,
    })
  }
  return out
}

export interface ScoredCandidate {
  row: {
    id: string; name: string; kind: string; description: string; content: string
    scope: string; updatedAt: number; syncedAt: number; pinned: boolean
  }
  state: CandidateState
  usage: number
  /** s4 decay score [0,1], precomputed by the caller so this stays DB-free. */
  decay: number
  /** #121: true when this candidate is the superseded (old) endpoint of a
   *  CONTRADICTS/EVOLVED_INTO edge — precomputed by the caller (keeps this DB-free). */
  superseded: boolean
}

/**
 * Pure scoring + filtering of an already-hydrated candidate set. Extracted from
 * graphRecall so the now-slice scope prior and the folder-transcendence guard
 * are unit-testable without embeddings/DB. NOTE: there is NO scope EXCLUSION
 * here — scope enters ONLY as the additive scopeProximity prior, so recall stays
 * folder-transcending. Stub/hub kinds (file/tool/thread) and thin concepts are
 * dropped; since/until bounds applied.
 */
export const rankCandidates = (candidates: ScoredCandidate[], ctx: RecallContext): RecallHit[] => {
  const hits: RecallHit[] = []
  for (const c of candidates) {
    const { row, state } = c
    if (ctx.since !== undefined && row.updatedAt < ctx.since) continue
    if (ctx.until !== undefined && row.updatedAt > ctx.until) continue
    // Traversal hubs aren't "memories" — file/tool stubs and (now) thread hubs.
    if (row.kind === 'file' || row.kind === 'tool' || row.kind === 'thread') continue
    if (row.kind === 'concept' && (row.content ?? '').trim().length < 50) continue

    const sig: Omit<RecallSignals, 'composite' | 'decay' | 'superseded'> = {
      cosine: state.cosine,
      hops: state.hops,
      recency: recencyScore(row.updatedAt),
      viaEdge: state.viaEdge,
      viaWeight: state.viaWeight,
      usage: c.usage,
    }
    // Pinned mental models get a flat +0.3 boost. Scope prior is a small additive
    // nudge (never an exclusion). s4 decay de-prioritizes stale. #121: a SUPERSEDED
    // memory (old endpoint of CONTRADICTS/EVOLVED_INTO) is docked so the current
    // memory outranks it — de-prioritize, never filter.
    const pinBoost = row.pinned ? 0.3 : 0
    const scopeBonus = SCOPE_PRIOR_WEIGHT * scopeProximity(row.scope, ctx.scopes)
    const supersedePenalty = c.superseded ? SUPERSEDE_RANK_PENALTY : 0
    const compositeScore =
      composite(sig, ctx) + pinBoost + scopeBonus - DECAY_RANK_PENALTY * c.decay - supersedePenalty

    hits.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description,
      content: row.content,
      scope: row.scope,
      source: kindToSource(row.kind, row.scope),
      syncedAt: row.syncedAt,
      signals: { ...sig, decay: c.decay, superseded: c.superseded, composite: compositeScore },
    })
  }
  hits.sort((a, b) => b.signals.composite - a.signals.composite)
  return hits
}

/**
 * #121: the SUPERSEDED (old) members of a candidate set — the `dst` of a
 * CONTRADICTS edge (materialized new→old) or the `src` of an EVOLVED_INTO edge
 * (materialized old→new). One bounded query per relation over the candidate ids
 * (never a corpus scan), mirroring how decay stays candidate-bounded. Honors the
 * supersede edges sync builds from `contradicts:` / `evolved_from:` frontmatter.
 */
export const supersededCandidateIds = (ids: string[]): Set<string> => {
  const out = new Set<string>()
  if (ids.length === 0) return out
  const ph = placeholders(ids.length)
  const contradicted = all<{ id: string }>(
    `SELECT DISTINCT dst AS id FROM edges WHERE rel = 'CONTRADICTS' AND dst IN (${ph})`,
    ...ids,
  )
  const evolved = all<{ id: string }>(
    `SELECT DISTINCT src AS id FROM edges WHERE rel = 'EVOLVED_INTO' AND src IN (${ph})`,
    ...ids,
  )
  for (const r of contradicted) out.add(r.id)
  for (const r of evolved) out.add(r.id)
  return out
}

// ── public API ──────────────────────────────────────────────────────────────

export const graphRecall = async (ctx: RecallContext): Promise<RecallHit[]> => {
  const limit = ctx.limit ?? 5
  const exclude = new Set(ctx.excludeIds ?? [])
  const pool = new Map<string, CandidateState>()

  // 1. Vector seeds
  let queryVec: Float32Array | null = null
  try {
    queryVec = await embedText(buildEmbedQuery(ctx))
  } catch {
    queryVec = null
  }
  if (queryVec) {
    const seeds = await searchSimilar(queryVec, SEED_K, MIN_COSINE)
    for (const s of seeds) {
      addCandidate(pool, s.id, { hops: 0, cosine: s.score, viaEdge: null })
    }
  }

  // 2. Edge expansion from seeds (1 hop)
  if (pool.size > 0) {
    const seedIds = Array.from(pool.keys())
    await expandFromSeeds(seedIds, pool)
  }

  // 3. Edge expansion from file + tool context — pulls in entries
  //    that wouldn't have been found by cosine but are clearly
  //    relevant to the user's current focus.
  if (ctx.files && ctx.files.length > 0) {
    await expandFromFiles(ctx.files, pool)
  }
  if (ctx.tool) {
    await expandFromTool(ctx.tool, pool)
  }

  // 3b. Co-thread expansion (now-slice) — objective binder. Runs after ALL seed
  //     + file/tool expansion so siblings expand from every seed; bounded 2-hop.
  if (pool.size > 0) {
    await expandCoThread(Array.from(pool.keys()), pool)
  }

  // 4. Drop excluded ids before hydration to save a round-trip
  for (const id of exclude) pool.delete(id)
  if (pool.size === 0) return []

  // 5. Hydrate full rows from the graph
  const candidateIds = Array.from(pool.keys())
  const rows = await hydrate(candidateIds)

  // 5b. Bulk-load usage bonuses — one sidecar read for the whole
  //     candidate set instead of one per candidate.
  const usage = await usageBonuses(candidateIds)

  // 5c. #121: which candidates are the SUPERSEDED endpoint of a CONTRADICTS/
  //     EVOLVED_INTO relation — one bounded edge query over the candidate set.
  const superseded = supersededCandidateIds(candidateIds)

  // 6. Assemble scored candidates (decay + supersession precomputed per candidate so
  //    the ranking stays a pure, testable function) and rank. Scope enters ONLY as
  //    the soft prior inside rankCandidates — NOT a filter (folder-transcending).
  //    s4 decay: ONE decayScore per already-fetched candidate (bounded to the
  //    candidate set, never a corpus scan).
  const candidates: ScoredCandidate[] = []
  for (const id of candidateIds) {
    const row = rows.get(id)
    if (!row) continue
    const state = pool.get(id)!
    candidates.push({
      row,
      state,
      usage: usage.get(id) ?? 0,
      decay: decayScore(id, Date.now()).score,
      superseded: superseded.has(id),
    })
  }
  const hits = rankCandidates(candidates, ctx)

  // 7. Limit
  return hits.slice(0, limit)
}

/**
 * ABOUT tier-1 — file-knowledge recall. Given a repo-relative file (the
 * PreToolUse edit target), surface the memories that mention that file, ranked
 * by the same composite as `graphRecall`. This deliberately does NOT reuse
 * `expandFromFiles` (which matches the underscore-encoded stub id exactly):
 * stored `mentions_files` paths are heterogeneous, so we scan the MENTIONS_FILE
 * file-stubs and path-shape-match on the stub's verbatim `name` via
 * `fileMentionMatches` — unifying absolute / cross-machine / repo-relative
 * copies of the same file under one target.
 *
 * The match is path-based (mentions_files carries no reliable repo token), so a
 * relative path shared by two different repos can cross-match; tier-1 accepts
 * this (code paths are usually specific enough) — tier-2's symbol-level
 * about_edges scoped to mentioned files tightens it.
 */
export const recallForFile = async (
  repoRelFile: string,
  opts: { limit?: number } = {},
): Promise<RecallHit[]> => {
  const limit = opts.limit ?? 3
  const target = (repoRelFile ?? '').trim()
  if (!target) return []

  // Scan MENTIONS_FILE edges → their file-stub `name` (the verbatim stored
  // path; the id is lossily underscore-encoded, the name is not). Normalize +
  // suffix-match against the repo-relative target.
  //
  // Exclude session-sourced edges in SQL. A session is not file-knowledge — it
  // merely touched the file — and a single large session emits a MENTIONS_FILE
  // edge for EVERY file it touched (hundreds), so sessions both pollute the
  // scarce 3-slot pre-edit surface and dominate this synchronous scan. Bounding
  // the source to non-session nodes is the same change for correctness and cost.
  const rows = all<{ memId: string; storedPath: string | null }>(
    `SELECT e.src AS memId, f.name AS storedPath
       FROM edges e
       JOIN entries f ON f.id = e.dst
       JOIN entries s ON s.id = e.src
      WHERE e.rel = 'MENTIONS_FILE' AND f.kind = 'file' AND s.kind <> 'session'`,
  )
  const memIds = new Set<string>()
  for (const r of rows) {
    if (r.storedPath && fileMentionMatches(r.storedPath, target)) memIds.add(r.memId)
  }
  if (memIds.size === 0) return []

  const ids = Array.from(memIds)
  const hydrated = await hydrate(ids)
  const usage = await usageBonuses(ids)
  // #121: which of this file's memories are the superseded (old) endpoint — one
  // bounded edge query (not per-candidate), so it's cheap even on the per-edit path.
  const superseded = supersededCandidateIds(ids)
  const ctx: RecallContext = { query: '', files: [target] }

  const hits: RecallHit[] = []
  for (const id of ids) {
    const row = hydrated.get(id)
    if (!row) continue
    // Same stub-drop filters as graphRecall — traversal hubs aren't "memories".
    // Sessions are excluded in SQL above; this is defense-in-depth.
    if (row.kind === 'file' || row.kind === 'tool' || row.kind === 'session') continue
    if (row.kind === 'concept' && (row.content ?? '').trim().length < 50) continue

    const sig: Omit<RecallSignals, 'composite' | 'decay' | 'superseded'> = {
      cosine: null,
      hops: 1,
      recency: recencyScore(row.updatedAt),
      viaEdge: 'MENTIONS_FILE',
      usage: usage.get(id) ?? 0,
    }
    const pinBoost = row.pinned ? 0.3 : 0
    // s4 decay on this PER-EDIT path is GATED default-OFF (see DECAY_ON_RECALLFORFILE):
    // when off we don't even call decayScore, so zero added per-edit cost. Same
    // de-prioritize-never-filter contract as graphRecall when enabled.
    const decayPenaltyScore = DECAY_ON_RECALLFORFILE ? decayScore(id, Date.now()).score : 0
    const supersedePenalty = superseded.has(id) ? SUPERSEDE_RANK_PENALTY : 0
    hits.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description,
      content: row.content,
      scope: row.scope,
      source: kindToSource(row.kind, row.scope),
      syncedAt: row.syncedAt,
      signals: { ...sig, decay: decayPenaltyScore, superseded: superseded.has(id), composite: composite(sig, ctx) + pinBoost - DECAY_RANK_PENALTY * decayPenaltyScore - supersedePenalty },
    })
  }

  hits.sort((a, b) => b.signals.composite - a.signals.composite)
  return hits.slice(0, limit)
}
