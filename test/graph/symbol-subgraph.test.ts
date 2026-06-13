#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Hermetic DB: point the graph at a temp file BEFORE importing db.js. The graph
// db module reads CKN_GRAPH_DB_PATH at module-load time, so this must run before
// the dynamic import below.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-subgraph-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { __upsertSymbolsOn, listSymbolSubgraph, setRepoDefaultBranch, forgetRepoBranchSymbols } =
  await import('../../server/graph/symbols.js')
const { getDb } = await import('../../server/graph/db.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// __upsertSymbolsOn qualifies every id to `${machine}@${branch}::${naturalId}`
// (see qualifyId), and edges store the qualified endpoints. listSymbolSubgraph
// returns those stored (qualified) ids verbatim — the Code-view selection flow
// keys off the qualified id, so node ids/edge endpoints must match it.
const qA = 'm@main::r:a.ts#fnA'
const qB = 'm@main::r:b.ts#fnB'
const qC = 'm@main::r:b.ts#fnC'

// Seed a tiny repo on branch 'main': a.ts has fnA (called by fnB in b.ts).
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'r:a.ts#fnA', name: 'fnA', symbolKind: 'function', repo: 'r', file: 'a.ts', line: 1 },
      { id: 'r:b.ts#fnB', name: 'fnB', symbolKind: 'function', repo: 'r', file: 'b.ts', line: 2 },
      { id: 'r:b.ts#fnC', name: 'fnC', symbolKind: 'function', repo: 'r', file: 'b.ts', line: 9 },
    ],
    edges: [{ src: 'r:b.ts#fnB', dst: 'r:a.ts#fnA', kind: 'CALLS' }],
  },
  { machine: 'm', branch: 'main', baseBranch: 'main', commitSha: 'sha1' },
)

// symbols mode, no cap: 3 symbol nodes + 1 CALLS edge, branch echoed.
{
  const g = await listSymbolSubgraph({ repo: 'r', branch: 'main', machine: 'm', mode: 'symbols', topN: 100 })
  assert.equal(g.branch, 'main', 'branch echoed')
  assert.equal(g.totalSymbols, 3, 'total counts the full set')
  assert.equal(g.truncated, false, 'not truncated under cap')
  const symNodes = g.nodes.filter((n) => n.type === 'symbol')
  assert.equal(symNodes.length, 3, 'three symbol nodes')
  const callEdges = g.edges.filter((e) => e.kind === 'CALLS')
  assert.equal(callEdges.length, 1, 'one CALLS edge')
  assert.equal(callEdges[0]!.from, qB, 'edge from fnB')
  assert.equal(callEdges[0]!.to, qA, 'edge to fnA')
  ok('symbols mode returns nodes + typed edges')
}

// modules mode: file→file aggregation. b.ts → a.ts via fnB→fnA.
{
  const g = await listSymbolSubgraph({ repo: 'r', branch: 'main', machine: 'm', mode: 'modules' })
  const modNodes = g.nodes.filter((n) => n.type === 'module')
  assert.equal(modNodes.length, 2, 'two module nodes (a.ts, b.ts)')
  const aMod = modNodes.find((n) => n.type === 'module' && n.file === 'a.ts')!
  assert.equal((aMod as any).symbolCount, 1, 'a.ts has 1 symbol')
  const bMod = modNodes.find((n) => n.type === 'module' && n.file === 'b.ts')!
  assert.equal((bMod as any).symbolCount, 2, 'b.ts has 2 symbols')
  assert.equal(g.edges.length, 1, 'one aggregated module edge')
  assert.equal(g.edges[0]!.from, bMod.id, 'edge from b.ts module')
  assert.equal(g.edges[0]!.to, aMod.id, 'edge to a.ts module')
  ok('modules mode aggregates file→file')
}

// cap: topN=1 keeps only the most-central symbol; truncated=true.
{
  const g = await listSymbolSubgraph({ repo: 'r', branch: 'main', machine: 'm', mode: 'symbols', topN: 1 })
  assert.equal(g.truncated, true, 'capped → truncated')
  const symNodes = g.nodes.filter((n) => n.type === 'symbol')
  assert.equal(symNodes.length, 1, 'only top-1 symbol node')
  assert.equal((symNodes[0] as any).id, qA, 'fnA is most central (1 dependent)')
  ok('topN cap keeps most-central symbols')
}

