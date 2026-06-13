#!/usr/bin/env tsx
/** profile_facet graph module: schema, merge, confidence/trend, arbitration. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.CKN_EMBEDDINGS = 'off'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-profile-'))
process.env.CKN_GRAPH_DB_PATH = path.join(tmp, 'graph.sqlite')

const { getDb, all, run } = await import('../../server/graph/db.js')
getDb()

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

try {
  // Task 1: table exists + round-trips
  run(
    `INSERT INTO profile_facet_meta (id, dimension, facet_key, stance, valence, competing_group,
       confidence, trend, evidence_count, first_observed, last_observed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'profile_facet:user/communication/verbosity/terse', 'communication', 'verbosity', 'terse',
    'trait', 'communication:verbosity', 0.4, 'strengthening', 1, 100, 100,
  )
  const row = all<any>(`SELECT * FROM profile_facet_meta WHERE id = ?`,
    'profile_facet:user/communication/verbosity/terse')[0]
  assert.equal(row.competing_group, 'communication:verbosity')
  assert.equal(row.confidence, 0.4)
  ok('profile_facet_meta round-trips')

  const { observeFacet, getFacet, facetId } = await import('../../server/graph/profile.js')

  // Use REALISTIC timestamps: reads recompute trend/confidence from age, so fixtures must be
  // "recent" to read as strengthening. (Shared across later test blocks.)
  const DAY = 86_400_000
  const T = Date.now()
  const cand = {
    dimension: 'communication' as const, facet_key: 'verbosity', stance: 'terse',
    statement: 'Prefers terse answers with options + pros/cons', valence: 'trait' as const,
  }
  observeFacet(cand, 's1', T)
  let f = getFacet('profile_facet:user/communication/verbosity/terse')!
  assert.equal(f.evidence_count, 1, 'one session → count 1')
  assert.ok(f.confidence > 0.39 && f.confidence < 0.41, '1 session ≈ 0.40')
  // same session again → idempotent (no double count)
  observeFacet(cand, 's1', T)
  f = getFacet('profile_facet:user/communication/verbosity/terse')!
  assert.equal(f.evidence_count, 1, 'same session is idempotent')
  // a second distinct session → confidence rises, trend strengthening
  observeFacet(cand, 's2', T)
  f = getFacet('profile_facet:user/communication/verbosity/terse')!
  assert.equal(f.evidence_count, 2, 'two distinct sessions → count 2')
  assert.ok(f.confidence > 0.63 && f.confidence < 0.65, '2 sessions ≈ 0.64')
  assert.equal(f.trend, 'strengthening', 'recent corroboration → strengthening')
  ok('observeFacet merges + confidence + trend')

  const { activeFacets, getProfile } = await import('../../server/graph/profile.js')

  // Seed a competing stance in the same group, stronger via 3 sessions.
  const loose = { dimension: 'communication' as const, facet_key: 'verbosity', stance: 'verbose',
    statement: 'Likes long detailed answers', valence: 'trait' as const }
  observeFacet(loose, 'a1', T); observeFacet(loose, 'a2', T); observeFacet(loose, 'a3', T)
  const active = activeFacets({ minConfidence: 0 })
  const group = active.filter((f) => f.competing_group === 'communication:verbosity')
  assert.equal(group.length, 1, 'exactly one active facet per competing group')
  assert.equal(group[0]!.stance, 'verbose', 'higher-confidence stance wins active slot')
  ok('competing-group arbitration picks highest confidence')

  // Injection gate: a 1-session facet (≈0.40) is below INJECT_MIN (0.6) and excluded.
  observeFacet({ dimension: 'values' as const, facet_key: 'simplicity', stance: 'pro',
    statement: 'Values simple solutions', valence: 'trait' as const }, 'z1', T)
  const gated = activeFacets({ minConfidence: 0.6 })
  assert.ok(!gated.some((f) => f.competing_group === 'values:simplicity'),
    'sub-threshold facet is gated out of injection')
  ok('confidence gate excludes weak facets')

  // DECAY (spec §1.1): a strong 3-session facet last corroborated >60d ago reads as stale,
  // its confidence decays (×0.5) below the bar, and it drops out of injection — no cron.
  const old = { dimension: 'cognition' as const, facet_key: 'risk', stance: 'bold',
    statement: 'Takes bold technical bets', valence: 'trait' as const }
  observeFacet(old, 'o1', T - 70 * DAY); observeFacet(old, 'o2', T - 70 * DAY); observeFacet(old, 'o3', T - 70 * DAY)
  const stale = activeFacets({ minConfidence: 0 }).find((f) => f.competing_group === 'cognition:risk')!
  assert.equal(stale.trend, 'stale', '>60d since corroboration → stale')
  assert.ok(stale.confidence < 0.4, 'stale confidence decayed (3 sessions ×0.5 ≈ 0.39)')
  assert.ok(!activeFacets({ minConfidence: 0.6 }).some((f) => f.competing_group === 'cognition:risk'),
    'decayed facet drops below the injection bar')
  ok('uncorroborated perception decays out (no human edit needed)')

  const profile = getProfile()
  assert.ok(Array.isArray(profile.facets), 'getProfile returns facets[]')
  assert.equal(typeof profile.narrative, 'string', 'getProfile returns narrative string')
  ok('getProfile shape')

  // forgetProfile (private-mind/tier forget): wipes ALL profile nodes — facets AND
  // the synthesized narrative — so no stale "about the human" survives the wipe.
  const { forgetProfile } = await import('../../server/graph/profile.js')
  // Seed a narrative node so the round-trip exercises the narrative-deletion path.
  run(
    `INSERT INTO entries (id, name, kind, content, scope, updatedAt, syncedAt)
     VALUES ('profile_narrative:user', 'narrative', 'profile_narrative', ?, 'user', ?, ?)`,
    'The human is terse and values simplicity.', T, T,
  )
  // And a DERIVED_FROM edge into the narrative, to prove edge cleanup too.
  run(`INSERT INTO edges (src, dst, rel) VALUES ('profile_narrative:user', 'session:s1', 'DERIVED_FROM')`)
  // Sanity: there ARE facets + a non-empty narrative before the wipe.
  const beforeFacets = activeFacets({ minConfidence: 0 })
  assert.ok(beforeFacets.length > 0, 'facets exist before forget')
  assert.equal(getProfile().narrative, 'The human is terse and values simplicity.',
    'narrative is injected before forget')
  const expectedFacetRows = Number(
    all<{ c: number }>(`SELECT COUNT(*) AS c FROM entries WHERE kind = 'profile_facet'`)[0]!.c)
  const removed = forgetProfile()
  assert.equal(removed, expectedFacetRows + 1, 'returned count = all facet rows + the narrative')
  const after = getProfile()
  assert.equal(after.narrative, '', 'narrative is gone after forget')
  assert.equal(after.facets.length, 0, 'no facets after forget')
  assert.equal(
    Number(all<{ c: number }>(`SELECT COUNT(*) AS c FROM profile_facet_meta`)[0]!.c), 0,
    'profile_facet_meta is emptied')
  assert.equal(
    Number(all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edges WHERE src = 'profile_narrative:user' OR dst = 'profile_narrative:user'`)[0]!.c),
    0, 'narrative edges are removed')
  ok('forgetProfile wipes facets + narrative (count + getProfile empty)')

  // Task 8: private-mind profile tier — export→import merges evidence by competing_group.
  // Re-seed a facet (forget wiped everything above) so there is something to export.
  observeFacet(cand, 's1', T); observeFacet(cand, 's2', T)
  const { exportProfileSnapshot, importProfileSnapshot } = await import('../../server/graph/profile.js')
  // export current state, simulate a peer machine that saw the same facet in 1 extra session
  const snap = exportProfileSnapshot()
  const terse = snap.facets.find((f: any) => f.stance === 'terse')!
  const peerSnap = { narrative: '', facets: [{ ...terse, evidence_count: terse.evidence_count + 1 }] }
  importProfileSnapshot(peerSnap)
  const merged = getFacet(terse.id)!
  assert.ok(merged.evidence_count >= terse.evidence_count + 1, 'cross-machine evidence unions upward')
  ok('importProfileSnapshot merges evidence by competing_group')

  // Fix 1 (spec §9): a federation-merged evidence boost must NOT be eroded by a later local
  // observe. observeFacet recomputes distinct from edges, but max()-es it against the stored
  // count so a higher peer-merged count survives. Fresh isolated facet.
  const fed = { dimension: 'work-cadence' as const, facet_key: 'tempo', stance: 'fast',
    statement: 'Moves fast, dislikes time-estimate padding', valence: 'trait' as const }
  observeFacet(fed, 'fed1', T); observeFacet(fed, 'fed2', T)
  let fedFacet = getFacet(facetId(fed))!
  assert.equal(fedFacet.evidence_count, 2, 'two local sessions → count 2 before federation merge')
  // Peer machine saw it in 3 sessions: export, bump to 3, import (max() unions to 3).
  const fedSnap = exportProfileSnapshot()
  const fedExported = fedSnap.facets.find((x: any) => x.id === facetId(fed))!
  importProfileSnapshot({ narrative: '', facets: [{ ...fedExported, evidence_count: 3 }] })
  fedFacet = getFacet(facetId(fed))!
  assert.equal(fedFacet.evidence_count, 3, 'federation merge boosts evidence to 3')
  // Re-observe with an ALREADY-counted session id: local distinct is still 2, but the stored
  // boost (3) must persist — before the fix this dropped back to 2.
  observeFacet(fed, 'fed1', T)
  fedFacet = getFacet(facetId(fed))!
  assert.ok(fedFacet.evidence_count >= 3, 'local re-observe does not erode federation boost (stays >= 3)')
  ok('federation evidence boost survives a later local observe')

  // Fix 2 (spec §10): narrative is gated on the active facet set. With no facet passing the
  // requested gate, getProfile must suppress the (otherwise stale) narrative. Wipe to an
  // isolated state, seed a single sub-threshold (1-session ≈ 0.40) facet + a narrative.
  const { getProfile: getProfileGated } = await import('../../server/graph/profile.js')
  forgetProfile()
  observeFacet({ dimension: 'autonomy' as const, facet_key: 'oversight', stance: 'low',
    statement: 'Prefers minimal oversight', valence: 'trait' as const }, 'g1', T)
  run(
    `INSERT INTO entries (id, name, kind, content, scope, updatedAt, syncedAt)
     VALUES ('profile_narrative:user', 'narrative', 'profile_narrative', ?, 'user', ?, ?)`,
    'The human prefers minimal oversight.', T, T,
  )
  // Sanity: with the gate open the narrative DOES inject (≥1 active facet).
  assert.ok(getProfileGated({ minConfidence: 0 }).facets.length > 0, 'one active facet at gate 0')
  assert.equal(getProfileGated({ minConfidence: 0 }).narrative, 'The human prefers minimal oversight.',
    'narrative injects while a supporting facet is active')
  // At gate 0.6 the lone 1-session facet is below threshold → facets empty → narrative suppressed.
  assert.equal(getProfileGated({ minConfidence: 0.6 }).facets.length, 0, 'no facet passes 0.6 gate')
  assert.equal(getProfileGated({ minConfidence: 0.6 }).narrative, '',
    'narrative suppressed once supporting facets decay below the gate')
  ok('getProfile gates narrative on active facets (spec §10)')

  console.log(`\n${passed} assertions passed.`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
