#!/usr/bin/env tsx
/**
 * L2-T4 unit test: symmetric-failover link dedupe (server/bus/meshWs.ts).
 *
 * Two mutually-reachable nodes may BOTH dial → two live links to the SAME
 * peerNode (our DIALED one + the INBOUND one they opened to us). The mesh keeps
 * exactly ONE — the link dialed by the LOWER nodeId (the canonical dialer) — and
 * closes the other. Either side may re-dial on a drop (no master/slave).
 *
 * Same temp-DB + dynamic-import convention as test/bus/ws-channel.test.ts (the
 * db.ts singleton is process-wide; both link ends share one store — fine, the
 * assertions are about the LINK SET, not two independent stores). Standalone tsx
 * + node:assert/strict (no vitest).
 *
 * `nodeId()` is host-derived and fixed at runtime, so rather than fake it we READ
 * the real value and pick peerNode strings that sort deterministically BELOW and
 * ABOVE it — exercising both tiebreak directions for real.
 *
 * Test rig: a loopback ws server stands in for the peer's endpoint. It answers
 * EVERY inbound `hello` with a hello carrying the scenario's peerNode, so the
 * DIALED client Link (connectPeer) learns peerNode from the server's reply. The
 * ACCEPTED (inbound) Link is built by wrapping a server-side socket via
 * acceptPeer, and learns peerNode from a hello the matching client sends it. Once
 * both links share a peerNode, learnPeer → dedupe collapses them to one.
 *
 * Proves:
 *   A. shouldKeepLink (pure tiebreak): self<peer ⇒ keep DIALED; self>peer ⇒ keep ACCEPTED.
 *   B. self < peerNode → WE are canonical → the DIALED link survives, the inbound closes.
 *   C. self > peerNode → THEY are canonical → the INBOUND (accepted) link survives, our dial closes.
 *   D. a single link to a peerNode is never deduped (nothing to dedupe).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'
import { peerHandshake } from './_peer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-l2-failover-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_TOKEN = 'fleet-secret'
// Long gossip interval so a per-link timer never fires mid-test.
process.env.CKN_MESH_GOSSIP_MS = '600000'
process.env.CKN_MESH_PEERS = ''
delete process.env.CKN_MESH_SELF

const { _resetMeshState } = await import('../../server/bus/meshState.js')
const { nodeId } = await import('../../server/bus/meshIdentity.js')
const { acceptPeer, connectPeer, stopWsMesh, wsPeerCount, wsLinks, shouldKeepLink } =
  await import('../../server/bus/meshWs.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await wait(10)
  }
}

async function main() {
  const self = nodeId()
  // A leading space sorts below any normal id; U+FFFF sorts above. Deterministic
  // relative to whatever host-derived self id this box has.
  const LOW = ' aaa-canonical-low'
  const HIGH = '￿zzz-canonical-high'
  assert.ok(LOW < self, `LOW (${JSON.stringify(LOW)}) must sort below self (${self})`)
  assert.ok(HIGH > self, `HIGH (${JSON.stringify(HIGH)}) must sort above self (${self})`)

  // ── A. Pure tiebreak helper ────────────────────────────────────────────────
  // self < peer ⇒ WE dial ⇒ keep the DIALED link, drop the accepted one.
  assert.equal(shouldKeepLink(self, HIGH, true), true, 'self<peer: keep DIALED link')
  assert.equal(shouldKeepLink(self, HIGH, false), false, 'self<peer: drop ACCEPTED link')
  // self > peer ⇒ THEY dial ⇒ keep the ACCEPTED (inbound) link, drop ours.
  assert.equal(shouldKeepLink(self, LOW, true), false, 'self>peer: drop DIALED link')
  assert.equal(shouldKeepLink(self, LOW, false), true, 'self>peer: keep ACCEPTED link')
  // self === peer (degenerate id collision): never close the last link.
  assert.equal(shouldKeepLink(self, self, true), true, 'self==peer: keep (no self-eviction)')
  assert.equal(shouldKeepLink(self, self, false), true, 'self==peer: keep (no self-eviction)')

  // The loopback peer endpoint. It answers every inbound hello with a hello as the
  // CURRENT scenario's peerNode (`peerReplyNode`), driving the DIALED link's learn.
  let peerReplyNode = ''
  // When set, the NEXT inbound loopback connection is the one production
  // `connectPeer` dialed — the loopback must answer ITS in-band handshake as the
  // peer. Connections that the test instead wraps via `acceptPeer` (the inbound
  // links) are handshaked by the PRODUCTION peer Link, so this stays false for them.
  // Set synchronously in the connection handler (race-free vs the dialer's hs1) and
  // self-clears so it gates exactly one connection.
  let loopbackActsAsPeer = false
  const serverSockets: WebSocket[] = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', (ws) => {
    serverSockets.push(ws)
    if (loopbackActsAsPeer) {
      loopbackActsAsPeer = false
      void peerHandshake(ws, process.env.CKN_MESH_TOKEN!).catch(() => {})
    }
    ws.on('message', (d) => {
      let f: any
      try {
        f = JSON.parse(String(d))
      } catch {
        return
      }
      if (f?.t === 'hello' && peerReplyNode) {
        try {
          ws.send(JSON.stringify({ t: 'hello', node: peerReplyNode, cursors: {} }))
        } catch {
          /* socket may be mid-close after dedupe */
        }
      }
    })
  })
  const port = (wss.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`

  /** Run one dedupe scenario: build a DIALED + an ACCEPTED link to the same
   * peerNode, assert dedupe leaves exactly one with the expected `dialed` flag. */
  async function scenario(peerNode: string, expectDialedSurvivor: boolean): Promise<void> {
    stopWsMesh()
    await until(() => wsPeerCount() === 0)
    _resetMeshState([])
    peerReplyNode = peerNode

    // (1) ACCEPTED (inbound) link: a client connects; the server-side socket is
    // wrapped via acceptPeer (dialed=false). The CLIENT sends a hello carrying
    // peerNode so the accepted Link learns it.
    const beforeAccept = serverSockets.length
    const inboundClient = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
    await new Promise<void>((resolve) => inboundClient.on('open', () => resolve()))
    await until(() => serverSockets.length > beforeAccept)
    acceptPeer(serverSockets[serverSockets.length - 1]) // dialed=false
    await until(() => wsPeerCount() === 1)
    await dialerHandshake(inboundClient, process.env.CKN_MESH_TOKEN!) // authenticate the accepted Link in-band
    inboundClient.send(JSON.stringify({ t: 'hello', node: peerNode, cursors: {} }))
    await until(() => wsLinks().some((l) => l.peerNode === peerNode && l.dialed === false))

    // (2) DIALED link: connectPeer opens a client Link (dialed=true) to the
    // loopback; the loopback answers its in-band handshake as the peer, then
    // answers its hello with peerNode (peerReplyNode) → the dialed Link learns
    // peerNode and dedupe fires across both links.
    loopbackActsAsPeer = true // the next loopback connection is connectPeer's dial
    connectPeer(url)
    await until(() => wsPeerCount() === 2)

    // Dedupe must collapse the two links to exactly ONE.
    await until(() => wsPeerCount() === 1, 3000)
    await wait(50) // let a deferred (setImmediate) close settle

    const survivors = wsLinks()
    assert.equal(survivors.length, 1, `dedupe leaves exactly one link for ${JSON.stringify(peerNode)}`)
    assert.equal(survivors[0].peerNode, peerNode, 'survivor is the right peer')
    assert.equal(
      survivors[0].dialed,
      expectDialedSurvivor,
      expectDialedSurvivor
        ? 'self<peer: the link WE dialed survives'
        : 'self>peer: the link THEY dialed (our accepted inbound) survives',
    )

    inboundClient.close()
    await wait(20)
  }

  // ── B. self < peerNode (HIGH) → WE are canonical dialer → DIALED link survives ──
  await scenario(HIGH, true)

  // ── C. self > peerNode (LOW) → THEY are canonical → ACCEPTED (inbound) survives ──
  await scenario(LOW, false)

  // ── D. a single link to a peerNode is never deduped ─────────────────────────
  {
    stopWsMesh()
    await until(() => wsPeerCount() === 0)
    _resetMeshState([])
    peerReplyNode = ''
    const before = serverSockets.length
    const c = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
    await new Promise<void>((resolve) => c.on('open', () => resolve()))
    await until(() => serverSockets.length > before)
    acceptPeer(serverSockets[serverSockets.length - 1])
    await until(() => wsPeerCount() === 1)
    await dialerHandshake(c, process.env.CKN_MESH_TOKEN!) // authenticate the accepted Link in-band
    c.send(JSON.stringify({ t: 'hello', node: HIGH, cursors: {} }))
    await wait(100)
    assert.equal(wsPeerCount(), 1, 'a lone link to a peerNode is never deduped away')
    c.close()
  }

  // ── teardown ────────────────────────────────────────────────────────────────
  stopWsMesh()
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log('l2-failover OK')
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
