import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { MemoryStore, hashContent } from '../server/store.js'
import { recall } from '../server/recall.js'
import { lexicalSeed, vectorSeed } from '../server/seed.js'
import { EmbeddingEstimator } from '../server/embedding.js'
import type { Memory, Shape } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const NOW = 1_800_000_000_000

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const add = (
  s: MemoryStore,
  id: string,
  content: string,
  over: Partial<Memory> = {},
): Memory => {
  s.upsert({
    id,
    source: `/mem/${id}.md`,
    name: id,
    description: '',
    content,
    shape: 'reference' as Shape,
    authorship: 'authored',
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: NOW - 1000,
    ingestedAt: NOW - 1000,
    outcome: '',
    outcomeText: '',
    contentHash: hashContent(id, '', content),
    ...over,
  } as never)
  return s.get(id) as Memory
}

const DEPLOY =
  'deploy by running the release script on the build host then wait for the health check ' +
  'to report green before switching traffic over to the new pods'

const run = (s: MemoryStore, q: string, over: Record<string, unknown> = {}) =>
  recall(q, { store: s, seeds: [lexicalSeed(s)], asOf: NOW, k: 5, ...over })

// ── the four ways a result can be short, and they must not look alike ────────

test('AN EMPTY CORPUS SAYS SO — it is not "no matches"', () => {
  const s = store()
  const out = run(s, 'deployment')
  assert.equal(out.corpusEmpty, true)
  assert.deepEqual(out.hits, [])
})

test('a POPULATED corpus with no match is not corpusEmpty', () => {
  const s = store()
  add(s, 'cats', 'cats sleep through the middle of the day in warm places near windows')
  const out = run(s, 'kubernetes')
  assert.equal(out.corpusEmpty, false)
})

test('A DEGRADED SEED IS NAMED, so lexical-because-off differs from broken', async () => {
  const s = store()
  add(s, 'a', DEPLOY)
  const dead = new EmbeddingEstimator({
    name: 'dead',
    dims: 384,
    embed: async () => {
      throw new Error('model failed to load')
    },
  })
  await dead.warm(['probe'])

  const out = recall('deploy', {
    store: s,
    seeds: [vectorSeed(s, dead), lexicalSeed(s)],
    asOf: NOW,
    k: 5,
  })
  assert.equal(out.seed.via, 'lexical')
  assert.equal(out.seed.degradedFrom?.kind, 'vector')
  assert.match(out.seed.degradedFrom!.reason, /model failed to load/)
})

test('THE CUT REPORTS ITS OWN DROPS — a short result is explainable', () => {
  const s = store()
  add(s, 'strong', DEPLOY)
  for (let i = 0; i < 4; i++) {
    add(s, `weak${i}`, `deploy ${i} ${'unrelated filler words about other subjects '.repeat(4)}`)
  }
  const out = run(s, DEPLOY, { k: 5 })
  assert.ok(out.hits.length >= 1)
  assert.equal(typeof out.cut.droppedByFloor, 'number')
  assert.equal(typeof out.cut.droppedByK, 'number')
})

// ── the pipeline ordering ────────────────────────────────────────────────────

test('SIGNALS TRAVEL WITH EVERY HIT — "why did this surface?" is answerable', () => {
  const s = store()
  add(s, 'a', DEPLOY)
  const out = run(s, DEPLOY)
  const hit = out.hits[0]!
  assert.equal(hit.signals.via, 'seed')
  assert.equal(hit.signals.hops, 0)
  assert.equal(typeof hit.score, 'number')
  assert.ok(hit.signals.similarity !== undefined, 'the estimator judged it')
})

test('SCOPE IS A PRIOR, NOT A FILTER — the other project is RANKED, not removed', () => {
  // The guarantee is about RANKING. Asserted with the relevance floor stood down
  // (fraction 0), because the floor cuts on total score and scope feeds that
  // score — so the two compose into something that can look like a filter at the
  // edge. That interaction is real and documented in recall.ts; this test pins
  // the property the prior itself promises.
  const s = store()
  add(s, 'mine', DEPLOY, { scope: 'proj-a' })
  add(
    s,
    'theirs',
    'deploy the release build to staging first and run the health check suite there ' +
      'before any traffic is switched anywhere near production pods',
    { scope: 'proj-b' },
  )
  const out = run(s, DEPLOY, { scope: 'proj-a', k: 10, relevanceFraction: 0 })
  const ids = out.hits.map((h) => h.memory.id)
  assert.ok(ids.includes('theirs'), 'present')
  assert.equal(ids[0], 'mine', 'and merely outranked')
})

