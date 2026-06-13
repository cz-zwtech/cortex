#!/usr/bin/env tsx
/**
 * Backfill for legacy metaId collisions (split a shared metaId per-session).
 *
 * The claimMetaId fix prevents NEW collisions; this repairs EXISTING ones (e.g.
 * meta_2lAMd55srF3s shared by 4 round-table sessions). splitMetaId mints a fresh
 * metaId for each sharer (mint-for-all), or keeps it on one nominated session
 * (keep-one). Routes through the server's single writer (an UPDATE, never a
 * DELETE). Temp-DB pattern mirrors test/graph/bus.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-metasplit-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_EMBEDDINGS = 'off'

const { getDb, run, all } = await import('../../server/graph/db.js')
const { registerSession, splitMetaId } = await import('../../server/graph/bus.js')
getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const metaOf = (ids: string[]) =>
  all<{ id: string; meta_id: string }>(
    `SELECT id, meta_id FROM session_meta WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  )

// Seed 4 sessions, then force them to share one tainted metaId (the legacy
// collision shape). A 5th session on a different metaId must stay untouched.
for (const id of ['sp1', 'sp2', 'sp3', 'sp4', 'other']) {
  await registerSession({ sessionId: id, cwd: `/repo/${id}`, machine: 'm' })
}
run(`UPDATE session_meta SET meta_id = 'meta_COLLIDE' WHERE id IN ('sp1','sp2','sp3','sp4')`)
run(`UPDATE session_meta SET meta_id = 'meta_OTHER' WHERE id = 'other'`)

// ── mint-for-all: every sharer gets a distinct fresh metaId ─────────────────
{
  const r = splitMetaId('meta_COLLIDE')
  assert.equal(r.reassigned.length, 4, 'all 4 sharers reassigned')
  const after = metaOf(['sp1', 'sp2', 'sp3', 'sp4'])
  const metas = after.map((x) => x.meta_id)
  assert.ok(metas.every((m) => m !== 'meta_COLLIDE'), 'no sharer keeps the tainted metaId')
  assert.equal(new Set(metas).size, 4, 'each sharer got a DISTINCT metaId')
  assert.ok(metas.every((m) => m.startsWith('meta_')), 'fresh ids are well-formed')
  assert.equal(metaOf(['other'])[0]!.meta_id, 'meta_OTHER', 'a different metaId is untouched')
  ok('mint-for-all splits the collision into 4 distinct identities')
}

// ── keep-one: the nominated session keeps the metaId, others get fresh ──────
{
  run(`UPDATE session_meta SET meta_id = 'meta_C2' WHERE id IN ('sp1','sp2','sp3','sp4')`)
  const r = splitMetaId('meta_C2', 'sp2')
  assert.equal(r.reassigned.length, 3, 'three reassigned, the kept one excluded')
  assert.equal(metaOf(['sp2'])[0]!.meta_id, 'meta_C2', 'nominated session keeps the metaId')
  const others = metaOf(['sp1', 'sp3', 'sp4']).map((x) => x.meta_id)
  assert.ok(others.every((m) => m !== 'meta_C2'), 'the rest no longer share it')
  assert.equal(new Set(others).size, 3, 'the rest each got a distinct fresh metaId')
  ok('keep-one retains the metaId on the nominated session, splits the rest')
}

// ── blank / unknown metaId is a safe no-op ──────────────────────────────────
{
  assert.equal(splitMetaId('').reassigned.length, 0, 'blank metaId → no-op')
  assert.equal(splitMetaId('meta_NOPE').reassigned.length, 0, 'unknown metaId → no-op')
  ok('blank/unknown metaId is a safe no-op')
}

console.log(`\nOK metaid-split.test.ts — ${passed} assertions passed`)
