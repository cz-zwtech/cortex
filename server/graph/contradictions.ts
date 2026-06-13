/**
 * Contradiction detection — server-side graph read.
 *
 * The embedding + vector-similarity step (lock-free, reads the embeddings
 * sidecar) stays in the caller (bin/ckn-extract.ts). This module owns only
 * the graph-touching part: hydrate the candidate similar entries' outcome +
 * MENTIONS edges, then apply the heuristic.
 *
 * It lives server-side because the server owns the embedding worker; the
 * caller POSTs the candidate IDs to /api/graph/contradictions and only falls
 * back to calling this module directly when no server is bound.
 *
 * Heuristic (unchanged): a new memory CONTRADICTS an old one when they have
 * opposite outcomes (success vs failure) AND share at least one file/tool
 * reference (same context). Unknown outcomes never contradict.
 */
import { all } from './db.js'

export interface ContradictionQuery {
  /** Candidate entry ids from the vector-similarity pass (cosine ≥ cutoff). */
  similarIds: string[]
  /** Outcome of the NEW memory — 'success' | 'failure' | other. */
  outcome: string
  /** Files the new memory mentions (for shared-context check). */
  mentionsFiles: string[]
  /** Tools the new memory mentions. */
  mentionsTools: string[]
}

export const findContradictions = async (q: ContradictionQuery): Promise<string[]> => {
  const { similarIds, outcome, mentionsFiles, mentionsTools } = q
  if (similarIds.length === 0) return []

  // Opposite-outcome is the gate; bail before any graph work when the new
  // memory's outcome has no clean opposite.
  const oppositeOf: Record<string, string> = { success: 'failure', failure: 'success' }
  const wantedOpposite = oppositeOf[outcome]
  if (!wantedOpposite) return []

  const placeholders = similarIds.map(() => '?').join(', ')

  const rows = all<{ id: string; outcome: string; kind: string }>(
    `SELECT id, outcome, kind FROM entries WHERE id IN (${placeholders}) ` +
      `AND kind <> 'file' AND kind <> 'tool' AND kind <> 'session' ` +
      `AND kind <> 'concept' AND kind <> 'agent'`,
    ...similarIds,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))

  const fileMentions = new Map<string, Set<string>>()
  const toolMentions = new Map<string, Set<string>>()
  try {
    // MATCH (m:Entry)-[:MENTIONS_FILE]->(f:Entry) WHERE m.id IN [...]:
    // gather mentioned-file NAMES per source via the edge table joined back
    // to entries for the target's name. src = the mentioning memory.
    const fr = all<{ id: string; name: string }>(
      `SELECT ed.src AS id, f.name AS name FROM edges ed ` +
        `JOIN entries f ON f.id = ed.dst ` +
        `WHERE ed.rel = 'MENTIONS_FILE' AND ed.src IN (${placeholders})`,
      ...similarIds,
    )
    for (const row of fr) {
      if (!fileMentions.has(row.id)) fileMentions.set(row.id, new Set())
      fileMentions.get(row.id)!.add(row.name)
    }
  } catch {
    // edge table may not exist on a partial install — treat as no overlaps
  }
  try {
    const tr = all<{ id: string; name: string }>(
      `SELECT ed.src AS id, t.name AS name FROM edges ed ` +
        `JOIN entries t ON t.id = ed.dst ` +
        `WHERE ed.rel = 'MENTIONS_TOOL' AND ed.src IN (${placeholders})`,
      ...similarIds,
    )
    for (const row of tr) {
      if (!toolMentions.has(row.id)) toolMentions.set(row.id, new Set())
      toolMentions.get(row.id)!.add(row.name)
    }
  } catch {
    // skip
  }

  const newFilesSet = new Set(mentionsFiles)
  const newToolsSet = new Set(mentionsTools)
  const sharesContext = (id: string): boolean => {
    const fm = fileMentions.get(id)
    if (fm) {
      for (const f of fm) if (newFilesSet.has(f)) return true
    }
    const tm = toolMentions.get(id)
    if (tm) {
      for (const t of tm) if (newToolsSet.has(t)) return true
    }
    return false
  }

  const contradicts: string[] = []
  for (const id of similarIds) {
    const row = byId.get(id)
    if (!row) continue
    if (row.outcome !== wantedOpposite) continue
    if (!sharesContext(id)) continue
    contradicts.push(id)
  }
  return contradicts
}
