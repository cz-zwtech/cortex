#!/usr/bin/env tsx
/**
 * nextLocalBase — localBase must reflect FEDERATED state, never raw local.
 * Regression for the data-loss trap: with the conflict-free transport
 * (fetch + reset-to-origin), advancing the baseline for an UN-PUSHED local-origin
 * edit makes the next sync revert the worktree to origin's old copy and then
 * adopt it over the live ~/.claude edit (base==local → "unchanged, remote moved").
 */
import assert from 'node:assert/strict'

const { nextLocalBase } = await import('../../server/privateMind.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// The bug: an un-pushed local edit must KEEP its prior (last-federated) base, so
// the reconcile keeps preferring the local edit (R===base → push-local) instead
// of adopting origin's old copy (L===base → adopt-remote).
{
  const out = nextLocalBase({
    prior: { 'memory/x.md': 'OLD' },
    localHashes: { 'memory/x.md': 'EDIT' },
    localOrigin: new Set(['memory/x.md']),
    federated: false,
  })
  assert.equal(out['memory/x.md'], 'OLD', 'un-pushed local edit keeps prior base (no data-loss adopt)')
  ok('un-pushed local-origin edit keeps prior base')
}

// Once a push lands it, the baseline advances to the new hash.
{
  const out = nextLocalBase({
    prior: { 'memory/x.md': 'OLD' },
    localHashes: { 'memory/x.md': 'EDIT' },
    localOrigin: new Set(['memory/x.md']),
    federated: true,
  })
  assert.equal(out['memory/x.md'], 'EDIT', 'federated edit advances base')
  ok('federated local-origin edit advances base')
}

// Adopted / in-sync (non-local-origin) files always take the local hash.
{
  const out = nextLocalBase({
    prior: { 'memory/a.md': 'X' },
    localHashes: { 'memory/a.md': 'Y' },
    localOrigin: new Set(),
    federated: false,
  })
  assert.equal(out['memory/a.md'], 'Y', 'adopted/in-sync file bases to local hash')
  ok('non-local-origin file bases to local hash')
}

// A brand-new un-pushed local-origin file (no prior base) is OMITTED — stays
// "never synced" so it re-pushes and is never mistaken for an adopt/delete.
{
  const out = nextLocalBase({
    prior: {},
    localHashes: { 'memory/new.md': 'H' },
    localOrigin: new Set(['memory/new.md']),
    federated: false,
  })
  assert.equal('memory/new.md' in out, false, 'brand-new un-pushed file omitted from base')
  ok('brand-new un-pushed local-origin file omitted')
}

// ...and once federated, the brand-new file is based.
{
  const out = nextLocalBase({
    prior: {},
    localHashes: { 'memory/new.md': 'H' },
    localOrigin: new Set(['memory/new.md']),
    federated: true,
  })
  assert.equal(out['memory/new.md'], 'H', 'federated brand-new file bases')
  ok('brand-new file bases once federated')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
