#!/usr/bin/env tsx
/**
 * In-process test for pruneSessionsByMachine(machine).
 *
 * Uses dynamic imports so CKN_GRAPH_DB_PATH is set BEFORE db.ts evaluates its
 * module-level DB_PATH constant (static imports are hoisted, bypassing the env
 * assignment — dynamic imports respect the assignment order). Also sets
 * CKN_FORBID_DEFAULT_DB=1 so any accidental open of the real DB throws loudly.
 *
 * Seeds:
 *   - 3 rows for machine 'm1' in mixed states (signed_off, live, old/stale)
 *     each with an entries stub-node + incident edge
 *   - 2 rows for machine 'keepme'
 * Asserts:
 *   - pruneSessionsByMachine('m1') returns { machine: 'm1', deleted: 3 } and all
 *     m1 rows (session_meta + entries + edges) are gone
 *   - 'keepme' rows are UNTOUCHED
 *   - pruneSessionsByMachine('') and ('   ') are no-ops returning deleted: 0
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-prune-by-machine-'))
const DB_PATH = path.join(tmpDir, 'graph.sqlite')

// Set BEFORE any db-touching dynamic import so db.ts captures the temp path.
process.env.CKN_GRAPH_DB_PATH = DB_PATH
process.env.CKN_FORBID_DEFAULT_DB = '1'

// Dynamic imports — evaluated AFTER the env assignments above.
const { openDb } = await import('../../server/graph/db.js')
const { pruneSessionsByMachine } = await import('../../server/bus/pruneStaleSessions.js')

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

// Seed directly into the temp DB via a separate handle (not the singleton).
const seed = openDb(DB_PATH)
try {
  const insertMeta = seed.prepare(
    `INSERT INTO session_meta (id, machine, status, last_seen) VALUES (?, ?, ?, ?)`,
  )
  const insertEntry = seed.prepare(
    `INSERT INTO entries (id, name, kind, scope) VALUES (?, ?, 'session', ?)`,
  )
  const insertEdge = seed.prepare(
    `INSERT INTO edges (src, dst, rel) VALUES ('some-node', ?, 'OCCURRED_IN')`,
  )

  // 3 rows for m1: signed_off, live, stale-old
  for (const [id, status, age] of [
    ['m1-signed-off', 'signed_off', 2 * DAY],
    ['m1-live', 'live', 1000],
    ['m1-stale', 'live', 40 * DAY],
  ] as [string, string, number][]) {
    insertMeta.run(id, 'm1', status, NOW - age)
    insertEntry.run(id, id, `session:${id}`)
    insertEdge.run(id)
  }

  // 2 rows for keepme (no graph residue needed)
  insertMeta.run('keep-1', 'keepme', 'live', NOW - 1000)
  insertMeta.run('keep-2', 'keepme', 'signed_off', NOW - DAY)
} finally {
  seed.close()
}

// ── blank / whitespace → no-op ─────────────────────────────────────────────
const emptyResult = pruneSessionsByMachine('')
assert.deepEqual(emptyResult, { machine: '', deleted: 0 }, 'empty string → no-op, 0 deleted')

const wsResult = pruneSessionsByMachine('   ')
assert.deepEqual(wsResult, { machine: '   ', deleted: 0 }, 'whitespace-only → no-op, 0 deleted')

// ── verify seed state via a readonly handle ────────────────────────────────
const verify = new Database(DB_PATH, { readonly: true })
assert.equal(
  (verify.prepare(`SELECT COUNT(*) AS c FROM session_meta WHERE machine = 'keepme'`).get() as { c: number }).c,
  2,
  'keepme rows present before purge',
)
assert.equal(
  (verify.prepare(`SELECT COUNT(*) AS c FROM session_meta WHERE machine = 'm1'`).get() as { c: number }).c,
  3,
  'm1 rows present before purge',
)
verify.close()

// ── purge m1 ──────────────────────────────────────────────────────────────
const result = pruneSessionsByMachine('m1')
assert.deepEqual(result, { machine: 'm1', deleted: 3 }, 'returns correct machine + deleted count')

// Verify via a fresh readonly handle AFTER the purge.
const check = new Database(DB_PATH, { readonly: true })
try {
  // session_meta rows gone
  assert.equal(
    (check.prepare(`SELECT COUNT(*) AS c FROM session_meta WHERE machine = 'm1'`).get() as { c: number }).c,
    0,
    'all m1 session_meta rows removed',
  )
  // entries stub-nodes gone
  for (const id of ['m1-signed-off', 'm1-live', 'm1-stale']) {
    assert.equal(
      (check.prepare(`SELECT COUNT(*) AS c FROM entries WHERE id = ?`).get(id) as { c: number }).c,
      0,
      `entries stub for ${id} removed`,
    )
    assert.equal(
      (check.prepare(`SELECT COUNT(*) AS c FROM edges WHERE dst = ?`).get(id) as { c: number }).c,
      0,
      `edges for ${id} removed`,
    )
  }
  // keepme rows UNTOUCHED
  assert.equal(
    (check.prepare(`SELECT COUNT(*) AS c FROM session_meta WHERE machine = 'keepme'`).get() as { c: number }).c,
    2,
    'keepme rows UNTOUCHED',
  )
} finally {
  check.close()
}

// ── idempotent second call ─────────────────────────────────────────────────
const second = pruneSessionsByMachine('m1')
assert.deepEqual(second, { machine: 'm1', deleted: 0 }, 'second call is idempotent — 0 deleted')

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('prune-by-machine.test.ts: all assertions passed')
process.exit(0)
