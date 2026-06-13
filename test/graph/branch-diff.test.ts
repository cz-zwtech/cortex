#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Hermetic DB: set CKN_GRAPH_DB_PATH BEFORE importing db.js (read at load time).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-branchdiff-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { __upsertSymbolsOn, symbolBranchDiff } = await import('../../server/graph/symbols.js')
const { getDb } = await import('../../server/graph/db.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const M = 'm'
const REPO = 'r'

interface SeedSym {
  nat: string // naturalId (repo:file#name)
  name: string
  file: string
  line?: number
  signature?: string
}

// Seed one branch's symbol set (its own qualified ids via __upsertSymbolsOn).
async function seed(branch: string, baseBranch: string, syms: SeedSym[]): Promise<void> {
  await __upsertSymbolsOn(
    getDb(),
    {
      symbols: syms.map((s) => ({
        id: s.nat,
        name: s.name,
        symbolKind: 'function',
        repo: REPO,
        file: s.file,
        line: s.line ?? 1,
        signature: s.signature ?? 'v1',
      })),
      edges: [],
    },
    { machine: M, branch, baseBranch, commitSha: `sha_${branch}` },
  )
}

const NAT = {
  foo: `${REPO}:a.ts#foo`,
  bar: `${REPO}:a.ts#bar`,
  qux: `${REPO}:b.ts#qux`,
  newA: `${REPO}:c.ts#newA`,
  newB: `${REPO}:c.ts#newB`,
}

// base 'main': foo/bar/qux all at v1
await seed('main', 'main', [
  { nat: NAT.foo, name: 'foo', file: 'a.ts', signature: 'v1' },
  { nat: NAT.bar, name: 'bar', file: 'a.ts', signature: 'v1' },
  { nat: NAT.qux, name: 'qux', file: 'b.ts', signature: 'v1' },
])

// branch 'a': foo changed (v2), bar unchanged (v1), qux unchanged (v1), newA added
await seed('a', 'main', [
  { nat: NAT.foo, name: 'foo', file: 'a.ts', signature: 'v2' },
  { nat: NAT.bar, name: 'bar', file: 'a.ts', signature: 'v1' },
  { nat: NAT.qux, name: 'qux', file: 'b.ts', signature: 'v1' },
  { nat: NAT.newA, name: 'newA', file: 'c.ts', signature: 'v1' },
])

// branch 'b': foo changed (v3), bar changed (v2), qux REMOVED, newB added
await seed('b', 'main', [
  { nat: NAT.foo, name: 'foo', file: 'a.ts', signature: 'v3' },
  { nat: NAT.bar, name: 'bar', file: 'a.ts', signature: 'v2' },
  { nat: NAT.newB, name: 'newB', file: 'c.ts', signature: 'v1' },
])

const nats = (rows: { naturalId: string }[]) => rows.map((r) => r.naturalId).sort()

// ── direct A↔B diff ──────────────────────────────────────────────────────────
{
  const diff = await symbolBranchDiff(REPO, 'a', 'b', { base: 'main', machine: M })

  assert.equal(diff.base, 'main', 'base echoed')

  // added = on A, not B: newA (B has no newA) + qux (B removed it)
  assert.deepEqual(nats(diff.added), [NAT.newA, NAT.qux].sort(), 'added = A-not-B')
  ok('added: symbols on A but not B')

  // removed = on B, not A: newB
  assert.deepEqual(nats(diff.removed), [NAT.newB], 'removed = B-not-A')
  ok('removed: symbols on B but not A')

  // changed = on both, fingerprint differs: foo (v2 vs v3), bar (v1 vs v2)
  assert.deepEqual(nats(diff.changed), [NAT.bar, NAT.foo].sort(), 'changed = both-differ')
  ok('changed: symbols present on both with differing fingerprint')
}

// ── competing intersection (the conflict warning) ─────────────────────────────
{
  const diff = await symbolBranchDiff(REPO, 'a', 'b', { base: 'main', machine: M })
  // A touched vs base: foo (v2≠v1), newA (new). bar=v1 unchanged, qux=v1 unchanged.
  // B touched vs base: foo (v3≠v1), bar (v2≠v1), newB (new).
  // intersection: foo only.
  assert.deepEqual(nats(diff.competing), [NAT.foo], 'competing = touched-on-both-vs-base')
  ok('competing: only foo (touched on BOTH a and b vs base)')

  // the competing descriptor carries the natural id + name/file/line
  const c = diff.competing[0]!
  assert.equal(c.name, 'foo', 'competing carries name')
  assert.equal(c.file, 'a.ts', 'competing carries file')
  ok('competing entries carry the symbol descriptor')
}

// ── base resolution via GraphHead when omitted ───────────────────────────────
{
  // omit base → resolves from defaultBaseBranch (GraphHead recorded base).
  // every seeded branch recorded base 'main', so the most-recent head's base is 'main'.
  const diff = await symbolBranchDiff(REPO, 'a', 'b', { machine: M })
  assert.equal(diff.base, 'main', 'base defaults to GraphHead-resolved main')
  assert.deepEqual(nats(diff.competing), [NAT.foo], 'competing unchanged with resolved base')
  ok('base resolves from GraphHead when omitted')
}

// ── no competing when branches touch disjoint symbols ────────────────────────
{
  // branch 'c': only bar changed (vs base). branch 'd': only foo changed.
  await seed('c', 'main', [
    { nat: NAT.foo, name: 'foo', file: 'a.ts', signature: 'v1' }, // unchanged
    { nat: NAT.bar, name: 'bar', file: 'a.ts', signature: 'vC' }, // changed
    { nat: NAT.qux, name: 'qux', file: 'b.ts', signature: 'v1' },
  ])
  await seed('d', 'main', [
    { nat: NAT.foo, name: 'foo', file: 'a.ts', signature: 'vD' }, // changed
    { nat: NAT.bar, name: 'bar', file: 'a.ts', signature: 'v1' }, // unchanged
    { nat: NAT.qux, name: 'qux', file: 'b.ts', signature: 'v1' },
  ])
  const diff = await symbolBranchDiff(REPO, 'c', 'd', { base: 'main', machine: M })
  assert.deepEqual(diff.competing, [], 'disjoint touches → no competing')
  // but they still differ (foo: v1 vs vD, bar: vC vs v1) → changed has both
  assert.deepEqual(nats(diff.changed), [NAT.bar, NAT.foo].sort(), 'both still appear as changed A↔B')
  ok('disjoint changes → empty competing, still reported as changed')
}

console.log(`\n${passed} assertions passed.`)
