/**
 * The liveness mechanisms exist to answer ONE question per assertion: could this
 * evidence exist if the thing did not happen THIS RUN?
 *
 * The threat model is self-deception, not fraud. Nobody forges evidence; the
 * risk is evidence that exists equally in both worlds — and it already bit once,
 * when hand-fired dispatcher runs left trace entries indistinguishable from a
 * real session's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CANARY_TOOL_MARKER, mintNonce, nonceLine } from '../core/liveness.js'

test('a nonce is unique per invocation — a stale artifact cannot carry this run\'s', () => {
  const seen = new Set(Array.from({ length: 200 }, () => mintNonce()))
  assert.equal(seen.size, 200, 'no collisions')
})

test('the echoed line carries BOTH the event and the nonce, so the join is possible', () => {
  const n = mintNonce()
  const line = nonceLine('SessionStart', n)
  assert.match(line, new RegExp(`event="SessionStart"`))
  assert.match(line, new RegExp(`nonce="${n}"`))
})

test('the echoed line is self-describing to a human reading their own transcript', () => {
  // It lands in the user's context. Someone should be able to tell what it is
  // and that it is harmless without going looking for us.
  assert.match(nonceLine('SessionStart', mintNonce()), /cortex-liveness/)
})

test('the canary marker is a string no real command would contain', () => {
  // This is what lets the deny path ship unflagged. A flag would make it
  // test-only, which is the exact class of defect the trace was built to close.
  assert.equal(CANARY_TOOL_MARKER, 'cortex-uat-canary')
  for (const ordinary of ['ls -la', 'npm test', 'git status', 'rm -rf build', 'echo hello']) {
    assert.ok(!ordinary.includes(CANARY_TOOL_MARKER))
  }
})
