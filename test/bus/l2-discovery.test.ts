#!/usr/bin/env tsx
/**
 * L2-T3 unit test: the prober + discovery sweep (server/bus/meshDiscovery.ts).
 *
 * No DB — meshState holds no graph, so (like test/bus/l2-capability.test.ts) we
 * seed the singleton via _resetMeshState() and inject deterministic dependencies
 * rather than spinning a loopback ws server. The prober's WebSocket impl is stubbed
 * via `_setWebSocketImpl` (fire `open` ⇒ probe true, `error` ⇒ probe false) and
 * `connectPeer` via `_setConnectPeer` (a spy), so classification is fully
 * deterministic. Standalone tsx + node:assert/strict (no vitest).
 *
 * Proves:
 *   1. probe resolves true on `open`, false on `error`.
 *   2. probe-ok      ⇒ capability `reachable` + connectPeer invoked (spy).
 *   3. probe-fail + hasInbound ⇒ capability `reception-only`, NO connectPeer.
 *   4. probe-fail + no inbound ⇒ capability `unreachable`, NO connectPeer.
 *   5. probe never throws when the WS constructor itself throws.
 */
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'

process.env.CKN_MESH_PEERS = '' // accept-only seed; we drive peers via _resetMeshState
process.env.CKN_MESH_TOKEN = 'fleet-secret'
delete process.env.CKN_MESH_SELF
// classifyAndMaybeDial now debounce-persists the peer set (FR-7 G1) — point it at a
// temp file so this test can never write the real ~/.config/ckn/mesh-peers.json.
process.env.CKN_MESH_PEERS_FILE = path.join(os.tmpdir(), `ckn-l2disc-peers-${process.pid}.json`)

const { _resetMeshState } = await import('../../server/bus/meshState.js')
const {
  probe,
  classifyAndMaybeDial,
  triggerSweep,
  networkFingerprint,
  _setWebSocketImpl,
  _setConnectPeer,
} = await import('../../server/bus/meshDiscovery.js')

/**
 * A stub WS whose connect outcome is dictated per-instance. `outcome` chooses which
 * event fires on next tick; `'throw'` makes the constructor itself throw (probe must
 * still resolve false, never reject).
 */
type Outcome = 'open' | 'error' | 'close' | 'throw'

let lastUrl = ''
let lastHeaders: Record<string, string> | undefined

function makeWsStub(outcome: Outcome) {
  return class StubWs {
    private handlers: Record<string, Array<(...a: any[]) => void>> = {}
    closed = false
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      lastUrl = url
      lastHeaders = opts?.headers
      if (outcome === 'throw') throw new Error('connect refused synchronously')
      // Fire the chosen event asynchronously, after handlers attach.
      setTimeout(() => {
        const ev = outcome === 'close' ? 'close' : outcome
        for (const cb of this.handlers[ev] ?? []) cb()
      }, 0)
    }
    on(event: string, cb: (...a: any[]) => void) {
      ;(this.handlers[event] ??= []).push(cb)
    }
    close() {
      this.closed = true
    }
  }
}

