/**
 * Bus message housekeeping (stage 3, part A) — keep the inbox a WORKING surface,
 * not an append-only log. The dominant noise is `kind='ack'` confirmations
 * ("received, acting." — 235 in 7 days on the dev fleet): they're not actionable
 * and they bury real messages on the decision surface (watcher firehose + inbox).
 *
 * Two mechanisms:
 *   - DE-NOISE: ack/done kinds are suppressed from the working watcher line + the
 *     default `ckn-bus inbox` (still visible via `--all`).
 *   - EXPIRE (Corey's call: delete, not archive): a periodic prune deletes old
 *     ack/done messages so `bus_messages` stays bounded. Content kinds
 *     (msg/reply/etc.) are NEVER expired here — only ephemeral confirmations.
 *
 * Pure decisions are unit-tested; the I/O wrapper (pruneBusMessages) does the
 * DELETE, mirroring staleSessionPrune.
 */
import { all, run, transaction } from '../graph/db.js'

/** Confirmation kinds — pure coordination acks, safe to suppress + expire. */
export function isAckKind(kind: string | undefined): boolean {
  return kind === 'ack' || kind === 'done'
}

export interface BusRetentionPolicy {
  /** Delete ack/done messages older than this (default 24h). */
  ackTtlMs: number
}
export const DEFAULT_BUS_RETENTION: BusRetentionPolicy = { ackTtlMs: 24 * 60 * 60 * 1000 }

export interface ExpirableMessage {
  id: string
  kind: string
  createdAt: number
}

/**
 * Pure: which message ids should be EXPIRED (deleted). Only ack/done kinds, only
 * once older than ackTtlMs. Content kinds are never returned — losing a confirmation
 * is harmless; losing a msg/reply is not. (`now` injectable for tests.)
 */
export function expirableBusMessages(
  msgs: ExpirableMessage[],
  now: number,
  policy: BusRetentionPolicy = DEFAULT_BUS_RETENTION,
): string[] {
  const cutoff = now - policy.ackTtlMs
  return msgs.filter((m) => isAckKind(m.kind) && m.createdAt < cutoff).map((m) => m.id)
}

/**
 * Delete expired ack/done messages. Returns the count deleted. Best-effort; safe
 * to run at boot + on an interval. `now` injectable for tests.
 */
export function pruneBusMessages(
  now: number = Date.now(),
  policy: BusRetentionPolicy = DEFAULT_BUS_RETENTION,
): number {
  const cutoff = now - policy.ackTtlMs
  // Select then delete by id so the decision matches the pure function exactly
  // (and stays readable). ack/done only — content kinds are never touched.
  const rows = all<{ id: string }>(
    `SELECT id FROM bus_messages WHERE kind IN ('ack','done') AND created_at < ?`,
    cutoff,
  )
  if (!rows.length) return 0
  transaction(() => {
    for (const r of rows) run(`DELETE FROM bus_messages WHERE id = ?`, r.id)
  })
  return rows.length
}
