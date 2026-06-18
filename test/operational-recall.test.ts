#!/usr/bin/env tsx
/**
 * operationalRecall — the ckn-aware operational bucket (#119 Part 2). Two fixes
 * PM approved: (i) EXCLUDE session-state snapshots (precompact/handoff) so they
 * don't occupy operational slots; (ii) pull STANDING rules (ALWAYS/NEVER) to the
 * front so a rule like "ALWAYS ssh the -claude host" isn't crowded out of the
 * top-N by stronger-cosine but lower-priority hits. Pure + unit-tested.
 */
import assert from 'node:assert/strict'

const { isSessionState, isStandingRule, bucketOperational } = await import(
  '../server/graph/operationalRecall.js'
)

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const hit = (o: {
  name: string
  description?: string
  cosine?: number
  source?: string
  kind?: string
}): any => ({
  id: o.name,
  name: o.name,
  kind: o.kind ?? 'memory',
  description: o.description ?? '',
  content: '',
  scope: 'user',
  source: o.source ?? 'memory',
  syncedAt: 0,
  signals: { cosine: o.cosine ?? 0.9 },
})

// ── isSessionState ──
{
  assert.equal(isSessionState({ name: 'precompact-6d56-2026' }), true, 'precompact snapshot')
  assert.equal(isSessionState({ name: 'session-handoff-x' }), true, 'handoff snapshot')
  assert.equal(isSessionState({ name: 'ssh-claude-suffix-hosts' }), false, 'a real rule is not session-state')
  ok('isSessionState: matches precompact/handoff snapshots only')
}

// ── isStandingRule ──
{
  assert.equal(isStandingRule({ description: 'ALWAYS SSH to the -claude host' }), true, 'ALWAYS')
  assert.equal(isStandingRule({ description: 'NEVER use the bare hostname' }), true, 'NEVER')
  assert.equal(isStandingRule({ description: 'A standing operational rule for X' }), true, 'standing rule phrase')
  // corpus vocabulary: most must-always-surface rules use PINNED / STANDING markers
  assert.equal(isStandingRule({ description: 'environment-architecture PINNED' }), true, 'PINNED marker')
  assert.equal(isStandingRule({ description: 'zw-node multi-user parity STANDING note' }), true, 'STANDING marker')
  assert.equal(isStandingRule({ description: 'a long-standing habit, all lower-case' }), false, 'lowercase standing is not a marker')
  assert.equal(isStandingRule({ description: 'some normal memory about a thing' }), false, 'normal memory')
  ok('isStandingRule: ALWAYS/NEVER + PINNED/STANDING markers + standing-rule phrase')
}

// ── bucketOperational: standing-first, session-state/low-cosine/non-memory excluded ──
{
  const all = [
    hit({ name: 'cortex-a', description: 'normal note', cosine: 0.9 }),
    hit({ name: 'cortex-b', description: 'normal note', cosine: 0.85 }),
    hit({ name: 'precompact-xyz', description: 'session snapshot', cosine: 0.8 }), // session-state → out
    hit({ name: 'ssh-claude-suffix-hosts', description: 'ALWAYS SSH to the -claude host', cosine: 0.7 }), // standing, lower cosine
    hit({ name: 'cortex-c', description: 'normal note', cosine: 0.6 }),
    hit({ name: 'low', description: 'normal note', cosine: 0.3 }), // below gate → out
    hit({ name: 'shared-x', description: 'x', source: 'shared', cosine: 0.95 }), // not memory → out
  ]
  const out = bucketOperational(all, 5)
  assert.equal(out[0]?.name, 'ssh-claude-suffix-hosts', 'standing rule pulled to FRONT despite lower cosine')
  assert.ok(!out.some((h: any) => h.name === 'precompact-xyz'), 'session-state excluded')
  assert.ok(!out.some((h: any) => h.name === 'low'), 'below-cosine excluded')
  assert.ok(!out.some((h: any) => h.name === 'shared-x'), 'non-memory excluded')
  assert.ok(out.length <= 5, 'capped')
  ok('bucketOperational: standing-first; session-state / low-cosine / non-memory excluded')
}

// ── a PINNED-marked rule (corpus vocabulary) is boosted to the front too ──
{
  const all = [
    hit({ name: 'cortex-x', description: 'normal note', cosine: 0.95 }),
    hit({ name: 'systemd-user-docker', description: 'systemd-user docker parity PINNED', cosine: 0.5 }),
  ]
  const out = bucketOperational(all, 5)
  assert.equal(out[0]?.name, 'systemd-user-docker', 'PINNED rule pulled to front over a higher-cosine normal hit')
  ok('bucketOperational: PINNED-marked rule boosted to front')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
