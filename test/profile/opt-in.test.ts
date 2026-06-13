#!/usr/bin/env tsx
/** Personality profile is opt-in via CKN_PROFILE (default OFF): env parsing +
 *  the capability sheet omits the whole "Your profile" section when off. */
import assert from 'node:assert/strict'
const { profileEnabled, renderMarkdown } = await import('../../server/capabilitySheet.js')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// 1) env parsing — default off; common truthy values enable.
const orig = process.env.CKN_PROFILE
const cases: [string | undefined, boolean][] = [
  [undefined, false], ['', false], ['0', false], ['off', false], ['no', false],
  ['1', true], ['on', true], ['true', true], ['TRUE', true], ['Yes', true],
]
for (const [v, exp] of cases) {
  if (v === undefined) delete process.env.CKN_PROFILE
  else process.env.CKN_PROFILE = v
  assert.equal(profileEnabled(), exp, `CKN_PROFILE=${JSON.stringify(v)} → ${exp}`)
}
if (orig === undefined) delete process.env.CKN_PROFILE
else process.env.CKN_PROFILE = orig
ok('profileEnabled parses CKN_PROFILE (default off)')

// 2) renderMarkdown gates the whole profile section on profileEnabled.
const base: any = {
  skills: [], agents: [], mcpServers: [], permissions: [],
  additionalDirectories: [], defaultMode: undefined, memories: [],
  identityMarkdown: '',
  profile: { narrative: 'NARR-MARKER', facets: [] },
  overrides: ['OVERRIDE-MARKER'],
  onboarding: false,
}
const off = renderMarkdown({ ...base, profileEnabled: false })
assert.ok(!off.includes('### Your profile'), 'profile heading omitted when off')
assert.ok(!off.includes('NARR-MARKER'), 'narrative not leaked when off')
assert.ok(!off.includes('OVERRIDE-MARKER'), 'overrides not leaked when off')

const on = renderMarkdown({ ...base, profileEnabled: true })
assert.ok(on.includes('### Your profile'), 'profile heading present when on')
assert.ok(on.includes('OVERRIDE-MARKER'), 'overrides surfaced when on')
ok('renderMarkdown omits the profile section when CKN_PROFILE is off')

console.log(`\n${passed} assertions passed.`)
