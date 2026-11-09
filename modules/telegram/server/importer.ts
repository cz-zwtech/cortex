/**
 * Import the earlier Python gateway's store (its state/*.sqlite3) into this module's, as one bot.
 *
 * Read-only on the source: it is opened read-only and never changed, so the
 * old service can be started again on it (the cutover's rollback). Idempotent:
 * every row keeps its id, so a second run adds nothing. Ids sessions already
 * hold (it_…, ob_…, inbound numbers) mean the same thing after the move.
 *
 * Dropped on the way: outbound.item_id, expects_reply and answered, which
 * the earlier gateway wrote and never read. Times are normalised to the microsecond ISO
 * form, so rows imported from its own legacy import compare correctly.
 */
import Database from 'better-sqlite3'

import { iso, kvGet, kvSet, tx, type Db } from './db.js'

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const MICRO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const norm = (v: unknown) => (typeof v === 'string' && ISO_LIKE.test(v) && !MICRO.test(v) ? iso(Date.parse(v)) : v)

export type ImportReport = { tables: Record<string, { source: number; imported: number }>; offset: { source: number | null; now: number | null } }

export const importLegacyGateway = (target: Db, sourceFile: string, bot: string, operator: string): ImportReport => {
  const src = new Database(sourceFile, { readonly: true, fileMustExist: true })
  try {
    const rows = (table: string) => src.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
    const report: ImportReport = { tables: {}, offset: { source: null, now: null } }
    const copy = (table: string, cols: string[], extra: Record<string, unknown>, map: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) => {
      const all = rows(table)
      const names = [...cols, ...Object.keys(extra)]
      const stmt = target.prepare(`INSERT OR IGNORE INTO ${table}(${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      let imported = 0
      for (const raw of all) {
        const r = map(raw)
        imported += stmt.run(...cols.map((c) => norm(r[c] ?? null)), ...Object.values(extra)).changes
      }
      report.tables[table] = { source: all.length, imported }
    }
    tx(target, () => {
      copy(
        'items',
        ['id', 'source', 'owner', 'severity', 'title', 'body', 'dedupe_key', 'repeat_count', 'state', 'resolution', 'created_at', 'updated_at', 'fallback_due_at',
          'routed_at', 'route_attempts', 'next_route_at', 'acked_at', 'acked_by', 'escalated_at', 'outbound_id', 'reviewed_at', 'reviewed_by'],
        { bot },
      )
      copy('events', ['id', 'item_id', 'at', 'from_state', 'to_state', 'actor', 'note'], {})
      copy(
        'outbound',
        ['id', 'sender', 'reply_route', 'topic', 'text', 'idempotency_key', 'state', 'attempts', 'next_attempt_at', 'last_error', 'message_id', 'created_at', 'sent_at'],
        { bot, operator },
      )
      copy(
        'inbound',
        ['id', 'update_id', 'legacy_key', 'at', 'chat_id', 'from_id', 'text', 'reply_to', 'route_to', 'topic', 'matched_by', 'claimed_by', 'claimed_at', 'notified', 'notify_attempts'],
        { bot, operator },
      )
      copy('routes', ['tag', 'sender', 'at'], { bot })
      const kv = new Map((rows('kv') as { key: string; value: string }[]).map((r) => [r.key, r.value]))
      const off = kv.has('offset') ? Number(kv.get('offset')) : null
      if (off !== null) kvSet(target, `${bot}:offset`, Math.max(off, Number(kvGet(target, `${bot}:offset`) ?? 0)))
      if (kv.has('dropped_unauthorised') && !kvGet(target, `${bot}:dropped_unauthorised`)) kvSet(target, `${bot}:dropped_unauthorised`, kv.get('dropped_unauthorised')!)
      if (kv.has('last_poll_at') && !kvGet(target, `${bot}:last_poll_at`)) kvSet(target, `${bot}:last_poll_at`, String(norm(kv.get('last_poll_at'))))
      const now = kvGet(target, `${bot}:offset`)
      report.offset = { source: off, now: now === undefined ? null : Number(now) }
    })
    return report
  } finally {
    src.close()
  }
}
