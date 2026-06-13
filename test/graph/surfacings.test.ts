#!/usr/bin/env tsx
/**
 * s1 — graph-backed surfacings log. recordSurfacings upserts a SURFACED_IN edge
 * (src=memory, dst=session) per recalled memory: weight = surface COUNT, notedAt =
 * lastSurfacedAt. One edge per (memory,session) — repeats increment, don't dup. The
 * session gets a kind='session' stub so the edge never dangles. s3/s4 read these.
 *
 * Temp-DB pattern mirrors test/graph/linkage-backfill.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-surfacings-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')

getDb()

const COLS =
  `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, authorship, outcome, outcome_text, agent_id, session_id, pinned, engagement, machine, content_hash)`
const insertEntry = (id: string, kind: string) =>
  run(
    `INSERT INTO entries ${COLS} VALUES (?, ?, ?, '', '', '', 'user', 0, 0, 'human', '', '', '', '', 0, 0, '', '')`,
    id, id, kind,
  )
const surfEdge = (mem: string, sess: string) =>
  get<{ weight: number; notedAt: number; firstAt: number }>(
    `SELECT weight, notedAt, firstAt FROM edges WHERE src=? AND dst=? AND rel='SURFACED_IN'`,
    mem,
    sess,
  )
const surfRows = (mem: string, sess: string) =>
  get<{ c: number }>(
    `SELECT count(*) c FROM edges WHERE src=? AND dst=? AND rel='SURFACED_IN'`,
    mem,
    sess,
  )!.c
const totalSurfEdges = () =>
  get<{ c: number }>(`SELECT count(*) c FROM edges WHERE rel='SURFACED_IN'`)!.c

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

insertEntry('mem:a', 'memory')
insertEntry('mem:b', 'project')

// ── 1. records an edge per surfaced memory + ensures the session stub ─────────
{
  recordSurfacings('sess:1', ['mem:a', 'mem:b'], 1000)
  const ea = surfEdge('mem:a', 'sess:1')
  assert.ok(ea, 'mem:a → sess:1 SURFACED_IN created')
  assert.equal(ea!.weight, 1, 'count starts at 1')
  assert.equal(ea!.notedAt, 1000, 'notedAt = surfacing time')
  assert.ok(surfEdge('mem:b', 'sess:1'), 'mem:b → sess:1 edge too')
  const sess = get<{ kind: string }>(`SELECT kind FROM entries WHERE id='sess:1'`)
  assert.ok(sess, 'session stub created')
  assert.equal(sess!.kind, 'session', "stub kind='session' (so the edge never dangles)")
  ok('one SURFACED_IN edge per surfaced memory + session stub ensured')
}

// ── 2. repeat (same memory+session) increments count + bumps notedAt, ONE row ─
{
  recordSurfacings('sess:1', ['mem:a'], 2000)
  const ea = surfEdge('mem:a', 'sess:1')
  assert.equal(ea!.weight, 2, 'repeat increments the surface count')
  assert.equal(ea!.notedAt, 2000, 'notedAt bumped to the latest surfacing')
  assert.equal(surfRows('mem:a', 'sess:1'), 1, 'still exactly one edge — no duplicate row')
  ok('repeat surfacing increments count, bumps lastAt, no dup')
}

// ── 3. a different session is a separate edge (per-session granularity) ───────
{
  recordSurfacings('sess:2', ['mem:a'], 3000)
  assert.equal(surfEdge('mem:a', 'sess:2')!.weight, 1, 'new session → fresh count')
  assert.equal(surfEdge('mem:a', 'sess:1')!.weight, 2, "the other session's edge is untouched")
  ok('per-session edges are independent')
}

// ── 4. empty / blank sessionId → no-op (can't attribute) ──────────────────────
{
  const before = totalSurfEdges()
  recordSurfacings('', ['mem:a'], 4000)
  recordSurfacings('   ', ['mem:b'], 4000)
  assert.equal(totalSurfEdges(), before, 'blank sessionId records nothing')
  ok('empty/blank sessionId is a no-op')
}

// ── 5. empty memoryIds → no-op (not even a session stub) ──────────────────────
{
  recordSurfacings('sess:3', [], 5000)
  assert.equal(get(`SELECT id FROM entries WHERE id='sess:3'`), undefined, 'no memories → no work at all')
  ok('empty memoryIds is a no-op')
}

// ── 6. observational SURFACED_IN survives the memory's re-upsert (blocking) ───
// upsertEntry wipes a re-synced entry's DECLARED outbound edges. But SURFACED_IN is
// OBSERVED (no frontmatter source to re-derive it), and /cortex-snapshot rewrites
// memory files constantly — a rel-blind wipe would reset s4's signal on every edit.
// So observational rels must survive; declared rels (LINKS_TO etc.) must still go.
{
  const { upsertEntry } = await import('../../server/graph/sync.ts')
  // mem:a carries SURFACED_IN→sess:1 (weight 2) + sess:2 (weight 1) from above; give
  // it a DECLARED edge too.
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES ('mem:a', 'mem:b', 'LINKS_TO')`)
  upsertEntry(null, {
    id: 'mem:a', name: 'mem:a', kind: 'memory', description: '',
    content: 'edited body — a re-sync', source: 'x', scope: 'user', updatedAt: 9999,
  })
  assert.equal(surfEdge('mem:a', 'sess:1')!.weight, 2, 'SURFACED_IN survives re-upsert with weight intact')
  assert.ok(surfEdge('mem:a', 'sess:2'), "all of the memory's SURFACED_IN edges survive")
  assert.equal(
    get(`SELECT 1 FROM edges WHERE src='mem:a' AND dst='mem:b' AND rel='LINKS_TO'`),
    undefined,
    'a DECLARED edge is still wiped by the re-upsert (the change is narrow: observational-only)',
  )
  ok('observational edges survive memory re-upsert; declared edges still wiped')
}

// ── 7. firstAt is set on INSERT and NEVER bumped by ON CONFLICT (s3) ──────────
// D3 acted-on correlation needs the FIRST-surfaced-at: notedAt is LAST and bumps
// on every recall, so a heavily-recalled (acted-on!) memory would drift to
// lastSurfaced > lastEdit and systematically fail "edit-after-surface". firstAt is
// a separate, stable column so D3 can read firstSurfacedAt. See the s3 doc
// (D3-on-lastAt is FORBIDDEN). Migrated NOW while the live SURFACED_IN corpus is 0,
// so firstAt is exact from the first live row post-power-cycle.
{
  recordSurfacings('sess:first', ['mem:a'], 10000)
  const e1 = surfEdge('mem:a', 'sess:first')
  assert.equal(e1!.firstAt, 10000, 'firstAt set to the first surfacing time on insert')
  assert.equal(e1!.notedAt, 10000, 'notedAt also = first surfacing initially')

  recordSurfacings('sess:first', ['mem:a'], 20000) // re-surface later
  const e2 = surfEdge('mem:a', 'sess:first')
  assert.equal(e2!.firstAt, 10000, 'firstAt is STABLE — never bumped by ON CONFLICT')
  assert.equal(e2!.notedAt, 20000, 'notedAt bumps to the latest (the lastAt D3 must NOT use)')
  assert.equal(e2!.weight, 2, 'weight still increments')
  ok('firstAt set-on-insert, never bumped (stable for D3); notedAt + weight still bump')
}

console.log(`\nOK surfacings.test.ts — ${passed} assertions passed`)
