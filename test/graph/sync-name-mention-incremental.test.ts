#!/usr/bin/env tsx
/**
 * commit-1 (sync-saturation) — incremental inferNameMentionEdges.
 *
 * The regression (Fable's profile): inferNameMentionEdges was an O(N²) full
 * scan every sync — ~6299 entries × 6287 name-regexes ≈ 30M+ regex tests =
 * 14.6s of a 28s pass, rebuilding the same edges each run. The fix makes it
 * INCREMENTAL: given the ids changed this sync, only (re)evaluate pairs where
 * the SOURCE changed (changed × all-targets) or the TARGET changed (all ×
 * changed-target-names). A full scan runs ONLY for an empty-graph rebuild
 * (changedIds omitted/null).
 *
 * The discriminator: an incremental call must NOT re-create an edge between two
 * UNCHANGED entries — the old full scan does, which is the wasted work.
 *
 * Temp-DB pattern mirrors test/graph/recall-for-file.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-namemention-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.js')
const { inferNameMentionEdges } = await import('../../server/graph/sync.js')

getDb()

const NOW = Date.now()
const entry = (id: string, name: string, content: string) =>
  run(
    `INSERT INTO entries (id, name, kind, content, source, scope, updatedAt, syncedAt)
     VALUES (?, ?, 'memory', ?, 'src', 'memory:auto', ?, ?)`,
    id,
    name,
    content,
    NOW,
    NOW,
  )

const mentionEdge = (src: string, dst: string) =>
  get<{ x: number }>(
    `SELECT 1 AS x FROM edges WHERE src = ? AND dst = ? AND rel = 'LINKS_TO' AND label = 'mentions'`,
    src,
    dst,
  )
const clearMentionEdges = () => run(`DELETE FROM edges WHERE rel = 'LINKS_TO' AND label = 'mentions'`)

// alpha mentions beta + gamma; beta mentions alpha; gamma (the changed one) mentions alpha.
entry('m-a', 'alpha-topic', 'references beta-topic and gamma-topic')
entry('m-b', 'beta-topic', 'references alpha-topic')
entry('m-c', 'gamma-topic', 'references alpha-topic')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. incremental: only pairs touching a changed id are (re)evaluated
{
  clearMentionEdges()
  inferNameMentionEdges(null, ['m-c']) // only m-c changed this sync
  assert.ok(mentionEdge('m-c', 'm-a'), 'changed source m-c -> m-a (its content mentions alpha-topic)')
  assert.ok(mentionEdge('m-a', 'm-c'), 'm-a -> changed target m-c (m-a mentions gamma-topic) [all x changed-target]')
  assert.ok(!mentionEdge('m-a', 'm-b'), 'unchanged pair m-a -> m-b NOT re-created (incremental skip)')
  assert.ok(!mentionEdge('m-b', 'm-a'), 'unchanged pair m-b -> m-a NOT re-created (incremental skip)')
  ok('incremental scans only pairs touching a changed id')
}

// ── 2. empty changedIds → no work (nothing changed this sync)
{
  clearMentionEdges()
  inferNameMentionEdges(null, [])
  assert.ok(!mentionEdge('m-c', 'm-a'), 'no changed ids → no edges created')
  ok('empty changedIds is a no-op')
}

// ── 3. full scan (no changedIds — empty-graph rebuild path) connects everything
{
  clearMentionEdges()
  inferNameMentionEdges(null) // full rebuild
  assert.ok(mentionEdge('m-a', 'm-b'), 'full: m-a -> m-b')
  assert.ok(mentionEdge('m-b', 'm-a'), 'full: m-b -> m-a')
  assert.ok(mentionEdge('m-c', 'm-a'), 'full: m-c -> m-a')
  assert.ok(mentionEdge('m-a', 'm-c'), 'full: m-a -> m-c')
  ok('full scan (no changedIds) connects all matching pairs')
}

console.log(`\nOK sync-name-mention-incremental.test.ts — ${passed} assertions passed`)