// branch resolution: omit branch → resolve from GraphHead baseBranch (main here).
{
  const g = await listSymbolSubgraph({ repo: 'r', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'main', 'resolved branch from GraphHead')
  assert.ok(g.totalSymbols === 3, 'resolved view non-empty')
  ok('branch omitted resolves from GraphHead')
}

// REGRESSION (the "merit" bug): symbols live on `master` while the GraphHead's
// baseBranch is `main`. Omitting the branch must resolve to the branch that
// actually HAS symbols (master), not the base (main) — resolving the base
// renders an empty graph even though the symbols pane (no branch filter) shows
// rows. See displaySymbolBranch vs defaultBaseBranch.
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'mr:x.ts#fnX', name: 'fnX', symbolKind: 'function', repo: 'mr', file: 'x.ts', line: 1 },
      { id: 'mr:y.ts#fnY', name: 'fnY', symbolKind: 'function', repo: 'mr', file: 'y.ts', line: 2 },
    ],
    edges: [{ src: 'mr:y.ts#fnY', dst: 'mr:x.ts#fnX', kind: 'CALLS' }],
  },
  { machine: 'm', branch: 'master', baseBranch: 'main', commitSha: 'sha2' },
)
{
  const g = await listSymbolSubgraph({ repo: 'mr', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'master', 'resolves to the symbol-bearing branch, not the base')
  assert.equal(g.totalSymbols, 2, 'non-empty: master symbols surfaced (was empty before the fix)')
  ok('omitted branch resolves to symbol-bearing branch (merit regression)')
}

// Branch DEFAULT PIN (the right-click "set as default"): with two branches the
// heuristic picks the richest (dev, 3 symbols); a pin overrides it, a stale pin
// (branch with no symbols) falls back to the heuristic, and clearing reverts.
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'pr:a.ts#a1', name: 'a1', symbolKind: 'function', repo: 'pr', file: 'a.ts', line: 1 },
      { id: 'pr:a.ts#a2', name: 'a2', symbolKind: 'function', repo: 'pr', file: 'a.ts', line: 2 },
      { id: 'pr:a.ts#a3', name: 'a3', symbolKind: 'function', repo: 'pr', file: 'a.ts', line: 3 },
    ],
    edges: [],
  },
  { machine: 'm', branch: 'dev', baseBranch: 'main', commitSha: 'd1' },
)
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'pr:b.ts#b1', name: 'b1', symbolKind: 'function', repo: 'pr', file: 'b.ts', line: 1 },
    ],
    edges: [],
  },
  { machine: 'm', branch: 'legacy', baseBranch: 'main', commitSha: 'l1' },
)
{
  let g = await listSymbolSubgraph({ repo: 'pr', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'dev', 'heuristic picks the richest branch')

  setRepoDefaultBranch('pr', 'legacy', 1)
  g = await listSymbolSubgraph({ repo: 'pr', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'legacy', 'pinned default overrides the heuristic')
  assert.equal(g.totalSymbols, 1, 'shows the pinned branch symbols')

  setRepoDefaultBranch('pr', 'ghost', 1)
  g = await listSymbolSubgraph({ repo: 'pr', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'dev', 'stale pin (no symbols) falls back to the heuristic')

  setRepoDefaultBranch('pr', null, 1)
  g = await listSymbolSubgraph({ repo: 'pr', machine: 'm', mode: 'symbols' })
  assert.equal(g.branch, 'dev', 'cleared pin reverts to the heuristic')
  ok('default-branch pin: honor / stale-fallback / clear')
}

// Branch-scoped forget: prune one branch, the repo's other branches survive.
// ('pr' from the pin block has dev=3, legacy=1.)
{
  const removed = await forgetRepoBranchSymbols('pr', 'legacy', 'm')
  assert.equal(removed, 1, 'forgot the single legacy symbol')
  const gone = await listSymbolSubgraph({ repo: 'pr', branch: 'legacy', machine: 'm', mode: 'symbols' })
  assert.equal(gone.totalSymbols, 0, 'legacy snapshot removed')
  const dev = await listSymbolSubgraph({ repo: 'pr', branch: 'dev', machine: 'm', mode: 'symbols' })
  assert.equal(dev.totalSymbols, 3, 'dev snapshot left intact')
  ok('branch-scoped forget removes only the named branch')
}

// Empty-branch ("") is a real, forgettable coordinate (pre-lineage/unstamped
// ingest). The branch-forget must handle it, leaving the named branch intact.
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'es:x.ts#x1', name: 'x1', symbolKind: 'function', repo: 'es', file: 'x.ts', line: 1 },
      { id: 'es:x.ts#x2', name: 'x2', symbolKind: 'function', repo: 'es', file: 'x.ts', line: 2 },
    ],
    edges: [],
  },
  { machine: 'm', branch: '', baseBranch: '', commitSha: '' },
)
await __upsertSymbolsOn(
  getDb(),
  {
    symbols: [
      { id: 'es:y.ts#y1', name: 'y1', symbolKind: 'function', repo: 'es', file: 'y.ts', line: 1 },
    ],
    edges: [],
  },
  { machine: 'm', branch: 'main', baseBranch: 'main', commitSha: 'e1' },
)
{
  const removed = await forgetRepoBranchSymbols('es', '', 'm')
  assert.equal(removed, 2, 'forgot the 2 unstamped (branch="") symbols')
  const gone = await listSymbolSubgraph({ repo: 'es', branch: '', machine: 'm', mode: 'symbols' })
  assert.equal(gone.totalSymbols, 0, 'empty-branch coordinate removed')
  const main = await listSymbolSubgraph({ repo: 'es', branch: 'main', machine: 'm', mode: 'symbols' })
  assert.equal(main.totalSymbols, 1, 'named branch left intact')
  ok('branch-scoped forget handles the empty-branch coordinate')
}

console.log(`\n${passed} assertions passed.`)
fs.rmSync(dir, { recursive: true, force: true })
