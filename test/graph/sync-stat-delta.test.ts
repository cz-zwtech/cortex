#!/usr/bin/env tsx
/**
 * commit-2 slice 2 — wire the sync_manifest stat-delta into the sync pre-pass.
 *
 * The pre-pass used to read + sha256 EVERY memory file each run just to detect
 * change (~4s of /mnt-WSL small-file IO at ~2.5k files — the residual after
 * commit-1 killed the O(N²) name-mention scan). The manifest (slice-1) records
 * each file's (mtime,size); this slice makes the pre-pass SKIP opening a file
 * whose stat is unchanged AND that already has a graph entry.
 *
 * Decision A (re-upsert deletes only src=id) is the precondition: because
 * inbound edges survive a re-upsert, an unchanged source never needs re-reading
 * to restore its edges — so skipping the read is safe.
 *
 * End-to-end against a temp $HOME, mirroring sync-port.test.ts's disk-sync block.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dbdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-statdelta-db-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dbdir, 'graph.sqlite')
process.env.HOME = dbdir

const { getDb, run, get } = await import('../../server/graph/db.js')
const sync = await import('../../server/graph/sync.js')
const { readSyncManifest } = await import('../../server/graph/syncManifest.js')

getDb()

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-statdelta-home-'))
const memDir = path.join(home, '.claude', 'memory')
fs.mkdirSync(memDir, { recursive: true })
const foo = path.join(memDir, 'foo.md')
fs.writeFileSync(foo, `---\nname: Foo\ntype: memory\n---\noriginal body\n`, 'utf8')

const hashOf = (src: string) =>
  get<{ content_hash: string }>(`SELECT content_hash FROM entries WHERE source = ?`, src)?.content_hash

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. first sync ingests foo + records its (mtime,size) in the manifest
{
  const r = await sync.syncMemories(home)
  assert.ok(r.synced >= 1, `first sync ingests foo (synced=${r.synced})`)
  const man = readSyncManifest()
  assert.ok(man.has(foo), 'manifest records foo after the sync')
  const st = fs.statSync(foo)
  assert.equal(man.get(foo)!.size, st.size, 'manifest size matches disk')
  ok('first sync ingests + writes the manifest')
}

// ── 2. second sync, no disk change → foo skipped (stat unchanged)
{
  const r = await sync.syncMemories(home)
  assert.equal(r.synced, 0, 'no-change sync upserts nothing')
  assert.ok(r.skipped >= 1, 'foo counted as skipped')
  ok('unchanged file is skipped on the second sync')
}

// ── 3. stat is the READ-GATE: a stat-unchanged file is not re-opened/re-hashed,
//      even if the stored content_hash no longer matches disk. (This pins the
//      designed fast-path — stat gates the read; the hash check only runs on
//      files we open. A same-(mtime,size) content swap is the accepted skip.)
{
  run(`UPDATE entries SET content_hash = 'STALE-NOT-MATCHING' WHERE source = ?`, foo)
  const r = await sync.syncMemories(home) // foo's stat is unchanged → must NOT re-read
  assert.equal(r.synced, 0, 'stat-unchanged file is not re-ingested despite a stale stored hash')
  assert.equal(hashOf(foo), 'STALE-NOT-MATCHING', 'stored hash untouched — proves the read was skipped')
  ok('stat-unchanged short-circuits before the hash check (read-gate)')
}

// ── 4. wiped-graph guard: an entry missing from the graph is RE-READ even when
//      the manifest still carries its stat (skip requires an existing entry).
{
  run(`DELETE FROM entries WHERE source = ?`, foo) // graph loses foo; manifest persists
  assert.equal(hashOf(foo), undefined, 'foo entry gone')
  const r = await sync.syncMemories(home)
  assert.ok(r.synced >= 1, 'foo re-ingested despite unchanged stat (no entry ⟹ read)')
  assert.ok(hashOf(foo) && hashOf(foo) !== 'STALE-NOT-MATCHING', 'foo rebuilt with a fresh real hash')
  ok('wiped-graph guard re-reads a file with no entry')
}

// ── 5. genuine content change (size differs) → stat changed → re-upserted
{
  const before = hashOf(foo)
  fs.writeFileSync(foo, `---\nname: Foo\ntype: memory\n---\na substantially longer, different body\n`, 'utf8')
  const r = await sync.syncMemories(home)
  assert.ok(r.synced >= 1, 'changed file re-ingested')
  assert.ok(hashOf(foo) && hashOf(foo) !== before, 'content_hash updated to the new body')
  ok('genuine content change is re-read + re-upserted')
}

console.log(`\nOK sync-stat-delta.test.ts — ${passed} assertions passed`)
