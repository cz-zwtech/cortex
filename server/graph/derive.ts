/**
 * Observation derivation — server-side module.
 *
 * Walks Cortex memories, finds clusters of semantically-similar entries,
 * and writes Observation nodes with DERIVED_FROM edges to each source.
 * Lives in the server (not just a CLI script) because the server owns the
 * embedding worker thread; any in-process Cortex client that needs to write
 * with warm embeddings goes through here.
 *
 * The CLI wrapper `bin/ckn-derive.ts` calls this via POST /api/derive
 * when the server is up, and direct-imports this module only when no
 * server is bound (same pattern as ckn-sync.ts).
 *
 * Design influences:
 *   - Hindsight (vectorize.io): evidence-grounded Observations with
 *     trend tracking (stable/strengthening/weakening/stale).
 *   - Honcho (plastic-labs): async derive worker decoupled from
 *     ingest; observer/observed pairing reserved (default 'self').
 *
 * Synthesis is currently deterministic — the Observation's name is
 * derived from the cluster's seed memory and member count. An LLM
 * (Haiku) synthesis pass is the obvious next step.
 */
import { all, run, transaction } from './db.js'
import { getEmbeddingMode, embedText } from '../embeddings.js'
import { searchSimilar } from '../embeddingStore.js'

export interface DeriveOptions {
  /** Restrict to memories whose scope starts with this prefix. */
  scope?: string | null
  /** Minimum cluster size (members including the seed). Default 3. */
  minCluster?: number
  /** Minimum cosine similarity for cluster membership. Default 0.7. */
  cosineMin?: number
  /** When true, return the planned clusters without writing anything. */
  dryRun?: boolean
}

export interface ClusterSummary {
  observationId: string
  observationName: string
  scope: string
  trend: 'stable' | 'strengthening' | 'weakening' | 'stale'
  memberIds: string[]
  firstObserved: number
  lastObserved: number
}

export interface DeriveResult {
  candidates: number
  clusters: ClusterSummary[]
  created: number
  dryRun: boolean
}

interface MemoryRow {
  id: string
  name: string
  scope: string
  updatedAt: number
  kind: string
}

const STALE_AGE_DAYS = 60
const STRENGTHEN_DAYS = 7

const slugify = (s: string): string =>
  s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'observation'

/**
 * Build a human-readable observation name from a cluster of memory names.
 *
 * LLM-driven naming (Haiku via `claude -p`) was the original plan but is
 * ruled out by the 2026-06-15 billing change that moves `claude -p` onto
 * per-call API credits. Running it on every cluster every Stop hook
 * would burn real money continuously.
 *
 * Deterministic instead: pick the cluster member whose name reads best
 * (longest descriptive name, biased away from pattern-style prefixes
 * even though pattern kinds are filtered upstream) and append a count.
 */
const buildDisplayName = (memberNames: string[], total: number): string => {
  if (memberNames.length === 0) return `Observation (×${total})`
  // Prefer the longest non-pattern-style name. Pattern names tend to
  // start with "bash-exit-code-", "edit-tool-use-error-", etc. — those
  // are filtered upstream now but might still appear via cosine
  // clustering of similarly-shaped names.
  const sorted = [...memberNames].sort((a, b) => {
    const aPat = /^(bash|edit|read|write|grep)-/.test(a) ? 1 : 0
    const bPat = /^(bash|edit|read|write|grep)-/.test(b) ? 1 : 0
    if (aPat !== bPat) return aPat - bPat
    return b.length - a.length
  })
  const seed = sorted[0]!
  // Truncate very long names for readability in capability sheet
  const display = seed.length > 64 ? seed.slice(0, 61) + '…' : seed
  return `${display} (×${total})`
}

const deriveTrend = (
  firstObserved: number,
  lastObserved: number,
  newMemberCount: number,
): 'stable' | 'strengthening' | 'weakening' | 'stale' => {
  const ageDays = (Date.now() - lastObserved) / 86_400_000
  if (ageDays > STALE_AGE_DAYS) return 'stale'
  if (newMemberCount > 0 && ageDays < STRENGTHEN_DAYS) return 'strengthening'
  const span = (lastObserved - firstObserved) / 86_400_000
  if (span > STALE_AGE_DAYS && newMemberCount === 0) return 'weakening'
  return 'stable'
}

