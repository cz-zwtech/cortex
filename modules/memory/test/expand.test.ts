import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { MemoryStore, hashContent } from '../server/store.js'
import { expand } from '../server/expand.js'
import { lexicalSeed, runSeed, vectorSeed, type Seed } from '../server/seed.js'
import { EmbeddingEstimator } from '../server/embedding.js'
import { scoreCeiling } from '../server/rank.js'
import type { Memory } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const add = (s: MemoryStore, id: string, content = `body of ${id} with several words in it`) => {
  s.upsert({
    id,
    source: `/mem/${id}.md`,
    name: id,
    description: '',
    content,
    shape: 'reference',
    authorship: 'authored',
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: 1000,
    ingestedAt: 1000,
    outcome: '',
    outcomeText: '',
    contentHash: hashContent(id, '', content),
  } as never)
  return s.get(id) as Memory
}

const chain = (s: MemoryStore, n: number) => {
  const ms = Array.from({ length: n }, (_, i) => add(s, `m${i}`))
  for (let i = 0; i + 1 < n; i++) {
    s.setDeclaredEdges(`m${i}`, [{ src: `m${i}`, dst: `m${i + 1}`, rel: 'evolved_into' }])
  }
  return ms
}

// ── the stopping rule ────────────────────────────────────────────────────────

test('THE BOUND STOPS THE TRAVERSAL BEFORE PAYING FOR THE HOP', () => {
  // A high k-th best means no deeper candidate could enter the result, so
  // expansion must stop — and stop without having walked the edges.
  const s = store()
  const ms = chain(s, 10)
  const out = expand([ms[0]!], { store: s, kthBest: 10 })
  assert.equal(out.stoppedByBound, true)
  assert.equal(out.depthExplored, 0, 'not one hop was paid for')
  assert.deepEqual(out.reached, [])
})

test('and it goes DEEP when nothing held is dominating — where a cap truncates', () => {
  const s = store()
  const ms = chain(s, 6)
  const out = expand([ms[0]!], { store: s, kthBest: 0 })
  assert.equal(out.stoppedByBound, false)
  assert.ok(out.depthExplored >= 5, `explored ${out.depthExplored}`)
  assert.equal(out.reached.length, 5, 'every reachable memory found')
})

test('PRUNING IS LOSSLESS — bounded output equals unbounded output', () => {
  // The property that makes this an admissible bound rather than a heuristic.
  // A ceiling below the held k-th can only exclude candidates that could not
  // have placed anyway.
  const s = store()
  const ms = chain(s, 8)
  const unbounded = expand([ms[0]!], { store: s })
  const threshold = scoreCeiling(4) + 0.001 // nothing at depth ≥4 can beat this
  const bounded = expand([ms[0]!], { store: s, kthBest: threshold })

  const keptByBoth = unbounded.reached.filter((r) => r.hops < 4).map((r) => r.memory.id)
  assert.deepEqual(bounded.reached.map((r) => r.memory.id), keptByBoth)
})

test('no seeds means no traversal at all', () => {
  const s = store()
  const out = expand([], { store: s, kthBest: 0 })
  assert.deepEqual(out.reached, [])
  assert.equal(out.depthExplored, 0)
})

// ── the lossy bound is reported; the lossless one need not be ────────────────

test('THE BREADTH CAP IS LOSSY, SO IT IS REPORTED', () => {
  // Depth stopping is lossless and needs no apology. Breadth truncation drops
  // real candidates, and a traversal that silently stopped early reads as
  // "nothing else was relevant" — the one thing it does not mean.
  const s = store()
  const hub = add(s, 'hub')
  const targets = Array.from({ length: 40 }, (_, i) => add(s, `t${i}`))
  s.setDeclaredEdges(
    'hub',
    targets.map((t) => ({ src: 'hub', dst: t.id, rel: 'evolved_into' as const })),
  )

  const out = expand([hub], { store: s, kthBest: 0, maxEdgesPerNode: 5 })
  assert.deepEqual(out.breadthTruncatedAt, ['hub'], 'names the node it truncated at')
  assert.equal(out.reached.length, 5)
})

test('a node under the cap is NOT reported as truncated', () => {
  const s = store()
  const ms = chain(s, 3)
  const out = expand([ms[0]!], { store: s, kthBest: 0, maxEdgesPerNode: 32 })
  assert.deepEqual(out.breadthTruncatedAt, [])
})

test('a cycle terminates — every node is visited once', () => {
  const s = store()
  const ms = chain(s, 4)
  s.setDeclaredEdges('m3', [{ src: 'm3', dst: 'm0', rel: 'evolved_into' }])
  const out = expand([ms[0]!], { store: s, kthBest: 0 })
  const ids = out.reached.map((r) => r.memory.id)
  assert.equal(new Set(ids).size, ids.length, 'no repeats')
  assert.ok(!ids.includes('m0'), 'and never returns to a seed')
})

test('every reached memory carries its hop count and the relation that found it', () => {
  const s = store()
  const ms = chain(s, 3)
  const out = expand([ms[0]!], { store: s, kthBest: 0 })
  assert.equal(out.reached[0]!.hops, 1)
  assert.equal(out.reached[0]!.relation, 'evolved_into')
  assert.equal(out.reached[1]!.hops, 2)
})

