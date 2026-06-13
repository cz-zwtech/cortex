#!/usr/bin/env tsx
/**
 * commit-2 prerequisite — re-upsert edge ownership (decision A, consensus
 * cortex-dev + 6d56cecc + Fable, 2026-06-10).
 *
 * An edge belongs to the entry that DECLARES it (its src). Re-upserting an
 * entry X therefore has authority ONLY over edges X declares (src=X) — it must
 * NOT delete inbound edges U→X that another entry U declared. The old
 * `DELETE ... WHERE src=id OR dst=id` wiped inbound edges, which forced the
 * commit-1 b″ pass to re-read+restore every unchanged source's edges — the
 * exact coupling that blocked the commit-2 stat-delta pre-pass (you can't
 * restore U→X without reading U). Narrowing the re-upsert delete to src=id
 * preserves inbound edges, so unchanged files never need re-reading.
 *
 * Genuine delete/rename paths (deleteScope, vault re-import, derive/patterns
 * rebuild) KEEP `src=id OR dst=id` — there the node is going away, so its
 * inbound edges SHOULD be cleaned up. This test pins only the re-upsert path.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-upsert-inbound-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.js')
const { upsertEntry } = await import('../../server/graph/sync.js')

getDb()

const entry = (id: string, content: string) => ({
  id, name: `n-${id}`, kind: 'memory', description: '', content,
  source: `${id}.md`, scope: 'user', updatedAt: 1, contentHash: content,
})
const edge = (src: string, dst: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel, label) VALUES (?, ?, 'LINKS_TO', 'related')`, src, dst)
const edgeExists = (src: string, dst: string) =>
  !!get<{ x: number }>(`SELECT 1 AS x FROM edges WHERE src = ? AND dst = ?`, src, dst)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// Seed: U, X, Y all present; U→X (inbound to X, declared by U) + X→Y (outbound, declared by X).
upsertEntry(null, entry('U', 'u-v1'))
upsertEntry(null, entry('X', 'x-v1'))
upsertEntry(null, entry('Y', 'y-v1'))
edge('U', 'X')
edge('X', 'Y')

// ── 1. re-upserting X PRESERVES the inbound edge U→X (U declared it, not X)
{
  upsertEntry(null, entry('X', 'x-v2')) // X's content changed → re-upsert
  assert.equal(edgeExists('U', 'X'), true, 'inbound U→X survives X re-upsert (edge belongs to declarer U)')
  ok('re-upsert preserves inbound edges')
}

// ── 2. re-upserting X still CLEARS X's own outbound edges (src=X authority)
{
  assert.equal(edgeExists('X', 'Y'), false, 'outbound X→Y cleared by X re-upsert (X declared it)')
  ok('re-upsert clears the re-upserted entry\'s outbound edges')
}

// ── 3. the entry row itself is replaced (content updated)
{
  const row = get<{ content_hash: string }>(`SELECT content_hash FROM entries WHERE id = 'X'`)
  assert.equal(row?.content_hash, 'x-v2', 'X row carries the new content')
  ok('re-upsert replaces the entry row')
}

console.log(`\nOK upsert-preserves-inbound.test.ts — ${passed} assertions passed`)
