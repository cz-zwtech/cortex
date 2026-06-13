import { all, get, run, transaction } from '../graph/db.js'

/**
 * Stale-session-row prune for the bus presence table.
 *
 * The watcher reaper (reapOrphanedWatchers.ts) kills orphaned `ckn-bus watch`
 * PROCESSES, but leaves the dead session's presence ROW in `session_meta`. Those
 * rows accumulate (hook-test leftovers + long-dead sessions) and pollute
 * `GET /api/bus/peers` so the peer list stops being meaningful. This prunes the
 * genuinely-dead rows.
 *
 * REVERSIBLE by design: presence is an upsert (`touchSession`, POST
 * /api/bus/touch) fired on every UserPromptSubmit. If a pruned session ever
 * `--resume`s, its next prompt re-touches it back into existence — so we only
 * ever remove rows that are dead RIGHT NOW. The sole loss is the durable
 * friendly-name / meta_id lineage for a session dead >24h/>30d, which is
 * acceptable. live/idle/recent rows are NEVER pruned (their age is below both
 * thresholds).
 */

/** signed_off + grace passed: an explicitly-ended session, 24h after sign-off. */
export const PRUNE_SIGNED_OFF_MS = 24 * 60 * 60 * 1000
/** Hard cap: any-status session untouched for 30d is abandoned/crashed. */
export const PRUNE_HARD_MS = 30 * 24 * 60 * 60 * 1000

/** The presence-row fields the prune decision needs. `rawStatus` is the STORED
 * status (`live`/`signed_off`/…), NOT the age-derived live/idle/stale. */
export interface PruneSession {
  sessionId: string
  rawStatus: string
  lastSeen: number
}

/**
 * Decide which session ids to prune. A row is pruned iff EITHER:
 *   - it is raw `signed_off` AND `now - lastSeen > PRUNE_SIGNED_OFF_MS` (24h), OR
 *   - `now - lastSeen > PRUNE_HARD_MS` (30d), regardless of status.
 * Otherwise it is KEPT. live/idle/recent rows are always kept — their age is
 * below both thresholds. Pure + unit-tested; the I/O wrapper feeds it a
 * `session_meta` snapshot.
 */
export function staleSessionPrune(sessions: PruneSession[], now: number): string[] {
  const doomed: string[] = []
  for (const s of sessions) {
    const age = now - s.lastSeen
    const signedOffExpired = s.rawStatus === 'signed_off' && age > PRUNE_SIGNED_OFF_MS
    const hardExpired = age > PRUNE_HARD_MS
    if (signedOffExpired || hardExpired) doomed.push(s.sessionId)
  }
  return doomed
}

/**
 * Best-effort prune of stale presence rows. Reads the `session_meta` snapshot,
 * applies `staleSessionPrune`, and DELETEs the doomed rows in one transaction.
 *
 * A session appears in `GET /api/bus/peers` purely via its `session_meta` row
 * (listPeers: `SELECT * FROM session_meta WHERE last_seen > 0`), so deleting that
 * row removes it from the peer list. A session id can ALSO carry an `entries` row
 * (id == sessionId, kind='session', created by `ensureStubEntry` when a pattern's
 * `occurredIn` references it) plus incident `OCCURRED_IN` edges — so to leave no
 * orphan node/edge we mirror the full-node delete (forgetRepoSymbols / sync.ts):
 * edges incident to the id, then the `entries` row, then the `session_meta` row.
 *
 * Fully try/catch-guarded so it can NEVER throw into server startup. Returns the
 * count pruned, and logs it when non-zero.
 */
/**
 * Delete ALL `session_meta` rows for `machine` (plus associated graph edges +
 * `entries` stub-nodes) in one transaction. Intended for one-time cleanup of
 * test-pollution sessions on a known bogus machine name — all rows go regardless
 * of state or age.
 *
 * Safety: blank/whitespace `machine` is a no-op (never match-all).
 * Fully try/catch-guarded; never throws. Returns the deleted count.
 */
export function pruneSessionsByMachine(machine: string): { machine: string; deleted: number } {
  if (!machine.trim()) return { machine, deleted: 0 }
  let deleted = 0
  try {
    const rows = all<{ id: string }>(
      `SELECT id FROM session_meta WHERE machine = ?`,
      machine,
    )
    if (!rows.length) return { machine, deleted: 0 }
    transaction(() => {
      for (const { id } of rows) {
        run(`DELETE FROM edges WHERE src = ? OR dst = ?`, id, id)
        run(`DELETE FROM entries WHERE id = ? AND kind = 'session'`, id)
        run(`DELETE FROM session_meta WHERE id = ? AND machine = ?`, id, machine)
        deleted++
      }
    })
    if (deleted) console.log(`[bus] purged ${deleted} session row(s) for machine '${machine}'`)
  } catch {
    /* never throw */
  }
  return { machine, deleted }
}

export function pruneStaleSessions(now = Date.now()): number {
  let pruned = 0
  try {
    const sessions = all<{ sessionId: string; rawStatus: string; lastSeen: number }>(
      `SELECT id AS sessionId, status AS rawStatus, last_seen AS lastSeen FROM session_meta`,
    )
    const doomed = staleSessionPrune(sessions, now)
    if (!doomed.length) return 0
    transaction(() => {
      for (const id of doomed) {
        // Belt-and-braces: re-check the row is still dead at delete time so a
        // session that healed (touched itself live) between the snapshot read and
        // here is never removed. Pruning is reversible, but this avoids the race.
        const cur = get<{ rawStatus: string; lastSeen: number }>(
          `SELECT status AS rawStatus, last_seen AS lastSeen FROM session_meta WHERE id = ?`,
          id,
        )
        if (!cur) continue
        if (!staleSessionPrune([{ sessionId: id, ...cur }], now).length) continue
        // Remove any session-node graph residue (mirrors the full-node delete):
        // edges incident to the id, then the stub entry, then the presence row.
        run(`DELETE FROM edges WHERE src = ? OR dst = ?`, id, id)
        run(`DELETE FROM entries WHERE id = ? AND kind = 'session'`, id)
        run(`DELETE FROM session_meta WHERE id = ?`, id)
        pruned++
      }
    })
    if (pruned) console.log(`[bus] pruned ${pruned} stale session presence row(s)`)
  } catch {
    /* never block startup */
  }
  return pruned
}
