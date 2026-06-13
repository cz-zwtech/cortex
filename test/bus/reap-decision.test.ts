#!/usr/bin/env tsx
/**
 * Pure decision for the startup reap of orphaned `ckn-bus watch` processes.
 * Conservative by design: reap ONLY a watcher whose session row exists, is raw
 * `signed_off`, AND whose last_seen is older than 60 min. Never reaps a
 * live/idle/resuming session, nor a proc whose session row is absent.
 */
import assert from 'node:assert/strict'
import { reapDecision, type WatcherProc, type ReapSession } from '../../bin/_bus-watch.js'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

const procs: WatcherProc[] = [
  { pid: 101, sessionId: 'old-signed-off' }, // signed_off 2h ago → reap
  { pid: 102, sessionId: 'recent-signed-off' }, // signed_off 2m ago → keep (may be resuming)
  { pid: 103, sessionId: 'live' }, // live/recent → keep
  { pid: 104, sessionId: 'ghost' }, // no session row → keep (may be registering)
]

const sessions: ReapSession[] = [
  { sessionId: 'old-signed-off', rawStatus: 'signed_off', lastSeen: NOW - 2 * HOUR },
  { sessionId: 'recent-signed-off', rawStatus: 'signed_off', lastSeen: NOW - 2 * MIN },
  { sessionId: 'live', rawStatus: 'live', lastSeen: NOW - 1000 },
  // 'ghost' deliberately absent.
]

const kill = reapDecision(procs, sessions, NOW)

assert.deepEqual(kill, [101], 'reaps ONLY the signed_off + >60min-stale watcher (exact pid list)')
assert.ok(!kill.includes(102), 'a signed_off-but-recent session is NOT reaped (might be resuming)')
assert.ok(!kill.includes(103), 'a live session is NOT reaped')
assert.ok(!kill.includes(104), 'a proc whose session row is absent is NOT reaped (conservative)')

// Edge: signed_off exactly at the 60-min cutoff is NOT reaped (strict >).
const edge = reapDecision(
  [{ pid: 200, sessionId: 'edge' }],
  [{ sessionId: 'edge', rawStatus: 'signed_off', lastSeen: NOW - HOUR }],
  NOW,
)
assert.deepEqual(edge, [], 'exactly-60-min-old signed_off is NOT reaped (strict greater-than)')

// Edge: an idle (raw not-signed_off, old) session is NOT reaped — only the raw
// signed_off status qualifies, never the age-derived idle/stale.
const idle = reapDecision(
  [{ pid: 300, sessionId: 'idle' }],
  [{ sessionId: 'idle', rawStatus: 'live', lastSeen: NOW - 3 * HOUR }],
  NOW,
)
assert.deepEqual(idle, [], 'an age-stale but raw-live session is NOT reaped')

console.log('reap-decision OK')
process.exit(0)
