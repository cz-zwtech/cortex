import { all, get, run, transaction } from '../graph/db.js'

/**
 * Stale-session-row prune for the bus presence table.
 *
 * The watcher reaper (reapOrphanedWatchers.ts) kills orphaned `ckn-bus watch`
 * PROCESSES, but leaves the dead session's presence ROW in `session_meta`. Those
 * rows accumulate (hook-test leftovers + long-dead sessions). This prunes the
 * genuinely-abandoned rows past a hard age cap.
 *
 * ANCHOR MODEL (Corey-locked 2026-07-07): a signed_off / stale row is RETAINED as
 * a durable IDENTITY ANCHOR, not deleted. `--resume` re-registers under the SAME
 * session id, so keeping the row means the morning re-register hits
 * `registerSession`'s UPDATE (rebind) branch — preserving friendly_name,
 * started_at, counters, and name_history — instead of the fresh-INSERT branch that
 * yields a HOLLOW presence (bare-id name, zeroed counters, reset started_at). The
 * read side (peers view) filters signed_off out by default so anchors don't clutter
 * the roster; `status` + the hard cap bound growth. There is NO transcript scan and
 * NO status dependency, so this is correct for every host incl. multi-user.
 *
 * WHY NO 24h signed_off delete (removed 2026-07-07): the old rule deleted a
 * signed_off row 24h after sign-off, trading away durable identity/lineage on the
 * assumption a >24h-idle session was disposable. The first-class resume lifecycle
 * (sessions stopped nightly / over a weekend and resumed) invalidates that: a
 * weekend gap exceeded 24h, so the boot prune deleted the anchor and the morning
 * resume hollow-INSERTed. We keep the anchor and let a generous 90d cap reclaim
 * only genuinely-abandoned rows.
 */

/** Hard cap: any-status session untouched for 90d is abandoned — the SOLE delete
 * rule. A signed_off/stale row under the cap is a retained identity anchor. */
export const PRUNE_HARD_MS = 90 * 24 * 60 * 60 * 1000

/** The presence-row fields the prune decision needs. `rawStatus` is the STORED
 * status (`live`/`signed_off`/…), NOT the age-derived live/idle/stale. */
export interface PruneSession {
  sessionId: string
  rawStatus: string
  lastSeen: number
}

/**
 * Decide which session ids to prune. A row is pruned iff `now - lastSeen >
 * PRUNE_HARD_MS` (90d), REGARDLESS of status — the sole delete rule. A signed_off /
 * stale row under the cap is KEPT as a durable identity anchor. Pure + unit-tested;
 * the I/O wrapper feeds it a `session_meta` snapshot. (`rawStatus` is retained on
 * the interface for callers/telemetry; the decision no longer branches on it.)
 */
export function staleSessionPrune(sessions: PruneSession[], now: number): string[] {
  const doomed: string[] = []
  for (const s of sessions) {
    if (now - s.lastSeen > PRUNE_HARD_MS) doomed.push(s.sessionId)
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
        // Belt-and-braces: re-check the row is still past the cap at delete time so
        // a session that healed (touched itself live) between the snapshot read and
        // here is never removed. The delete is IRREVERSIBLE, so this race guard is
        // load-bearing — a resumed anchor must never be deleted mid-prune.
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
