#!/usr/bin/env tsx
/**
 * I8 (G3) — dialable roster. A node learned PURELY via the relayed node roster
 * (`nodes[].url`) must become a real dial CANDIDATE, not a display-only row. Mirrors
 * l2-addr-gossip's harness: a real loopback ws server + peer socket drive the genuine
 * `onGossip` dispatch; the prober's WebSocket is stubbed to record which url it probed
 * and to FAIL (so no real dial), proving the roster url entered the SAME probe-gated
 * path as an addresses[] entry — without opening a socket.
 *
 * Proves:
 *   1. a gossip whose nodes[] carries a url (and NO addresses[]) schedules a probe
 *      for that url + registers it in knownAddresses (→ re-gossiped + dialable).
 *   2. a roster entry advertising OUR OWN self url is never probed (self-exclude).
 *   3. a roster entry with an empty/absent url is harmless (no probe, no throw).
 *   4. a roster url is never dialed on faith — probe verdict only (mirrors addresses[]).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-l2-roster-dial-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_TOKEN = 'l2-roster-token' // Link authenticates in-band (slice #4C)
process.env.CKN_MESH_GOSSIP_MS = '600000' // long: the per-link timer must not re-fire mid-test
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_PEERS = '' // accept-only seed
process.env.CKN_MESH_SELF = 'http://self-node:3001' // so self-exclude has a url to exclude

const { getMeshState, _resetMeshState } = await import('../../server/bus/meshState.js')
const { _setWebSocketImpl, _setConnectPeer } = await import('../../server/bus/meshDiscovery.js')
const { acceptPeer, stopWsMesh, wsPeerCount } = await import('../../server/bus/meshWs.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const REMOTE = 'peer-node-remote'

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

// Stub the prober's WS: record the base url it probed, then FAIL (no connectPeer).
const probedUrls: string[] = []
class ProbeRecorderWs {
  private handlers: Record<string, Array<(...a: any[]) => void>> = {}
  constructor(url: string) {
    const base = url.replace(/^ws/i, 'http').replace(/\/api\/mesh\/ws$/, '')
    probedUrls.push(base)
    setTimeout(() => {
      for (const cb of this.handlers['error'] ?? []) cb()
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
  _setConnectPeer((u) => dialedByProbe.push(u)) // must stay empty (every probe fails)

  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', (ws) => acceptPeer(ws))
  const port = (wss.address() as AddressInfo).port

  const peer = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
  const peerFrames = collectFrames(peer)
  await new Promise<void>((resolve) => peer.on('open', () => resolve()))
  await dialerHandshake(peer, process.env.CKN_MESH_TOKEN!) // authenticate in-band
  await until(() => wsPeerCount() === 1)
  // Drain the link's own initial gossip so its self-roster url isn't conflated below.
  await until(() => peerFrames.some((f) => f.t === 'gossip'))

  // ── (1) inbound gossip: a roster node with a url (NO addresses[]) → probe it ──
  const ROSTER_URL = 'http://gossiped-node:3201'
  const SELF_URL = 'http://self-node:3001'
  peer.send(
    JSON.stringify({
      t: 'gossip',
      node: REMOTE,
      sessions: [],
      nodes: [
        { nodeId: 'gn', machineId: 'gossiped-1', hostname: 'gn', url: ROSTER_URL, lastActivityAt: Date.now() },
        // (2) a roster entry advertising OUR OWN url must be self-excluded.
        { nodeId: 'me', machineId: 'self-1', hostname: 'me', url: SELF_URL, lastActivityAt: Date.now() },
        // (3) a roster entry with no url is harmless.
        { nodeId: 'nat', machineId: 'nat-1', hostname: 'nat', url: '', lastActivityAt: Date.now() },
      ],
    }),
  )
  await until(() => probedUrls.includes(ROSTER_URL))

  const mesh = getMeshState()
  assert.ok(mesh.knownAddresses().includes(ROSTER_URL), 'a roster url becomes a known (re-gossipable) address')
  const p = mesh.allPeers().find((x) => x.url === ROSTER_URL)
  assert.ok(p, 'roster url is registered as a peer')
  assert.notEqual(p!.capability, 'reachable', 'roster url classified by PROBE, never reachable on faith')

  assert.ok(!probedUrls.includes(SELF_URL), 'our own url in a roster is self-excluded (never probed)')
  assert.ok(!mesh.knownAddresses().includes(SELF_URL), 'self url never enters the dial registry')
  assert.deepEqual(dialedByProbe, [], 'a roster url is probed, NEVER connectPeer-dialed on faith')

  // ── (3 cont.) a roster with only known/empty urls schedules no new probe ──────
  const before = probedUrls.length
  peer.send(
    JSON.stringify({
      t: 'gossip',
      node: REMOTE,
      sessions: [],
      nodes: [{ nodeId: 'gn', machineId: 'gossiped-1', hostname: 'gn', url: ROSTER_URL, lastActivityAt: Date.now() }],
    }),
  )
  await wait(50)
  assert.equal(probedUrls.length, before, 'a roster of only already-known urls triggers no new probe')

  // a gossip with no nodes[] at all is harmless (older peer) — no probe, no throw.
  peer.send(JSON.stringify({ t: 'gossip', node: REMOTE, sessions: [] }))
  await wait(50)
  assert.equal(probedUrls.length, before, 'gossip without a roster triggers no probe')

  peer.close()
  stopWsMesh()
  _setWebSocketImpl(null)
  _setConnectPeer(null)
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log('l2-roster-dial OK')
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
