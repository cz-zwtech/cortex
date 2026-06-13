#!/usr/bin/env tsx
/**
 * Watcher self-exit + compact-survivor policy (#40, B+).
 *
 * B+ decouples the watcher from session lifecycle: a `ckn-bus watch` process is a
 * DELIVERY CHANNEL, never the session's lifecycle owner. It must NOT sign off the
 * session on its own teardown (that cascaded a live session to signed_off when one
 * of N watchers was killed). It still self-exits once its OWN session is genuinely
 * signed_off (SessionEnd) — but only after a DEBOUNCE, so a transient signed_off
 * during a /compact self-heal revive does not kill a live watcher (r1). And on a
 * /compact resume it reaps any surviving pre-compact watcher so a session never
 * runs two (the source of the two-watcher situation).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  watcherShouldExit,
  SIGNED_OFF_EXIT_STREAK,
  survivorAdoptPids,
  selfAncestryPids,
} from '../../bin/_bus-watch.js'

// ── self-exit guard, now debounced (r1) ──────────────────────────────────────
// Live / idle / stale sessions keep the watcher running, regardless of streak.
assert.equal(watcherShouldExit({ status: 'live' }, true, 9), false, 'live → keep running')
assert.equal(watcherShouldExit({ status: 'idle' }, true, 9), false, 'idle → keep running')
assert.equal(watcherShouldExit({ status: 'stale' }, true, 9), false, 'stale → keep running (user may be away)')

// Debounce: a single signed_off read (streak 1) must NOT exit — a /compact resume
// flips signed_off→live via the self-heal touch within a poll or two (r1).
assert.equal(
  watcherShouldExit({ status: 'signed_off' }, true, 1),
  false,
  'signed_off once (streak 1) → do NOT exit (revive-race guard)',
)
// Sustained signed_off for the full streak → genuinely ended → exit.
assert.equal(
  watcherShouldExit({ status: 'signed_off' }, true, SIGNED_OFF_EXIT_STREAK),
  true,
  'signed_off for the full streak after live → exit (clean /exit leak case)',
)

// Signed off but never seen live (stale prior incarnation at watch start) → do NOT
// exit even past the streak (startup race guard).
assert.equal(
  watcherShouldExit({ status: 'signed_off' }, false, 9),
  false,
  'signed_off before ever live → do not exit (startup race guard)',
)
// Absent from peers (undefined) is not a terminal signal on its own.
assert.equal(watcherShouldExit(undefined, true, 9), false, 'absent → keep running')
// The debounce is real (>=2 consecutive polls).
assert.ok(SIGNED_OFF_EXIT_STREAK >= 2, 'debounce requires at least 2 consecutive signed_off polls')

// ── compact-survivor adopt (B+) — ancestor-safe + starttime-ordered ───────────
// The live-dogfood bug (SELF-ANCESTOR-KILL): a watcher's WHOLE ancestry (the
// Monitor `bash -c`, `npx`, `tsx` layers) also matches scanWatcherProcs with the
// same session env, so excluding only my leaf pid made a fresh watcher SIGTERM its
// own parents. survivorAdoptPids now takes (excludePids = my full ancestor chain,
// myStartTicks, session, procs) and reaps ONLY same-session procs that are NOT an
// ancestor AND are PROVABLY older than me (a survivor is older; #44 mutual-kill).
{
  const procs = [
    { pid: 100, sessionId: 'S', startTicks: 1000 }, // genuine survivor: older, not my ancestor → REAP
    { pid: 150, sessionId: 'S', startTicks: 900 }, // MY Monitor shell ancestor (older, same session env) → NEVER
    { pid: 200, sessionId: 'S', startTicks: 2000 }, // me (the fresh leaf) → NEVER
    { pid: 120, sessionId: 'S', startTicks: 3000 }, // a NEWER same-session watcher (not older) → not reaped
    { pid: 300, sessionId: 'OTHER', startTicks: 500 }, // other session → NEVER
  ]
  const myAncestry = [200, 150, 1] // leaf + Monitor shell + init
  assert.deepEqual(
    survivorAdoptPids(myAncestry, 2000, 'S', procs).sort((a, b) => a - b),
    [100],
    'reaps only the older non-ancestor same-session survivor; never my ancestor (self-ancestor-kill), me, a newer watcher, or another session',
  )
  // Unknown starttime (0) on a candidate → do NOT reap (err to a benign duplicate, never zero).
  assert.deepEqual(
    survivorAdoptPids([1], 2000, 'S', [{ pid: 9, sessionId: 'S', startTicks: 0 }]),
    [],
    'candidate with unreadable starttime is not reaped',
  )
  // My own starttime unknown (0) → reap nothing (can't prove anyone older).
  assert.deepEqual(
    survivorAdoptPids([1], 0, 'S', [{ pid: 9, sessionId: 'S', startTicks: 1000 }]),
    [],
    'unknown self-starttime → adopt is a no-op',
  )
}

// selfAncestryPids walks the real /proc tree from this process up to init; on Linux
// it must at least include this process, and is bounded (never loops).
{
  const chain = selfAncestryPids()
  assert.ok(Array.isArray(chain), 'returns an array')
  assert.ok(chain.includes(process.pid), 'always includes the starting pid (self)')
  assert.ok(chain.length <= 64, 'bounded walk (no runaway/cycle)')
}

// ── cascade-prevention pin (#40 core) ────────────────────────────────────────
// The watcher (ckn-bus.ts) must NEVER POST a session signoff — doing so on a
// watcher's SIGTERM cascaded a LIVE session to signed_off whenever one of N
// watchers was killed. Signoff is SessionEnd-owned (ckn-extract). Pinned at source
// so the POST can't be silently re-added (comments mention "signoff" but never the
// "/api/bus/signoff" path).
{
  const src = fs.readFileSync(new URL('../../bin/ckn-bus.ts', import.meta.url), 'utf8')
  assert.ok(
    !src.includes('/api/bus/signoff'),
    'ckn-bus.ts (the watcher) never POSTs /api/bus/signoff — signoff is SessionEnd-owned',
  )
}

console.log('watcher-exit OK')
process.exit(0)
