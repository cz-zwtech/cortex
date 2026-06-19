/**
 * #121 — supersession in recall ranking (pure rankCandidates unit).
 *
 * A memory marked as the SUPERSEDED (old) endpoint of a CONTRADICTS/EVOLVED_INTO
 * relation is docked a penalty so the current memory ranks above it — but it is a
 * de-prioritization, NEVER a filter (mark-not-delete): a superseded sole match
 * still returns. This is the unit-level proof; supersede-recall.test.ts proves the
 * edge-query end to end.
 */
import assert from 'node:assert/strict'
import { rankCandidates, type ScoredCandidate } from '../../server/graph/recall.js'

const mk = (id: string, superseded: boolean, cosine = 0.6): ScoredCandidate => ({
  row: {
    id, name: id, kind: 'memory', description: '', content: 'x'.repeat(80),
    scope: 'user', updatedAt: 1_700_000_000_000, syncedAt: 1_700_000_000_000, pinned: false,
  },
  state: { hops: 0, cosine, viaEdge: null },
  usage: 0,
  decay: 0,
  superseded,
})

const ctx = { query: 'q' } as any

// 1. Equal cosine: the superseded (stale) memory ranks BELOW the current one, both return.
{
  const hits = rankCandidates([mk('old', true), mk('new', false)], ctx)
  assert.equal(hits.length, 2, 'superseded memory is deprioritized, NEVER filtered — both return')
  assert.equal(hits[0].id, 'new', 'the non-superseded memory ranks above the equal-cosine superseded one')
  assert.equal(hits[1].id, 'old', 'the superseded memory sinks below the current one')
}

// 2. The penalty is real + observable on the signal.
{
  const hits = rankCandidates([mk('old', true), mk('new', false)], ctx)
  const newer = hits.find((h) => h.id === 'new')!
  const older = hits.find((h) => h.id === 'old')!
  assert.equal(older.signals.superseded, true, 'superseded flag surfaced for debuggability')
  assert.equal(newer.signals.superseded, false, 'non-superseded flag is false')
  assert.ok(
    newer.signals.composite - older.signals.composite >= 0.3,
    'superseded memory is docked a meaningful penalty (>= decay-scale)',
  )
}

// 3. A superseded SOLE match still returns (mark-not-delete).
{
  const sole = rankCandidates([mk('only', true)], ctx)
  assert.equal(sole.length, 1, 'a superseded memory that is the only match still returns')
  assert.equal(sole[0].id, 'only', 'sole superseded match is present')
}

// 4. The supersede penalty overrides a small cosine edge held by the stale memory.
{
  const hits = rankCandidates([mk('stale', true, 0.7), mk('fresh', false, 0.6)], ctx)
  assert.equal(hits[0].id, 'fresh', 'a stale memory does not out-surface the current one on a small cosine lead')
}

console.log('supersede-ranking unit: OK')
process.exit(0)
