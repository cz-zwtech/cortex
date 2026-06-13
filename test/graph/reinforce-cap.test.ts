#!/usr/bin/env tsx
/**
 * s4 — reinforcementFor's recent-K cap (the bound that keeps decayScore cheap on
 * the recall path at corpus scale, and is SEMANTICALLY right: recent corroboration
 * IS reinforcement). Only the K most-recently-surfaced sessions are scanned, so an
 * acted-on that's fallen out of the recent window no longer reinforces — it fades
 * (Corey's "memories become irrelevant") — UNTIL a fresh surfacing re-bumps it back
 * into the window (the self-correcting loop). K via CKN_REINFORCE_RECENT_K.
 *
 * Temp-DB pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
process.env.CKN_REINFORCE_RECENT_K = '2' // cap to the 2 most-recent surfaced sessions
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-reinforce-cap-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')
const { recordEditedIn } = await import('../../server/graph/editedIn.ts')
const { fileEntryId } = await import('../../server/graph/sync.ts')
const { reinforcementFor } = await import('../../server/graph/actedOn.ts')

getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// m mentions F; F was edited in the OLD session (acted-on there). m is surfaced in
// three sessions; only the OLDEST is the acted-on one.
const F = '/repo/cap.ts'
recordEditedIn('s:old', [{ path: F, count: 1, firstAt: 1000, lastAt: 1000 }]) // edit in s:old → acted-on there
run(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES ('m', ?, 'MENTIONS_FILE')`, fileEntryId(F))
recordSurfacings('s:old', ['m'], 1000) // oldest surfacing
recordSurfacings('s:mid', ['m'], 2000)
recordSurfacings('s:new', ['m'], 3000) // newest

// ── 1. acted-on only in a session BEYOND the recent-K window → not reinforced ──
{
  // recent-2 by notedAt = s:new(3000), s:mid(2000); s:old(1000) is excluded — and
  // s:old is the only acted-on session, so reinforcement has faded.
  assert.equal(
    reinforcementFor('m'),
    null,
    'acted-on only in a session beyond recent-K → NOT reinforced (stale corroboration fades)',
  )
  ok('reinforcementFor cap: old acted-on outside recent-K does not reinforce')
}

// ── 2. a fresh surfacing re-bumps the old session into recent-K → reinforced ──
{
  recordSurfacings('s:old', ['m'], 4000) // s:old re-surfaced → now the most recent
  // recent-2 = s:old(4000), s:new(3000); s:old carries the edit, firstSurfacedAt
  // stays 1000 (set-on-insert) so lastEdit(1000) >= firstSurfaced(1000) → D3.
  assert.equal(
    reinforcementFor('m'),
    'D3',
    'a fresh surfacing re-bumps the old acted-on session into recent-K → reinforced again (self-correcting)',
  )
  ok('reinforcementFor cap: a fresh surfacing self-corrects reinforcement back')
}

console.log(`\nOK reinforce-cap.test.ts — ${passed} cases passed`)
