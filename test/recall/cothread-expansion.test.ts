#!/usr/bin/env tsx
/**
 * Piece 2 (now-slice): co-thread recall expansion.
 *  A. The GROUPS edge bonus must beat the flat hop penalty so a cosine-less
 *     co-thread sibling clears the bar — asserted THROUGH the real composite()
 *     (no hand-copied penalty constant to drift).
 *  B. The bounded 2-hop traversal (seed member -> thread hub -> sibling members)
 *     surfaces a sibling end-to-end via graphRecall, and the thread hub itself
 *     never appears as a hit.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { ScoredCandidate } from '../../server/graph/recall.js'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-cothread-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { graphRecall, rankCandidates } = await import('../../server/graph/recall.js')
getDb()

// ── A. bonus beats hop penalty (through the real composite) ────────────────────
const sib = (viaEdge: string | null): ScoredCandidate => ({
  row: {
    id: viaEdge ?? 'none', name: 'sib', kind: 'memory', description: '',
    content: 'x'.repeat(80), scope: 'project:B', updatedAt: 1_700_000_000_000, syncedAt: 1, pinned: false,
  },
  state: { hops: 2, cosine: null, viaEdge }, usage: 0, decay: 0, superseded: false,
})
const [g] = rankCandidates([sib('GROUPS')], { query: 'q' } as any)
const [n] = rankCandidates([sib(null)], { query: 'q' } as any)
assert.ok(g, 'cosine-less GROUPS sibling is a valid hit')
assert.ok(g.signals.composite > 0, 'GROUPS sibling composite must be positive (bonus beats hop penalty)')
assert.ok(g.signals.composite > n.signals.composite, 'GROUPS bonus raises composite over a bare 2-hop candidate')

// ── B. 2-hop traversal end-to-end ──────────────────────────────────────────────
const NOW = Date.now()
const entry = (id: string, kind: string) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    id, `name-${id}`, kind, '', 'y'.repeat(80), 'src', 'project:A', NOW, NOW,
  )
const edge = (src: string, dst: string, rel: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`, src, dst, rel)

entry('m1', 'memory')
entry('m2', 'memory')
entry('thr', 'thread')
edge('m1', 'file:F', 'MENTIONS_FILE') // m1 seeds in via file expansion
edge('thr', 'm1', 'GROUPS')           // thread groups both members (src=thread)
edge('thr', 'm2', 'GROUPS')

const hits = await graphRecall({ query: 'q', files: ['F'], limit: 20 })
const byId = new Map(hits.map((h) => [h.id, h]))
assert.ok(byId.has('m1'), 'file-seeded member present')
assert.ok(byId.has('m2'), 'co-thread sibling surfaced via the 2-hop GROUPS traversal')
assert.equal(byId.get('m2')!.signals.viaEdge, 'GROUPS', 'sibling viaEdge = GROUPS')
assert.equal(byId.get('m2')!.signals.hops, 2, 'sibling entered at 2 hops')
assert.ok(!byId.has('thr'), 'the thread hub is never a recall hit')

console.log('cothread-expansion: OK')
process.exit(0)
