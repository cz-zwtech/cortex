import assert from 'node:assert/strict'
import { rankCandidates, type ScoredCandidate } from '../../server/graph/recall.js'

const mk = (id: string, scope: string): ScoredCandidate => ({
  row: {
    id, name: id, kind: 'memory', description: '', content: 'x'.repeat(80),
    scope, updatedAt: 1_700_000_000_000, syncedAt: 1_700_000_000_000, pinned: false,
  },
  state: { hops: 0, cosine: 0.5, viaEdge: null },
  usage: 0,
  decay: 0,
})

// cwd is under project:A; B is a DIFFERENT project. Both equal cosine.
const ctx = { query: 'q', scopes: ['project:A'] } as any
const hits = rankCandidates([mk('B', 'project:B'), mk('A', 'project:A')], ctx)

// 1. FOLDER-TRANSCENDENCE: the out-of-scope memory is NOT dropped.
assert.equal(hits.length, 2, 'both candidates must survive — scope is a prior, not a filter')
assert.ok(hits.find((h) => h.id === 'B'), 'different-project memory must still return')
// 2. PRIOR WORKS: same-project memory out-ranks the equally-relevant other.
assert.equal(hits[0].id, 'A', 'in-scope memory should edge out the equal-cosine out-of-scope one')

// 3. THREAD HUBS are not memories — never rendered as hits.
const threadCand: ScoredCandidate = { ...mk('T', 'project:A'), row: { ...mk('T', 'project:A').row, kind: 'thread' } }
const withThread = rankCandidates([mk('A', 'project:A'), threadCand], ctx)
assert.ok(!withThread.find((h) => h.kind === 'thread'), 'thread hub must be dropped from hits')

console.log('folder-transcendence-guard: OK')
process.exit(0)
