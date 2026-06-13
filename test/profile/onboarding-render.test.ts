#!/usr/bin/env tsx
/** renderProfileSection onboarding nudge: the /profile-setup prompt appears ONLY when the
 * onboarding flag is true (default false). */
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

// capabilitySheet may pull in graph-backed modules at import; point them at a throwaway DB.
process.env.CKN_EMBEDDINGS = 'off'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-onboarding-render-'))
process.env.CKN_GRAPH_DB_PATH = path.join(tmp, 'graph.sqlite')
const { getDb } = await import('../../server/graph/db.js')
getDb()

const { renderProfileSection } = await import('../../server/capabilitySheet.js')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
const empty = { narrative: '', facets: [] as any[] }

try {
  // 1. onboarding=true → the /profile-setup nudge mentioning a blank profile.
  const on = renderProfileSection(empty, [], true)
  assert.ok(on.includes('/profile-setup'), 'onboarding render names /profile-setup')
  assert.ok(/blank/i.test(on), 'onboarding render calls the profile blank')
  ok('onboarding=true renders the /profile-setup blank-profile nudge')

  // 2. onboarding=false → no /profile-setup nudge.
  const off = renderProfileSection(empty, [], false)
  assert.ok(!off.includes('/profile-setup'), 'onboarding=false omits the nudge')
  ok('onboarding=false omits the /profile-setup nudge')

  // 3. Default (third arg omitted) is false → no nudge.
  const def = renderProfileSection(empty, [])
  assert.ok(!def.includes('/profile-setup'), 'default omits the nudge (onboarding defaults to false)')
  ok('default (no third arg) omits the /profile-setup nudge')

  console.log(`\n${passed} assertions passed.`)
} catch (e) {
  console.error('\nFAIL:', e instanceof Error ? e.message : e)
  process.exit(1)
} finally {
  delete process.env.CKN_GRAPH_DB_PATH
  delete process.env.CKN_EMBEDDINGS
  fs.rmSync(tmp, { recursive: true, force: true })
}
