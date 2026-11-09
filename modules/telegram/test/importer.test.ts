import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

import { kvGet, openDb } from '../server/db.js'
import { importLegacyGateway } from '../server/importer.js'
import { make, OPERATOR, tmp, update } from './harness.js'

/** The earlier gateway's store in its real schema, with one of everything. */
const source = () => {
  const file = path.join(tmp(), 'legacy.sqlite3')
  const db = new Database(file)
  db.exec(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'legacy-gateway-schema.sql'), 'utf-8'))
  const t = '2026-10-01T09:00:00.123456Z'
  db.prepare(`INSERT INTO items(id, source, owner, severity, title, body, state, created_at, updated_at, fallback_due_at, next_route_at)
              VALUES ('it_aaa', 'gpu', 'globex-dev', 'info', 'old info', 'b', 'routed', ?, ?, 'never', ?)`).run(t, t, t)
  db.prepare(`INSERT INTO items(id, source, owner, severity, title, body, state, created_at, updated_at, fallback_due_at, outbound_id, escalated_at)
              VALUES ('it_bbb', 'gpu', 'globex-dev', 'page', 'old page', 'b', 'sent', ?, ?, ?, 'ob_bbb', ?)`).run(t, t, t, t)
  db.prepare(`INSERT INTO events(item_id, at, from_state, to_state, actor) VALUES ('it_bbb', ?, NULL, 'queued', 'gpu')`).run(t)
  db.prepare(`INSERT INTO outbound(id, item_id, sender, reply_route, topic, text, expects_reply, idempotency_key, state, created_at, message_id, sent_at)
              VALUES ('ob_bbb', NULL, 'old-gateway', 'globex-dev', 'it_bbb', 'old-gateway -- unacknowledged', 1, NULL, 'sent', ?, 501, ?)`).run(t, t)
  db.prepare(`INSERT INTO outbound(id, sender, reply_route, topic, text, expects_reply, idempotency_key, state, created_at, message_id, sent_at)
              VALUES ('ob_ccc', 'ops-dev (triage)', 'ops-dev', 'ACME-6', 'ops-dev (triage) -- which branch?', 1, 'k1', 'sent', ?, 502, ?)`).run(t, t)
  db.prepare(`INSERT INTO inbound(id, update_id, at, chat_id, from_id, text, reply_to, route_to, topic, matched_by, notified)
              VALUES (7, 900, '2026-10-01T09:05:00Z', ?, ?, 'main', 502, 'ops-dev', 'ACME-6', 'reply to a known message', 1)`).run(OPERATOR, OPERATOR)
  db.prepare(`INSERT INTO inbound(id, legacy_key, at, from_id, text, claimed_by) VALUES (8, 'lk1', ?, ?, 'legacy', 'acme-dev')`).run(t, OPERATOR)
  db.prepare(`INSERT INTO routes(tag, sender, at) VALUES ('ACME-6', 'ops-dev', ?)`).run(t)
  db.prepare(`INSERT INTO kv(key, value) VALUES ('offset', '901'), ('dropped_unauthorised', '3'), ('last_poll_at', ?)`).run(t)
  db.close()
  return file
}

test('import copies every row as one bot, keeps ids, drops the dead columns, and normalises times', () => {
  const src = source()
  const dir = tmp()
  const db = openDb(path.join(dir, 'telegram.sqlite'))
  const r = importLegacyGateway(db, src, 'dev', 'alex')
  assert.deepEqual(r.tables, {
    items: { source: 2, imported: 2 }, events: { source: 1, imported: 1 }, outbound: { source: 2, imported: 2 },
    inbound: { source: 2, imported: 2 }, routes: { source: 1, imported: 1 },
  })
  assert.deepEqual(r.offset, { source: 901, now: 901 })
  assert.equal(kvGet(db, 'dev:dropped_unauthorised'), '3')
  const inb = db.prepare('SELECT * FROM inbound WHERE id = 7').get() as Record<string, unknown>
  assert.equal(inb.bot, 'dev')
  assert.equal(inb.operator, 'alex')
  assert.equal(inb.at, '2026-10-01T09:05:00.000000Z', 'second-precision legacy times become the microsecond form')
  const ob = db.prepare("SELECT * FROM outbound WHERE id = 'ob_ccc'").get() as Record<string, unknown>
  assert.deepEqual([ob.bot, ob.operator, ob.message_id, ob.idempotency_key], ['dev', 'alex', 502, 'k1'])
  assert.ok(!('expects_reply' in ob) && !('answered' in ob) && !('item_id' in ob))
  db.close()
})

test('a second import adds nothing, and the source is untouched (rollback stays possible)', () => {
  const src = source()
  const before = fs.readFileSync(src)
  const db = openDb(path.join(tmp(), 'telegram.sqlite'))
  importLegacyGateway(db, src, 'dev', 'alex')
  const again = importLegacyGateway(db, src, 'dev', 'alex')
  for (const t of Object.values(again.tables)) assert.equal(t.imported, 0)
  assert.ok(before.equals(fs.readFileSync(src)), 'the source file is byte-for-byte the same')
  db.close()
})

test('after the import, the gateway carries on: a reply to an imported thread routes, new inbound ids follow on', async () => {
  const src = source()
  const dir = tmp()
  const db = openDb(path.join(dir, 'telegram.sqlite'))
  importLegacyGateway(db, src, 'dev', 'alex')
  db.close()
  const { gw } = make({ dir })
  const id = await gw.handleUpdate('dev', update('feature/x', { replyTo: 502, id: 950 }))
  assert.equal(id, 9)
  const row = gw.replies({ id })[0]!
  assert.deepEqual([row.route_to, row.topic], ['ops-dev', 'ACME-6'])
  assert.equal(kvGet(gw.db, 'dev:offset'), '951')
  assert.equal(gw.replies({ owner: 'acme-dev' })[0]!.text, 'legacy', 'imported claims still find their owner')
})
