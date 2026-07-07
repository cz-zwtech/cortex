#!/usr/bin/env tsx
/**
 * Integration test for the FR resume-presence S1 ANCHOR model against a real temp
 * DB. Proves the full lifecycle the Corey-locked design guarantees:
 *   (a) a signed_off row UNDER the 90d cap SURVIVES a boot prune (durable anchor);
 *   (b) a row PAST 90d (any status) is DELETED with its entries stub + edges;
 *   (c) a `--resume` of a RETAINED signed_off anchor re-registers into the UPDATE
 *       (rebind) branch — status flips live, and friendly_name + started_at +
 *       counters + name_history are PRESERVED (no hollow INSERT).
 *
 * Dynamic imports so CKN_GRAPH_DB_PATH is captured before db.ts evaluates.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-stale-prune-anchor-'))
const DB_PATH = path.join(tmpDir, 'graph.sqlite')

process.env.CKN_GRAPH_DB_PATH = DB_PATH
process.env.CKN_FORBID_DEFAULT_DB = '1'

const { openDb, get } = await import('../../server/graph/db.js')
const { pruneStaleSessions } = await import('../../server/bus/pruneStaleSessions.js')
const { registerSession } = await import('../../server/graph/bus.js')

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

const ANCHOR = 'anchor-signed-off-10d'
const OVERCAP = 'overcap-91d'
const ANCHOR_STARTED_AT = NOW - 10 * DAY

const seed = openDb(DB_PATH)
try {
  const insertMeta = seed.prepare(
    `INSERT INTO session_meta (id, machine, status, last_seen, friendly_name, title, started_at, turns_count, name_history)
     VALUES (?, 'm1', ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertEntry = seed.prepare(
    `INSERT INTO entries (id, name, kind, scope) VALUES (?, ?, 'session', ?)`,
  )
  const insertEdge = seed.prepare(
    `INSERT INTO edges (src, dst, rel) VALUES ('some-node', ?, 'OCCURRED_IN')`,
  )
  // (a) durable anchor: signed_off, 10d idle, real identity.
  insertMeta.run(ANCHOR, 'signed_off', NOW - 10 * DAY, 'anchored', 'anchored topic', ANCHOR_STARTED_AT, 7, 'earlier-name')
  // (b) over-cap: 91d idle, with graph residue to prove cleanup.
  insertMeta.run(OVERCAP, 'signed_off', NOW - 91 * DAY, 'ancient', '', NOW - 91 * DAY, 3, '')
  insertEntry.run(OVERCAP, OVERCAP, `session:${OVERCAP}`)
  insertEdge.run(OVERCAP)
} finally {
  seed.close()
}

const pruned = pruneStaleSessions(NOW)

const metaRow = (id: string) =>
  get<{ status: string; friendly_name: string; started_at: number; turns_count: number; name_history: string }>(
    `SELECT status, friendly_name, started_at, turns_count, name_history FROM session_meta WHERE id = ?`,
    id,
  )

// (a) the anchor SURVIVED, fully intact.
const anchor = metaRow(ANCHOR)
assert.ok(anchor, '(a) a signed_off row under 90d SURVIVES the boot prune')
assert.equal(anchor?.friendly_name, 'anchored', '(a) anchor keeps its friendly_name')
assert.equal(anchor?.turns_count, 7, '(a) anchor keeps its counters')

// (b) the over-cap row + its graph residue were DELETED.
assert.ok(!metaRow(OVERCAP), '(b) a >90d row is DELETED')
assert.ok(!get(`SELECT id FROM entries WHERE id = ?`, OVERCAP), '(b) its entries stub is DELETED')
assert.ok(!get(`SELECT dst FROM edges WHERE dst = ?`, OVERCAP), '(b) its incident edge is DELETED')
assert.equal(pruned, 1, '(b) exactly the >90d row was pruned')

// (c) RESUME the retained anchor: nameless re-register (as ckn-context does) →
// UPDATE (rebind) branch, identity preserved, status back to live.
await registerSession({ sessionId: ANCHOR, title: '', cwd: '/some/project', machine: 'm1' })
const resumed = metaRow(ANCHOR)
assert.equal(resumed?.status, 'live', '(c) resume flips the anchor status to live')
assert.equal(resumed?.friendly_name, 'anchored', '(c) resume PRESERVES friendly_name (name-floor, not hollow)')
assert.equal(resumed?.started_at, ANCHOR_STARTED_AT, '(c) resume PRESERVES started_at (UPDATE branch, not reset)')
assert.equal(resumed?.turns_count, 7, '(c) resume PRESERVES counters (not zeroed)')
assert.ok((resumed?.name_history ?? '').includes('earlier-name'), '(c) resume PRESERVES name_history')

console.log('stale-prune-anchor OK')
process.exit(0)
