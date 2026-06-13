#!/usr/bin/env tsx
/**
 * L2-T2 unit test: address-list gossip on the WS channel (server/bus/meshWs.ts).
 *
 * Same temp-DB + dynamic-import pattern as test/bus/ws-channel.test.ts (the WS Link
 * touches the bus store on open: hello→backlog reads `messagesOriginatedSince`).
 * Point db.ts at a fresh SQLite file via CKN_GRAPH_DB_PATH BEFORE importing the
 * module under test. We drive a REAL loopback ws server + peer socket so the gossip
 * frame goes through the genuine `onGossip` dispatch, then assert the L2 effects.
 *
 * `classifyAndMaybeDial` is stubbed at its source seam: meshDiscovery's
 * `_setWebSocketImpl` makes every probe resolve `false` (so no real dial is ever
 * attempted) while RECORDING which url it probed; `_setConnectPeer` is a spy proving
 * a gossiped address is never dialed-on-faith. So a probe being scheduled for a url
 * is observable as that url appearing in the probed-list — without opening any socket.
 *
 * Proves:
 *   1. a gossip carrying NEW addresses registers each `unknown` on meshState and
 *      schedules a probe (classifyAndMaybeDial) for each — never connectPeer.
 *   2. a gossip carrying ONLY already-known addresses schedules NO new probe.
 *   3. an outbound gossip frame from the link carries our knownAddresses().
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-l2-addr-gossip-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_TOKEN = 'l2-addr-token' // Link authenticates in-band (slice #4C)
// Deterministic, long gossip interval so the per-link timer doesn't re-fire mid-test.
process.env.CKN_MESH_GOSSIP_MS = '600000'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_PEERS = '' // accept-only seed; we drive known addrs via _resetMeshState
delete process.env.CKN_MESH_SELF

const { getMeshState, _resetMeshState } = await import('../../server/bus/meshState.js')
const { _setWebSocketImpl, _setConnectPeer } = await import('../../server/bus/meshDiscovery.js')
const { acceptPeer, stopWsMesh, wsPeerCount } = await import('../../server/bus/meshWs.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const REMOTE = 'peer-node-remote'

/** Collect every frame a socket receives, parsed. */
function collectFrames(ws: WebSocket): any[] {
  const out: any[] = []
  ws.on('message', (d) => {
    try {
      out.push(JSON.parse(String(d)))
    } catch {
      /* ignore */
    }
  })
  return out
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await wait(10)
  }
}

// ── stub the prober's WebSocket so classifyAndMaybeDial probes resolve `false`
// (no real dial) while RECORDING the url it probed. Recovering the base url from
// the WS endpoint (ws://host:port/api/mesh/ws → http://host:port) lets us assert
// WHICH addresses got a probe scheduled. ────────────────────────────────────────
const probedUrls: string[] = []
class ProbeRecorderWs {
  private handlers: Record<string, Array<(...a: any[]) => void>> = {}
  constructor(url: string) {
    // wsEndpoint(base) = base.replace(http→ws) + '/api/mesh/ws'; invert it.
    const base = url.replace(/^ws/i, 'http').replace(/\/api\/mesh\/ws$/, '')
    probedUrls.push(base)
    setTimeout(() => {
      for (const cb of this.handlers['error'] ?? []) cb() // fail → no connectPeer
    }, 0)
  }
  on(event: string, cb: (...a: any[]) => void) {
    ;(this.handlers[event] ??= []).push(cb)
  }
  close() {
    /* throwaway */
  }
}

async function main() {
  _resetMeshState([])
  _setWebSocketImpl(ProbeRecorderWs as any)
  const dialedByProbe: string[] = []
  _setConnectPeer((u) => dialedByProbe.push(u)) // must stay empty (probes all fail)

  // ── Stand up a loopback ws server; each accepted socket becomes a Link. ──────
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', (ws) => acceptPeer(ws))
  const port = (wss.address() as AddressInfo).port

  const peer = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
  const peerFrames = collectFrames(peer)
  await new Promise<void>((resolve) => peer.on('open', () => resolve()))
  await dialerHandshake(peer, process.env.CKN_MESH_TOKEN!) // authenticate in-band
  await until(() => wsPeerCount() === 1)

  // ── (3) the link's own gossip frame carries our knownAddresses() ────────────
  await until(() => peerFrames.some((f) => f.t === 'gossip'))
  const outGossip = peerFrames.find((f) => f.t === 'gossip')
  assert.ok(Array.isArray(outGossip.addresses), 'outbound gossip carries an addresses array')
  assert.deepEqual(
    outGossip.addresses.sort(),
    getMeshState().knownAddresses().sort(),
    'outbound gossip addresses = our knownAddresses()',
  )

  // ── (1) inbound gossip with NEW addresses → learn `unknown` + probe each ─────
  const NEW_A = 'http://node-a:3101'
  const NEW_B = 'http://node-b:3102'
  peer.send(
    JSON.stringify({ t: 'gossip', node: REMOTE, sessions: [], addresses: [NEW_A, NEW_B] }),
  )
  await until(() => probedUrls.includes(NEW_A) && probedUrls.includes(NEW_B))

  const mesh = getMeshState()
  for (const url of [NEW_A, NEW_B]) {
    const p = mesh.allPeers().find((x) => x.url === url)
    assert.ok(p, `new gossiped address ${url} is registered`)
    // The address was registered `unknown` then the scheduled probe ran. Because
    // the stub probe FAILS (and there's no inbound link), the verdict is
    // `unreachable` — never `reachable` (which alone would authorize a dial). The
    // observable invariant: a gossiped address is classified by a PROBE, never
    // assumed reachable on faith.
    assert.notEqual(p!.capability, 'reachable', `${url} not assumed reachable on faith`)
  }
  assert.ok(mesh.knownAddresses().includes(NEW_A), 'NEW_A is now known')
  assert.ok(mesh.knownAddresses().includes(NEW_B), 'NEW_B is now known')
  // The failing probe must NOT have produced a dial — gossip never dials on faith.
  assert.deepEqual(dialedByProbe, [], 'a gossiped address is probed, NEVER connectPeer-dialed on faith')

  // ── (2) a gossip carrying ONLY already-known addresses schedules NO new probe ─
  const probesBefore = probedUrls.length
  peer.send(
    JSON.stringify({ t: 'gossip', node: REMOTE, sessions: [], addresses: [NEW_A, NEW_B] }),
  )
  await wait(50)
  assert.equal(
    probedUrls.length,
    probesBefore,
    'a gossip of only already-known addresses triggers no new probe',
  )

  // a gossip with NO addresses field (an L1 peer) is harmless — no probe, no throw.
  peer.send(JSON.stringify({ t: 'gossip', node: REMOTE, sessions: [] }))
  await wait(50)
  assert.equal(probedUrls.length, probesBefore, 'gossip without addresses triggers no probe')

  // ── teardown ────────────────────────────────────────────────────────────────
  peer.close()
  stopWsMesh()
  _setWebSocketImpl(null)
  _setConnectPeer(null)
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log('l2-addr-gossip OK')
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (err) => {
    cleanup()
    console.error(err)
    process.exit(1)
  },
)
