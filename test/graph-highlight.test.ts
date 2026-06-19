/**
 * #122(c) — pure highlight-decision helpers for the graph view. Extracted from
 * GraphCanvas so the per-element selection/filter styling is unit-testable (the
 * React/D3 component itself has no render harness). The component applies these
 * decisions to retained d3 selections (scoped to affected elements) instead of a
 * full-DOM selectAll sweep per selection/filter change.
 */
import assert from 'node:assert/strict'
import { nodeHighlight, textOpacity, edgeHighlight, setsEqual } from '../src/app/shell/graphHighlight.js'

const NONE = new Set<string>()

// ── nodeHighlight ───────────────────────────────────────────────────────────
{
  const active = nodeHighlight('a', 'memory', 'a', NONE)
  assert.deepEqual(active, { active: true, strokeWidth: 2.5, fillOpacity: 0.4, r: 9, opacity: 1 }, 'active node styling')

  const plain = nodeHighlight('b', 'memory', 'a', NONE)
  assert.deepEqual(plain, { active: false, strokeWidth: 1.4, fillOpacity: 0.18, r: 7, opacity: 1 }, 'non-active, no filter')

  // Cluster filter EXCLUDES this kind → dimmed.
  const dimmed = nodeHighlight('b', 'memory', 'a', new Set(['decision']))
  assert.equal(dimmed.fillOpacity, 0.05, 'filtered-out node fill dimmed')
  assert.equal(dimmed.opacity, 0.25, 'filtered-out node opacity dimmed')

  // Cluster filter INCLUDES this kind → full.
  const kept = nodeHighlight('b', 'memory', 'a', new Set(['memory']))
  assert.equal(kept.fillOpacity, 0.18, 'in-filter node fill full')
  assert.equal(kept.opacity, 1, 'in-filter node opacity full')

  // The ACTIVE node stays active-styled even when a filter would exclude its kind.
  const activeDespiteFilter = nodeHighlight('a', 'memory', 'a', new Set(['decision']))
  assert.equal(activeDespiteFilter.fillOpacity, 0.4, 'active node keeps active fill regardless of filter')
}

// ── textOpacity ─────────────────────────────────────────────────────────────
{
  assert.equal(textOpacity('memory', NONE), 0.95, 'no filter → full text')
  assert.equal(textOpacity('memory', new Set(['decision'])), 0.2, 'filtered-out → dim text')
  assert.equal(textOpacity('memory', new Set(['memory'])), 0.95, 'in-filter → full text')
}

// ── edgeHighlight ───────────────────────────────────────────────────────────
{
  const touches = edgeHighlight('a', 'b', 'memory', 'memory', 'a', NONE)
  assert.deepEqual(touches, { touchesActive: true, strokeOpacity: 0.9, strokeWidth: 1.4 }, 'edge touching active')

  const idle = edgeHighlight('x', 'y', 'memory', 'memory', 'a', NONE)
  assert.deepEqual(idle, { touchesActive: false, strokeOpacity: 0.55, strokeWidth: 1 }, 'edge not touching active, no filter')

  // Filter present, edge touches neither in-filter kind → dimmed.
  const filteredOut = edgeHighlight('x', 'y', 'memory', 'memory', null, new Set(['decision']))
  assert.equal(filteredOut.strokeOpacity, 0.1, 'edge outside filter dimmed')

  // Filter present, edge touches an in-filter kind → normal.
  const filteredIn = edgeHighlight('x', 'y', 'memory', 'decision', null, new Set(['decision']))
  assert.equal(filteredIn.strokeOpacity, 0.55, 'edge touching in-filter kind normal')
}

// ── setsEqual ───────────────────────────────────────────────────────────────
{
  assert.equal(setsEqual(new Set(['a', 'b']), new Set(['b', 'a'])), true, 'same elements → equal')
  assert.equal(setsEqual(new Set(['a']), new Set(['a', 'b'])), false, 'different size → not equal')
  assert.equal(setsEqual(new Set(['a', 'b']), new Set(['a', 'c'])), false, 'same size, different elems → not equal')
  assert.equal(setsEqual(NONE, new Set()), true, 'two empty sets → equal')
}

console.log('graph-highlight pure helpers: OK')
process.exit(0)
