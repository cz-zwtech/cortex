#!/usr/bin/env tsx
/**
 * L2-T1 unit test: the per-edge capability model on MeshState.
 *
 * Covers learnAddress (register-if-new + dedupe), setCapability (transitions +
 * lastProbeAt stamp), knownAddresses + dialTargets (reflect capability state),
 * and markInbound (flips hasInbound). MeshState holds no DB, so no temp graph;
 * it seeds from peerUrls(), so CKN_MESH_PEERS is set BEFORE the dynamic import
 * (repo convention). Wall-clock is injected → deterministic. Standalone tsx +
 * node:assert/strict (no vitest).
 */
import assert from 'node:assert/strict'

process.env.CKN_MESH_PEERS = 'http://node-b:3002'
delete process.env.CKN_MESH_SELF

const { MeshState } = await import('../../server/bus/meshState.js')

async function main() {
  const B = 'http://node-b:3002'
  const C = 'http://node-c:3003'
  const D = 'http://node-d:3004'

  // ── seeding: a seeded peer starts `unknown`, unprobed, no inbound ───────────
  {
    const ms = new MeshState([B])
    const [p] = ms.allPeers()
    assert.ok(p, 'seeded peer present')
    assert.equal(p!.capability, 'unknown', 'seeded peer starts unknown')
    assert.equal(p!.lastProbeAt, 0, 'never probed')
    assert.equal(p!.hasInbound, false, 'no inbound link yet')
  }

  // ── learnAddress: registers a new address `unknown`, and dedupes ───────────
  {
    const ms = new MeshState([B])
    ms.learnAddress(C)
    assert.deepEqual(
      ms.knownAddresses().sort(),
      [B, C].sort(),
      'learnAddress registers the new address',
    )
    const cBefore = ms.allPeers().find((p) => p.url === C)!
    assert.equal(cBefore.capability, 'unknown', 'learned address starts unknown')

    // mutate, then re-learn the SAME address — must not reset existing state
    ms.setCapability(C, 'reachable', 5_000)
    ms.learnAddress(C)
    assert.equal(ms.knownAddresses().length, 2, 'learnAddress is idempotent (no dupe)')
    const cAfter = ms.allPeers().find((p) => p.url === C)!
    assert.equal(cAfter.capability, 'reachable', 'idempotent learn preserves capability')
    assert.equal(cAfter.lastProbeAt, 5_000, 'idempotent learn preserves lastProbeAt')

    // learning a seeded address is also a no-op
    ms.learnAddress(B)
    assert.equal(ms.knownAddresses().length, 2, 'learning an existing seeded address dedupes')
  }

  // ── setCapability: transitions through every state + stamps lastProbeAt ─────
  {
    const ms = new MeshState([B])

    ms.setCapability(B, 'reachable', 1_000)
    let p = ms.allPeers().find((x) => x.url === B)!
    assert.equal(p.capability, 'reachable', 'unknown→reachable')
    assert.equal(p.lastProbeAt, 1_000, 'lastProbeAt stamped on first verdict')

    ms.setCapability(B, 'unreachable', 2_000)
    p = ms.allPeers().find((x) => x.url === B)!
    assert.equal(p.capability, 'unreachable', 'reachable→unreachable')
    assert.equal(p.lastProbeAt, 2_000, 'lastProbeAt re-stamped on each verdict')

    ms.setCapability(B, 'reception-only', 3_000)
    p = ms.allPeers().find((x) => x.url === B)!
    assert.equal(p.capability, 'reception-only', 'unreachable→reception-only')
    assert.equal(p.lastProbeAt, 3_000, 'lastProbeAt tracks the latest probe')

    // setCapability on an unseen key registers it (ensurePeer)
    ms.setCapability(D, 'reachable', 4_000)
    assert.ok(ms.knownAddresses().includes(D), 'setCapability registers an unseen key')
  }

  // ── knownAddresses + dialTargets reflect capability state ──────────────────
  {
    const ms = new MeshState([B])
    ms.learnAddress(C)
    ms.learnAddress(D)

    // nothing probed yet → no dial targets, but all three are known
    assert.deepEqual(ms.dialTargets(), [], 'no reachable peers ⇒ empty dial-list')
    assert.deepEqual(ms.knownAddresses().sort(), [B, C, D].sort(), 'all learned addresses known')

    ms.setCapability(B, 'reachable', 1_000)
    ms.setCapability(C, 'reception-only', 1_000)
    ms.setCapability(D, 'unreachable', 1_000)

    assert.deepEqual(ms.dialTargets(), [B], 'only `reachable` peers are dial targets')
    assert.deepEqual(
      ms.knownAddresses().sort(),
      [B, C, D].sort(),
      'knownAddresses covers every capability (for gossip)',
    )

    // a second reachable joins the dial-list
    ms.setCapability(C, 'reachable', 2_000)
    assert.deepEqual(ms.dialTargets().sort(), [B, C].sort(), 'dial-list grows as peers become reachable')

    // demoting one drops it from the dial-list but keeps it known
    ms.setCapability(B, 'unreachable', 3_000)
    assert.deepEqual(ms.dialTargets(), [C], 'demoted peer leaves the dial-list')
    assert.ok(ms.knownAddresses().includes(B), 'demoted peer is still known')
  }

  // ── markInbound flips hasInbound (drives reception-only classification) ─────
  {
    const ms = new MeshState([B])
    assert.equal(ms.allPeers()[0]!.hasInbound, false, 'no inbound by default')

    ms.markInbound(B)
    assert.equal(ms.allPeers()[0]!.hasInbound, true, 'markInbound flips hasInbound')

    // idempotent
    ms.markInbound(B)
    assert.equal(ms.allPeers()[0]!.hasInbound, true, 'markInbound is idempotent')

    // markInbound on an ephemeral accept-side key registers it
    const ephemeral = 'ws-accept:127.0.0.1:54321'
    ms.markInbound(ephemeral)
    const p = ms.allPeers().find((x) => x.url === ephemeral)!
    assert.ok(p, 'markInbound registers an unseen accept-side key')
    assert.equal(p.hasInbound, true, 'accept-side key marked inbound')
    assert.equal(p.capability, 'unknown', 'accept-side key still unknown until probed')
  }

  console.log('l2-capability OK')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
