#!/usr/bin/env tsx
/**
 * §2 reconciliation (memory→file linkage, Fable's table). Keyed by (src,dst,rel) —
 * ONE MENTIONS_FILE edge per (memory,file). The author's frontmatter edit is
 * intent and wins both ways: listing a file UPGRADES a derived edge to frontmatter;
 * retracting it DOWNGRADES to derived (if the body still mentions it) or REMOVES it.
 * A purely body-derived edge persists while the body mentions it. Legacy NULL
 * provenance reads as 'frontmatter' (every pre-existing memory edge came from one).
 */
import assert from 'node:assert/strict'
import { reconcileFileEdgeOps } from '../../server/graph/reconcileFileEdges.ts'

// helper: find the action for a dst (undefined = no op emitted = left as-is)
const actionFor = (ops: ReturnType<typeof reconcileFileEdgeOps>, dst: string) =>
  ops.find((o) => o.dst === dst)?.action

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── the 7 rows of the table ─────────────────────────────────────────────────
{
  const ops = reconcileFileEdgeOps(
    [
      { dst: 'file:d_keep', provenance: 'derived' }, // derived + still derived → no op
      { dst: 'file:d_up', provenance: 'derived' }, // derived + now in frontmatter → upgrade
      { dst: 'file:f_keep', provenance: 'frontmatter' }, // frontmatter + still in fm → no op
      { dst: 'file:f_down', provenance: 'frontmatter' }, // fm + retracted, body has it → downgrade
      { dst: 'file:f_gone', provenance: 'frontmatter' }, // fm + retracted, body lacks it → remove
      { dst: 'file:d_gone', provenance: 'derived' }, // derived + body edited away → remove
    ],
    /* frontmatter */ ['file:f_keep', 'file:f_down_NO', 'file:d_up', 'file:new_fm'].filter((x) => x !== 'file:f_down_NO'),
    /* derived */ ['file:d_keep', 'file:f_down', 'file:new_derived'],
  )

  assert.equal(actionFor(ops, 'file:new_fm'), 'create-frontmatter', 'none + frontmatter → create-frontmatter')
  assert.equal(actionFor(ops, 'file:new_derived'), 'create-derived', 'none + derived-only → create-derived')
  assert.equal(actionFor(ops, 'file:d_up'), 'upgrade', 'derived + frontmatter → upgrade')
  assert.equal(actionFor(ops, 'file:f_keep'), undefined, 'frontmatter + still listed → no op')
  assert.equal(actionFor(ops, 'file:f_down'), 'downgrade', 'frontmatter retracted + body has it → downgrade')
  assert.equal(actionFor(ops, 'file:f_gone'), 'remove', 'frontmatter retracted + body lacks → remove')
  assert.equal(actionFor(ops, 'file:d_gone'), 'remove', 'derived + body edited away → remove')
  assert.equal(actionFor(ops, 'file:d_keep'), undefined, 'derived + body still mentions → no op')
  ok('all 7 rows + derived-stays resolve correctly')
}

// ── idempotency: a settled state yields ZERO ops (the re-run guarantee) ──────
{
  const ops = reconcileFileEdgeOps(
    [
      { dst: 'file:a', provenance: 'frontmatter' },
      { dst: 'file:b', provenance: 'derived' },
    ],
    ['file:a'],
    ['file:b'],
  )
  assert.deepEqual(ops, [], 're-running on a settled corpus produces no ops (idempotent)')
  ok('settled state → zero ops (idempotency)')
}

// ── precedence: same file in BOTH frontmatter and body → ONE frontmatter edge ─
{
  const ops = reconcileFileEdgeOps([], ['file:x'], ['file:x'])
  assert.equal(ops.length, 1, 'one op for the single (src,dst) pair')
  assert.equal(ops[0]!.action, 'create-frontmatter', 'frontmatter wins the precedence tie')
  ok('file in frontmatter AND body → one frontmatter edge')
}

console.log(`\nOK reconcile-file-edges.test.ts — ${passed} assertions passed`)
