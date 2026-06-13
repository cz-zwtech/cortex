#!/usr/bin/env tsx
/**
 * ABOUT tier-1 join (Item-2 slice 2): recallForFile.
 *
 * Given a repo-relative edit target, surface the memories that mention that
 * file — across the heterogeneous stored shapes — ranked by the EXISTING
 * recall composite. The decisive case: the same logical repo file stored under
 * an absolute zwd root, an absolute zw1 (cross-machine) root, and a bare
 * repo-relative path must ALL surface for one repo-relative target (an exact
 * fileEntryId match would catch only one and fracture the rest).
 *
 * Temp-DB pattern mirrors test/graph/recall.test.ts: set CKN_GRAPH_DB_PATH +
 * CKN_EMBEDDINGS=off + HOME before importing db.js / recall.js.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-recallfile-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { recallForFile } = await import('../../server/graph/recall.js')

getDb()

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const fileEntryId = (p: string): string => `file:${p.replace(/\//g, '_').replace(/\\/g, '_')}`

const entry = (id: string, kind: string, scope: string, updatedAt: number, pinned = 0) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, `name-${id}`, kind, `desc-${id}`, 'x'.repeat(80), 'src', scope, updatedAt, updatedAt, pinned,
  )
// A file stub as sync.ts writes it: id = underscore-encoded path, name = verbatim path.
const fileStub = (storedPath: string) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, pinned)
     VALUES (?, ?, 'file', '', '', '', 'file', ?, ?, 0)`,
    fileEntryId(storedPath), storedPath, NOW, NOW,
  )
const mentions = (memId: string, storedPath: string) =>
  run(`INSERT INTO edges (src, dst, rel) VALUES (?, ?, 'MENTIONS_FILE')`, memId, fileEntryId(storedPath))

// Same logical repo file under three real stored shapes, three distinct memories.
const ABS_ZWD = '/path/to/cortex/bin/ckn-sync.ts'
const ABS_ZW1 = '/home/claude/cortex/bin/ckn-sync.ts'
const REL = 'bin/ckn-sync.ts'
const OTHER = '/home/claude/cortex/bin/ckn-name-session.ts'

entry('m-abs', 'memory', 'memory:auto', NOW - 2 * DAY)
entry('m-x1', 'memory', 'memory:auto', NOW - 3 * DAY)
entry('m-rel', 'memory', 'memory:auto', NOW - 1 * DAY)
entry('m-other', 'memory', 'memory:auto', NOW - 1 * DAY)
entry('m-pin', 'memory', 'memory:auto', NOW - 90 * DAY, 1) // old but pinned
entry('m-none', 'memory', 'memory:auto', NOW - 1 * DAY) // mentions nothing
// A session node that touched the target file. Sessions emit a MENTIONS_FILE
// edge per touched file (a big session → hundreds), so they both pollute the
// 3-slot pre-edit surface AND dominate the synchronous edge scan. They are NOT
// file-knowledge and must be excluded at the query.
entry('s-sess', 'session', 'session', NOW) // most-recent, would otherwise top the list
fileStub(ABS_ZWD); fileStub(ABS_ZW1); fileStub(REL); fileStub(OTHER)

mentions('m-abs', ABS_ZWD)
mentions('m-x1', ABS_ZW1)
mentions('m-rel', REL)
mentions('m-pin', ABS_ZWD)
mentions('m-other', OTHER)
mentions('s-sess', REL) // session touched the target file

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. all three stored shapes of the same file surface for one repo-rel target
{
  const hits = await recallForFile(REL, { limit: 10 })
  const ids = new Set(hits.map((h) => h.id))
  assert.ok(ids.has('m-abs'), 'absolute-zwd-stored memory surfaced')
  assert.ok(ids.has('m-x1'), 'absolute-zw1 (cross-machine) memory surfaced')
  assert.ok(ids.has('m-rel'), 'repo-relative-stored memory surfaced')
  assert.ok(!ids.has('m-other'), 'a different file is not surfaced')
  assert.ok(!ids.has('m-none'), 'a memory mentioning no file is not surfaced')
  ok('three stored shapes unify under one repo-relative target')

  // file stubs themselves must never appear as hits
  assert.ok(![...ids].some((i) => i.startsWith('file:')), 'file stubs dropped')
  ok('file stub hubs excluded from results')

  // session nodes are NOT file-knowledge — a session merely touched the file.
  // Despite being the most-recent node, s-sess must not appear.
  assert.ok(!ids.has('s-sess'), 'session node excluded from file-knowledge')
  assert.ok(!hits.some((h) => h.kind === 'session'), 'no session-kind hits')
  ok('session nodes excluded (not file-knowledge)')

  const byId = new Map(hits.map((h) => [h.id, h]))
  assert.equal(byId.get('m-abs')!.signals.viaEdge, 'MENTIONS_FILE', 'viaEdge set')
  assert.equal(byId.get('m-abs')!.signals.hops, 1, 'hops=1')
  assert.equal(byId.get('m-abs')!.signals.cosine, null, 'no vector seed → cosine null')
  ok('signals provenance: MENTIONS_FILE / hops=1 / cosine null')
}

// ── 2. ranked by the existing composite (pin boost floats the pinned hit up)
{
  const hits = await recallForFile(REL, { limit: 10 })
  const idx = (id: string) => hits.findIndex((h) => h.id === id)
  assert.ok(idx('m-pin') !== -1, 'pinned hit present')
  assert.ok(hits[idx('m-pin')].signals.composite > hits[idx('m-abs')].signals.composite,
    'pin boost reflected in composite')
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].signals.composite >= hits[i].signals.composite, 'sorted by composite desc')
  }
  ok('ranked by existing composite, pinned floats up')
}

// ── 3. limit caps the result count
{
  const hits = await recallForFile(REL, { limit: 2 })
  assert.ok(hits.length <= 2, 'limit respected')
  ok('limit caps results')
}

// ── 4. no-match + empty target yield empty
{
  assert.deepEqual(await recallForFile('does/not/exist.ts', { limit: 5 }), [], 'no match → []')
  assert.deepEqual(await recallForFile('', { limit: 5 }), [], 'empty target → []')
  ok('no-match and empty target return empty')
}

console.log(`\nOK recall-for-file.test.ts — ${passed} assertions passed`)
