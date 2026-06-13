#!/usr/bin/env tsx
/**
 * Session-presence relay: the DNS half of cross-machine comms. A node gossips its
 * OWN live/idle sessions PLUS every live/idle remote session it has learned, so
 * presence propagates multi-hop (a spoke learns other spokes' sessions through the
 * hub) — mirroring the node roster's rosterForGossip. Liveness is judged by each
 * session's own lastSeen, so relay can never immortalize a dead session.
 */
import assert from 'node:assert/strict'

const { _resetMeshState } = await import('../../server/bus/meshState.js')
const { LIVE_MS, STALE_MS } = await import('../../server/bus/identity.js')
import type { SessionPresence } from '../../server/graph/_rows.js'

const NOW = 1_000_000_000_000
let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

/** A SessionPresence with a given id/lastSeen/machine; other fields are inert. */
const presence = (
  sessionId: string,
  lastSeen: number,
  machine: string,
  extra: Partial<SessionPresence> = {},
): SessionPresence => ({
  sessionId,
  friendlyName: sessionId,
  cwd: '/x',
  machine,
  title: '',
  startedAt: 0,
  lastSeen,
  rawStatus: '',
  supersedes: '',
  metaId: '',
  nameHistory: [],
  cadenceS: 0,
  ...extra,
})

// ── relay: own local + learned remote both go out (→ multi-hop propagation) ──
{
  const mesh = _resetMeshState([])
  // Learned spoke A's session via the hub zw1's gossip.
  mesh.mergeGossip('zw1', [presence('A-sess', NOW, 'zwd')], NOW)
  // We (spoke B) re-advertise: our own session + the one we learned.
  const out = mesh.presencesForGossip([presence('B-sess', NOW, 'zw2')], NOW)
  assert.deepEqual(
    out.map((p) => p.sessionId).sort(),
    ['A-sess', 'B-sess'],
    'gossip relays self + learned remote sessions',
  )
  ok('presencesForGossip relays the full known set (enables multi-hop)')
}

// ── local wins: a session known both locally and via relay dedups to local ──
{
  const mesh = _resetMeshState([])
  mesh.mergeGossip('zw1', [presence('dup', NOW, 'relayed', { friendlyName: 'stale-copy' })], NOW)
  const out = mesh.presencesForGossip([presence('dup', NOW, 'local', { friendlyName: 'fresh' })], NOW)
  assert.equal(out.length, 1, 'one row per sessionId')
  assert.equal(out[0]!.friendlyName, 'fresh', 'local copy wins on collision')
  assert.equal(out[0]!.machine, 'local')
  ok('local presence wins over a relayed copy of the same session')
}

// ── idle remote (5–60 min) is still relayed (display parity with local idle) ──
{
  const mesh = _resetMeshState([])
  mesh.mergeGossip('zw1', [presence('idle-sess', NOW - (LIVE_MS + 1000), 'zwd')], NOW)
  const out = mesh.presencesForGossip([], NOW)
  assert.equal(out.some((p) => p.sessionId === 'idle-sess'), true, 'idle remote relayed')
  ok('an idle remote session is still relayed')
}

// ── no immortal ghost: a stale-origin session is NOT relayed onward, even while
//    it still sits in the gossiped map (receivedAt TTL not yet expired) ──
{
  const mesh = _resetMeshState([])
  // receivedAt = NOW (fresh), but the session's OWN lastSeen is 61 min old → stale.
  mesh.mergeGossip('zw1', [presence('dead', NOW - (STALE_MS + 1000), 'zwd')], NOW)
  assert.equal(
    mesh.gossipedPeers(NOW).some((p) => p.sessionId === 'dead'),
    true,
    'still in the raw gossiped view (receivedAt fresh)',
  )
  const out = mesh.presencesForGossip([], NOW)
  assert.equal(
    out.some((p) => p.sessionId === 'dead'),
    false,
    'stale-origin session is dropped from the relay set',
  )
  ok('relay judges liveness by the session lastSeen — a dead origin cannot be immortalized')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
