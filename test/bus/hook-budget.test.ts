#!/usr/bin/env tsx
/**
 * FR resume-presence S3a: prompt-boundary hook (ckn-pause-context) budget helpers.
 * The UserPromptSubmit hook must deliver presence + inbox within a small budget or
 * Claude Code discards its WHOLE output (a silent inbox drop). These bound the slow
 * bits so a cold resume against a slow server can't blow the budget:
 *   - watcherScanFitsBudget: gate the deferrable /proc watcher scan on remaining budget;
 *   - fetchBounded: an AbortController-bounded fetch that can never stall the hook.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { watcherScanFitsBudget, fetchBounded, HOOK_SOFT_BUDGET_MS } from '../../bin/_hook-budget.js'

// --- watcherScanFitsBudget: the /proc scan runs only while under the soft budget ---
assert.equal(watcherScanFitsBudget(50), true, 'a fast critical block leaves budget for the scan')
assert.equal(watcherScanFitsBudget(HOOK_SOFT_BUDGET_MS + 1), false, 'over budget → skip the scan')
assert.equal(watcherScanFitsBudget(HOOK_SOFT_BUDGET_MS), false, 'exactly at budget → skip (strict <)')
assert.equal(watcherScanFitsBudget(1500, 3000), true, 'honors an explicit budget override')

// --- fetchBounded: always settles by the deadline; null on timeout, Response on success ---
const slow = http.createServer((_req, res) => setTimeout(() => res.end('late'), 1000))
const fast = http.createServer((_req, res) => res.end('ok'))
await new Promise<void>((r) => slow.listen(0, () => r()))
await new Promise<void>((r) => fast.listen(0, () => r()))
const slowPort = (slow.address() as { port: number }).port
const fastPort = (fast.address() as { port: number }).port
try {
  const t0 = Date.now()
  const timedOut = await fetchBounded(`http://127.0.0.1:${slowPort}/`, {}, 150)
  const elapsed = Date.now() - t0
  assert.equal(timedOut, null, 'a response slower than the deadline yields null (bounded, not hung)')
  assert.ok(elapsed < 600, `returns by ~deadline, not the full 1s server delay (elapsed ${elapsed}ms)`)

  const ok = await fetchBounded(`http://127.0.0.1:${fastPort}/`, {}, 1000)
  assert.ok(ok && ok.ok, 'a fast response is returned as the Response')
} finally {
  slow.close()
  fast.close()
}

console.log('hook-budget OK')
process.exit(0)
