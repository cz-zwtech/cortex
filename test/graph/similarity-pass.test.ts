#!/usr/bin/env tsx
/**
 * #127 — sync-time similarity-edge materialization (Pass D), end to end against the
 * embedding sidecar. No model: vectors are written directly via putEmbedding, so this
 * exercises the pass logic without loading bge. Covers: SIMILAR_TO carries cosine in
 * `weight`; top-K by threshold; the hub in-degree cap; CONDITION A (a source re-upsert
 * must NOT wipe its SIMILAR_TO edges — the Pass-D-owned carve-out); and incremental
 * recompute touching ONLY the changed source (the bounded staleness condition B notes).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'local' // mode != off => similarity enabled; no model loads (we never embed text)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sim-pass-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, all } = await import('../../server/graph/db.ts')
const { putEmbedding } = await import('../../server/embeddingStore.ts')
const { getEmbeddingDim } = await import('../../server/embeddings.ts')
const { materializeSimilarityEdges, upsertEntry } = await import('../../server/graph/sync.ts')

getDb()
const DIM = getEmbeddingDim()
const vec = (a: number, b: number) => {
  const v = new Float32Array(DIM)
  v[0] = a
  v[1] = b
  return v
}
const insMem = (id: string) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'memory','','','', 'user',0,0,'','','','','',0,0,'','')`,
    id, id,
  )
const simEdges = () =>
  all<{ src: string; dst: string; weight: number }>(
    `SELECT src, dst, weight FROM edges WHERE rel='SIMILAR_TO' ORDER BY src, dst`,
  )
const find = (s: string, d: string) => simEdges().find((e) => e.src === s && e.dst === d)

// A=e1, B≈(0.8,0.6): cos(A,B)=0.8, C≈(0.6,0.8): cos(A,C)=0.6, cos(B,C)=0.96
insMem('A'); insMem('B'); insMem('C')
await putEmbedding('A', vec(1, 0))
await putEmbedding('B', vec(0.8, 0.6))
await putEmbedding('C', vec(0.6, 0.8))

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// 1. full materialization: SIMILAR_TO carries cosine in weight, top-K >= threshold ──
{
  await materializeSimilarityEdges(null)
  assert.ok(find('A', 'B') && Math.abs(find('A', 'B')!.weight - 0.8) < 1e-4, 'A->B weight = cos 0.8')
  assert.ok(find('A', 'C') && Math.abs(find('A', 'C')!.weight - 0.6) < 1e-4, 'A->C weight = cos 0.6')
  assert.ok(find('B', 'C') && Math.abs(find('B', 'C')!.weight - 0.96) < 1e-4, 'B->C weight = cos 0.96')
  ok('full pass: SIMILAR_TO edges carry cosine in weight, selected by threshold')
}

// 2. CONDITION A: a source re-upsert must NOT wipe its SIMILAR_TO edges ─────────────
{
  const before = simEdges().filter((e) => e.src === 'A').length
  assert.ok(before >= 1, 'A has outbound SIMILAR_TO before re-upsert')
  upsertEntry(null, {
    id: 'A', name: 'A', kind: 'memory', description: '', content: 'changed body',
    source: '', scope: 'user', updatedAt: 1,
  } as any)
  const after = simEdges().filter((e) => e.src === 'A').length
  assert.equal(after, before, 'SIMILAR_TO survives a source re-sync (Pass-D-owned, carved out of the upsert delete)')
  ok('CONDITION A: SIMILAR_TO survives a source re-upsert')
}

// 3. incremental recompute touches ONLY the changed source ──────────────────────────
{
  await putEmbedding('A', vec(0, 1)) // A now aligns with C (cos 0.8) more than B (cos 0.6)
  const bBefore = JSON.stringify(simEdges().filter((e) => e.src === 'B'))
  await materializeSimilarityEdges(['A'])
  const bAfter = JSON.stringify(simEdges().filter((e) => e.src === 'B'))
  assert.equal(bAfter, bBefore, 'unchanged source B is untouched by an incremental A recompute (bounded staleness)')
  assert.ok(find('A', 'C') && Math.abs(find('A', 'C')!.weight - 0.8) < 1e-4, 'A->C recomputed to the new cosine 0.8')
  ok('incremental: only the changed source is recomputed')
}

// 4. hub in-degree cap ──────────────────────────────────────────────────────────────
{
  process.env.CKN_SIMILARITY_MAX_INDEGREE = '1'
  await materializeSimilarityEdges(null)
  const inDeg = new Map<string, number>()
  for (const e of simEdges()) inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1)
  for (const [, n] of inDeg) assert.ok(n <= 1, 'no target exceeds the in-degree cap')
  delete process.env.CKN_SIMILARITY_MAX_INDEGREE
  ok('hub cap: SIMILAR_TO in-degree bounded per target')
}

console.log(`\nOK similarity-pass.test.ts — ${passed} cases passed`)
process.exit(0)
