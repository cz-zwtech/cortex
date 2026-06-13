#!/usr/bin/env tsx
/**
 * s3 — EDITED_IN sync integration (Option C, r2 incremental). `syncEditedIn`
 * walks ~/.claude/projects/<proj>/*.jsonl, and for each CHANGED transcript
 * (stat-delta against the shared sync_manifest, never re-parsing an unchanged
 * one) parses successful edits and upserts EDITED_IN edges. The manifest is
 * path-keyed and shared with the memory pre-pass — transcripts and .md files
 * never collide.
 *
 * Temp-DB + temp-HOME pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-editedin-sync-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, get } = await import('../../server/graph/db.ts')
const { readSyncManifest, writeSyncManifest } = await import('../../server/graph/syncManifest.ts')
const { fileEntryId } = await import('../../server/graph/sync.ts')
const { syncEditedIn } = await import('../../server/graph/editedIn.ts')

getDb()

const toolUse = (time: string, id: string, name: string, filePath: string) =>
  JSON.stringify({
    type: 'assistant', timestamp: time,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }] },
  })
const toolResult = (time: string, useId: string) =>
  JSON.stringify({
    type: 'user', timestamp: time,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: 'ok' }] },
  })

const A = '/repo/server/graph/sync.ts'
const B = '/repo/server/graph/threads.ts'
const projDir = path.join(dir, '.claude', 'projects', 'proj-x')
fs.mkdirSync(projDir, { recursive: true })
const sid = 'sess-abc'
const file = path.join(projDir, `${sid}.jsonl`)

const editEdge = (fileId: string, sess: string) =>
  get<{ weight: number; notedAt: number }>(
    `SELECT weight, notedAt FROM edges WHERE src=? AND dst=? AND rel='EDITED_IN'`, fileId, sess,
  )

// one full sync cycle: read manifest fresh (as syncMemories does at its top),
// derive, persist the manifest.
const cycle = async () => {
  const manifest = readSyncManifest()
  const updates: Array<{ path: string; mtime: number; size: number }> = []
  const r = await syncEditedIn(dir, manifest, updates)
  writeSyncManifest(updates)
  return r
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. first sync derives EDITED_IN from the transcript ───────────────────────
{
  fs.writeFileSync(file, [
    toolUse('2026-06-11T10:00:00.000Z', 'e1', 'Edit', A),
    toolResult('2026-06-11T10:00:01.000Z', 'e1'),
  ].join('\n'))
  const r = await cycle()
  assert.equal(r.transcripts, 1, 'one transcript parsed')
  const e = editEdge(fileEntryId(A), sid)
  assert.ok(e, 'EDITED_IN edge derived for the edited file')
  assert.equal(e!.weight, 1, 'weight = one successful edit')
  ok('first sync derives EDITED_IN from a transcript')
}

// ── 2. r2 — an UNCHANGED transcript is skipped (not re-parsed) ─────────────────
{
  const r = await cycle()
  assert.equal(r.transcripts, 0, 'unchanged transcript stat-skipped (session entry exists)')
  ok('r2: unchanged transcript is not re-parsed')
}

// ── 3. a CHANGED transcript (appended edit) is re-parsed; new edge appears ─────
// Appending changes the file SIZE, so the stat-delta fires regardless of any
// mtime-rounding flakiness (#42-proof).
{
  fs.appendFileSync(file, '\n' + [
    toolUse('2026-06-11T10:05:00.000Z', 'e2', 'Write', B),
    toolResult('2026-06-11T10:05:01.000Z', 'e2'),
  ].join('\n'))
  const r = await cycle()
  assert.equal(r.transcripts, 1, 'changed transcript re-parsed')
  assert.ok(editEdge(fileEntryId(B), sid), 'the newly-edited file got its EDITED_IN edge')
  assert.equal(editEdge(fileEntryId(A), sid)!.weight, 1, 'the first file\'s weight is still correct (SET, not doubled)')
  ok('r2: a changed transcript re-derives; SET-weight stays idempotent')
}

// ── 4. grow with a REPEAT edit to an existing file → tail-ADD increments ───────
// Appending another edit to A grows the file; the tail (only the appended bytes)
// is parsed and ADDed, so A's weight goes 1→2 without re-reading the whole file.
{
  fs.appendFileSync(file, '\n' + [
    toolUse('2026-06-11T10:10:00.000Z', 'e3', 'Edit', A),
    toolResult('2026-06-11T10:10:01.000Z', 'e3'),
  ].join('\n'))
  const r = await cycle()
  assert.equal(r.transcripts, 1, 'grown transcript re-parsed')
  assert.equal(editEdge(fileEntryId(A), sid)!.weight, 2, 'repeat edit to A increments via tail-ADD (1→2)')
  ok('grow: tail-parse ADDs the appended edit to an already-edited file')
}

// ── 5. SHRINK (a /compact rewrite) → full reparse + SET resets the weight ──────
// A smaller file can't be tail-extended; it falls to the full-reparse fallback,
// whose SET makes the weight reflect the NEW (post-compaction) content — so a
// compaction that drops history doesn't leave a stale inflated count.
{
  fs.writeFileSync(file, [
    toolUse('2026-06-11T10:20:00.000Z', 'e4', 'Edit', A),
    toolResult('2026-06-11T10:20:01.000Z', 'e4'),
  ].join('\n'))
  const r = await cycle()
  assert.equal(r.transcripts, 1, 'shrunk transcript re-parsed (full)')
  assert.equal(editEdge(fileEntryId(A), sid)!.weight, 1, 'shrink → full SET resets A weight to the new content (1, not 2)')
  ok('shrink: a smaller transcript triggers full reparse + SET (compaction-safe)')
}

// ── 6. mid-line prevSize: a record straddling the tail boundary is still counted ─
// readTail backs up to the previous newline, so a record split by the byte
// boundary (a sync that statted mid-append) isn't dropped.
{
  const midFile = path.join(projDir, 'sess-mid.jsonl')
  const sidM = 'sess-mid'
  fs.writeFileSync(midFile, [
    toolUse('2026-06-11T12:00:00.000Z', 'm1', 'Edit', '/m/a.ts'),
    toolResult('2026-06-11T12:00:01.000Z', 'm1'),
  ].join('\n'))
  await cycle() // first-sight full → /m/a.ts counted, session 'sess-mid' exists
  const sizeBefore = fs.statSync(midFile).size
  fs.appendFileSync(midFile, '\n' + [
    toolUse('2026-06-11T12:05:00.000Z', 'm2', 'Write', '/m/b.ts'),
    toolResult('2026-06-11T12:05:01.000Z', 'm2'),
  ].join('\n'))
  // Force prevSize a few bytes INTO the appended record (mid-line straddle).
  const st = fs.statSync(midFile)
  writeSyncManifest([{ path: midFile, mtime: Math.floor(st.mtimeMs), size: sizeBefore + 5 }])
  await cycle()
  assert.ok(editEdge(fileEntryId('/m/b.ts'), sidM), 'straddling record recovered via newline backup')
  ok('readTail: a record straddling the boundary is counted (backup to prev newline)')
}

console.log(`\nOK edited-in-sync.test.ts — ${passed} cases passed`)
