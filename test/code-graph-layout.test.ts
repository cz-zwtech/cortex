#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import { layoutCodeGraph, type LayoutInput } from '../src/app/shell/codeGraphLayout.js'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// fnB CALLS fnA → fnA is a dependency of fnB → fnA is to the LEFT (lower tier).
// Tiers run by longest path FROM a source node; a pure callee (no out-edges) is
// tier 0, its caller tier 1.
{
  const input: LayoutInput = {
    nodes: [
      { type: 'symbol', id: 'A', name: 'fnA', symbolKind: 'function', file: 'a.ts', line: 1, centrality: 1, groundTruthValid: true },
      { type: 'symbol', id: 'B', name: 'fnB', symbolKind: 'function', file: 'b.ts', line: 2, centrality: 0, groundTruthValid: true },
    ],
    edges: [{ from: 'B', to: 'A', kind: 'CALLS' }],
  }
  const out = layoutCodeGraph(input, { width: 800, height: 600 })
  const a = out.nodes.find((n) => n.id === 'A')!
  const b = out.nodes.find((n) => n.id === 'B')!
  assert.equal(a.tier, 0, 'callee fnA at tier 0')
  assert.equal(b.tier, 1, 'caller fnB at tier 1')
  assert.ok(a.x < b.x, 'dependency drawn left of dependent')
  ok('longest-path tiers place dependencies left')
}

// Containers: nodes grouped by file; one container per distinct file.
{
  const input: LayoutInput = {
    nodes: [
      { type: 'symbol', id: 'A', name: 'fnA', symbolKind: 'function', file: 'a.ts', line: 1, centrality: 0, groundTruthValid: true },
      { type: 'symbol', id: 'A2', name: 'fnA2', symbolKind: 'function', file: 'a.ts', line: 5, centrality: 0, groundTruthValid: true },
      { type: 'module', id: 'mod:r:c.ts', file: 'c.ts', symbolCount: 9 },
    ],
    edges: [],
  }
  const out = layoutCodeGraph(input, { width: 800, height: 600 })
  assert.equal(out.containers.length, 2, 'two file containers (a.ts, c.ts)')
  const aBox = out.containers.find((c) => c.file === 'a.ts')!
  assert.equal(aBox.nodeIds.length, 2, 'a.ts container holds both symbols')
  ok('nodes grouped into per-file containers')
}

// Cycle safety: A↔B must not infinite-loop; both get a finite tier.
{
  const input: LayoutInput = {
    nodes: [
      { type: 'symbol', id: 'A', name: 'a', symbolKind: 'function', file: 'a.ts', line: 1, centrality: 1, groundTruthValid: true },
      { type: 'symbol', id: 'B', name: 'b', symbolKind: 'function', file: 'b.ts', line: 1, centrality: 1, groundTruthValid: true },
    ],
    edges: [{ from: 'A', to: 'B', kind: 'CALLS' }, { from: 'B', to: 'A', kind: 'CALLS' }],
  }
  const out = layoutCodeGraph(input, { width: 800, height: 600 })
  assert.ok(out.nodes.every((n) => Number.isFinite(n.tier)), 'all tiers finite under a cycle')
  ok('cycles do not hang and yield finite tiers')
}

// Edge geometry: every input edge maps to a positioned edge with both endpoints.
{
  const input: LayoutInput = {
    nodes: [
      { type: 'symbol', id: 'A', name: 'a', symbolKind: 'function', file: 'a.ts', line: 1, centrality: 1, groundTruthValid: true },
      { type: 'symbol', id: 'B', name: 'b', symbolKind: 'function', file: 'b.ts', line: 1, centrality: 0, groundTruthValid: true },
    ],
    edges: [{ from: 'B', to: 'A', kind: 'IMPORTS' }],
  }
  const out = layoutCodeGraph(input, { width: 800, height: 600 })
  assert.equal(out.edges.length, 1, 'one positioned edge')
  const e = out.edges[0]!
  assert.equal(e.kind, 'IMPORTS', 'edge kind preserved for coloring')
  assert.ok(Number.isFinite(e.x1) && Number.isFinite(e.y1) && Number.isFinite(e.x2) && Number.isFinite(e.y2), 'endpoints positioned')
  ok('edges carry kind + positioned endpoints')
}

// An edge to a missing node is dropped (defensive — server should prevent this).
{
  const input: LayoutInput = {
    nodes: [{ type: 'symbol', id: 'A', name: 'a', symbolKind: 'function', file: 'a.ts', line: 1, centrality: 0, groundTruthValid: true }],
    edges: [{ from: 'A', to: 'GHOST', kind: 'CALLS' }],
  }
  const out = layoutCodeGraph(input, { width: 800, height: 600 })
  assert.equal(out.edges.length, 0, 'edge with unknown endpoint dropped')
  ok('dangling edges dropped')
}

console.log(`\n${passed} assertions passed.`)
