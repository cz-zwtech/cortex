#!/usr/bin/env tsx
/** renderProfileSection: descriptive, gated, capped, override-aware. */
import assert from 'node:assert/strict'
const { renderProfileSection } = await import('../../server/capabilitySheet.js')

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const md = renderProfileSection(
  { narrative: 'Corey is decisive and values terse, high-signal exchanges.',
    facets: [
      { id: 'a', dimension: 'communication', facet_key: 'verbosity', stance: 'terse',
        statement: 'Prefers terse answers with options + pros/cons', valence: 'trait',
        competing_group: 'communication:verbosity', confidence: 0.78, trend: 'strengthening',
        evidence_count: 4, first_observed: 1, last_observed: 2 } as any,
    ] },
  ['Always give options with brief pros/cons'],  // feedback override one-liners
)
assert.ok(md.includes('### Your profile'), 'has the profile heading')
assert.ok(md.includes('Corey is decisive'), 'includes narrative')
assert.ok(md.includes('terse'), 'includes an active facet')
assert.ok(/not.*rules|behav/i.test(md), 'frames perception as descriptive, not rules')
assert.ok(md.includes('options with brief pros/cons'), 'surfaces interaction overrides')
assert.ok(!md.includes('What Cortex has observed about this user'), 'old block is gone')
ok('renderProfileSection composes narrative + facets + overrides')
console.log(`\n${passed} assertions passed.`)
