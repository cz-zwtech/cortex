#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Hermetic DB: point the graph at a temp file BEFORE importing db.js (the module
// reads CKN_GRAPH_DB_PATH at load time).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-refchain-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { __upsertSymbolsOn, resolveRefChain, refChain2 } = await import('../../server/graph/symbols.js')
const { getDb } = await import('../../server/graph/db.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const M = 'm'
const REPO = 'r'

// Seed a (repo, branch) coordinate with one symbol + a recorded GraphHead whose
// baseBranch encodes the ancestry edge. __upsertSymbolsOn writes a GraphHead per
// repo with baseBranch = opts.baseBranch, which is exactly the ancestry pointer
// resolveRefChain walks.
async function seedBranch(branch: string, baseBranch: string): Promise<void> {
  await __upsertSymbolsOn(
    getDb(),
    {
      symbols: [
        {
          id: `${REPO}:f.ts#fn_${branch.replace(/[^a-z0-9]/gi, '_')}`,
          name: 'fn',
          symbolKind: 'function',
          repo: REPO,
          file: 'f.ts',
          line: 1,
        },
      ],
      edges: [],
    },
    { machine: M, branch, baseBranch, commitSha: `sha_${branch}` },
  )
}

// ── N-level ancestry: epic/x → feature/y → main ──────────────────────────────
{
  await seedBranch('main', 'main') // root: base === self, walk stops here
  await seedBranch('feature/y', 'main')
  await seedBranch('epic/x', 'feature/y')

  const chain = await resolveRefChain(REPO, 'epic/x', M)
  assert.deepEqual(chain, ['epic/x', 'feature/y', 'main'], 'epic → feature → main')
  ok('N-level chain walks GraphHead.baseBranch ancestry')

  // querying mid-chain: feature/y → main (2 levels, but produced by the walk)
  const fchain = await resolveRefChain(REPO, 'feature/y', M)
  assert.deepEqual(fchain, ['feature/y', 'main'], 'feature → main')
  ok('mid-chain resolves the remaining ancestry')

  // querying the root: just [main] (self-base terminates immediately)
  const mchain = await resolveRefChain(REPO, 'main', M)
  assert.deepEqual(mchain, ['main'], 'root base alone')
  ok('root branch (self-base) resolves to itself')
}

// ── cycle safety: a → b → a must not loop ────────────────────────────────────
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-refchain-cyc-'))
  // re-seed in the SAME db but a distinct repo so heads don't collide
  const CYC = 'cyc'
  await __upsertSymbolsOn(
    getDb(),
    { symbols: [{ id: `${CYC}:f.ts#a`, name: 'a', symbolKind: 'function', repo: CYC, file: 'f.ts', line: 1 }], edges: [] },
    { machine: M, branch: 'a', baseBranch: 'b', commitSha: 's1' },
  )
  await __upsertSymbolsOn(
    getDb(),
    { symbols: [{ id: `${CYC}:f.ts#b`, name: 'b', symbolKind: 'function', repo: CYC, file: 'f.ts', line: 1 }], edges: [] },
    { machine: M, branch: 'b', baseBranch: 'a', commitSha: 's2' },
  )
  const chain = await resolveRefChain(CYC, 'a', M)
  // a → b → (a already seen) STOP. No infinite loop, each visited once.
  assert.deepEqual(chain, ['a', 'b'], 'cycle stops after each branch once')
  assert.equal(new Set(chain).size, chain.length, 'no duplicate branches')
  void dir2
  ok('cycle in ancestry is broken (no loop, no dupes)')
}

// ── missing-ancestry fallback: no GraphHead for the requested branch ──────────
{
  // A branch nobody ingested → no GraphHead → fall back to 2-level [branch, base].
  // base resolves from defaultBaseBranch (repo r's most-recently-extracted head's
  // base; the last seed was epic/x with base feature/y).
  const chain = await resolveRefChain(REPO, 'wip/never-ingested', M)
  assert.deepEqual(
    chain,
    ['wip/never-ingested', 'feature/y'],
    'missing ancestry → legacy 2-level [branch, defaultBase]',
  )
  ok('missing-ancestry falls back to 2-level chain')

  // explicit fallbackBase honored when ancestry missing
  const chain2 = await resolveRefChain(REPO, 'wip/x', M, 'develop')
  assert.deepEqual(chain2, ['wip/x', 'develop'], 'explicit fallbackBase used')
  ok('explicit fallbackBase used on missing ancestry')

  // branch === fallbackBase collapses to a single element (refChain2 semantics)
  const chain3 = await resolveRefChain(REPO, 'main', M, 'main')
  assert.deepEqual(chain3, ['main'], 'branch === base → single element')
  ok('branch equal to base collapses to single element')
}

// ── refChain2 still exported with legacy 2-level semantics ────────────────────
{
  assert.deepEqual(refChain2('feat', 'main'), ['feat', 'main'], '2-level')
  assert.deepEqual(refChain2('main', 'main'), ['main'], 'same → single')
  assert.deepEqual(refChain2('', 'main'), [''], 'empty branch yields single empty element')
  ok('refChain2 legacy fallback preserved')
}

console.log(`\n${passed} assertions passed.`)
