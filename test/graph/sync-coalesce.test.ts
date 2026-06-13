#!/usr/bin/env tsx
/**
 * commit-1 (sync-saturation) c — single-flight coalescing.
 *
 * N sessions hitting their Stop-hook sync near-simultaneously queued N full
 * passes behind the write lock = the multiplicative saturation. Coalescing
 * makes all callers arriving during an in-flight pass share that pass, plus ONE
 * trailing pass (their writes may have landed after the active pass began), so
 * a burst of N → exactly 2 runs, never N.
 *
 * Pure timing logic (no DB), but importing sync.js pulls db.js — set the temp
 * env first, same as the other graph tests.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-coalesce-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { coalesceSync } = await import('../../server/graph/sync.js')

let invocations = 0
const run = (): Promise<number> => {
  invocations++
  const mine = invocations
  return new Promise((resolve) => setTimeout(() => resolve(mine), 20))
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. a burst of 5 concurrent callers → 1 active + 1 trailing pass
{
  const ps = Array.from({ length: 5 }, () => coalesceSync(run))
  const results = await Promise.all(ps)
  assert.equal(invocations, 2, '5 concurrent callers → exactly 2 runs (active + 1 trailing)')
  assert.equal(results.filter((r) => r === 1).length, 1, 'one caller got the active pass (run #1)')
  assert.equal(results.filter((r) => r === 2).length, 4, 'four callers coalesced into the trailing pass (run #2)')
  ok('burst of N coalesces to 1 active + 1 trailing, all callers get a result')
}

// ── 2. a later call (after the burst settled) starts a fresh pass
{
  const r = await coalesceSync(run)
  assert.equal(invocations, 3, 'a call after settle starts a fresh pass')
  assert.equal(r, 3, 'fresh caller gets its own pass result')
  ok('a later call is not stuck on the prior coalesced pass')
}

console.log(`\nOK sync-coalesce.test.ts — ${passed} assertions passed`)
