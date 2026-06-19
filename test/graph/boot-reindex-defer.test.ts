#!/usr/bin/env tsx
/**
 * #123 — deferred embedding + the interrupted-backfill guard, end to end.
 *
 * (c) deferEmbeddings collects the embed work into result.embedQueue instead of
 * embedding inline under the graph write lock. The risk: an entry upserted with a
 * content_hash whose deferred embed never completes would be skipped as "unchanged"
 * forever → unembedded + unsearchable. The guard (mayEmbedSkip) makes the fast-paths
 * skip an unchanged entry ONLY if it already has a vector, so a never-completed embed
 * is RE-QUEUED on the next sync, and once embedded it correctly skips.
 *
 * Embeddings mode is 'local' so the guard engages, but embedText is NEVER called
 * (deferEmbeddings + a manual putEmbedding stand in for the backfill) — so no model
 * loads. Temp-DB/home pattern mirrors sync-stat-delta.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'local' // guard engages (mode != off); we never embedText
const dbdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bootreindex-db-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dbdir, 'graph.sqlite')
process.env.HOME = dbdir // isolates the embeddings sidecar under HOME/.config/ckn too

const { getDb } = await import('../../server/graph/db.js')
const sync = await import('../../server/graph/sync.js')
const { putEmbedding, embeddingCount } = await import('../../server/embeddingStore.js')
const { getEmbeddingDim } = await import('../../server/embeddings.js')

getDb()

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bootreindex-home-'))
const memDir = path.join(home, '.claude', 'memory')
fs.mkdirSync(memDir, { recursive: true })
fs.writeFileSync(
  path.join(memDir, 'foo.md'),
  `---\nname: Foo\ntype: memory\n---\nsome body content worth embedding here\n`,
  'utf8',
)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. deferEmbeddings: upserted + QUEUED, not embedded inline ───────────────────
const r1 = await sync.syncMemories(home, { deferEmbeddings: true })
assert.ok(r1.synced >= 1, 'first sync ingests foo')
assert.equal(r1.embedQueue.length, 1, 'embed is deferred → queued, not embedded inline')
assert.equal(await embeddingCount(), 0, 'no vector stored yet (deferred, backfill not run)')
const id = r1.embedQueue[0]!.id
ok('deferEmbeddings upserts the entry + queues the embed (no inline vector)')

// ── 2. embed never completed → next sync RE-PROCESSES it (does not skip) ──────────
const r2 = await sync.syncMemories(home, { deferEmbeddings: true })
assert.ok(r2.synced >= 1, 'unembedded entry is re-ingested, NOT skipped (interrupted-backfill guard)')
assert.ok(r2.embedQueue.some((e) => e.id === id), 'the still-unembedded entry is re-queued')
ok('a deferred-but-never-completed embed is re-queued on the next sync, never stranded')

// ── 3. backfill completes (vector stored) → next sync correctly SKIPS ─────────────
await putEmbedding(id, new Float32Array(getEmbeddingDim()))
const r3 = await sync.syncMemories(home, { deferEmbeddings: true })
assert.equal(r3.synced, 0, 'once embedded, the unchanged entry is skipped')
assert.ok(r3.skipped >= 1, 'foo skipped as unchanged-and-embedded')
assert.equal(r3.embedQueue.length, 0, 'nothing re-queued once a vector exists')
ok('once embedded, an unchanged entry is correctly skipped (fast-path intact)')

console.log(`\nOK boot-reindex-defer.test.ts — ${passed} cases passed`)
process.exit(0)
