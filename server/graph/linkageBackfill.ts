/**
 * §3 memory→file linkage backfill (migration "0009"). One repeatable, idempotent
 * pass over the corpus: derive file mentions from each memory's body+description
 * (§1), reconcile MENTIONS_FILE edges with provenance (§2), then a REFERENTIAL
 * triage pass (§4). Bounded — one query for memories + per-memory edge reads, no
 * graph-wide rescans (the wedge lesson). Re-run ⇒ 0 new edges (keyed upserts +
 * idempotent reconcile).
 *
 * NON-destructive to memories: triage removes ONLY broken referential pointers
 * (dangling src/dst MENTIONS_FILE edges) + empty file-stubs. Session-sourced and
 * explicit/frontmatter edges are never removed here; stale-derived decay is s4.
 *
 * Runs in 3 contexts, all calling this one function: server boot (runMigrations,
 * gated by migrations.json), the POST /api/graph/linkage-backfill endpoint, and
 * the server-less ckn-backfill-md CLI.
 */
import { all, get, run, transaction } from './db.js'
import { deriveFileMentions } from './fileMentions.js'
import { reconcileFileEdgeOps, type ExistingFileEdge, type EdgeProvenance } from './reconcileFileEdges.js'
import { applyFileEdgeOps, fileEntryId, pruneOrphanStubs } from './sync.js'

export interface BackfillResult {
  scanned: number
  edgesCreated: number
  edgesUpdated: number
  removed: number
}

// kinds that are NOT memory content (their edges are session/auto provenance).
const NON_MEMORY = ['session', 'file', 'tool']

export async function backfillLinkage(): Promise<BackfillResult> {
  const memories = all<{ id: string; content: string | null; description: string | null }>(
    `SELECT id, content, description FROM entries WHERE kind NOT IN (${NON_MEMORY.map(() => '?').join(',')})`,
    ...NON_MEMORY,
  )

  let scanned = 0
  let edgesCreated = 0
  let edgesUpdated = 0

  transaction(() => {
    for (const m of memories) {
      scanned++
      const text = `${m.content ?? ''}\n${m.description ?? ''}`
      // verbatim path → stub id, kept for stub creation (§1: name is verbatim).
      const pathById = new Map<string, string>()
      for (const p of deriveFileMentions(text)) pathById.set(fileEntryId(p), p)
      const derivedDsts = [...pathById.keys()]

      const existing: ExistingFileEdge[] = all<{ dst: string; provenance: string | null }>(
        `SELECT dst, provenance FROM edges WHERE src = ? AND rel = 'MENTIONS_FILE'`,
        m.id,
      ).map((e) => ({ dst: e.dst, provenance: (e.provenance as EdgeProvenance) || 'frontmatter' }))
      // The backfill reads the GRAPH (not files): existing frontmatter edges ARE
      // the author's frontmatter intent, so they stay (never auto-removed). The
      // job is to ADD body-derived edges. Retract-detection runs at sync per-file.
      const frontmatterDsts = existing.filter((e) => e.provenance === 'frontmatter').map((e) => e.dst)

      const r = applyFileEdgeOps(m.id, reconcileFileEdgeOps(existing, frontmatterDsts, derivedDsts), pathById)
      edgesCreated += r.created
      edgesUpdated += r.updated
    }
  })

  // ── §4 referential triage (one-time sweep) — REMOVE broken pointers only ──
  let removed = 0
  transaction(() => {
    // Dangling MENTIONS_FILE edges: src or dst row absent from `entries`.
    const dangling = get<{ c: number }>(
      `SELECT count(*) c FROM edges WHERE rel = 'MENTIONS_FILE'
         AND (src NOT IN (SELECT id FROM entries) OR dst NOT IN (SELECT id FROM entries))`,
    )
    removed += Number(dangling?.c ?? 0)
    run(
      `DELETE FROM edges WHERE rel = 'MENTIONS_FILE'
         AND (src NOT IN (SELECT id FROM entries) OR dst NOT IN (SELECT id FROM entries))`,
    )
  })
  // Empty file-stubs (content='' + zero edges) — the existing referential prune.
  removed += await pruneOrphanStubs()

  return { scanned, edgesCreated, edgesUpdated, removed }
}
