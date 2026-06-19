#!/usr/bin/env tsx
/**
 * #127 — pure similarity helpers (no I/O, dependency-free so they're trivially
 * tsx-testable). topKSimilar finds an entry's nearest neighbours by cosine over a
 * provided vector store; capInDegree bounds hub over-linking by keeping only the
 * strongest M inbound similarity edges per target. The sync-time Pass D composes
 * these with the embedding sidecar + the graph; this test pins the math + selection.
 */
import assert from 'node:assert/strict'
import { cosine, topKSimilar, capInDegree } from '../../server/graph/similarity.ts'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const v = (...xs: number[]) => Float32Array.from(xs)

// ── cosine ──────────────────────────────────────────────────────────────────
{
  assert.ok(Math.abs(cosine(v(1, 0, 0), v(1, 0, 0)) - 1) < 1e-6, 'identical => 1')
  assert.ok(Math.abs(cosine(v(2, 0), v(1, 0)) - 1) < 1e-6, 'proportional => 1 (normalised)')
  assert.ok(Math.abs(cosine(v(1, 0), v(0, 1))) < 1e-6, 'orthogonal => 0')
  assert.ok(Math.abs(cosine(v(1, 0), v(-1, 0)) + 1) < 1e-6, 'opposite => -1')
  assert.equal(cosine(v(0, 0), v(1, 0)), 0, 'zero vector => 0 (guarded, no NaN)')
  ok('cosine: identical/proportional/orthogonal/opposite/zero')
}

// ── topKSimilar: top-K by cosine desc, excludes self, drops below threshold ────
{
  const store = new Map<string, Float32Array>([
    ['T', v(1, 0)],          // self — must be excluded
    ['A', v(1, 0)],          // cos 1.0
    ['B', v(0.8, 0.6)],      // cos 0.8
    ['C', v(0, 1)],          // cos 0.0 — below threshold
  ])
  const hits = topKSimilar('T', v(1, 0), store, 5, 0.5)
  assert.deepEqual(hits.map((h) => h.id), ['A', 'B'], 'self excluded, below-threshold dropped, desc by score')
  assert.ok(Math.abs(hits[0]!.score - 1) < 1e-6 && Math.abs(hits[1]!.score - 0.8) < 1e-6, 'scores are the cosine')
  ok('topKSimilar: excludes self, drops < threshold, sorts desc')
}
{
  const store = new Map<string, Float32Array>([['A', v(1, 0)], ['B', v(0.8, 0.6)]])
  const hits = topKSimilar('T', v(1, 0), store, 1, 0.5)
  assert.equal(hits.length, 1, 'k caps the neighbour count')
  assert.equal(hits[0]!.id, 'A', 'keeps the strongest')
  ok('topKSimilar: respects K')
}

// ── capInDegree: bound inbound similarity edges per target ─────────────────────
{
  const edges = [
    { src: 's1', dst: 'hub', weight: 0.9 },
    { src: 's2', dst: 'hub', weight: 0.8 },
    { src: 's3', dst: 'hub', weight: 0.7 },
    { src: 's4', dst: 'hub', weight: 0.6 },
    { src: 's5', dst: 'normal', weight: 0.55 },
  ]
  const capped = capInDegree(edges, 2)
  const hubKept = capped.filter((e) => e.dst === 'hub').map((e) => e.src).sort()
  assert.deepEqual(hubKept, ['s1', 's2'], 'hub keeps only the 2 strongest inbound')
  assert.equal(capped.filter((e) => e.dst === 'normal').length, 1, 'under-cap target unaffected')
  assert.equal(capped.length, 3, 'total = 2 (hub) + 1 (normal)')
  ok('capInDegree: keeps top-M inbound per target, leaves under-cap targets')
}

console.log(`\nOK similarity.test.ts — ${passed} cases passed`)
process.exit(0)
