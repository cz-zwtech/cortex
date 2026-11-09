/**
 * Boot-time redaction reconciliation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESTORE IS THE WRONG ACTOR
 *
 * The obvious design is "restore replays the manifest". That puts the guarantee
 * in the hands of a human copying files, and a manual restore that skips the
 * procedure silently un-redacts — the exact failure the permanent manifest
 * exists to prevent, reintroduced as a documentation step.
 *
 * So the enforcement moves to BOOT. A monotonic redaction EPOCH is stored in two
 * places — the manifest, and the graph. Every boot compares them and replays the
 * difference. Restore-without-procedure then converges anyway, and there is no
 * step for a human to forget.
 *
 * Both halves are repaired, because a restore can roll back either one:
 *
 *   SEGMENTS restored from a pre-redaction backup → the content is back in the
 *   journal. The manifest is a separate file and survives, so replaying it
 *   removes the content again.
 *
 *   GRAPH restored from a pre-redaction backup → the node is back, and its
 *   applied epoch is old. The difference is replayed against the graph.
 *
 * The test that justifies all of this is written as RESTORE, BOOT, ASSERT —
 * deliberately with no procedural step, because a test that replayed the
 * manifest by hand would prove the wrong thing.
 */

import type { Journal } from './journal.js'
import type { MemoryStore } from './store.js'

export type ReconcileReport = {
  /** Epoch the graph had applied before this ran. */
  from: number
  /** Epoch the manifest is at. */
  to: number
  /** Content records removed from the journal segments. */
  journalRemoved: number
  /** Memories removed from the graph. */
  graphRemoved: number
}

/**
 * Bring the graph and the journal up to the manifest's epoch.
 *
 * Safe to run on every boot: replaying an already-applied redaction removes
 * nothing and costs a scan. Cheap enough that making it conditional would trade
 * a real guarantee for a negligible saving.
 */
export const reconcileRedactions = (journal: Journal, store: MemoryStore): ReconcileReport => {
  const from = store.appliedRedactionEpoch()
  const to = journal.epoch()

  // Deliberately NOT `if (to <= from) return`. An equal epoch still means the
  // segments may have been rolled back — the graph's counter says nothing about
  // the journal's contents, and the whole point is that we do not trust a
  // restore to have been done correctly.
  const journalRemoved = journal.replayRedactions()

  let graphRemoved = 0
  for (const r of journal.redactions()) {
    if (r.targetMemoryId && store.delete(r.targetMemoryId)) graphRemoved++
    graphRemoved += store.deleteByContentHash(r.targetHash)
  }

  store.setAppliedRedactionEpoch(to)
  return { from, to, journalRemoved, graphRemoved }
}
