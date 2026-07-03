#!/usr/bin/env tsx
/**
 * #126 — pure edge-styling helpers for the graph view. getAllForGraph now exports
 * every entries<->entries edge carrying its `rel`, so the view colours edges by
 * type and offers an opt-in per-rel filter (mirroring the highlightedKinds cluster
 * filter). These helpers are pure so they're unit-testable without a render harness.
 */
import assert from 'node:assert/strict'
import { relColor, relVisible, DEFAULT_REL_COLOR } from '../src/app/shell/graphEdgeStyle.ts'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── relColor: known rels distinct + non-empty; unknown -> default ───────────────
{
  const rels = ['LINKS_TO', 'MENTIONS_FILE', 'MENTIONS_TOOL', 'EDITED_IN', 'CONTRADICTS', 'EVOLVED_INTO']
  for (const r of rels) {
    assert.equal(typeof relColor(r), 'string')
    assert.ok(relColor(r).length > 0, `${r} has a colour`)
  }
  assert.notEqual(relColor('LINKS_TO'), relColor('MENTIONS_FILE'), 'distinct rels get distinct colours')
  assert.notEqual(relColor('CONTRADICTS'), relColor('EVOLVED_INTO'), 'supersession rels distinguishable')
  ok('relColor: known rels return distinct non-empty colours')
}
{
  assert.equal(relColor('SOME_UNMAPPED_REL'), DEFAULT_REL_COLOR, 'unknown rel falls back to default colour')
  ok('relColor: unknown rel -> DEFAULT_REL_COLOR')
}

// ── relVisible: empty filter shows all; non-empty shows only members ────────────
{
  const none = new Set<string>()
  assert.equal(relVisible('MENTIONS_FILE', none), true, 'empty filter => everything visible')
  assert.equal(relVisible('LINKS_TO', none), true, 'empty filter => everything visible')
  ok('relVisible: empty filter shows all rels')
}
{
  const only = new Set(['LINKS_TO', 'CONTRADICTS'])
  assert.equal(relVisible('LINKS_TO', only), true, 'member rel visible')
  assert.equal(relVisible('CONTRADICTS', only), true, 'member rel visible')
  assert.equal(relVisible('MENTIONS_FILE', only), false, 'non-member rel hidden under an active filter')
  ok('relVisible: non-empty filter shows only member rels')
}

console.log(`\nOK graph-edge-style.test.ts — ${passed} cases passed`)
process.exit(0)