// ── seed provenance ──────────────────────────────────────────────────────────

test('SEED PROVENANCE IS REPORTED — lexical-because-off must differ from broken', async () => {
  // The 486-unembedded shape, one layer up. A caller that cannot distinguish a
  // deliberate configuration from a dead backend reports both as healthy.
  const s = store()
  add(s, 'a', 'deployment release script on the build host with green health checks')

  const dead = new EmbeddingEstimator({
    name: 'dead',
    dims: 384,
    embed: async () => {
      throw new Error('no model loaded')
    },
  })
  // NOT warmed, so the estimator has not yet discovered it is broken — the
  // vector seed reports available and returns nothing, which is honest but not
  // what this test is about. Warming is what surfaces the failure; see the next
  // test.
  await dead.warm(['probe'])

  const out = runSeed([vectorSeed(s, dead), lexicalSeed(s)], 'deployment', 10)
  assert.equal(out.via, 'lexical', 'it fell back')
  assert.ok(out.memories.length > 0)
})

test('a degraded seed NAMES what it degraded FROM and why', async () => {
  const s = store()
  add(s, 'a', 'deployment release script on the build host with green health checks')
  const dead = new EmbeddingEstimator({
    name: 'dead',
    dims: 384,
    embed: async () => {
      throw new Error('model failed to load')
    },
  })
  await dead.warm(['anything']) // provokes the failure so unavailable() reports

  const out = runSeed([vectorSeed(s, dead), lexicalSeed(s)], 'deployment', 10)
  assert.equal(out.via, 'lexical')
  assert.equal(out.degradedFrom?.kind, 'vector')
  assert.match(out.degradedFrom!.reason, /model failed to load/)
})

test('no degradedFrom when the preferred seed simply ran', () => {
  const s = store()
  add(s, 'a', 'deployment release script on the build host with green health checks')
  const out = runSeed([lexicalSeed(s)], 'deployment', 10)
  assert.equal(out.via, 'lexical')
  assert.equal(out.degradedFrom, undefined)
})

test('the VECTOR SEED RETURNS NOTHING rather than faking it with lexical hits', () => {
  // A vector seed that quietly returns lexical results is precisely the lie the
  // provenance machinery exists to prevent — it would report `via: vector` for
  // a substring match.
  const s = store()
  add(s, 'a', 'deployment release script on the build host with green health checks')
  const ready = new EmbeddingEstimator({ name: 'stub', dims: 384, embed: async (t) => t.map(() => new Float32Array(384)) })
  const seeds: Seed[] = [vectorSeed(s, ready)]
  const out = runSeed(seeds, 'deployment', 10)
  assert.equal(out.via, 'vector')
  assert.deepEqual(out.memories, [], 'not built beyond the seam, and it says so by returning nothing')
})

test('every seed unavailable ⇒ via "none", still with the reason', async () => {
  const s = store()
  const dead = new EmbeddingEstimator({
    name: 'dead',
    dims: 384,
    embed: async () => {
      throw new Error('backend gone')
    },
  })
  await dead.warm(['x'])
  const out = runSeed([vectorSeed(s, dead)], 'q', 5)
  assert.equal(out.via, 'none')
  assert.equal(out.degradedFrom?.kind, 'vector')
})

test('THE THRESHOLD TIGHTENS FROM RESULTS JUST READ (the user\'s actual ask)', () => {
  // Without onDepth the threshold is whatever the seeds scored, fixed for the
  // whole traversal — sound but leaving most of the saving unclaimed, because
  // the strongest evidence for stopping is what the traversal just produced.
  const s = store()
  const ms = chain(s, 8)

  const seen: number[] = []
  const tightening = expand([ms[0]!], {
    store: s,
    kthBest: 0,
    // Depth 1 returns something strong enough that nothing deeper can compete.
    onDepth: (reached) => {
      seen.push(reached.length)
      return reached.length ? scoreCeiling(2) + 0.001 : undefined
    },
  })
  const staticThreshold = expand([ms[0]!], { store: s, kthBest: 0 })

  assert.ok(seen.length > 0, 'the callback saw each completed depth')
  assert.equal(tightening.stoppedByBound, true)
  assert.ok(
    tightening.depthExplored < staticThreshold.depthExplored,
    `tightening explored ${tightening.depthExplored}, static explored ${staticThreshold.depthExplored}`,
  )
})

test('a tightening threshold is MONOTONE — it can never loosen mid-traversal', () => {
  // If it could fall, the bound would stop being admissible partway through and
  // the losslessness guarantee would hold for a prefix only.
  const s = store()
  const ms = chain(s, 6)
  const out = expand([ms[0]!], {
    store: s,
    kthBest: scoreCeiling(3),
    onDepth: () => -999, // tries to loosen
  })
  // It stopped where the ORIGINAL threshold said, not where the loosened one did.
  assert.ok(out.depthExplored <= 3, `explored ${out.depthExplored}`)
})
