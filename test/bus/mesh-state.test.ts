#!/usr/bin/env tsx
/**
 * T4 unit test: the in-process MeshState — peer reachability transitions, the
 * gossiped-presence TTL drop, zombie set/clear, and broadcast targeting.
 *
 * MeshState holds no DB, so this needs no temp graph; but it seeds from
 * `peerUrls()`, so CKN_MESH_PEERS/CKN_MESH_GOSSIP_MS are set BEFORE the dynamic
 * import (per the repo convention). Wall-clock is injected, so every assertion
 * is deterministic. Standalone tsx + node:assert/strict (no vitest).
 */
import assert from 'node:assert/strict'

process.env.CKN_MESH_PEERS = 'http://node-b:3002'
process.env.CKN_MESH_GOSSIP_MS = '20000' // TTL = 2× = 40_000 ms
delete process.env.CKN_MESH_SELF

const { MeshState } = await import('../../server/bus/meshState.js')

/** Minimal SessionPresence fixture — only the fields the view actually carries. */
function presence(sessionId: string, machine = 'host-b'): any {
  return {
    sessionId,
    friendlyName: sessionId,
    cwd: '/repo',
    machine,
    title: sessionId,
    startedAt: 1,
    lastSeen: 1,
    rawStatus: 'live',
    supersedes: '',
    metaId: `meta_${sessionId}`,
    nameHistory: [],
  }
}

async function main() {
  const B = 'http://node-b:3002'
  const NB = 'node-b-id'

  // ── seeding: peer is known but starts unreachable / non-broadcast ──────────
  {
    const ms = new MeshState([B])
    assert.deepEqual(ms.peerUrls(), [B], 'seeded from the passed peer list')
    assert.deepEqual(ms.broadcastTargets(), [], 'unreachable peer is not a broadcast target')
  }

  // ── transition detection: first reachable = transition, steady-state isn't ─
  {
    const ms = new MeshState([B])
    const t1 = ms.markReachable(B, NB, 1, 1_000)
    assert.equal(t1, true, 'unreachable→reachable is a transition')
    const t2 = ms.markReachable(B, NB, 1, 2_000)
    assert.equal(t2, false, 'reachable→reachable is NOT a transition (no double catch-up)')
    assert.deepEqual(ms.broadcastTargets(), [B], 'reachable non-zombie peer is a broadcast target')

    // drop then recover → a fresh transition
    ms.markUnreachable(B, 3_000)
    assert.deepEqual(ms.broadcastTargets(), [], 'unreachable peer drops from broadcast targets')
    const t3 = ms.markReachable(B, NB, 1, 4_000)
    assert.equal(t3, true, 'recovery after an unreachable mark is a fresh transition')
  }

  // ── TTL drop of stale gossip ───────────────────────────────────────────────
  {
    const ms = new MeshState([B])
    ms.markReachable(B, NB, 1, 1_000)
    ms.mergeGossip(NB, [presence('sess-1')], 1_000)
    assert.deepEqual(
      ms.gossipedPeers(2_000).map((p) => p.sessionId),
      ['sess-1'],
      'fresh gossip is visible',
    )
    // still inside the 40_000 ms TTL window
    assert.equal(ms.gossipedPeers(40_000).length, 1, 'gossip visible up to the TTL boundary')
    // past 2× gossip interval since receivedAt → aged out
    assert.deepEqual(ms.gossipedPeers(41_001), [], 'stale gossip past 2×interval is dropped')

    // a re-gossip refreshes receivedAt and revives visibility
    ms.mergeGossip(NB, [presence('sess-1')], 50_000)
    assert.deepEqual(
      ms.gossipedPeers(51_000).map((p) => p.sessionId),
      ['sess-1'],
      're-gossip refreshes the TTL window',
    )
  }

  // ── gossipedPeers strips the source/receivedAt tags (returns SessionPresence) ─
  {
    const ms = new MeshState([B])
    ms.markReachable(B, NB, 1, 1_000)
    ms.mergeGossip(NB, [presence('sess-x')], 1_000)
    const [p] = ms.gossipedPeers(1_500)
    assert.ok(p, 'one presence returned')
    assert.equal((p as any).sourceNode, undefined, 'sourceNode tag stripped from the view')
    assert.equal((p as any).receivedAt, undefined, 'receivedAt tag stripped from the view')
    assert.equal(p!.machine, 'host-b', 'underlying SessionPresence fields preserved')
  }

  // ── zombie: reachable + 0 sessions + silent past threshold → zombie ────────
  {
    const ms = new MeshState([B])
    const ZOMBIE_MS = 10_000

    // reachable WITH a session at t=1000 → activity stamped, not a zombie yet
    ms.markReachable(B, NB, 1, 1_000)
    ms.mergeGossip(NB, [presence('sess-live')], 1_000)
    ms.evaluateZombies(20_000, ZOMBIE_MS)
    assert.deepEqual(ms.broadcastTargets(), [B], 'a peer with a session is never a zombie')

    // session goes away: reachable but 0 sessions reported, no new activity
    ms.markReachable(B, NB, 0, 2_000)
    // not yet past the silence threshold (last activity was t=1000)
    ms.evaluateZombies(9_000, ZOMBIE_MS)
    assert.equal(ms.allPeers()[0]!.zombie, false, 'within the silence window: not yet a zombie')

    // now silent past the threshold (now - lastActivityAt(1000) > 10000)
    ms.evaluateZombies(11_001, ZOMBIE_MS)
    assert.equal(ms.allPeers()[0]!.zombie, true, 'reachable + 0 sessions + silent → zombie')
    assert.deepEqual(ms.broadcastTargets(), [], 'a zombie is excluded from broadcast targets')

    // gossiped presences from a zombied source are hidden from the fleet view
    ms.mergeGossip(NB, [presence('sess-ghost')], 11_500)
    assert.deepEqual(
      ms.gossipedPeers(12_000).map((p) => p.sessionId),
      [],
      'presence from a zombied source is excluded from gossipedPeers',
    )

    // ── cleared by a new session: gossip reporting ≥1 session revives it ─────
    const revived = ms.markReachable(B, NB, 1, 12_000)
    assert.equal(revived, false, 'still reachable — revival is not an unreachable transition')
    assert.equal(ms.allPeers()[0]!.zombie, false, 'a reported session clears the zombie verdict')
    assert.deepEqual(ms.broadcastTargets(), [B], 'revived peer is a broadcast target again')

    // re-evaluating immediately keeps it alive (activity clock was reset)
    ms.evaluateZombies(13_000, ZOMBIE_MS)
    assert.equal(ms.allPeers()[0]!.zombie, false, 'fresh activity holds off a new zombie verdict')
  }

  // ── recordActivity also clears a zombie (e.g. an ingest arrives) ───────────
  {
    const ms = new MeshState([B])
    const ZOMBIE_MS = 10_000
    ms.markReachable(B, NB, 0, 1_000)
    ms.evaluateZombies(11_001, ZOMBIE_MS)
    assert.equal(ms.allPeers()[0]!.zombie, true, 'preconditioned to zombie')
    ms.recordActivity(B, 12_000)
    assert.equal(ms.allPeers()[0]!.zombie, false, 'recordActivity clears the zombie verdict')
  }

  console.log('mesh-state OK')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