test('the scope prior lowers a score, and the CUT is what can act on it', () => {
  // This previously asserted the floor FIRED here. It no longer does, and the
  // change is a fix rather than a regression: with query-coverage relevance both
  // memories genuinely answer the query, so neither is padding. The old
  // expectation was a consequence of Jaccard penalising the memory for being
  // longer than the query — it was measuring the broken metric, not the prior.
  //
  // The documented composition is still real (scope feeds the score, the floor
  // cuts on score) but it now bites only when a memory is genuinely irrelevant,
  // which is the behaviour we wanted. Asserted as the mechanism rather than as a
  // fixture outcome.
  const s = store()
  add(s, 'mine', DEPLOY, { scope: 'proj-a' })
  add(s, 'unrelated', 'cats sleep through the middle of the day in warm window ledges', {
    scope: 'proj-b',
  })

  const out = run(s, DEPLOY, { scope: 'proj-a', k: 10 })
  assert.equal(out.hits[0]!.memory.id, 'mine')
  assert.ok(
    out.cut.droppedByFloor >= 1 || !out.hits.some((h) => h.memory.id === 'unrelated'),
    'the genuinely irrelevant memory does not reach the context',
  )
})

test('a PINNED memory outranks an equal unpinned one', () => {
  const s = store()
  add(s, 'plain', DEPLOY)
  add(s, 'pinned', DEPLOY + ' x', { pinned: true })
  const out = run(s, DEPLOY, { k: 10 })
  assert.equal(out.hits[0]!.memory.id, 'pinned')
})

test('EDGE-REACHED MEMORIES CARRY THEIR RELATION AND HOP COUNT', () => {
  const s = store()
  add(s, 'seedable', DEPLOY)
  add(s, 'neighbour', 'a completely different subject about invoicing and billing cycles')
  s.setDeclaredEdges('seedable', [
    { src: 'seedable', dst: 'neighbour', rel: 'evolved_into' },
  ])
  const out = run(s, DEPLOY, { k: 10 })
  const edge = out.hits.find((h) => h.memory.id === 'neighbour')
  assert.ok(edge, 'reached by traversal')
  assert.equal(edge!.signals.via, 'edge')
  assert.equal(edge!.signals.hops, 1)
  assert.equal(edge!.signals.relation, 'evolved_into')
})

test('asOf IS EXPLICIT — the same query at two instants ranks differently', () => {
  // Never Date.now() internally, so a past ranking is recomputable and a
  // regression can be reproduced.
  //
  // The two memories must NOT be near-duplicates, or collapse folds them and the
  // test measures collapse instead of asOf — which is exactly what an earlier
  // version of this test was doing, passing for the wrong reason.
  const s = store()
  add(s, 'old', DEPLOY, { authoredAt: NOW - 400 * 24 * 3600_000 })
  add(s, 'other', 'deploy notifications go to the release channel after traffic is switched', {
    authoredAt: NOW,
  })

  const now = run(s, DEPLOY, { k: 10 })
  const then = recall(DEPLOY, {
    store: s,
    seeds: [lexicalSeed(s)],
    asOf: NOW - 399 * 24 * 3600_000,
    k: 10,
  })

  const scoreOf = (r: typeof now, id: string) =>
    r.hits.find((h) => h.memory.id === id)?.score ?? null
  assert.notEqual(
    scoreOf(now, 'old'),
    scoreOf(then, 'old'),
    'the same memory scores differently at two instants',
  )
})

test('THE TRAVERSAL REPORTS HOW IT ENDED', () => {
  const s = store()
  add(s, 'a', DEPLOY)
  const out = run(s, DEPLOY)
  assert.equal(typeof out.traversal.depthExplored, 'number')
  assert.equal(typeof out.traversal.stoppedByBound, 'boolean')
  assert.ok(Array.isArray(out.traversal.breadthTruncatedAt))
})

