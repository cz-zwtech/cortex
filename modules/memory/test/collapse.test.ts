import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collapse,
  collapseThenTake,
  pairKey,
  type Candidate,
} from '../server/collapse.js'
import { LEXICAL_ESTIMATOR } from '../server/reconcile.js'
import type { Memory } from '../server/types.js'

const mem = (id: string, content: string, over: Partial<Memory> = {}): Memory => ({
  id,
  source: `/memory/${id}.md`,
  name: id,
  description: '',
  content,
  shape: 'observation',
  authorship: 'authored',
  scope: 'user',
  pinned: false,
  protected: false,
  contentHash: id,
  machine: 'node-a',
  authoredAt: 1_000_000,
  ingestedAt: 1_000_000,
  outcome: '',
  outcomeText: '',
  ...over,
})

const cand = (m: Memory, score: number): Candidate => ({ memory: m, score })

// Three phrasings of one fact — the re-save-forever population.
const V1 = 'The build fails when NODE_ENV is unset, so export it before running the release task.'
const V2 = 'The build fails when NODE_ENV is not set, so export it before running the release task.'
const V3 = 'Build fails when NODE_ENV is unset; export it before you run the release task.'
const OTHER = 'Metrics dashboards are provisioned from the repository and never edited in the UI.'
const ALSO = 'The staging database listens on port 5433 and is reseeded from an anonymised dump.'

test('near-duplicates collapse to ONE representative', () => {
  const out = collapse([cand(mem('a', V1), 0.9), cand(mem('b', V2), 0.89)], { threshold: 0.6 })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.memory.id, 'a')
})

test('the collapse is NEVER silent — siblings are reported', () => {
  // A collapse the consumer cannot detect is indistinguishable from a merge:
  // the exact failure this moved out of storage, arriving through another door.
  const out = collapse([cand(mem('a', V1), 0.9), cand(mem('b', V2), 0.89)], { threshold: 0.6 })
  assert.equal(out[0]!.siblings.length, 1)
  assert.equal(out[0]!.siblings[0]!.id, 'b')
})

test('genuinely different memories are NOT collapsed', () => {
  const out = collapse(
    [cand(mem('a', V1), 0.9), cand(mem('o', OTHER), 0.8), cand(mem('s', ALSO), 0.7)],
    { threshold: 0.6 },
  )
  assert.equal(out.length, 3)
})

// ── star clustering ──────────────────────────────────────────────────────────

test('STAR clustering — a chain does not swallow non-neighbours', () => {
  // A~B and B~C, but A~C below threshold. Under connected components C would
  // hide behind A's representative despite not being A's near-duplicate, and
  // re-save accumulation makes those chains grow.
  const sim = (x: string, y: string) => {
    const k = [x, y].sort().join('|')
    if (k === ['A', 'B'].sort().join('|')) return 0.92
    if (k === ['B', 'C'].sort().join('|')) return 0.92
    if (k === ['A', 'C'].sort().join('|')) return 0.75
    return 1
  }

  const out = collapse(
    [cand(mem('a', 'A'), 0.9), cand(mem('b', 'B'), 0.8), cand(mem('c', 'C'), 0.7)],
    { threshold: 0.8, estimator: { ...LEXICAL_ESTIMATOR, name: 'stub', compare: sim } },
  )

  // A takes B (0.92). C is NOT within threshold of A (0.75), so it survives.
  assert.deepEqual(out.map((h) => h.memory.id), ['a', 'c'])
})

// ── contradiction exemption ──────────────────────────────────────────────────

test('a declared CONTRADICTS pair is exempt from collapse', () => {
  const a = mem('a', 'Prefer pnpm in this repository for every install.')
  const b = mem('b', 'Prefer pnpm in this repository for every install.')
  const out = collapse([cand(a, 0.9), cand(b, 0.89)], {
    threshold: 0.5,
    contradicts: new Set([pairKey('a', 'b')]),
  })
  assert.equal(out.length, 2, 'hiding one side would be a merge in effect')
})

