#!/usr/bin/env tsx
/**
 * #121 — supersession in recall ranking (end to end). A memory that is the
 * SUPERSEDED (old) endpoint of a CONTRADICTS (new->old) or EVOLVED_INTO (old->new)
 * edge is DE-PRIORITIZED in recall so the current memory outranks it — but it is
 * NEVER filtered (mark-not-delete): a superseded sole match still returns. This is
 * the fix for the stale-memory-out-surfaces-the-current-one incident.
 *
 * Embeddings OFF -> candidates via ctx.files (MENTIONS_FILE). Temp-DB pattern
 * mirrors decay-ranking.test.ts. Edge directions match what sync materializes from
 * `contradicts:` / `evolved_from:` frontmatter (ensureTypedEdge(rel, from, to)).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-supersede-rank-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.ts')
const { fileEntryId } = await import('../../server/graph/sync.ts')
const { graphRecall, recallForFile } = await import('../../server/graph/recall.ts')

getDb()
const DAY = 86_400_000
const now = Date.now()

// Equal updatedAt across the pair so recency/decay/edge/usage are equal — the ONLY
// differentiator is the supersede penalty.
const insMem = (id: string) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'memory', '', 'body content long enough to render in recall hits here', '', 'user', ?, 0, 'human', '', '', '', '', 0, 0, '', '')`,
    id, id, now - 200 * DAY,
  )
const mentions = (memId: string, file: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, 'MENTIONS_FILE')`, memId, fileEntryId(file))
const edge = (src: string, dst: string, rel: string) =>
  run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`, src, dst, rel)
// recallForFile JOINs the file STUB entry (f.name = stored path) — graphRecall does not
// need it, but the per-edit path does, so case 4 seeds it.
const insFile = (filePath: string) =>
  run(
    `INSERT OR IGNORE INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'file', '', '', '', '', 0, 0, '', '', '', '', '', 0, 0, '', '')`,
    fileEntryId(filePath), filePath,
  )

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. CONTRADICTS (new -> old): the OLD (dst) is superseded, sinks below new ────
{
  const F = '/repo/contradicts.ts'
  insMem('c:new'); mentions('c:new', F)
  insMem('c:old'); mentions('c:old', F)
  edge('c:new', 'c:old', 'CONTRADICTS') // new contradicts old -> old superseded
  const hits = await graphRecall({ query: 'anything', files: [F], limit: 10 })
  assert.equal(hits.length, 2, 'both return — supersession RANKS, never filters')
  assert.deepEqual(hits.map((h) => h.id), ['c:new', 'c:old'], 'current memory outranks the contradicted one')
  assert.equal(hits.find((h) => h.id === 'c:old')!.signals.superseded, true, 'old (dst of CONTRADICTS) marked superseded')
  assert.equal(hits.find((h) => h.id === 'c:new')!.signals.superseded, false, 'new not superseded')
  ok('CONTRADICTS: superseded (old=dst) de-prioritized below current')
}

// ── 2. EVOLVED_INTO (old -> new): the OLD (src) is superseded, sinks below new ───
{
  const F = '/repo/evolved.ts'
  insMem('e:new'); mentions('e:new', F)
  insMem('e:old'); mentions('e:old', F)
  edge('e:old', 'e:new', 'EVOLVED_INTO') // old evolved into new -> old superseded
  const hits = await graphRecall({ query: 'anything', files: [F], limit: 10 })
  assert.deepEqual(hits.map((h) => h.id), ['e:new', 'e:old'], 'the evolved-into (current) memory outranks the old one')
  assert.equal(hits.find((h) => h.id === 'e:old')!.signals.superseded, true, 'old (src of EVOLVED_INTO) marked superseded')
  ok('EVOLVED_INTO: superseded (old=src) de-prioritized below current')
}

// ── 3. a superseded SOLE match still returns (mark-not-delete) ──────────────────
{
  const G = '/repo/lonely-superseded.ts'
  insMem('s:old'); mentions('s:old', G)
  insMem('s:new') // exists but does not mention G, so only s:old is a candidate
  edge('s:new', 's:old', 'CONTRADICTS')
  const hits = await graphRecall({ query: 'anything', files: [G], limit: 5 })
  assert.equal(hits.length, 1, 'the only match returns despite being superseded (never filtered)')
  assert.equal(hits[0]!.id, 's:old')
  assert.equal(hits[0]!.signals.superseded, true, 'it IS superseded — just not removed')
  ok('a superseded sole match still returns (MARK never delete)')
}

// ── 4. recallForFile (per-edit path) also de-prioritizes the superseded memory ──
{
  const R = 'src/rf-supersede.ts'
  insFile(R)
  insMem('rf:new'); mentions('rf:new', R)
  insMem('rf:old'); mentions('rf:old', R)
  edge('rf:new', 'rf:old', 'CONTRADICTS')
  const hits = await recallForFile(R, { limit: 10 })
  assert.deepEqual(hits.map((h) => h.id), ['rf:new', 'rf:old'], 'recallForFile: current memory outranks the superseded one')
  assert.equal(hits.find((h) => h.id === 'rf:old')!.signals.superseded, true, 'recallForFile marks the old endpoint superseded')
  assert.equal(hits.find((h) => h.id === 'rf:new')!.signals.superseded, false, 'recallForFile: current not superseded')
  ok('recallForFile: superseded memory de-prioritized on the per-edit path')
}

console.log(`\nOK supersede-recall.test.ts — ${passed} cases passed`)
process.exit(0)
