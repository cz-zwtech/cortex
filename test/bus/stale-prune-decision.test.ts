#!/usr/bin/env tsx
/**
 * Pure decision for the stale-session-row prune — ANCHOR model. A presence row is
 * pruned iff `(now - last_seen) > PRUNE_HARD_MS` (90d), REGARDLESS of status. A
 * signed_off / stale row under the cap is RETAINED as a durable identity anchor so
 * a `--resume` finds it and UPDATE-rebinds (name + started_at + counters preserved)
 * instead of hollow-INSERTing. There is no separate signed_off (24h) delete.
 */
import assert from 'node:assert/strict'
import { staleSessionPrune, PRUNE_HARD_MS, type PruneSession } from '../../server/bus/pruneStaleSessions.js'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const sessions: PruneSession[] = [
  { sessionId: 'signed-off-25h', rawStatus: 'signed_off', lastSeen: NOW - 25 * HOUR }, // KEEP (anchor)
  { sessionId: 'signed-off-89d', rawStatus: 'signed_off', lastSeen: NOW - 89 * DAY }, // KEEP (under cap)
  { sessionId: 'signed-off-91d', rawStatus: 'signed_off', lastSeen: NOW - 91 * DAY }, // prune (hard cap)
  { sessionId: 'live', rawStatus: 'live', lastSeen: NOW - 1 * MIN }, // KEEP
  { sessionId: 'stale-2h', rawStatus: 'live', lastSeen: NOW - 2 * HOUR }, // KEEP
  { sessionId: 'abandoned-91d', rawStatus: 'live', lastSeen: NOW - 91 * DAY }, // prune (hard cap)
]

const doomed = staleSessionPrune(sessions, NOW)

assert.deepEqual(
  doomed,
  ['signed-off-91d', 'abandoned-91d'],
  'prunes ONLY rows past the 90d hard cap (any status); a signed_off under 90d is a retained anchor',
)
assert.ok(!doomed.includes('signed-off-25h'), 'a signed_off 25h anchor is KEPT (no 24h delete anymore)')
assert.ok(!doomed.includes('signed-off-89d'), 'a signed_off 89d row is KEPT (under the 90d cap)')
assert.ok(!doomed.includes('live'), 'a live session is KEPT')
assert.ok(!doomed.includes('stale-2h'), 'a stale (2h) session is KEPT')

// The hard cap is 90 days (Corey-locked).
assert.equal(PRUNE_HARD_MS, 90 * DAY, 'hard cap is 90 days')

// Boundary: strict greater-than — exactly at the cutoff is KEPT.
assert.deepEqual(
  staleSessionPrune(
    [{ sessionId: 'edge', rawStatus: 'signed_off', lastSeen: NOW - PRUNE_HARD_MS }],
    NOW,
  ),
  [],
  'exactly at the 90d cutoff is KEPT (strict >)',
)

console.log('stale-prune-decision OK')
process.exit(0)
