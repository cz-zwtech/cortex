#!/usr/bin/env tsx
/** Engagement-tagged feedback is excluded from the SOFT profile injection
 * (it's hard now, in the managed CLAUDE.md block); untagged feedback still
 * soft-injects as an interaction override. */
import assert from 'node:assert/strict'
const { selectOverrides, renderProfileSection } = await import('../../server/capabilitySheet.js')

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const memories = [
  { id: 'm1', name: 'plan-first', scope: 'user', kind: 'feedback',
    description: 'Plan before any significant change', bodyPreview: '', syncedAt: 2, engagement: 1 },
  { id: 'm2', name: 'options-pros-cons', scope: 'user', kind: 'feedback',
    description: 'Always give options with brief pros/cons', bodyPreview: '', syncedAt: 1, engagement: 0 },
  { id: 'm3', name: 'a-note', scope: 'user', kind: 'memory',
    description: 'not a feedback memory', bodyPreview: '', syncedAt: 0, engagement: 0 },
] as any

const overrides = selectOverrides(memories)
assert.deepEqual(overrides, ['Always give options with brief pros/cons'],
  'only untagged feedback survives as a soft override; engagement + non-feedback excluded')
ok('selectOverrides drops engagement-tagged + non-feedback')

const md = renderProfileSection({ narrative: '', facets: [] }, overrides)
assert.ok(md.includes('Always give options with brief pros/cons'), 'untagged override surfaced')
assert.ok(!md.includes('Plan before any significant change'), 'engagement directive NOT in soft section')
ok('renderProfileSection shows untagged, hides engagement-tagged')

console.log(`\n${passed} assertions passed.`)
