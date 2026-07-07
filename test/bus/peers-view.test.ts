#!/usr/bin/env tsx
/**
 * FR resume-presence S1 read-side: the default `ckn-bus peers` roster hides
 * signed_off ANCHOR rows (retained by the 90d-cap prune) so the list stays
 * meaningful; `--all` includes them. Pure filter — status-only, order-preserving.
 */
import assert from 'node:assert/strict'
import { visiblePeers } from '../../bin/_peers-view.js'

const peers = [
  { sessionId: 'a', status: 'live' },
  { sessionId: 'b', status: 'idle' },
  { sessionId: 'c', status: 'signed_off' },
  { sessionId: 'd', status: 'stale' },
  { sessionId: 'e', status: 'signed_off' },
]

// Default view: live/idle/stale only, signed_off hidden, order preserved.
assert.deepEqual(
  visiblePeers(peers, false).map((p) => p.sessionId),
  ['a', 'b', 'd'],
  'default view excludes signed_off, keeps live/idle/stale in order',
)

// --all: everything, order preserved.
assert.deepEqual(
  visiblePeers(peers, true).map((p) => p.sessionId),
  ['a', 'b', 'c', 'd', 'e'],
  'include-all view shows signed_off too',
)

// Degenerate inputs.
assert.deepEqual(visiblePeers([], false), [], 'empty in, empty out')
assert.deepEqual(
  visiblePeers([{ sessionId: 'z', status: 'signed_off' }], false).length,
  0,
  'all-signed_off default view is empty',
)

console.log('peers-view OK')
process.exit(0)
