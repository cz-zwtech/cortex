#!/usr/bin/env tsx
/**
 * #128 — pure helpers for the persisted/baked graph layout. The graph view bakes
 * node positions once and opens FROZEN at them (no radiate); it re-settles only when
 * the graph actually changed. The change-detector signature must be EDGE-AWARE
 * (edges drive force positions, and batch #2 is all about richer edges), and the
 * restore must map saved positions onto the current node set. Pure + dependency-free
 * so they're unit-testable without a render harness, mirroring graphHighlight.ts.
 */
import assert from 'node:assert/strict'
import { layoutSignature, restoreLayout, layoutCovers } from '../src/app/shell/graphLayout.ts'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const edges = [
  { from: 'a', to: 'b', rel: 'LINKS_TO' },
  { from: 'b', to: 'c', rel: 'SIMILAR_TO' },
]
const sig = layoutSignature(nodes, edges)

// ── signature: order-independent, node- AND edge-aware ──────────────────────────
{
  const reordered = layoutSignature(
    [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
    [{ from: 'b', to: 'c', rel: 'SIMILAR_TO' }, { from: 'a', to: 'b', rel: 'LINKS_TO' }],
  )
  assert.equal(reordered, sig, 'signature is order-independent (sorted)')
  ok('signature: stable under node/edge reordering')
}
{
  assert.notEqual(layoutSignature([...nodes, { id: 'd' }], edges), sig, 'a new node changes the sig')
  assert.notEqual(layoutSignature(nodes, [...edges, { from: 'a', to: 'c', rel: 'SIMILAR_TO' }]), sig, 'a new edge changes the sig (edge-aware)')
  assert.notEqual(layoutSignature(nodes, []), sig, 'edge count matters')
  assert.notEqual(
    layoutSignature(nodes, [{ from: 'a', to: 'b', rel: 'MENTIONS_FILE' }, { from: 'b', to: 'c', rel: 'SIMILAR_TO' }]),
    sig,
    "an edge's rel changes the sig (typed edges matter — #126/#127)",
  )
  ok('signature: node-add, edge-add, edge-count, and edge-rel all invalidate')
}

// ── restoreLayout: map saved positions onto the current node set ─────────────────
{
  const saved = { sig, nodes: [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }] }
  const restored = restoreLayout(saved, ['a', 'b', 'c'])
  assert.equal(restored.get('a')?.x, 1)
  assert.equal(restored.get('a')?.y, 2)
  assert.equal(restored.get('b')?.y, 4)
  assert.equal(restored.has('c'), false, 'a node with no saved position is not restored')
  assert.equal(restoreLayout(null, ['a']).size, 0, 'null saved layout -> empty restore')
  ok('restoreLayout: restores matching ids, skips missing, null-safe')
}

// ── layoutCovers: is the saved layout complete for the current nodes? ────────────
{
  const saved = { sig, nodes: [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }] }
  assert.equal(layoutCovers(saved, ['a', 'b']), true, 'covers all present')
  assert.equal(layoutCovers(saved, ['a', 'b', 'c']), false, 'missing c -> not covered')
  assert.equal(layoutCovers(null, ['a']), false, 'null -> not covered')
  ok('layoutCovers: true only when every current node has a saved position')
}

console.log(`\nOK graph-layout-persist.test.ts — ${passed} cases passed`)
process.exit(0)
