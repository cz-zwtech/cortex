#!/usr/bin/env tsx
/**
 * s4 — decay / forgetting. `decayScore(M, now, cfg)` is a PURE, compute-on-demand
 * relevance signal: it MARKS a memory as more/less stale, never deletes
 * (Corey's charter: memories never go away, they become irrelevant — see
 * cortex-decay-philosophy-mark-not-delete). Score = coldness × rarity, ORDINAL
 * (any monotone combo is correct; weights are tuning), FLOORED by acted-on (s3
 * reinforcement). Exemptions: open-thread / pinned / engagement / acted-on /
 * grace. Q6: type:feedback directives decay SLOWER + carry a badge. Q5: the
 * acted-on reinforcement (D1/D3) is surfaced for the review badge.
 *
 * Temp-DB pattern mirrors test/graph/surfacings.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-decay-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { recordSurfacings } = await import('../../server/graph/surfacings.ts')
const { recordEditedIn } = await import('../../server/graph/editedIn.ts')
const { fileEntryId } = await import('../../server/graph/sync.ts')
const { decayScore, getDecayConfig } = await import('../../server/graph/decay.ts')

getDb()

const DAY = 86_400_000
const NOW = 1_000_000_000_000
const CFG = { graceDays: 10, coldnessHalfLifeDays: 30, directiveSlowFactor: 4, staleThreshold: 0.3 }

// insert an entry with controllable kind/updatedAt/pinned/engagement/content
const ins = (
  id: string,
  o: { kind?: string; updatedAt?: number; pinned?: boolean; engagement?: boolean; content?: string } = {},
) =>
  run(
    `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,authorship,outcome,outcome_text,agent_id,session_id,pinned,engagement,machine,content_hash)
     VALUES (?, ?, ?, '', ?, '', 'user', ?, 0, 'human', '', '', '', '', ?, ?, '', '')`,
    id,
    id,
    o.kind ?? 'memory',
    o.content ?? '',
    o.updatedAt ?? NOW - 100 * DAY,
    o.pinned ? 1 : 0,
    o.engagement ? 1 : 0,
  )

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. cold + rare + un-acted-on → high score, stale ──────────────────────────
{
  ins('m:cold', { updatedAt: NOW - 200 * DAY })
  recordSurfacings('s:1', ['m:cold'], NOW - 180 * DAY) // surfaced once, long ago
  const r = decayScore('m:cold', NOW, CFG)
  assert.equal(r.exempt, false, 'not exempt')
  assert.ok(r.score > 0.4, `cold+rare scores high (${r.score.toFixed(3)})`)
  assert.equal(r.stale, true, 'above stale threshold')
  assert.equal(r.reinforcement, null, 'never acted-on')
  ok('decayScore: cold + rare + un-acted-on → high score, stale')
}

// ── 2. recently surfaced (warm) → low score ───────────────────────────────────
{
  ins('m:warm', { updatedAt: NOW - 200 * DAY })
  recordSurfacings('s:2', ['m:warm'], NOW - 1 * DAY) // surfaced yesterday
  const r = decayScore('m:warm', NOW, CFG)
  assert.ok(r.score < 0.1, `warm scores low (${r.score.toFixed(3)})`)
  assert.equal(r.stale, false, 'below threshold')
  ok('decayScore: recently surfaced → low score (coldness dampens)')
}

// ── 3. frequently surfaced (high weight) → rarity dampens the score ───────────
{
  ins('m:freq', { updatedAt: NOW - 200 * DAY })
  for (let i = 0; i < 20; i++) recordSurfacings('s:3', ['m:freq'], NOW - 90 * DAY)
  const r = decayScore('m:freq', NOW, CFG)
  assert.equal(r.surfacings, 20, 'surfacing count summed from SURFACED_IN weight')
  assert.ok(r.score < 0.1, `frequent scores low despite some coldness (${r.score.toFixed(3)})`)
  ok('decayScore: frequently surfaced → rarity dampens score')
}

// ── 4. never surfaced + old → coldness from updatedAt, rarity maxed ────────────
{
  ins('m:never', { updatedAt: NOW - 200 * DAY }) // no SURFACED_IN at all
  const r = decayScore('m:never', NOW, CFG)
  assert.equal(r.surfacings, 0, 'zero surfacings')
  assert.ok(r.score > 0.9, `never-surfaced old memory scores very high (${r.score.toFixed(3)})`)
  assert.equal(r.stale, true, 'stale')
  ok('decayScore: never surfaced + old → coldness from updatedAt, rarity maxed')
}

// ── 5-9. exemptions → score 0, stale false, reason set ────────────────────────
{
  ins('m:pin', { pinned: true, updatedAt: NOW - 200 * DAY })
  const r = decayScore('m:pin', NOW, CFG)
  assert.equal(r.exempt, true); assert.equal(r.score, 0); assert.equal(r.stale, false)
  assert.equal(r.reason, 'pinned', 'pinned exemption')
  ok('decayScore: pinned → exempt')
}
{
  ins('m:eng', { engagement: true, updatedAt: NOW - 200 * DAY })
  assert.equal(decayScore('m:eng', NOW, CFG).reason, 'engagement', 'engagement exemption')
  ok('decayScore: engagement → exempt')
}
{
  ins('m:thread', { kind: 'thread', content: JSON.stringify({ status: 'open', next_step: 'x', links: [] }), updatedAt: NOW - 200 * DAY })
  assert.equal(decayScore('m:thread', NOW, CFG).reason, 'open-thread', 'open thread exempt')
  ins('m:thread-done', { kind: 'thread', content: JSON.stringify({ status: 'done', next_step: '', links: [] }), updatedAt: NOW - 200 * DAY })
  const done = decayScore('m:thread-done', NOW, CFG)
  assert.notEqual(done.reason, 'open-thread', 'a DONE thread is not open-thread-exempt — it can decay')
  ok('decayScore: OPEN thread exempt; DONE thread decays')
}
{
  // acted-on: mem mentions F, F edited in S, mem surfaced in S → reinforced, exempt
  ins('m:acted', { updatedAt: NOW - 100 * DAY })
  recordEditedIn('s:acted', [{ path: '/p/q.ts', count: 1, firstAt: NOW - 50 * DAY, lastAt: NOW - 50 * DAY }])
  run(`INSERT OR IGNORE INTO edges (src,dst,rel) VALUES ('m:acted', ?, 'MENTIONS_FILE')`, fileEntryId('/p/q.ts'))
  recordSurfacings('s:acted', ['m:acted'], NOW - 60 * DAY) // first-surfaced BEFORE the edit → D3
  const r = decayScore('m:acted', NOW, CFG)
  assert.equal(r.exempt, true); assert.equal(r.reason, 'acted-on', 'acted-on exemption')
  assert.equal(r.reinforcement, 'D3', 'badge: edit after surface → D3')
  ok('decayScore: acted-on → exempt + reinforcement badge')
}
{
  ins('m:fresh', { updatedAt: NOW - 2 * DAY }) // within 10d grace
  assert.equal(decayScore('m:fresh', NOW, CFG).reason, 'grace', 'fresh memory within grace exempt')
  ok('decayScore: within grace → exempt')
}

// ── 10. Q6 — type:feedback directive decays SLOWER (same coldness/rarity) ──────
{
  ins('m:plain', { updatedAt: NOW - 200 * DAY })
  recordSurfacings('s:p', ['m:plain'], NOW - 100 * DAY)
  ins('feedback-x', { updatedAt: NOW - 200 * DAY })           // feedback- prefix = directive
  recordSurfacings('s:f', ['feedback-x'], NOW - 100 * DAY)
  const plain = decayScore('m:plain', NOW, CFG)
  const directive = decayScore('feedback-x', NOW, CFG)
  assert.equal(plain.isDirective, false, 'plain is not a directive')
  assert.equal(directive.isDirective, true, 'feedback- prefix → directive')
  assert.ok(
    directive.score < plain.score,
    `directive decays slower → lower score (${directive.score.toFixed(3)} < ${plain.score.toFixed(3)})`,
  )
  ok('decayScore Q6: type:feedback directive decays slower + isDirective badge')
}

// ── 11. mark-not-delete guard — decayScore writes NOTHING ─────────────────────
// The s4 analog of s3's corroborate-not-authorize guard: decay is a SIGNAL, it
// must never mutate the graph (and certainly never delete a memory).
{
  const e0 = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  const n0 = get<{ c: number }>(`SELECT count(*) c FROM entries`)!.c
  decayScore('m:cold', NOW, CFG); decayScore('m:acted', NOW, CFG); decayScore('m:nope', NOW, CFG)
  assert.equal(get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c, e0, 'no edges written')
  assert.equal(get<{ c: number }>(`SELECT count(*) c FROM entries`)!.c, n0, 'no entries written/deleted')
  ok('decayScore: read-only — MARK never delete (zero graph writes)')
}

// ── 12. config knobs — getDecayConfig returns tunable numeric defaults ─────────
{
  const c = getDecayConfig()
  for (const k of ['graceDays', 'coldnessHalfLifeDays', 'directiveSlowFactor', 'staleThreshold'] as const) {
    assert.equal(typeof c[k], 'number', `${k} is a numeric knob`)
    assert.ok(c[k] > 0, `${k} has a sane default`)
  }
  ok('getDecayConfig: tunable numeric knobs with sane defaults')
}

console.log(`\nOK decay.test.ts — ${passed} cases passed`)
