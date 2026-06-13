#!/usr/bin/env tsx
/**
 * s4 — decay review surface (slice B). `decayReview(asOf)` scans the memory
 * corpus, scores each via decayScore, and returns the top non-exempt STALE
 * candidates (score desc) plus a tally of WHY the rest are exempt — the data the
 * `ckn-decay` CLI renders so a human can see what's fading and why. `keepMemory`
 * is the manual-reinforcement seam (Fable's lens: keep must BUMP the memory, never
 * just dismiss): it records a curation surfacing, resetting coldness so the memory
 * drops out of the candidate list. MARK never delete — nothing is removed.
 *
 * Temp-DB pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-decay-review-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')
const { decayScore, decayReview, keepMemory } = await import('../../server/graph/decay.ts')

getDb()

const DAY = 86_400_000
const NOW = 1_000_000_000_000
const CFG = { graceDays: 10, coldnessHalfLifeDays: 30, directiveSlowFactor: 4, staleThreshold: 0.3 }

const ins = (id: string, o: { pinned?: boolean; engagement?: boolean; updatedAt?: number } = {}) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, 'memory', '', '', '', 'user', ?, 0, 'human', '', '', '', '', ?, ?, '', '')`,
    id, id, o.updatedAt ?? NOW - 200 * DAY, o.pinned ? 1 : 0, o.engagement ? 1 : 0,
  )

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// seed: two stale (different coldness), one warm, one pinned (exempt), one engagement (exempt)
ins('m:s1'); recordSurfacings('x1', ['m:s1'], NOW - 190 * DAY) // very cold, rare → highest score
ins('m:s2'); recordSurfacings('x2', ['m:s2'], NOW - 60 * DAY)  // less cold → lower score
ins('m:warm'); recordSurfacings('x3', ['m:warm'], NOW - 1 * DAY) // warm → very low score
ins('m:pin', { pinned: true })
ins('m:eng', { engagement: true })

// ── 1. decayReview returns non-exempt candidates sorted by score desc ─────────
{
  const r = decayReview(NOW, { limit: 10, cfg: CFG })
  assert.equal(r.scanned, 5, 'scored every memory entry')
  const ids = r.candidates.map((c) => c.memoryId)
  assert.deepEqual(ids, ['m:s1', 'm:s2', 'm:warm'], 'non-exempt candidates, score desc')
  assert.ok(r.candidates[0]!.score >= r.candidates[1]!.score, 'sorted descending')
  assert.ok(!ids.includes('m:pin') && !ids.includes('m:eng'), 'exempt memories are NOT candidates')
  ok('decayReview: non-exempt candidates sorted by score desc')
}

// ── 2. exemptByReason tallies why the rest are exempt (the badge data) ────────
{
  const r = decayReview(NOW, { cfg: CFG })
  assert.equal(r.exemptByReason.pinned, 1, 'one pinned exemption tallied')
  assert.equal(r.exemptByReason.engagement, 1, 'one engagement exemption tallied')
  ok('decayReview: exemptByReason tally surfaces why memories are exempt')
}

// ── 3. limit caps the candidate list (review surface is top-N) ────────────────
{
  const r = decayReview(NOW, { limit: 1, cfg: CFG })
  assert.equal(r.candidates.length, 1, 'limit caps candidates')
  assert.equal(r.candidates[0]!.memoryId, 'm:s1', 'keeps the highest-decay one')
  ok('decayReview: limit caps the candidate list to the top-N')
}

// ── 4. keepMemory BUMPS the memory (manual reinforcement) — score drops ───────
{
  const before = decayScore('m:s1', NOW, CFG)
  assert.ok(before.score > 0.4, 'm:s1 starts stale')
  keepMemory('m:s1', NOW) // human reviewed + kept → a curation surfacing, coldness resets
  const after = decayScore('m:s1', NOW, CFG)
  assert.ok(after.score < before.score, `keep drops the score (${after.score.toFixed(3)} < ${before.score.toFixed(3)})`)
  assert.ok(after.surfacings > before.surfacings, 'keep bumps the surfacing count (a real touch, not a dismiss)')
  ok('keepMemory: bumps the memory (coldness reset, count up) — manual reinforcement seam')
}

// ── 5. MARK never delete — review + keep remove no memory ─────────────────────
{
  const memBefore = get<{ c: number }>(`SELECT count(*) c FROM entries WHERE kind='memory'`)!.c
  decayReview(NOW, { cfg: CFG })
  keepMemory('m:s2', NOW)
  const memAfter = get<{ c: number }>(`SELECT count(*) c FROM entries WHERE kind='memory'`)!.c
  assert.equal(memAfter, memBefore, 'no memory entry deleted (MARK never delete)')
  assert.ok(get(`SELECT id FROM entries WHERE id='m:s1'`), 'the kept memory still exists')
  ok('decay review path: MARK never delete (no memory removed)')
}

console.log(`\nOK decay-review.test.ts — ${passed} cases passed`)
