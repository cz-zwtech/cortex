#!/usr/bin/env tsx
/**
 * retryOnce — the #97 fix primitive. The private-mind clone/fetch over altssh:443
 * intermittently fails on first contact (a redundant fetch racing the just-finished
 * SSH dial). A single retry after a short backoff turns that transient into a
 * success instead of a scary "[ckn-mind] fatal: ...fetch...failed". Pure + injectable
 * so the retry policy is tested without spawning real git.
 *
 * Proves:
 *   1. a transient failure then success → resolves the success; fn called twice.
 *   2. first attempt already succeeds → fn called exactly once (no needless retry).
 *   3. fn fails BOTH times → returns the last (failed) result, fn called twice (the
 *      caller still sees the failure to surface/throw — retry never hides a real failure).
 */
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'

// Decouple the module from real mind state before import.
process.env.CKN_PRIVATE_MIND_PATH = path.join(os.tmpdir(), `ckn-retry-unused-${process.pid}`)

const { retryOnce } = await import('../../server/privateMind.js')

type R = { code: number }
const retryable = (r: R) => r.code !== 0

// 1. transient failure then success → success, two attempts.
{
  let n = 0
  const r = await retryOnce<R>(() => Promise.resolve(++n === 1 ? { code: 1 } : { code: 0 }), retryable, 0)
  assert.equal(r.code, 0, 'a transient failure is retried into a success')
  assert.equal(n, 2, 'fn was called exactly twice (one retry)')
}

// 2. first attempt succeeds → no retry.
{
  let n = 0
  const r = await retryOnce<R>(() => Promise.resolve((n++, { code: 0 })), retryable, 0)
  assert.equal(r.code, 0, 'first success returned')
  assert.equal(n, 1, 'no needless retry when the first attempt succeeds')
}

// 3. both attempts fail → last failed result returned, two attempts (failure not hidden).
{
  let n = 0
  const r = await retryOnce<R>(() => Promise.resolve((n++, { code: 1 })), retryable, 0)
  assert.equal(r.code, 1, 'a persistent failure is surfaced (not swallowed)')
  assert.equal(n, 2, 'retried exactly once before giving up')
}

console.log('git-retry OK — retryOnce turns a transient into success, surfaces a persistent failure')