test('an ordinary PARAPHRASE is not read as a contradiction', () => {
  // "unset" vs "not set" is the most common re-save pair there is. An earlier
  // negation list included bare "not" and exempted exactly the population this
  // feature exists to collapse — the false positive that disables the feature
  // rather than merely degrading it.
  const out = collapse([cand(mem('a', V1), 0.9), cand(mem('b', V2), 0.89)], { threshold: 0.6 })
  assert.equal(out.length, 1, 'paraphrase collapses')
})

test('LEXICAL NEGATION is enough — the pnpm case from the ladder argument', () => {
  // "prefer pnpm" and "never use pnpm" are near-identical in embedding space and
  // opposite in meaning. This is the case that proves clusters WILL contain
  // contradictions.
  const out = collapse(
    [
      cand(mem('a', 'Prefer pnpm in this repository for installs and scripts.'), 0.9),
      cand(mem('b', 'Never use pnpm in this repository for installs and scripts.'), 0.89),
    ],
    { threshold: 0.5 },
  )
  assert.equal(out.length, 2)
})

test('differing OUTCOME exempts a pair', () => {
  const out = collapse(
    [
      cand(mem('a', V1, { outcome: 'worked' }), 0.9),
      cand(mem('b', V2, { outcome: 'failed' }), 0.89),
    ],
    { threshold: 0.5 },
  )
  assert.equal(out.length, 2, 'one approach worked and another did not — both matter')
})

// ── recency vs pinned ────────────────────────────────────────────────────────

test('a stale PINNED representative flags that a newer variant exists', () => {
  // Representative order is pinned-first, so without this a pinned port-8080
  // silently beats the port-8081 correction sitting behind it.
  const old = mem(
    'pinned-old',
    'The metrics dashboard listens on port 8080 in every environment, including the lab container and the staging host.',
    { pinned: true, authoredAt: 1_000_000 },
  )
  const fresh = mem(
    'fresh',
    'The metrics dashboard listens on port 8080 in every environment, including the lab container and the staging server.',
    { authoredAt: 1_000_000 + 30 * 24 * 60 * 60 * 1000 },
  )

  const out = collapse([cand(old, 0.9), cand(fresh, 0.89)], { threshold: 0.5 })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.newerVariantExists, true, 'the consumer is told to look behind it')
})

// ── the ordering that is the whole point ─────────────────────────────────────

test('COLLAPSE RUNS BEFORE TOP-K IS CUT', () => {
  // Cut first and collapse second is the degenerate implementation: three
  // variants fill the top three slots, the collapse leaves one result, and the
  // two genuinely different memories are already gone. From outside it looks
  // identical to the correct version, which is why this is asserted.
  const ranked = [
    cand(mem('v1', V1), 0.95),
    cand(mem('v2', V2), 0.94),
    cand(mem('v3', V3), 0.93),
    cand(mem('other', OTHER), 0.80),
    cand(mem('also', ALSO), 0.75),
  ]

  const correct = collapseThenTake(ranked, 3, { threshold: 0.55 })
  assert.deepEqual(
    correct.map((h) => h.memory.id),
    ['v1', 'other', 'also'],
    'one slot for the fact, two for the distinct memories',
  )

  // The wrong order, spelled out so the difference is visible rather than argued.
  const degenerate = collapse(ranked.slice(0, 3), { threshold: 0.55 })
  assert.deepEqual(
    degenerate.map((h) => h.memory.id),
    ['v1'],
    'cut-then-collapse yields ONE result and discarded both distinct memories',
  )
})

test('cannot-judge is not "same" — short texts are never collapsed together', () => {
  // The estimator returns null below its token floor, and null must not be read
  // as similar. Two three-word memories are not evidence of anything.
  const out = collapse([cand(mem('a', 'Port is 8080.'), 0.9), cand(mem('b', 'Port is 8081.'), 0.8)])
  assert.equal(out.length, 2)
})
