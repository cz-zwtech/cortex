#!/usr/bin/env tsx
/**
 * s3 — EDITED_IN derivation (Option C: transcript-derived at sync).
 *
 * `parseEditedFiles` is the pure r1 core: from a session transcript's raw JSONL,
 * return the files SUCCESSFULLY edited — an Edit/Write/MultiEdit tool_use whose
 * matching tool_result is present and NOT is_error — aggregated per file with
 * edit count + first/last edit time. `recordEditedIn` upserts the file→session
 * EDITED_IN edges (weight = edit count, SET not incremented — the count is
 * recomputed from the whole transcript on each changed re-parse; notedAt = last
 * edit; firstAt set-on-insert, never bumped). EDITED_IN joins OBSERVATIONAL_RELS
 * so a re-upsert of its src node can't wipe it (mirrors the SURFACED_IN survival).
 *
 * Temp-DB pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-editedin-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { parseEditedFiles, recordEditedIn } = await import('../../server/graph/editedIn.ts')
const { fileEntryId, upsertEntry, OBSERVATIONAL_RELS } = await import('../../server/graph/sync.ts')

getDb()

// ── JSONL transcript fixture builders ────────────────────────────────────────
const ts = (s: string) => Date.parse(s)
const toolUse = (time: string, id: string, name: string, filePath: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: time,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }],
    },
  })
const toolResult = (time: string, useId: string, isError = false) =>
  JSON.stringify({
    type: 'user',
    timestamp: time,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: useId, content: isError ? 'err' : 'ok', is_error: isError }],
    },
  })

const editEdge = (fileId: string, sess: string) =>
  get<{ weight: number; notedAt: number; firstAt: number }>(
    `SELECT weight, notedAt, firstAt FROM edges WHERE src=? AND dst=? AND rel='EDITED_IN'`,
    fileId,
    sess,
  )

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. one successful Edit → one edited file, count 1, first=last=its time ────
{
  const raw = [
    toolUse('2026-06-11T10:00:00.000Z', 'tu1', 'Edit', '/repo/a.ts'),
    toolResult('2026-06-11T10:00:01.000Z', 'tu1'),
  ].join('\n')
  const files = parseEditedFiles(raw)
  assert.equal(files.length, 1, 'one file edited')
  assert.equal(files[0]!.path, '/repo/a.ts', 'verbatim path preserved')
  assert.equal(files[0]!.count, 1, 'one successful edit')
  assert.equal(files[0]!.firstAt, ts('2026-06-11T10:00:00.000Z'), 'firstAt = edit time')
  assert.equal(files[0]!.lastAt, ts('2026-06-11T10:00:00.000Z'), 'lastAt = edit time')
  ok('parseEditedFiles: one successful Edit')
}

// ── 2. r1 — an errored result and a result-less edit are NOT counted ──────────
{
  const raw = [
    toolUse('2026-06-11T10:00:00.000Z', 'errEdit', 'Edit', '/repo/bad.ts'),
    toolResult('2026-06-11T10:00:01.000Z', 'errEdit', true), // is_error → skip
    toolUse('2026-06-11T10:00:02.000Z', 'noResult', 'Write', '/repo/inflight.ts'), // no result → skip
    toolUse('2026-06-11T10:00:03.000Z', 'good', 'Edit', '/repo/ok.ts'),
    toolResult('2026-06-11T10:00:04.000Z', 'good'),
  ].join('\n')
  const files = parseEditedFiles(raw)
  assert.equal(files.length, 1, 'only the one successful edit survives r1')
  assert.equal(files[0]!.path, '/repo/ok.ts', 'errored + result-less edits dropped')
  ok('parseEditedFiles r1: errored / result-less edits excluded')
}

// ── 3. multiple successful edits aggregate; non-edit tools ignored ────────────
{
  const raw = [
    toolUse('2026-06-11T11:00:00.000Z', 'r1', 'Read', '/repo/a.ts'), // not an edit
    toolResult('2026-06-11T11:00:01.000Z', 'r1'),
    toolUse('2026-06-11T11:00:02.000Z', 'e1', 'Edit', '/repo/a.ts'),
    toolResult('2026-06-11T11:00:03.000Z', 'e1'),
    toolUse('2026-06-11T11:00:10.000Z', 'e2', 'MultiEdit', '/repo/a.ts'),
    toolResult('2026-06-11T11:00:11.000Z', 'e2'),
    toolUse('2026-06-11T11:00:20.000Z', 'e3', 'Write', '/repo/b.ts'),
    toolResult('2026-06-11T11:00:21.000Z', 'e3'),
  ].join('\n')
  const files = parseEditedFiles(raw)
  const byPath = new Map(files.map((f) => [f.path, f]))
  assert.equal(files.length, 2, 'two distinct files edited (Read ignored)')
  const a = byPath.get('/repo/a.ts')!
  assert.equal(a.count, 2, 'a.ts edited twice (Edit + MultiEdit)')
  assert.equal(a.firstAt, ts('2026-06-11T11:00:02.000Z'), 'firstAt = earliest edit')
  assert.equal(a.lastAt, ts('2026-06-11T11:00:10.000Z'), 'lastAt = latest edit')
  assert.equal(byPath.get('/repo/b.ts')!.count, 1, 'b.ts edited once (Write)')
  ok('parseEditedFiles: aggregates per file, MultiEdit/Write counted, Read ignored')
}

// ── 4. recordEditedIn writes file→session edges + stubs ───────────────────────
{
  recordEditedIn('sess:E', [
    { path: '/repo/a.ts', count: 2, firstAt: 1000, lastAt: 5000 },
    { path: '/repo/b.ts', count: 1, firstAt: 3000, lastAt: 3000 },
  ])
  const fa = fileEntryId('/repo/a.ts')
  const ea = editEdge(fa, 'sess:E')
  assert.ok(ea, 'EDITED_IN a.ts → sess:E created')
  assert.equal(ea!.weight, 2, 'weight = edit count')
  assert.equal(ea!.notedAt, 5000, 'notedAt = last edit (D3 reads this)')
  assert.equal(ea!.firstAt, 1000, 'firstAt = first edit')
  const sess = get<{ kind: string }>(`SELECT kind FROM entries WHERE id='sess:E'`)
  assert.equal(sess!.kind, 'session', 'session stub ensured')
  const fnode = get<{ kind: string; name: string }>(`SELECT kind, name FROM entries WHERE id=?`, fa)
  assert.equal(fnode!.kind, 'file', 'file stub ensured')
  assert.equal(fnode!.name, '/repo/a.ts', 'file stub carries the verbatim path (joins MENTIONS_FILE)')
  ok('recordEditedIn: file→session edges + session/file stubs')
}

// ── 5. re-record SETS weight (not incremented) + bumps notedAt, firstAt stable ─
// EDITED_IN is DERIVED — a changed transcript is re-parsed whole, so the count is
// authoritative and must be SET. Incrementing (the SURFACED_IN rule) would double
// it every sync. firstAt stays the first-ever edit; notedAt advances.
{
  const fa = fileEntryId('/repo/a.ts')
  recordEditedIn('sess:E', [{ path: '/repo/a.ts', count: 3, firstAt: 1000, lastAt: 9000 }])
  const ea = editEdge(fa, 'sess:E')
  assert.equal(ea!.weight, 3, 'weight SET to the recomputed count (not 2+3)')
  assert.equal(ea!.notedAt, 9000, 'notedAt bumped to the latest edit')
  assert.equal(ea!.firstAt, 1000, 'firstAt STABLE — never bumped by ON CONFLICT')
  ok('recordEditedIn: idempotent SET weight, notedAt bumps, firstAt stable')
}

// ── 6. blank session / empty files → no-op ────────────────────────────────────
{
  const before = get<{ c: number }>(`SELECT count(*) c FROM edges WHERE rel='EDITED_IN'`)!.c
  recordEditedIn('', [{ path: '/x.ts', count: 1, firstAt: 1, lastAt: 1 }])
  recordEditedIn('sess:Z', [])
  assert.equal(get<{ c: number }>(`SELECT count(*) c FROM edges WHERE rel='EDITED_IN'`)!.c, before, 'no edges added')
  assert.equal(get(`SELECT id FROM entries WHERE id='sess:Z'`), undefined, 'empty files → not even a session stub')
  ok('recordEditedIn: blank session / empty files no-op')
}

// ── 7. EDITED_IN ∈ OBSERVATIONAL_RELS — survives a re-upsert of its src node ───
// The re-upsert wipe is `DELETE edges WHERE src=id AND rel NOT IN OBSERVATIONAL_RELS`.
// EDITED_IN's src is a file node; if that node is ever re-upserted, its observed
// edit history must survive (it has no file frontmatter to re-derive it), exactly
// like SURFACED_IN. A declared edge from the same src must still be wiped.
{
  assert.ok(
    (OBSERVATIONAL_RELS as readonly string[]).includes('EDITED_IN'),
    'EDITED_IN is registered observational',
  )
  const fa = fileEntryId('/repo/a.ts') // carries EDITED_IN → sess:E (weight 3) from above
  run(`INSERT OR IGNORE INTO edges (src, dst, rel, label) VALUES (?, 'sess:E', 'LINKS_TO', '')`, fa)
  upsertEntry(null, {
    id: fa, name: '/repo/a.ts', kind: 'file', description: '',
    content: 're-upserted file node', source: 'x', scope: 'file', updatedAt: 9999,
  })
  assert.equal(editEdge(fa, 'sess:E')!.weight, 3, 'EDITED_IN survives the re-upsert with weight intact')
  assert.equal(
    get(`SELECT 1 FROM edges WHERE src=? AND dst='sess:E' AND rel='LINKS_TO'`, fa),
    undefined,
    'a DECLARED edge from the same src is still wiped (the exclusion is observational-only)',
  )
  ok('EDITED_IN observational: survives src re-upsert; declared edge still wiped')
}

// ── 8. recordEditedIn 'add' mode increments weight (the tail-parse path) ───────
// The incremental sync re-reads only an appended transcript TAIL and ADDs its
// edit counts to the existing edge (vs 'set', which replaces on a full reparse).
// notedAt advances; firstAt min-merges (a tail edit is always later, so no-op).
{
  const ft = fileEntryId('/repo/tail.ts')
  recordEditedIn('sess:ADD', [{ path: '/repo/tail.ts', count: 2, firstAt: 100, lastAt: 200 }], 'add')
  assert.equal(editEdge(ft, 'sess:ADD')!.weight, 2, "first 'add' inserts the count")
  recordEditedIn('sess:ADD', [{ path: '/repo/tail.ts', count: 1, firstAt: 300, lastAt: 400 }], 'add')
  const e = editEdge(ft, 'sess:ADD')
  assert.equal(e!.weight, 3, "'add' increments (2+1), NOT set")
  assert.equal(e!.notedAt, 400, 'notedAt advances to the latest tail edit')
  assert.equal(e!.firstAt, 100, 'firstAt stays the first-ever edit (min-merge no-op)')
  ok("recordEditedIn 'add': increments weight, advances notedAt, firstAt stable")
}

console.log(`\nOK edited-in.test.ts — ${passed} cases passed`)