async function main() {
  // ── 1. probe resolves true on open, false on error / close-before-open ──────
  _setWebSocketImpl(makeWsStub('open') as any)
  assert.equal(await probe('http://node-x:3009'), true, 'probe true on open')
  assert.equal(
    lastUrl,
    'ws://node-x:3009/api/mesh/ws',
    'probe dials the WS endpoint (http→ws + /api/mesh/ws)',
  )
  // slice #4C HARD CUTOVER: the probe opens the socket UNPRIVILEGED — no bearer.
  // Reachability is "did the upgrade succeed?"; trust is the in-band handshake's
  // job, not the probe's. So the token must NEVER ride a probe header (gate test 5).
  assert.ok(
    lastHeaders === undefined || lastHeaders.Authorization === undefined,
    'probe opens UNPRIVILEGED — no Authorization/bearer header; the token never goes on the wire',
  )

  _setWebSocketImpl(makeWsStub('error') as any)
  assert.equal(await probe('http://node-x:3009'), false, 'probe false on error')

  _setWebSocketImpl(makeWsStub('close') as any)
  assert.equal(await probe('http://node-x:3009'), false, 'probe false on close-before-open')

  // ── 5. probe never throws when the constructor throws (resolves false) ──────
  _setWebSocketImpl(makeWsStub('throw') as any)
  assert.equal(
    await probe('http://node-x:3009'),
    false,
    'probe resolves false (never rejects) when WS construction throws',
  )

  // ── 2. probe-ok ⇒ capability reachable + connectPeer invoked ────────────────
  {
    const REACH = 'http://node-reach:3010'
    const ms = _resetMeshState([REACH])
    const dialed: string[] = []
    _setConnectPeer((u) => dialed.push(u))
    _setWebSocketImpl(makeWsStub('open') as any)

    await classifyAndMaybeDial(REACH, 1_000)

    const p = ms.allPeers().find((x) => x.url === REACH)!
    assert.equal(p.capability, 'reachable', 'probe-ok ⇒ reachable')
    assert.equal(p.lastProbeAt, 1_000, 'lastProbeAt stamped with the injected now')
    assert.deepEqual(dialed, [REACH], 'probe-ok ⇒ connectPeer invoked exactly once for the peer')
    assert.deepEqual(ms.dialTargets(), [REACH], 'reachable peer is now a dial target')
  }

  // ── 3. probe-fail + hasInbound ⇒ reception-only, NO connectPeer ─────────────
  {
    const RECV = 'http://node-recv:3011'
    const RECV_NODE = 'node-recv-id'
    const ms = _resetMeshState([RECV])
    // This peer dialed us (inbound link) AND advertised its own url in hello/gossip,
    // so reception-only resolves by mapping node↔url (keyed by node, not socket).
    ms.markInboundNode(RECV_NODE)
    ms.recordNodeUrl(RECV_NODE, RECV)
    const dialed: string[] = []
    _setConnectPeer((u) => dialed.push(u))
    _setWebSocketImpl(makeWsStub('error') as any)

    await classifyAndMaybeDial(RECV, 2_000)

    const p = ms.allPeers().find((x) => x.url === RECV)!
    assert.equal(p.capability, 'reception-only', 'probe-fail + inbound ⇒ reception-only')
    assert.equal(p.lastProbeAt, 2_000, 'lastProbeAt stamped')
    assert.deepEqual(dialed, [], 'reception-only ⇒ NEVER dial (they own reconnect)')
    assert.deepEqual(ms.dialTargets(), [], 'reception-only peer is NOT a dial target')
  }

  // ── 4. probe-fail + no inbound ⇒ unreachable, NO connectPeer ────────────────
  {
    const UNRE = 'http://node-unre:3012'
    const ms = _resetMeshState([UNRE])
    const dialed: string[] = []
    _setConnectPeer((u) => dialed.push(u))
    _setWebSocketImpl(makeWsStub('error') as any)

    await classifyAndMaybeDial(UNRE, 3_000)

    const p = ms.allPeers().find((x) => x.url === UNRE)!
    assert.equal(p.capability, 'unreachable', 'probe-fail + no inbound ⇒ unreachable')
    assert.equal(p.lastProbeAt, 3_000, 'lastProbeAt stamped')
    assert.deepEqual(dialed, [], 'unreachable ⇒ NEVER dial')
    assert.deepEqual(ms.dialTargets(), [], 'unreachable peer is NOT a dial target')
  }

  // ── D5: networkFingerprint detects an address-set change (VPN up / etc.) ──────
  {
    const base = { eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] } as any
    const vpnUp = {
      eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }],
      tun0: [{ family: 'IPv4', address: '192.0.2.99', internal: false }],
    } as any
    const loopbackOnly = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] } as any
    assert.equal(networkFingerprint(base), networkFingerprint(base), 'fingerprint is stable for the same interfaces')
    assert.notEqual(networkFingerprint(base), networkFingerprint(vpnUp), 'a new interface (VPN up) changes the fingerprint')
    assert.equal(networkFingerprint(loopbackOnly), '', 'internal-only addresses are ignored')
  }

  // ── D5: triggerSweep re-probes + dials an unknown peer NOW (no wait) ──────────
  {
    const P = 'http://node-resweep:3013'
    const ms = _resetMeshState([P]) // seeded 'unknown'
    const dialed: string[] = []
    _setConnectPeer((u) => dialed.push(u))
    _setWebSocketImpl(makeWsStub('open') as any)

    triggerSweep()
    await new Promise((r) => setTimeout(r, 20)) // let the async probe + dial settle

    assert.equal(
      ms.allPeers().find((x) => x.url === P)!.capability,
      'reachable',
      'triggerSweep re-probed the unknown peer immediately',
    )
    assert.deepEqual(dialed, [P], 'triggerSweep dialed the now-reachable peer')
  }

  // restore real impls so we don't leak stubs into a subsequent run
  _setWebSocketImpl(null)
  _setConnectPeer(null)

  console.log('l2-discovery OK')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
