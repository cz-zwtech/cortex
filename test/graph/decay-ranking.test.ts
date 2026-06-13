#!/usr/bin/env tsx
/**
 * s4 — decay in recall ranking (slice C). A stale memory is DE-PRIORITIZED in
 * recall (its composite score is docked by a decay penalty) but NEVER filtered
 * out — a max-decay memory still RETURNS when it's the only match (MARK never
 * delete, applied to ranking). Exempt/acted-on memories get ZERO penalty
 * (Fable's lens). The decayScore call is bounded to the candidate SET, not the
 * corpus (PM's hot-path flag).
 *
 * Embeddings OFF → no vector seeds; candidates come via ctx.files
 * (expandFromFiles MENTIONS_FILE). Temp-DB pattern mirrors surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-decay-rank-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')
const { fileEntryId } = await import('../../server/graph/sync.ts')
const { graphRecall } = await import('../../server/graph/recall.ts')

getDb()

const DAY = 86_400_000
const now = Date.now()

const insMem = (id: string, o: { updatedAt?: number; pinned?: boolean } = {}) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'memory', '', 'body content long enough to render in recall hits here', '', 'user', ?, 0, 'human', '', '', '', '', ?, 0, '', '')`,
    id, id, o.updatedAt ?? now - 200 * DAY, o.pinned ? 1 : 0,
  )
const mentions = (memId: string, file: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, 'MENTIONS_FILE')`, memId, fileEntryId(file))

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const F = '/repo/decayrank.ts'
// All three mention F + share updatedAt (so recency/edge/usage are equal); they
// differ ONLY in decay: A warm (surfaced yesterday), B cold (never surfaced), C
// pinned (would-be-cold but EXEMPT).
insMem('rk:A'); mentions('rk:A', F); recordSurfacings('z', ['rk:A'], now - 1 * DAY)
insMem('rk:B'); mentions('rk:B', F)
insMem('rk:C', { pinned: true }); mentions('rk:C', F)

// ── 1. decay de-prioritizes the stale one; pinned-exempt floats up; ALL return ─
{
  const hits = await graphRecall({ query: 'anything', files: [F], limit: 10 })
  const ids = hits.map((h) => h.id)
  assert.equal(hits.length, 3, 'all three returned — decay RANKS, never filters out')
  assert.deepEqual(ids, ['rk:C', 'rk:A', 'rk:B'], 'pinned-exempt > warm > cold-decayed (decay de-prioritizes B)')
  const B = hits.find((h) => h.id === 'rk:B')!
  const C = hits.find((h) => h.id === 'rk:C')!
  const A = hits.find((h) => h.id === 'rk:A')!
  assert.ok(B.signals.decay > 0.4, `cold memory carries a real decay penalty (${B.signals.decay.toFixed(3)})`)
  assert.equal(C.signals.decay, 0, 'pinned/exempt memory gets ZERO decay penalty')
  assert.ok(A.signals.decay < B.signals.decay, 'warm memory decays less than cold')
  ok('graphRecall: decay de-prioritizes (rank, not filter); exempt = zero penalty')
}

// ── 2. a max-decay memory that is the ONLY match still RETURNS ─────────────────
{
  const G = '/repo/lonely.ts'
  insMem('rk:lonely'); mentions('rk:lonely', G) // never surfaced, old → max decay
  const hits = await graphRecall({ query: 'anything', files: [G], limit: 5 })
  assert.equal(hits.length, 1, 'the only match returns despite max decay (never filtered)')
  assert.equal(hits[0]!.id, 'rk:lonely')
  assert.ok(hits[0]!.signals.decay > 0.4, 'it IS decayed — just not removed')
  ok('graphRecall: a max-decay sole match still returns (MARK never delete in ranking)')
}

console.log(`\nOK decay-ranking.test.ts — ${passed} cases passed`)
