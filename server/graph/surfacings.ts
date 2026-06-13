/**
 * s1 — graph-backed surfacings log. Each recall surfaces some memories into a
 * session; record that as a `SURFACED_IN` edge (src=memory, dst=session) so s3
 * (acted-on detectors) can correlate "surfaced in S → a file it MENTIONS_FILE-links
 * to was edited in S" with pure edge-traversal, and s4 (decay) can spot stale,
 * never-acted-on memories. One edge per (memory,session): `weight` is the surface
 * COUNT and `notedAt` the last-surfaced-at — repeats upsert, they don't pile rows.
 *
 * Graph-native by design (not a usageScores JSON extension); SURFACED_IN reuses the
 * edges table (unconstrained `rel`, so no schema migration) and composes with the
 * §5.3 MENTIONS_FILE edges + OCCURRED_IN. See
 * /personal/docs/cortex/s1-surfacings-log-plan.md.
 */
import { run, transaction } from './db.js'
import { ensureStubEntry } from './sync.js'

/**
 * Upsert a SURFACED_IN edge for each surfaced memory in this session. No-op when
 * `sessionId` is blank (a UI/older-hook recall can't be attributed to a session) or
 * `memoryIds` is empty. Bounded — one stub-ensure + N keyed upserts in a single
 * transaction; never throws on a malformed id (the edge is best-effort instrumentation).
 */
export function recordSurfacings(sessionId: string, memoryIds: string[], now: number): void {
  const sid = (sessionId ?? '').trim()
  const ids = [...new Set((memoryIds ?? []).filter(Boolean))]
  if (!sid || ids.length === 0) return
  transaction(() => {
    // Ensure the session node so the edge never dangles (mirrors OCCURRED_IN).
    ensureStubEntry(null, sid, sid, 'session', `session:${sid}`)
    for (const mem of ids) {
      // firstAt is set ONLY on insert and left untouched by the conflict update —
      // s3's D3 acted-on correlation needs the FIRST-surfaced-at, and notedAt
      // (last-at) bumps on every recall. See the s3 doc (D3-on-lastAt forbidden).
      run(
        `INSERT INTO edges (src, dst, rel, weight, notedAt, firstAt) VALUES (?, ?, 'SURFACED_IN', 1, ?, ?)
           ON CONFLICT(src, dst, rel) DO UPDATE SET weight = weight + 1, notedAt = excluded.notedAt`,
        mem,
        sid,
        now,
        now,
      )
    }
  })
}
