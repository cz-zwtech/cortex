#!/usr/bin/env tsx
/**
 * Phase 2 read-path gate for recall.ts on the SQLite backend.
 *
 * graphRecall's vector-seed branch is sidecar-driven and storage-agnostic, so
 * it's out of scope for the Kuzu→SQLite port (and unavailable in a temp env).
 * We pin CKN_EMBEDDINGS=off so embedText() returns null and graphRecall skips
 * the seed branch, then drive the DECISIVE ported surface: the file/tool edge
 * expansion (single `edges`-table lookups), candidate hydration (SELECT … FROM
 * entries WHERE id IN (…)), and the unchanged JS-side composite scoring +
 * filtering. This exercises the exact SQL we ported.
 *
 * Plain tsx + node:assert/strict, mirroring test/graph/sqlite-db.test.ts. We set
 * CKN_GRAPH_DB_PATH BEFORE importing recall.ts so getDb()'s singleton opens our
 * temp file.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-recall-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
// Keep usage-scores sidecar out of the user's real config during the test.
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { graphRecall } = await import('../../server/graph/recall.js')

// Force the singleton open at our temp path + apply schema.
getDb()

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

// fileEntryId / toolEntryId mirror recall.ts's stub-id derivation.
const fileEntryId = (p: string): string => `file:${p.replace(/\//g, '_').replace(/\\/g, '_')}`
const toolEntryId = (t: string): string => `tool:${t.toLowerCase()}`

// ── seed entries ──────────────────────────────────────────────────────────────
const entry = (
  id: string,
  kind: string,
  scope: string,
  updatedAt: number,
  content = 'x'.repeat(80),
  pinned = 0,
) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `name-${id}`,
    kind,
    `desc-${id}`,
    content,
    'src',
    scope,
    updatedAt,
    updatedAt,
    pinned,
  )

// A memory mentioning a file — found via expandFromFiles.
entry('m-file', 'memory', 'memory:auto', NOW - 2 * DAY)
// A memory mentioning a tool — found via expandFromTool.
entry('m-tool', 'memory', 'memory:auto', NOW - 5 * DAY)
// A pattern also mentioning the tool — distinct source bucket + pinned boost.
entry('p-tool', 'pattern', 'pattern:auto', NOW - 40 * DAY, 'y'.repeat(120), 1)
// A shared-scope memory mentioning the file — for scope-filter test.
entry('s-file', 'memory', 'shared:team', NOW - 1 * DAY)
// An old memory mentioning the file — for since/until window test.
entry('m-file-old', 'memory', 'memory:auto', NOW - 100 * DAY)
// File + tool stub hubs (should be dropped from results even if pulled in).
entry('file:hub', 'file', 'file', NOW, '')
entry('tool:hub', 'tool', 'tool', NOW, '')

// ── seed edges (unified edges table, rel discriminator) ─────────────────────────
const edge = (src: string, dst: string, rel: string) =>
  run(`INSERT INTO edges (src, dst, rel) VALUES (?, ?, ?)`, src, dst, rel)

const FILE = 'src/app.ts'
const TOOL = 'Bash'
edge('m-file', fileEntryId(FILE), 'MENTIONS_FILE')
edge('s-file', fileEntryId(FILE), 'MENTIONS_FILE')
edge('m-file-old', fileEntryId(FILE), 'MENTIONS_FILE')
edge('m-tool', toolEntryId(TOOL), 'MENTIONS_TOOL')
edge('p-tool', toolEntryId(TOOL), 'MENTIONS_TOOL')

// ── 1. file + tool expansion finds the right entries, with provenance ──────────
{
  const hits = await graphRecall({ query: 'anything', files: [FILE], tool: TOOL, limit: 20 })
  const ids = new Set(hits.map((h) => h.id))
  assert.ok(ids.has('m-file'), 'file-mentioning memory surfaced')
  assert.ok(ids.has('m-tool'), 'tool-mentioning memory surfaced')
  assert.ok(ids.has('p-tool'), 'tool-mentioning pattern surfaced')
  assert.ok(ids.has('s-file'), 'shared file-mentioning memory surfaced (no scope filter)')

  // stub hubs must never appear in results
  assert.ok(!ids.has('file:hub'), 'file stub dropped')
  assert.ok(!ids.has('tool:hub'), 'tool stub dropped')

  // provenance: viaEdge set correctly per the edge that brought each in.
  const byId = new Map(hits.map((h) => [h.id, h]))
  assert.equal(byId.get('m-file')!.signals.viaEdge, 'MENTIONS_FILE', 'm-file viaEdge')
  assert.equal(byId.get('m-tool')!.signals.viaEdge, 'MENTIONS_TOOL', 'm-tool viaEdge')

  // shape contract: every hit carries the frozen RecallHit fields.
  for (const h of hits) {
    for (const k of ['id', 'name', 'kind', 'description', 'content', 'scope', 'source', 'syncedAt', 'signals']) {
      assert.ok(k in h, `hit has ${k}`)
    }
    const s = h.signals
    for (const k of ['cosine', 'hops', 'recency', 'viaEdge', 'usage', 'composite']) {
      assert.ok(k in s, `signals has ${k}`)
    }
    assert.equal(typeof h.syncedAt, 'number', 'syncedAt coerced to number')
    assert.equal(s.hops, 1, 'edge-expanded hits are 1 hop')
    assert.equal(s.cosine, null, 'no vector seed → cosine null')
  }

  // source bucketing: pattern→'pattern', shared:*→'shared', memory→'memory'.
  assert.equal(byId.get('p-tool')!.source, 'pattern', 'pattern source bucket')
  assert.equal(byId.get('s-file')!.source, 'shared', 'shared source bucket')
  assert.equal(byId.get('m-file')!.source, 'memory', 'memory source bucket')
}

// ── 2. scope filter keeps only matching scopes ─────────────────────────────────
{
  const hits = await graphRecall({ query: 'q', files: [FILE], tool: TOOL, scopes: ['shared:'], limit: 20 })
  const ids = new Set(hits.map((h) => h.id))
  assert.ok(ids.has('s-file'), 'shared kept under shared: prefix filter')
  assert.ok(!ids.has('m-file'), 'memory:auto excluded by shared: scope filter')
  assert.ok(!ids.has('m-tool'), 'tool memory excluded by shared: scope filter')
}

// ── 3. excludeIds drops the named id pre-hydration ─────────────────────────────
{
  const hits = await graphRecall({ query: 'q', files: [FILE], tool: TOOL, excludeIds: ['m-file'], limit: 20 })
  assert.ok(!hits.some((h) => h.id === 'm-file'), 'excluded id absent')
  assert.ok(hits.some((h) => h.id === 'm-tool'), 'non-excluded id still present')
}

// ── 4. since/until window drops out-of-range entries ───────────────────────────
{
  const hits = await graphRecall({
    query: 'q',
    files: [FILE],
    since: NOW - 10 * DAY,
    until: NOW,
    limit: 20,
  })
  const ids = new Set(hits.map((h) => h.id))
  assert.ok(ids.has('m-file'), 'in-window (2d old) kept')
  assert.ok(!ids.has('m-file-old'), 'out-of-window (100d old) dropped')
}

// ── 5. pinned boost ranks the pinned pattern above an unpinned tie-ish peer ─────
{
  // p-tool is pinned (+0.3) but old; m-tool is unpinned but newer. The flat
  // pin boost should still float p-tool to the top among the tool hits.
  const hits = await graphRecall({ query: 'q', tool: TOOL, limit: 20 })
  const idx = (id: string) => hits.findIndex((h) => h.id === id)
  assert.ok(idx('p-tool') !== -1 && idx('m-tool') !== -1, 'both tool hits present')
  assert.ok(idx('p-tool') < idx('m-tool'), 'pinned pattern outranks unpinned memory')
  assert.ok(hits[idx('p-tool')].signals.composite > hits[idx('m-tool')].signals.composite, 'pin boost reflected in composite')
}

// ── 6. limit caps the result count ─────────────────────────────────────────────
{
  const hits = await graphRecall({ query: 'q', files: [FILE], tool: TOOL, limit: 2 })
  assert.ok(hits.length <= 2, 'limit respected')
  // sorted descending by composite
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].signals.composite >= hits[i].signals.composite, 'sorted by composite desc')
  }
}

// ── 7. empty context (no seeds, no files/tool) yields no hits ───────────────────
{
  const hits = await graphRecall({ query: 'nothing matches', limit: 5 })
  assert.deepEqual(hits, [], 'no expansion sources → empty result')
}

console.log('OK recall.test.ts — all assertions passed')
