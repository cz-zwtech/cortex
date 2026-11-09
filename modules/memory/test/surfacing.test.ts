import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { MemoryStore, hashContent } from '../server/store.js'
import { recordSurfacing } from '../server/surfacing.js'
import { usageBonus, decayPenalty, COLDNESS_HALF_LIFE_MS } from '../server/rank.js'
import { reconcile } from '../server/reconcile.js'
import type { Memory, Shape } from '../server/types.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const NOW = 1_800_000_000_000

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const CONTENT =
  'Deploy by running the release script on the build host, then wait for the health check ' +
  'to report green before switching traffic over to the new pods.'

const add = (s: MemoryStore, id: string, over: Partial<Memory> = {}) => {
  s.upsert({
    id,
    source: `/mem/${id}.md`,
    name: id,
    description: '',
    content: CONTENT,
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
    contentHash: hashContent(id, '', CONTENT),
    ...over,
  } as never)
}

test('surfacing is RECORDED — the write half nothing had', () => {
  const s = store()
  add(s, 'a')
  const n = recordSurfacing(s, ['a'], 'sess-1', NOW)
  assert.equal(n, 1)
  const edges = s.observedEdges('a').filter((e) => e.rel === 'surfaced_in')
  assert.equal(edges.length, 1)
  assert.equal(edges[0]!.dst, 'sess-1')
})

test('IT MAKES THE USAGE WEIGHT NON-INERT — it was always zero before', () => {
  // `usageBonus` reads surfaced_in. With nothing writing them it returned 0 for
  // every memory forever, so the entire usage weight — 0.2, the second largest —
  // contributed nothing to any ranking, ever.
  const s = store()
  add(s, 'a')
  assert.equal(usageBonus(0), 0, 'the state it was permanently stuck in')

  for (const sess of ['s1', 's2', 's3']) recordSurfacing(s, ['a'], sess, NOW)
  const count = s
    .observedEdges('a')
    .filter((e) => e.rel === 'surfaced_in')
    .reduce((n, e) => n + e.count, 0)
  assert.ok(count >= 3)
  assert.ok(usageBonus(count) > 0, 'now it can actually contribute')
})

test('IT MAKES DECAY MEAN COLDNESS RATHER THAN AGE', () => {
  // Without a lastSurfacedAt, coldness measured from authoredAt — so decay was
  // AGE wearing coldness's name, and no memory could ever be warmed by use.
  const old = { pinned: false, protected: false, isThread: false, isStandingDirective: false }
  const authored = NOW - 10 * COLDNESS_HALF_LIFE_MS

  const neverSurfaced = decayPenalty({ ...old, authoredAt: authored }, NOW)
  const surfacedRecently = decayPenalty(
    { ...old, authoredAt: authored, lastSurfacedAt: NOW - 1 },
    NOW,
  )
  assert.ok(surfacedRecently.penalty < neverSurfaced.penalty, 'use warms it')
})

test('RUNG 0 SURFACED-IN CORROBORATION IS NOW REACHABLE IN PRODUCTION', () => {
  // The sharpest of the three. There was already a PASSING test for this rung —
  // it called store.observe() itself to create the precondition, so it proved the
  // rung worked while the system that would have to reach it never could. A test
  // that manufactures a state production cannot produce is green and worthless.
  //
  // This asserts the rung fires from a surfacing record made by the PRODUCTION
  // writer, not by the test.
  const s = store()
  add(s, 'existing')
  recordSurfacing(s, ['existing'], 'sess-1', NOW)

  const d = reconcile(
    {
      declaredId: 'existing',
      slug: 'renamed-entirely',
      scope: 'user',
      content:
        'Nothing whatsoever in common with the other text, written deliberately to share ' +
        'as few tokens as possible with it.',
      contentHash: 'h-new',
      machine: 'node-a',
      sessionId: 'sess-1',
    },
    { store: s },
  )
  assert.equal(d.action, 'update')
  assert.match(d.note, /surfaced to this session/)
})

// ── what must NOT be recorded ────────────────────────────────────────────────

test('SURFACED MEANS SHOWN, NOT RETURNED — no session id, no record', () => {
  const s = store()
  add(s, 'a')
  assert.equal(recordSurfacing(s, ['a'], undefined, NOW), 0)
  assert.equal(s.observedEdges('a').length, 0)
})

test('an empty list records nothing and creates no hub', () => {
  const s = store()
  assert.equal(recordSurfacing(s, [], 'sess-1', NOW), 0)
  assert.equal(s.getHub('sess-1'), null)
})

test('recording is BEST-EFFORT — a bad id must not lose the rest', () => {
  // Surfacing is a usage signal. Failing to record it is a slightly stale
  // ranking; throwing would be a broken session.
  const s = store()
  add(s, 'good')
  const n = recordSurfacing(s, ['no-such-memory', 'good'], 'sess-1', NOW)
  assert.ok(n >= 1, 'the good one still landed')
})

test('repeat surfacing accumulates rather than replacing', () => {
  const s = store()
  add(s, 'a')
  recordSurfacing(s, ['a'], 'sess-1', NOW)
  recordSurfacing(s, ['a'], 'sess-1', NOW + 1000)
  const e = s.observedEdges('a').find((x) => x.rel === 'surfaced_in')!
  assert.ok(e.count >= 2, 'the event log counts events')
  assert.ok(e.lastAt >= NOW + 1000, 'and tracks the most recent')
})
