import assert from 'node:assert/strict'
import test from 'node:test'

import { cosine, EmbeddingEstimator, type EmbeddingBackend } from '../server/embedding.js'
import { collapse, type Candidate } from '../server/collapse.js'
import type { Memory } from '../server/types.js'

/** Deterministic stand-in: hashes tokens into a small vector. No model, no IO. */
const stubBackend = (over: Partial<EmbeddingBackend> = {}): EmbeddingBackend => ({
  name: 'stub',
  dims: 16,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(16)
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0
        for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) | 0
        v[Math.abs(h) % 16]! += 1
      }
      return v
    }),
  ...over,
})

test('cosine is 1 for identical and 0 for orthogonal', () => {
  const a = new Float32Array([1, 0, 0])
  assert.equal(cosine(a, new Float32Array([1, 0, 0])), 1)
  assert.equal(cosine(a, new Float32Array([0, 1, 0])), 0)
})

test('a warmed pair compares; an UNWARMED one abstains and is COUNTED', async () => {
  // The distinction V1 lost: a miss is "you did not warm this", not "not
  // similar". Absorbing it would make a caller bug look like a verdict.
  const e = new EmbeddingEstimator(stubBackend())
  await e.warm(['the release script lives in bin'])
  const est = e.estimator()

  assert.equal(est.compare('the release script lives in bin', 'never warmed'), null)
  assert.equal(e.misses(), 1, 'counted, not absorbed')
})

test('an UNAVAILABLE backend abstains on every comparison and SAYS SO', async () => {
  // V1 degrades to null silently, and its corpus has 15 entries with zero
  // embeddings to show for it. A system with embeddings off and one with
  // embeddings broken must not look identical from outside.
  const e = new EmbeddingEstimator(
    stubBackend({
      embed: async () => {
        throw new Error('model failed to load')
      },
    }),
  )

  const report = await e.warm(['anything'])
  assert.equal(report.embedded, 0)
  assert.match(String(report.unavailable), /model failed to load/)
  assert.equal(e.estimator().compare('anything', 'anything'), null, 'abstains rather than guesses')
  assert.match(e.describe(), /UNAVAILABLE/)
  assert.match(e.describe(), /will NOT be collapsed/, 'and names the consequence')
})

test('a dead backend degrades to BIAS-TO-SPLIT, not to bad merges', async () => {
  // cannot-judge is already first-class in the collapse: it never merges. So a
  // broken model produces duplicates, which are visible and repairable, rather
  // than false merges, which are invisible and permanent. Safe by construction.
  const mem = (id: string, content: string): Memory => ({
    id, source: `/m/${id}.md`, name: id, description: '', content,
    shape: 'observation', authorship: 'authored', scope: 'user',
    pinned: false, protected: false, contentHash: id, machine: 'node-a',
    authoredAt: 1, ingestedAt: 1, outcome: '', outcomeText: '',
  })
  const e = new EmbeddingEstimator(
    stubBackend({ embed: async () => { throw new Error('down') } }),
  )
  await e.warm(['a'])

  const same = 'The build fails when NODE_ENV is unset, so export it first.'
  const cands: Candidate[] = [
    { memory: mem('a', same), score: 0.9 },
    { memory: mem('b', same), score: 0.8 },
  ]
  const out = collapse(cands, { estimator: e.estimator() })
  assert.equal(out.length, 2, 'duplicates survive — visible and repairable')
})

test('cosine floors do NOT inherit the lexical ones', async () => {
  // Different distributions, different shapes. Inheriting the numbers is the
  // failure that compiles, passes, and quietly degrades recall.
  const e = new EmbeddingEstimator(stubBackend())
  const est = e.estimator()
  assert.notEqual(est.relatedFloor, 0.45)
  assert.notEqual(est.nearDuplicateFloor, 0.8)
  assert.equal(est.provisional, true, 'chosen, not derived — and it says so in the type')
  assert.match(est.name, /^embedding:/)
})

test('warm is batched and skips what is already cached', async () => {
  let calls = 0
  let batchSizes: number[] = []
  const e = new EmbeddingEstimator(
    stubBackend({
      embed: async (texts) => {
        calls++
        batchSizes.push(texts.length)
        return texts.map(() => new Float32Array(16).fill(1))
      },
    }),
  )

  await e.warm(['one', 'two', 'three'])
  await e.warm(['one', 'two'])
  const r = await e.warm(['three', 'four'])

  assert.equal(calls, 2, 'a fully-cached warm makes no call at all')
  assert.deepEqual(batchSizes, [3, 1], 'batched, and only the new text')
  assert.equal(r.embedded, 1)
})
