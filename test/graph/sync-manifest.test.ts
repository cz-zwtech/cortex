#!/usr/bin/env tsx
/**
 * commit-2 (sync floor) slice 1 — the sync_manifest layer.
 *
 * The sync pre-pass reads + sha256s ALL ~2545 files every run just to detect
 * change — ~4s of /mnt-WSL small-file IO (the residual after commit-1 killed the
 * quadratic). A per-file (mtime,size) manifest lets the pre-pass SKIP reading a
 * file whose stat is unchanged; content_hash stays the authoritative upsert
 * signal for the files we DO open, so the mtime-preserving-edit fix isn't lost.
 * This slice is the pure manifest store; the pre-pass wiring is a follow-on.
 *
 * Temp-DB pattern mirrors test/graph/threads.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-manifest-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb } = await import('../../server/graph/db.js')
const { readSyncManifest, writeSyncManifest, statUnchanged } = await import(
  '../../server/graph/syncManifest.js'
)

getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. empty manifest + round-trip write/read
{
  assert.equal(readSyncManifest().size, 0, 'fresh manifest is empty')
  writeSyncManifest([
    { path: 'a.md', mtime: 100, size: 10 },
    { path: 'b.md', mtime: 200, size: 20 },
  ])
  const m = readSyncManifest()
  assert.equal(m.size, 2, 'two entries persisted')
  assert.deepEqual(m.get('a.md'), { mtime: 100, size: 10 }, 'round-trips mtime+size')
  ok('manifest write/read round-trip')
}

// ── 2. statUnchanged — the read-skip decision
{
  const m = readSyncManifest()
  assert.equal(statUnchanged('a.md', 100, 10, m), true, 'same mtime+size → unchanged (skip read)')
  assert.equal(statUnchanged('a.md', 101, 10, m), false, 'different mtime → changed')
  assert.equal(statUnchanged('a.md', 100, 11, m), false, 'different size → changed')
  assert.equal(statUnchanged('new.md', 100, 10, m), false, 'absent path → changed (new file)')
  ok('statUnchanged is exact on (mtime,size); absent → changed')
}

// ── 3. upsert: re-writing a path replaces its stat
{
  writeSyncManifest([{ path: 'a.md', mtime: 999, size: 99 }])
  assert.deepEqual(readSyncManifest().get('a.md'), { mtime: 999, size: 99 }, 'upsert replaces')
  assert.equal(readSyncManifest().size, 2, 'upsert does not add a duplicate')
  ok('writeSyncManifest upserts by path')
}

console.log(`\nOK sync-manifest.test.ts — ${passed} assertions passed`)
