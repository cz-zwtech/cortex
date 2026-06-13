#!/usr/bin/env tsx
/**
 * Pure decision for the stale-session-row prune. A presence row is pruned iff
 * EITHER it is raw `signed_off` AND >24h since last_seen, OR >30d since last_seen
 * (any status). live/idle/recent rows are always kept (age below both
 * thresholds), and a never-signed-off session under 30d is kept even if stale.
 */
import assert from 'node:assert/strict'
import {
  staleSessionPrune,
  PRUNE_SIGNED_OFF_MS,
  PRUNE_HARD_MS,
  type PruneSession,
} from '../../server/bus/pruneStaleSessions.js'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const sessions: PruneSession[] = [
  { sessionId: 'signed-off-25h', rawStatus: 'signed_off', lastSeen: NOW - 25 * HOUR }, // prune
  { sessionId: 'signed-off-1h', rawStatus: 'signed_off', lastSeen: NOW - 1 * HOUR }, // KEEP (grace)
  { sessionId: 'live', rawStatus: 'live', lastSeen: NOW - 1 * MIN }, // KEEP
  { sessionId: 'idle', rawStatus: 'live', lastSeen: NOW - 30 * MIN }, // KEEP
  { sessionId: 'abandoned-31d', rawStatus: 'live', lastSeen: NOW - 31 * DAY }, // prune (hard cap)
  { sessionId: 'stale-2h', rawStatus: 'live', lastSeen: NOW - 2 * HOUR }, // KEEP (under 30d)
]

const doomed = staleSessionPrune(sessions, NOW)

assert.deepEqual(
  doomed,
  ['signed-off-25h', 'abandoned-31d'],
  'prunes ONLY the signed_off+>24h and the >30d rows (exact id list, in order)',
)
assert.ok(!doomed.includes('signed-off-1h'), 'signed_off within the 24h grace is KEPT')
assert.ok(!doomed.includes('live'), 'a live (1-min) session is KEPT')
assert.ok(!doomed.includes('idle'), 'an idle (30-min) session is KEPT')
assert.ok(!doomed.includes('stale-2h'), 'a never-signed-off stale (2h, under 30d) session is KEPT')

// Boundary: strict greater-than on both thresholds.
assert.deepEqual(
  staleSessionPrune(
    [{ sessionId: 'edge', rawStatus: 'signed_off', lastSeen: NOW - PRUNE_SIGNED_OFF_MS }],
    NOW,
  ),
  [],
  'signed_off exactly at the 24h cutoff is KEPT (strict >)',
)
assert.deepEqual(
  staleSessionPrune([{ sessionId: 'edge', rawStatus: 'live', lastSeen: NOW - PRUNE_HARD_MS }], NOW),
  [],
  'any-status exactly at the 30d cutoff is KEPT (strict >)',
)

// A signed_off row also qualifies under the hard cap if >30d (either branch fires).
assert.deepEqual(
  staleSessionPrune(
    [{ sessionId: 'old-signed', rawStatus: 'signed_off', lastSeen: NOW - 40 * DAY }],
    NOW,
  ),
  ['old-signed'],
  'a >30d signed_off row is pruned',
)

console.log('stale-prune-decision OK')
process.exit(0)