export const deriveObservations = async (opts: DeriveOptions = {}): Promise<DeriveResult> => {
  const minCluster = opts.minCluster ?? 3
  const cosineMin = opts.cosineMin ?? 0.7
  const dryRun = !!opts.dryRun

  if (getEmbeddingMode() === 'off') {
    throw new Error('embeddings are off; cannot derive observations')
  }

  // Pull candidate memories — non-stub kinds, optionally scope-filtered.
  // Excludes:
  //   - file/tool/session/agent: stub nodes, not real memories
  //   - concept: thin auto-stubs, weak signal for synthesis
  //   - observation: avoid re-clustering our own output
  //   - pattern: fail→success traces have their own recall path. Their
  //     dominance (~60 of 87 first-pass clusters were pattern groupings)
  //     drowned out actual project/user-scope beliefs. Patterns are
  //     useful at PostToolUse-on-error; not as standing observations.
  const params: any[] = []
  let scopeClause = ''
  if (opts.scope) {
    scopeClause = ` AND scope LIKE ?`
    params.push(opts.scope + '%')
  }
  const memories = all<MemoryRow>(
    `SELECT id, name, scope, updatedAt, kind FROM entries ` +
      `WHERE kind <> 'file' AND kind <> 'tool' AND kind <> 'session' ` +
      `  AND kind <> 'agent' AND kind <> 'concept' AND kind <> 'observation' ` +
      `  AND kind <> 'pattern'` +
      scopeClause,
    ...params,
  )
  if (memories.length === 0) {
    return { candidates: 0, clusters: [], created: 0, dryRun }
  }

  // Memories already covered by an Observation — skip them, update later.
  const coveredBy = new Map<string, string>()
  try {
    const cov = all<{ oid: string; mid: string }>(
      `SELECT ed.src AS oid, ed.dst AS mid FROM edges ed ` +
        `JOIN entries o ON o.id = ed.src ` +
        `WHERE ed.rel = 'DERIVED_FROM' AND o.kind = 'observation'`,
    )
    for (const row of cov) {
      coveredBy.set(row.mid, row.oid)
    }
  } catch {
    // edge table absent — treat as no coverage
  }

  memories.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))

  const assigned = new Set<string>(coveredBy.keys())
  const clusters: { seed: MemoryRow; members: { id: string; cosine: number }[] }[] = []

  for (const seed of memories) {
    if (assigned.has(seed.id)) continue
    const vec = await embedText(seed.name)
    if (!vec) continue
    const sim = await searchSimilar(vec, 25, cosineMin)
    const members = sim
      .filter((s) => s.id !== seed.id && !assigned.has(s.id))
      .map((s) => ({ id: s.id, cosine: s.score }))
    const fullMembers = [{ id: seed.id, cosine: 1.0 }, ...members]
    if (fullMembers.length < minCluster) continue
    for (const m of fullMembers) assigned.add(m.id)
    clusters.push({ seed, members: fullMembers })
  }

  // Hydrate cluster member rows for timestamp computation.
  const memberRowById = new Map<string, MemoryRow>()
  for (const m of memories) memberRowById.set(m.id, m)

  const summaries: ClusterSummary[] = []
  let created = 0

  for (const cluster of clusters) {
    const sortedByTime = cluster.members
      .map((m) => memberRowById.get(m.id))
      .filter((m): m is MemoryRow => !!m)
      .sort((a, b) => Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0))
    if (sortedByTime.length === 0) continue
    const first = sortedByTime[0]!
    const last = sortedByTime[sortedByTime.length - 1]!
    const recentCount = sortedByTime.filter(
      (m) => Date.now() - Number(m.updatedAt ?? 0) < STRENGTHEN_DAYS * 86_400_000,
    ).length
    const trend = deriveTrend(
      Number(first.updatedAt ?? 0),
      Number(last.updatedAt ?? 0),
      recentCount,
    )

    const obsScope = cluster.seed.scope || 'user'
    const memberNames = sortedByTime.map((m) => m.name)
    const displayName = buildDisplayName(memberNames, cluster.members.length)
    const obsSlug = slugify(memberNames[0] ?? cluster.seed.name)
    const obsId = `observation:${obsScope}/${obsSlug}-${cluster.members.length}`
    const obsName = displayName
    const obsDesc = `Auto-derived from ${cluster.members.length} similar memories. Trend: ${trend}. Most recent: ${new Date(Number(last.updatedAt ?? 0)).toISOString().slice(0, 10)}.`

    summaries.push({
      observationId: obsId,
      observationName: obsName,
      scope: obsScope,
      trend,
      memberIds: cluster.members.map((m) => m.id),
      firstObserved: Number(first.updatedAt ?? 0),
      lastObserved: Number(last.updatedAt ?? 0),
    })

    if (dryRun) continue

    const now = Date.now()
    const firstObserved = Number(first.updatedAt ?? 0)
    const lastObserved = Number(last.updatedAt ?? 0)
    try {
      // DETACH DELETE the old observation (entry + its specialization + all
      // incident edges) then re-create — wrapped in one transaction so a
      // crash mid-rewrite never leaves a half-written observation.
      transaction(() => {
        // DETACH DELETE e (entry side: drop incident edges, then the node)
        run(`DELETE FROM edges WHERE src = ? OR dst = ?`, obsId, obsId)
        run(`DELETE FROM entries WHERE id = ?`, obsId)
        // DELETE o (observation specialization side-table)
        run(`DELETE FROM observation_meta WHERE id = ?`, obsId)

        run(
          `INSERT INTO entries ` +
            `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, ` +
            ` authorship, outcome, outcome_text, agent_id, session_id, pinned) ` +
            `VALUES (?, ?, 'observation', ?, '', 'derive', ?, ?, ?, 'derived', '', '', '', '', 0)`,
          obsId, obsName, obsDesc, obsScope, now, now,
        )
        run(
          `INSERT INTO observation_meta ` +
            `(id, trend, evidence_count, first_observed, last_observed, observer, pinned) ` +
            `VALUES (?, ?, ?, ?, ?, 'self', 0)`,
          obsId, trend, cluster.members.length, firstObserved, lastObserved,
        )
        // DERIVED_FROM edges: observation → each source memory. Composite PK
        // (src,dst,rel) gives free idempotency; INSERT OR IGNORE matches the
        // old per-edge CREATE (no duplicate edges).
        for (const m of cluster.members) {
          run(
            `INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, 'DERIVED_FROM')`,
            obsId, m.id,
          )
        }
      })
    } catch (e: any) {
      console.warn(`[ckn derive] write observation ${obsId} failed: ${e?.message ?? e}`)
      continue
    }
    created++
  }

  return { candidates: memories.length, clusters: summaries, created, dryRun }
}
