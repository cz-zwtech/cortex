#!/usr/bin/env tsx
/**
 * Unit test for bin/_blast-freshness.ts.
 *   - decideFreshness: pure (injected heads + provenance) — fresh / commit-drift
 *     / dirty / no-head cases.
 *   - ensureFresh: degradation paths via injected deps (no-refresh snapshot,
 *     refresh success → 'refreshed', refresh failure → 'stale', non-git → 'unknown').
 *
 * Run: npx tsx test/blast/freshness.test.ts
 */
import assert from 'node:assert/strict'
import { decideFreshness, ensureFresh } from '../../bin/_blast-freshness.js'
import type { GraphHeadRow } from '../../server/graph/_rows.js'
import type { GitProvenance } from '../../server/git/provenance.js'
import type { ResolvedTarget } from '../../bin/_blast-target.js'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const head = (over: Partial<GraphHeadRow> = {}): GraphHeadRow => ({
  repo: 'cortex',
  branch: 'main',
  machine: 'M',
  commitSha: 'abc123',
  dirty: false,
  dirtyFiles: '',
  baseBranch: 'main',
  extractedAt: 1000,
  ...over,
})

const prov = (over: Partial<GitProvenance> = {}): GitProvenance => ({
  branch: 'main',
  commitSha: 'abc123',
  dirty: false,
  dirtyFiles: '',
  baseBranch: 'main',
  ...over,
})

const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  repo: 'cortex',
  repoRoot: '/repo',
  branch: 'main',
  baseBranch: 'main',
  file: 'src/a.ts',
  mode: 'file',
  provenance: prov(),
  ...over,
})

// ── decideFreshness (pure) ───────────────────────────────────────────────────

// 1) same commit, clean tree, matching head → fresh.
{
  const d = decideFreshness({ heads: [head()], provenance: prov(), branch: 'main' })
  assert.equal(d, 'fresh')
  ok('same commit + clean → fresh')
}

// 2) commit drift → stale.
{
  const d = decideFreshness({
    heads: [head({ commitSha: 'old000' })],
    provenance: prov({ commitSha: 'new999' }),
    branch: 'main',
  })
  assert.equal(d, 'stale')
  ok('commit drift → stale')
}

// 3) dirty working tree (same commit) → stale.
{
  const d = decideFreshness({
    heads: [head()],
    provenance: prov({ dirty: true, dirtyFiles: ' M src/a.ts' }),
    branch: 'main',
  })
  assert.equal(d, 'stale')
  ok('dirty working tree → stale')
}

// 4) no head for the branch → stale (graph has nothing on this branch).
{
  const d = decideFreshness({
    heads: [head({ branch: 'other' })],
    provenance: prov(),
    branch: 'main',
  })
  assert.equal(d, 'stale')
  ok('no matching head → stale')
}

// 5) non-git (empty commit) → unknown.
{
  const d = decideFreshness({
    heads: [],
    provenance: prov({ commitSha: '', branch: '' }),
    branch: '',
  })
  assert.equal(d, 'unknown')
  ok('non-git provenance → unknown')
}

// ── ensureFresh (degradation paths via injected deps) ────────────────────────

const staleHeads = [head({ commitSha: 'old000' })]
const driftProv = prov({ commitSha: 'new999' })

// 6) --no-refresh on a stale target → snapshot, status 'stale', no ingest call.
{
  let ingestCalls = 0
  const r = await ensureFresh(
    target({ provenance: driftProv }),
    { refresh: false },
    {
      readGraphHeads: async () => staleHeads,
      ingestRepo: async () => {
        ingestCalls++
        return { symbols: 0, edges: 0, invalidated: 0 }
      },
      isServerUp: async () => true,
      acquireLock: async () => () => {},
    },
  )
  assert.equal(r.status, 'stale', 'no-refresh keeps it stale')
  assert.equal(ingestCalls, 0, 'no-refresh does not re-ingest')
  ok('--no-refresh → stale snapshot, no ingest')
}

// 7) stale + refresh allowed → re-ingest, status 'refreshed'.
{
  let ingestCalls = 0
  let released = false
  const r = await ensureFresh(
    target({ provenance: driftProv }),
    { refresh: true },
    {
      readGraphHeads: async () => staleHeads,
      ingestRepo: async () => {
        ingestCalls++
        return { symbols: 5, edges: 3, invalidated: 1 }
      },
      isServerUp: async () => true,
      acquireLock: async () => () => {
        released = true
      },
    },
  )
  assert.equal(r.status, 'refreshed', 'stale + refresh → refreshed')
  assert.equal(ingestCalls, 1, 're-ingested once')
  assert.equal(released, true, 'lock released')
  ok('stale + refresh → refreshed (ingest once, lock released)')
}

// 8) re-ingest throws → degrade to 'stale' (never block), with detail.
{
  const r = await ensureFresh(
    target({ provenance: driftProv }),
    { refresh: true },
    {
      readGraphHeads: async () => staleHeads,
      ingestRepo: async () => {
        throw new Error('extract boom')
      },
      isServerUp: async () => true,
      acquireLock: async () => () => {},
    },
  )
  assert.equal(r.status, 'stale', 'refresh failure degrades to stale')
  assert.match(r.detail ?? '', /boom/, 'detail carries the failure reason')
  ok('refresh failure → stale (never blocks)')
}

// 9) fresh target → no-op, no ingest.
{
  let ingestCalls = 0
  const r = await ensureFresh(
    target(),
    { refresh: true },
    {
      readGraphHeads: async () => [head()],
      ingestRepo: async () => {
        ingestCalls++
        return { symbols: 0, edges: 0, invalidated: 0 }
      },
      isServerUp: async () => true,
      acquireLock: async () => () => {},
    },
  )
  assert.equal(r.status, 'fresh')
  assert.equal(ingestCalls, 0, 'fresh → no ingest')
  ok('fresh → no-op')
}

// 10) non-git target → unknown, no ingest, no server requirement.
{
  let ingestCalls = 0
  const r = await ensureFresh(
    target({ provenance: prov({ commitSha: '', branch: '' }), branch: '' }),
    { refresh: true },
    {
      readGraphHeads: async () => [],
      ingestRepo: async () => {
        ingestCalls++
        return { symbols: 0, edges: 0, invalidated: 0 }
      },
      isServerUp: async () => true,
      acquireLock: async () => () => {},
    },
  )
  assert.equal(r.status, 'unknown')
  assert.equal(ingestCalls, 0, 'non-git → no ingest')
  ok('non-git → unknown, no ingest')
}

// 11) server down → throw with ckn-start guidance (only when a refresh is needed).
{
  let threw = false
  try {
    await ensureFresh(
      target({ provenance: driftProv }),
      { refresh: true },
      {
        readGraphHeads: async () => {
          throw new Error('ECONNREFUSED')
        },
        ingestRepo: async () => ({ symbols: 0, edges: 0, invalidated: 0 }),
        isServerUp: async () => false,
        acquireLock: async () => () => {},
      },
    )
  } catch (e: any) {
    threw = true
    assert.match(String(e?.message ?? e), /ckn-start/, 'guidance mentions ckn-start')
  }
  assert.equal(threw, true, 'server-down throws')
  ok('server down → throws with ckn-start guidance')
}

console.log(`\n${passed} assertions passed.`)
