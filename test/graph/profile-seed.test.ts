#!/usr/bin/env tsx
/** Declared (user-seeded) profile facets: onboarding warm-start, faster decay,
 * behavior-overtakes-seed, competing-group arbitration, no-downgrade-of-observed. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.CKN_EMBEDDINGS = 'off'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-profile-seed-'))
process.env.CKN_GRAPH_DB_PATH = path.join(tmp, 'graph.sqlite')

const { getDb, run } = await import('../../server/graph/db.js')
getDb()

const { seedFacet, observeFacet, getFacet, activeFacets, facetId, profileFacetCount, SEED_CONFIDENCE, INJECT_MIN } =
  await import('../../server/graph/profile.js')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps

const DAY = 86_400_000
const T = Date.now()
const reset = () => { run('DELETE FROM profile_facet_meta'); run(`DELETE FROM entries WHERE kind='profile_facet'`); run(`DELETE FROM edges WHERE rel='DERIVED_FROM'`) }

// Reusable candidates
const brief = {
  dimension: 'communication' as const, facet_key: 'answer-length', stance: 'brief-first',
  statement: 'Prefers brief answers first, expanded on request', valence: 'like' as const,
}
const detailed = {
  dimension: 'communication' as const, facet_key: 'answer-length', stance: 'detailed',
  statement: 'Prefers detailed answers by default', valence: 'like' as const,
}

try {
  // 1. A fresh declared seed is active at SEED_CONFIDENCE and labeled 'declared'.
  reset()
  seedFacet(brief, T)
  let f = getFacet(facetId(brief))!
  assert.ok(f, 'seed facet exists')
  assert.equal(f.source, 'declared', 'source is declared')
  assert.equal(f.evidence_count, 0, 'no behavioral evidence yet')
  assert.ok(approx(f.confidence, SEED_CONFIDENCE), `fresh seed conf ≈ ${SEED_CONFIDENCE}, got ${f.confidence}`)
  assert.ok(f.confidence >= INJECT_MIN, 'fresh seed clears the injection bar')
  ok('fresh declared seed is active at SEED_CONFIDENCE')

  // 2. A seed not corroborated by behavior decays below INJECT_MIN over time.
  reset()
  seedFacet(brief, T - 30 * DAY)         // seeded 30 days ago, never observed
  f = getFacet(facetId(brief))!
  assert.ok(f.confidence < INJECT_MIN, `30d-old seed decayed below inject (${f.confidence})`)
  assert.equal(activeFacets({ minConfidence: INJECT_MIN }).length, 0, 'decayed seed not injected')
  assert.equal(activeFacets({}).length, 1, 'but still present below the bar')
  ok('un-corroborated seed decays out on its own (no human edit)')

  // 3. Re-seeding a declared facet refreshes the decay clock.
  seedFacet(brief, T)                     // user re-affirms it today
  f = getFacet(facetId(brief))!
  assert.ok(approx(f.confidence, SEED_CONFIDENCE), 're-seed resets to full seed strength')
  ok('re-seeding resets the decay clock')

  // 4. Behavior overtakes the seed: observed evidence raises confidence past the seed floor,
  //    while the facet keeps its 'declared' provenance label.
  reset()
  seedFacet(brief, T)
  observeFacet(brief, 's1', T)
  observeFacet(brief, 's2', T)
  observeFacet(brief, 's3', T)
  f = getFacet(facetId(brief))!
  assert.equal(f.evidence_count, 3, '3 distinct sessions corroborate')
  assert.ok(f.confidence > SEED_CONFIDENCE, `observed conf overtakes seed floor (${f.confidence})`)
  assert.ok(approx(f.confidence, 0.784), `3-session conf ≈ 0.784, got ${f.confidence}`)
  assert.equal(f.source, 'declared', 'provenance label persists (you seeded it)')
  ok('behavioral evidence overtakes the seed (automatic trait gets stronger)')

  // 5. A corroborated trait survives even when the seed clock would have fully decayed —
  //    observed freshness, not the seed age, carries it.
  reset()
  seedFacet(brief, T - 90 * DAY)         // seed clock long past stale
  observeFacet(brief, 's1', T)           // but behavior corroborated it recently
  observeFacet(brief, 's2', T)
  f = getFacet(facetId(brief))!
  assert.ok(f.confidence >= INJECT_MIN, `recently-observed beats a stale seed clock (${f.confidence})`)
  ok('observed corroboration outlives the seed decay clock')

  // 6. Competing arbitration: a faded seed loses to an observed competing stance.
  reset()
  seedFacet(brief, T)                     // declared brief-first
  observeFacet(detailed, 's1', T)         // behavior says detailed (same competing_group)
  observeFacet(detailed, 's2', T)
  observeFacet(detailed, 's3', T)
  const active = activeFacets({ minConfidence: INJECT_MIN })
  assert.equal(active.length, 1, 'one winner per competing_group')
  assert.equal(active[0].stance, 'detailed', 'observed competing stance overtakes the seed')
  ok('observed competing facet overtakes a declared seed in the same group')

  // 7. seedFacet never downgrades a facet behavior has already observed.
  reset()
  observeFacet(brief, 's1', T)
  observeFacet(brief, 's2', T)
  observeFacet(brief, 's3', T)
  const before = getFacet(facetId(brief))!
  seedFacet(brief, T)                     // user "declares" something behavior already proved
  const after = getFacet(facetId(brief))!
  assert.equal(after.source, 'observed', 'stays observed — real evidence outranks a stated preference')
  assert.equal(after.evidence_count, 3, 'evidence not clobbered')
  assert.ok(approx(after.confidence, before.confidence), 'confidence not reset to the seed value')
  ok('seedFacet does not downgrade an already-observed facet')

  // 8. profileFacetCount counts every row on record (declared + observed, any confidence) —
  //    0 on a blank profile is the onboarding trigger.
  reset()
  assert.equal(profileFacetCount(), 0, 'blank profile has zero facets on record')
  seedFacet(brief, T)
  assert.equal(profileFacetCount(), 1, 'a single declared seed counts as one')
  observeFacet(detailed, 's1', T)         // a DIFFERENT dimension/facet_key/stance row
  assert.equal(profileFacetCount(), 2, 'counts both the declared seed and the observed facet')
  ok('profileFacetCount counts declared + observed rows at any confidence')

  console.log(`\n${passed} assertions passed.`)
} catch (e) {
  console.error('\nFAIL:', e instanceof Error ? e.message : e)
  process.exit(1)
} finally {
  delete process.env.CKN_GRAPH_DB_PATH
  delete process.env.CKN_EMBEDDINGS
  fs.rmSync(tmp, { recursive: true, force: true })
}
