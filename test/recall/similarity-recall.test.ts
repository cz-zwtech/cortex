#!/usr/bin/env tsx
/**
 * #127 — SIMILAR_TO in recall. expandFromSeeds walks similarity edges 1-hop, threading
 * the stored cosine as viaWeight; the composite rewards a stronger-similarity neighbour
 * proportionally (edgeBonus = 0.08 * cosine) so a 0.9 neighbour outranks a 0.56 one.
 * No model: expandFromSeeds is exercised directly with a hand-seeded pool, ranking via
 * the pure rankCandidates (mirroring supersede-ranking.test.ts).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-recall-sim-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.ts')
const { expandFromSeeds, rankCandidates } = await import('../../server/graph/recall.ts')
import type { ScoredCandidate } from '../../server/graph/recall.ts'

getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── A. expandFromSeeds walks SIMILAR_TO and threads the cosine as viaWeight ─────
{
  run(`INSERT INTO edges (src, dst, rel, weight) VALUES ('S','A','SIMILAR_TO',0.9)`)
  run(`INSERT INTO edges (src, dst, rel, weight) VALUES ('S','B','SIMILAR_TO',0.56)`)
  const pool = new Map<string, any>([['S', { hops: 0, cosine: 0.5, viaEdge: null }]])
  await expandFromSeeds(['S'], pool)
  assert.equal(pool.get('A')?.viaEdge, 'SIMILAR_TO', 'A pulled in via SIMILAR_TO')
  assert.ok(Math.abs(pool.get('A')?.viaWeight - 0.9) < 1e-6, 'A viaWeight = stored cosine 0.9')
  assert.equal(pool.get('B')?.viaEdge, 'SIMILAR_TO', 'B pulled in via SIMILAR_TO')
  assert.ok(Math.abs(pool.get('B')?.viaWeight - 0.56) < 1e-6, 'B viaWeight = stored cosine 0.56')
  ok('expandFromSeeds: walks SIMILAR_TO, threads cosine as viaWeight')
}

// ── B. ranking: a stronger-similarity neighbour outranks a weaker one ───────────
{
  const mk = (id: string, viaWeight: number): ScoredCandidate => ({
    row: {
      id, name: id, kind: 'memory', description: '', content: 'x'.repeat(80),
      scope: 'user', updatedAt: 1_700_000_000_000, syncedAt: 1_700_000_000_000, pinned: false,
    },
    state: { hops: 1, cosine: null, viaEdge: 'SIMILAR_TO', viaWeight },
    usage: 0,
    decay: 0,
    superseded: false,
  })
  const ctx = { query: 'q' } as any
  const hits = rankCandidates([mk('lo', 0.56), mk('hi', 0.9)], ctx)
  assert.equal(hits[0].id, 'hi', 'the 0.9-similarity neighbour outranks the 0.56 one')
  const hi = hits.find((h) => h.id === 'hi')!
  const lo = hits.find((h) => h.id === 'lo')!
  assert.ok(
    hi.signals.composite - lo.signals.composite > 0.02,
    'bonus scales with cosine: 0.08*(0.9-0.56) ~= 0.027 separation',
  )
  ok('rankCandidates: SIMILAR_TO bonus scales with the stored cosine')
}

console.log(`\nOK similarity-recall.test.ts — ${passed} cases passed`)
process.exit(0)
