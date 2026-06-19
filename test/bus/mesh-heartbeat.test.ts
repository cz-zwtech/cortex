/**
 * #116 mesh WS heartbeat — pure decision core.
 *
 * A silent TCP/VPN drop leaves ws.readyState === OPEN (the mesh dot stays green)
 * until OS keepalive (~hours). The heartbeat pings on an interval and, after a
 * configurable miss-tolerance (NOT a single missed pong — a momentarily laggy but
 * alive link must not flap), terminates the socket so the existing close→reconnect
 * path fires and the dot flips within seconds.
 *
 * This file tests the PURE core (no sockets, no timers). The WS wiring + the
 * behavioral flip-to-red-then-reconnect are exercised in mesh-heartbeat-link.test.ts.
 */
import assert from 'node:assert/strict'
import {
  heartbeatTick,
  pongTimeoutMs,
  heartbeatEnabled,
  meshPingIntervalMs,
  meshPingMissTolerance,
} from '../../server/bus/meshHeartbeat.js'

// ── heartbeatTick: ping while under tolerance, terminate at/over it ─────────────
{
  // Fresh link, tolerance 3: a tick with no outstanding misses pings + counts it.
  assert.deepEqual(heartbeatTick(0, 3), { action: 'ping', missed: 1 }, 'missed 0 → ping, count 1')
  assert.deepEqual(heartbeatTick(1, 3), { action: 'ping', missed: 2 }, 'missed 1 → ping, count 2')
  assert.deepEqual(heartbeatTick(2, 3), { action: 'ping', missed: 3 }, 'missed 2 → ping, count 3')
  // At tolerance: terminate, and do NOT keep incrementing.
  assert.deepEqual(heartbeatTick(3, 3), { action: 'terminate', missed: 3 }, 'missed == tol → terminate')
  assert.deepEqual(heartbeatTick(5, 3), { action: 'terminate', missed: 5 }, 'missed > tol → terminate')
}

// ── full silent-drop sequence: terminate only after `tolerance` missed pongs ─────
{
  const tolerance = 3
  let missed = 0
  const actions: string[] = []
  // No pong ever arrives (silent drop). Drive ticks until terminate.
  for (let i = 0; i < 6; i++) {
    const r = heartbeatTick(missed, tolerance)
    actions.push(r.action)
    missed = r.missed
    if (r.action === 'terminate') break
  }
  // 3 pings tolerated, then terminate on the 4th tick.
  assert.deepEqual(actions, ['ping', 'ping', 'ping', 'terminate'], 'tolerate 3 misses then terminate')
}

// ── a pong mid-sequence resets the counter and prevents termination ─────────────
{
  const tolerance = 3
  let missed = 0
  missed = heartbeatTick(missed, tolerance).missed // 1
  missed = heartbeatTick(missed, tolerance).missed // 2
  // pong arrives → caller resets missed to 0
  missed = 0
  const r = heartbeatTick(missed, tolerance)
  assert.equal(r.action, 'ping', 'after a pong reset, the link is healthy again — ping, never terminate')
  assert.equal(r.missed, 1, 'counter restarts from the reset')
}

// ── pongTimeoutMs: worst-case age from last pong to terminate = interval*(tol+1) ─
{
  assert.equal(pongTimeoutMs(15000, 3), 60000, 'interval 15s, tol 3 → 60s worst-case')
  assert.equal(pongTimeoutMs(10000, 2), 30000, 'interval 10s, tol 2 → 30s worst-case')
}

// ── meshPingMissTolerance: default 3, env override, invalid → default, min 1 ─────
{
  const save = process.env.CKN_MESH_PING_MISS
  delete process.env.CKN_MESH_PING_MISS
  assert.equal(meshPingMissTolerance(), 3, 'default miss tolerance is 3 (tolerate ~2-3)')
  process.env.CKN_MESH_PING_MISS = '5'
  assert.equal(meshPingMissTolerance(), 5, 'env override honored')
  process.env.CKN_MESH_PING_MISS = '0'
  assert.equal(meshPingMissTolerance(), 3, 'sub-1 falls back to default (never terminate on a single miss)')
  process.env.CKN_MESH_PING_MISS = 'nope'
  assert.equal(meshPingMissTolerance(), 3, 'non-numeric falls back to default')
  if (save === undefined) delete process.env.CKN_MESH_PING_MISS
  else process.env.CKN_MESH_PING_MISS = save
}

// ── meshPingIntervalMs: default 15s, env override, 0/neg disables, invalid→default ─
{
  const save = process.env.CKN_MESH_PING_MS
  delete process.env.CKN_MESH_PING_MS
  assert.equal(meshPingIntervalMs(), 15000, 'default ping interval is 15s')
  process.env.CKN_MESH_PING_MS = '8000'
  assert.equal(meshPingIntervalMs(), 8000, 'env override honored')
  process.env.CKN_MESH_PING_MS = '0'
  assert.equal(meshPingIntervalMs(), 0, 'explicit 0 disables (returns 0)')
  process.env.CKN_MESH_PING_MS = '-5'
  assert.equal(meshPingIntervalMs(), 0, 'negative disables (returns 0)')
  process.env.CKN_MESH_PING_MS = '5'
  assert.equal(meshPingIntervalMs(), 1000, 'a tiny positive misconfig is clamped to the 1s floor (no ping storm)')
  process.env.CKN_MESH_PING_MS = '2000'
  assert.equal(meshPingIntervalMs(), 2000, 'a positive value above the floor is honored as-is')
  process.env.CKN_MESH_PING_MS = 'nope'
  assert.equal(meshPingIntervalMs(), 15000, 'non-numeric falls back to default')
  if (save === undefined) delete process.env.CKN_MESH_PING_MS
  else process.env.CKN_MESH_PING_MS = save
}

// ── heartbeatEnabled: on for a positive interval, off when disabled ──────────────
{
  assert.equal(heartbeatEnabled(15000), true, 'positive interval → enabled')
  assert.equal(heartbeatEnabled(0), false, 'zero interval → disabled')
}

console.log('mesh-heartbeat pure-core: all assertions passed')
process.exit(0)
