#!/usr/bin/env tsx
/** Pure marker-fenced managed-block ops — append/upsert/extract/remove, no I/O. */
import assert from 'node:assert/strict'
import { upsertManagedBlock, extractManagedBlock, removeManagedBlock } from '../bin/_managed-block.js'

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
const ID = 'engagement'

// append when absent — preserves original, adds a single leading blank line
{
  const orig = '# CLAUDE.md\n\nMy hand-written stuff.\n'
  const out = upsertManagedBlock(orig, ID, ['- a', '- b'])
  assert.ok(out.startsWith(orig.trimEnd()), 'original content preserved at top')
  assert.match(out, /cortex:managed:engagement/, 'open marker present')
  assert.match(out, /\/cortex:managed:engagement/, 'close marker present')
  assert.match(out, /- a\n- b/, 'inner lines rendered')
  ok('append when absent')
}
// extract returns inner content
{
  const text = upsertManagedBlock('x\n', ID, ['- one', '- two'])
  const inner = extractManagedBlock(text, ID)
  assert.ok(inner && inner.includes('- one') && inner.includes('- two'), 'inner extracted')
  ok('extract inner')
}
// upsert replaces inner, preserves bytes OUTSIDE the markers verbatim
{
  const v1 = upsertManagedBlock('HEAD\n', ID, ['- old'])
  const withTail = v1 + '\nTAIL after block\n'
  const v2 = upsertManagedBlock(withTail, ID, ['- new1', '- new2'])
  assert.ok(v2.startsWith('HEAD'), 'head preserved')
  assert.match(v2, /TAIL after block/, 'tail preserved')
  assert.match(v2, /- new1\n- new2/, 'inner replaced')
  assert.ok(!v2.includes('- old'), 'old inner gone')
  ok('upsert replaces inner, preserves outside')
}
// idempotent: same lines → byte-identical
{
  const a = upsertManagedBlock('h\n', ID, ['- x'])
  const b = upsertManagedBlock(a, ID, ['- x'])
  assert.equal(a, b, 'idempotent re-render')
  ok('idempotent')
}
// remove strips block + markers, leaves the rest
{
  const text = 'A\n' + '\n<!-- cortex:managed:engagement -->\n- x\n<!-- /cortex:managed:engagement -->\n' + 'B\n'
  const out = removeManagedBlock(text, ID)
  assert.match(out, /A/, 'A kept'); assert.match(out, /B/, 'B kept')
  assert.ok(!out.includes('cortex:managed:engagement'), 'markers gone')
  assert.ok(!out.includes('- x'), 'inner gone')
  ok('remove')
}
// two different block ids coexist without collision
{
  let t = upsertManagedBlock('base\n', 'engagement', ['- e'])
  t = upsertManagedBlock(t, 'other', ['- o'])
  assert.match(t, /- e/); assert.match(t, /- o/)
  const t2 = removeManagedBlock(t, 'other')
  assert.match(t2, /- e/, 'engagement block survives removing other')
  assert.ok(!t2.includes('- o'), 'other removed')
  ok('multiple ids isolated')
}
// malformed (open marker, no close) → treated as absent; never throws, original kept intact
{
  const broken = 'top\n<!-- cortex:managed:engagement -->\n- dangling\n'
  const out = upsertManagedBlock(broken, ID, ['- safe'])
  assert.ok(typeof out === 'string' && out.includes('top'), 'no throw, content intact')
  ok('malformed markers handled safely')
}
console.log(`\n${passed} assertions passed.`)
