#!/usr/bin/env tsx
/**
 * Phase 0 gate for the Kuzu → SQLite migration: an empty SQLite DB opens at an
 * arbitrary path, the §1 schema applies, and a round-trip of one `entries` row
 * (with a boolean `pinned`) + one `edges` row reads back faithfully — including
 * the boolean coercion contract (stored as INTEGER 0/1, returned as a number).
 *
 * Plain tsx script + node:assert/strict, mirroring test/codegraph/graph-shutdown.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { openDb, initSchema } from '../../server/graph/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sqlite-'))
const dbPath = path.join(dir, 'graph.sqlite')

// 1. Open a fresh DB at a temp path. openDb() applies the schema + pragmas.
const db = openDb(dbPath)

// initSchema is idempotent — re-running must not throw (mirrors every-boot reapply).
initSchema(db)

// Pragmas landed as configured.
assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal', 'WAL mode set')
assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 0, 'foreign_keys OFF')

// Schema present: the core tables exist.
const tables = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name),
)
for (const t of [
  'entries',
  'pattern_meta',
  'session_meta',
  'observation_meta',
  'edges',
  'symbols',
  'graph_heads',
  'bus_messages',
]) {
  assert.ok(tables.has(t), `table ${t} created`)
}

// 2. Insert one entries row with a boolean pinned (stored as INTEGER 1).
const now = Date.now()
db.prepare(
  `INSERT INTO entries (id, name, kind, content, scope, updatedAt, syncedAt, machine, pinned)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run('mem:alpha', 'Alpha', 'memory', 'hello world', 'user', now, now, 'host1', 1)

// 3. Insert one edges row (idempotent composite PK).
db.prepare(`INSERT INTO edges (src, dst, rel, label) VALUES (?, ?, ?, ?)`).run(
  'mem:alpha',
  'mem:beta',
  'LINKS_TO',
  'related',
)

// 4. Read back + assert the full round-trip.
const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get('mem:alpha') as any
assert.equal(entry.id, 'mem:alpha', 'entry id round-trips')
assert.equal(entry.name, 'Alpha', 'entry name round-trips')
assert.equal(entry.kind, 'memory', 'entry kind round-trips')
assert.equal(entry.content, 'hello world', 'entry content round-trips')
assert.equal(entry.updatedAt, now, 'INT64 timestamp round-trips verbatim')

// Boolean coercion contract: stored 1 → returned as a number (callers map 1↔true).
assert.equal(typeof entry.pinned, 'number', 'pinned returns as number (not boolean)')
assert.equal(entry.pinned, 1, 'pinned stored as INTEGER 1')
assert.equal(Boolean(entry.pinned), true, 'pinned coerces to true')

const edge = db.prepare('SELECT * FROM edges WHERE src = ? AND dst = ? AND rel = ?').get(
  'mem:alpha',
  'mem:beta',
  'LINKS_TO',
) as any
assert.equal(edge.rel, 'LINKS_TO', 'edge rel round-trips')
assert.equal(edge.label, 'related', 'edge label round-trips')
assert.equal(edge.weight, 1.0, 'edge weight defaulted to 1.0')

// Composite-PK idempotency: INSERT OR IGNORE on the same (src,dst,rel) is a no-op.
const res = db
  .prepare(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`)
  .run('mem:alpha', 'mem:beta', 'LINKS_TO')
assert.equal(res.changes, 0, 'duplicate edge ignored via composite PK')
assert.equal(
  Number((db.prepare('SELECT count(*) AS c FROM edges').get() as any).c),
  1,
  'still one edge after duplicate insert',
)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('sqlite-db OK')
process.exit(0)