test('COLLAPSE HAPPENS BEFORE THE CUT — variants must not fill the top slots', () => {
  // Cut-first is the degenerate composition: three variants of one fact fill the
  // top three, the collapse leaves one result, and the two genuinely different
  // memories that should have ranked second and third are already discarded.
  const s = store()
  add(s, 'v1', DEPLOY)
  add(s, 'v2', DEPLOY + ' .')
  add(s, 'v3', DEPLOY + ' ..')
  add(s, 'other', 'an entirely separate fact about invoicing cycles and billing runs monthly')
  const out = run(s, DEPLOY, { k: 2 })
  const ids = out.hits.map((h) => h.memory.id)
  assert.ok(ids.length <= 2)
  assert.equal(new Set(ids).size, ids.length)
})

// ── laptop Stage A: candidate generation ─────────────────────────────────────

test('an older exact match beats newer memories that share only one word', () => {
  // "globex admins role" never reached globex-admins-role: the seed took the
  // newest memories mentioning "globex" and stopped before scoring.
  const s = store()
  const old = NOW - 400 * 86_400_000
  add(s, 'globex-admins-role', 'The two engineers who administer Globex own the database and deploys.', { authoredAt: old })
  for (let i = 0; i < 40; i++) add(s, `globex-note-${i}`, `globex status note ${i} about an unrelated deploy`, { authoredAt: NOW - i * 1000 })

  const hits = recall('globex admins role', { store: s, seeds: [lexicalSeed(s)], asOf: NOW }).hits
  assert.equal(hits[0]?.memory.name, 'globex-admins-role')
})

test('a session checkpoint is never a recall candidate, however well it matches', () => {
  const s = store()
  add(s, 'precompact-411f5f18', 'globex admins role globex admins role transcript', { authorship: 'extracted' })
  add(s, 'globex-admins-role', 'Globex admins and their role.')
  const names = recall('globex admins role', { store: s, seeds: [lexicalSeed(s)], asOf: NOW }).hits.map((h) => h.memory.name)
  assert.deepEqual(names, ['globex-admins-role'])
})

test('a rare query term outweighs a common one', () => {
  // Uniform weights let a memory matching only the everyday word tie or beat
  // the one matching the word that says what the question is about.
  const s = store()
  for (let i = 0; i < 30; i++) add(s, `deploy-${i}`, `deploy note ${i} for the nightly job`)
  add(s, 'deploy-checklist', 'Checklist for every release and rollback.', { name: 'deploy-checklist' })
  add(s, 'broker-layout', 'The kafka brokers sit behind the internal load balancer.')
  add(s, 'kafka-other', 'A second kafka mention so the term is rare, not unique.')

  const top = recall('kafka deploy', { store: s, seeds: [lexicalSeed(s)], asOf: NOW }).hits[0]?.memory.name
  assert.ok(top === 'broker-layout' || top === 'kafka-other', `got ${top}`)
})

test('explain accounts for one memory: returned, or where it fell out', () => {
  const s = store()
  add(s, 'pdf-tools-poppler', 'Read PDFs with pdftotext from poppler-utils.')
  for (let i = 0; i < 15; i++) add(s, `tools-note-${i}`, `Notes about build tools and pdf exports, number ${i}.`)
  add(s, 'unrelated', 'Nothing about the query at all.')
  const opts = { store: s, seeds: [lexicalSeed(s)], asOf: NOW, k: 3 }

  const hit = recall('pdf tools poppler', { ...opts, explain: 'pdf-tools-poppler' })
  assert.equal(hit.explain?.returned, true)
  assert.equal(hit.explain?.seedRank, 1, 'every query word in its name: the first lexical candidate')

  const past = recall('pdf tools poppler', { ...opts, explain: 'tools-note-9' })
  assert.equal(past.explain?.returned, false)
  assert.ok(past.explain?.cutBy === 'k' || past.explain?.collapsedInto, 'it is accounted for: past k, or behind a near-duplicate')

  const none = recall('pdf tools poppler', { ...opts, explain: 'unrelated' })
  assert.equal(none.explain?.seedRank, undefined, 'no query word matched it')
  assert.equal(none.explain?.seeded, false)

  assert.equal(recall('pdf', { ...opts, explain: 'no-such-memory' }).explain?.found, false)
})
