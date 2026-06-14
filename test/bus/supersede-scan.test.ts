#!/usr/bin/env tsx
/**
 * #86 supersedeScan — the pure decision behind register's rebind/supersede.
 *
 * Two fixes over the old inline scan:
 *  (1) it runs on the EFFECTIVE (post-floor) name — registerSession passes
 *      effectiveName, so a floored post-compact session supersedes its stale
 *      real-name twin instead of scanning the bare id and missing it.
 *  (2) SAME-MACHINE scoped — a register on machine A must never sign off a
 *      machine-B live session (mesh resolves cross-machine by metaId). An
 *      UNSTAMPED prior (machine '' the column default, or NULL) is treated as
 *      legacy same-machine so a pre-stamp stale row still gets cleaned.
 * shouldRebind still gates each candidate, so a phantom (no transcript) can't
 * sign off a real (transcript-backed) prior.
 */
import assert from 'node:assert/strict'

const { supersedeScan } = await import('../../server/bus/identity.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const incoming = (over: Record<string, unknown> = {}) => ({
  effectiveName: 'cortex-dev',
  cwd: '/c',
  sessionId: 'B',
  machine: 'm1',
  hasTranscript: false,
  ...over,
})

// ── 1. floored / explicit, same machine → supersede (the core behavior) ──────
assert.deepEqual(
  supersedeScan(incoming(), [{ id: 'A', machine: 'm1', hasTranscript: false }]),
  ['A'],
)
ok('1: same-machine prior under the effective name is superseded (floored + non-floored)')

// ── 2. cross-machine prior → NOT superseded (the peer-race fix) ──────────────
assert.deepEqual(
  supersedeScan(incoming(), [{ id: 'A', machine: 'm2', hasTranscript: false }]),
  [],
)
ok('2: a different-machine live row is NOT signed off (cross-machine coexist)')

// ── 3 + 4. unstamped legacy prior ('' or NULL) → same-machine wildcard ───────
assert.deepEqual(
  supersedeScan(incoming(), [{ id: 'A', machine: '', hasTranscript: false }]),
  ['A'],
)
assert.deepEqual(
  supersedeScan(incoming(), [{ id: 'A', machine: null, hasTranscript: false }]),
  ['A'],
)
ok('3+4: unstamped prior (machine "" or NULL) is treated as legacy same-machine')

// ── 5. phantom incoming cannot supersede a real (transcript-backed) prior ────
assert.deepEqual(
  supersedeScan(incoming({ hasTranscript: false }), [{ id: 'A', machine: 'm1', hasTranscript: true }]),
  [],
)
ok('5: phantom-cannot-supersede-real invariant preserved (shouldRebind guard)')

// ── 6. a real incoming DOES supersede a transcript-less prior ────────────────
assert.deepEqual(
  supersedeScan(incoming({ hasTranscript: true }), [{ id: 'A', machine: 'm1', hasTranscript: false }]),
  ['A'],
)
ok('6: transcript-backed incoming supersedes a transcript-less same-machine prior')

// ── 7. the incoming session id itself is never superseded ────────────────────
assert.deepEqual(
  supersedeScan(incoming(), [{ id: 'B', machine: 'm1', hasTranscript: false }]),
  [],
)
ok('7: self id is never signed off')

// ── 8. mixed priors: same-machine + unstamped kept, other-machine dropped ────
assert.deepEqual(
  supersedeScan(incoming(), [
    { id: 'A', machine: 'm1', hasTranscript: false },
    { id: 'C', machine: 'm2', hasTranscript: false },
    { id: 'D', machine: '', hasTranscript: false },
  ]),
  ['A', 'D'],
)
ok('8: mixed priors — same-machine + unstamped superseded, other-machine coexists')

// ── 9. unstamped INCOMING does not sign off a stamped prior ──────────────────
assert.deepEqual(
  supersedeScan(incoming({ machine: '' }), [{ id: 'A', machine: 'm1', hasTranscript: false }]),
  [],
)
ok('9: an unstamped local register does not sign off a stamped (machine-known) prior')

console.log(`\n${passed} assertions passed.`)
process.exit(0)
