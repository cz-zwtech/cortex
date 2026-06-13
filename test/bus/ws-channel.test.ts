#!/usr/bin/env tsx
/**
 * Unit test for the M2.1 WS channel core (T2, server/bus/meshWs.ts). Same
 * temp-DB + dynamic-import pattern as test/bus/ws-events.test.ts: point db.ts at
 * a fresh SQLite file via CKN_GRAPH_DB_PATH BEFORE importing the module under
 * test. The db.ts singleton is process-wide, so both "ends" of a loopback share
 * one store — fine here: the assertions are about the WIRE (frame dispatch +
 * echo-guard + backlog replay), not about two independent stores.
 *
 * Proves:
 *   1. echo-guard: a `msg` event tagged with a link's peerNode is NOT forwarded
 *      back to that peer; one tagged with a DIFFERENT peer (or local/undefined) IS.
 *   2. inbound `msg` frame ingests exactly once (idempotent on re-delivery).
 *   3. `hello` → the link replies with a `backlog` of `messagesOriginatedSince`
 *      (everything we originated past the cursor the peer sent for us).
 *   4. inbound `gossip` merges into the mesh presence view.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ws-channel-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
// Deterministic, short gossip interval so the per-link timer doesn't fire mid-test.
process.env.CKN_MESH_GOSSIP_MS = '600000'
// The Link now authenticates in-band (slice #4C); the loopback peer must share the
// fleet token + complete the dialer handshake before the link promotes to live.
process.env.CKN_MESH_TOKEN = 'ws-channel-token'

const { sendMessage, getCursor } = await import('../../server/graph/bus.js')
const { nodeId } = await import('../../server/bus/meshIdentity.js')
const { getMeshState, _resetMeshState } = await import('../../server/bus/meshState.js')
const { onBusMessage, emitBusMessage } = await import('../../server/bus/busEvents.js')
const { acceptPeer, stopWsMesh, wsPeerCount } = await import('../../server/bus/meshWs.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const REMOTE = 'peer-node-remote'
const OTHER = 'peer-node-other'

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

async function main() {
  _resetMeshState([])

  // Seed a message THIS node originated (origin_node = nodeId(), mesh_seq stamped)
  // so the hello→backlog reply has something to replay.
  const { id: originatedId } = await sendMessage({
    fromSession: 'sess-local',
    fromName: 'Local',
    to: 'Remote',
    kind: 'msg',
    body: 'originated locally',
  })

  // ── Stand up a loopback ws server; each accepted socket becomes a Link. ──────
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', (ws) => acceptPeer(ws))
  const port = (wss.address() as AddressInfo).port

  // A client socket that plays the role of the remote peer.
  const peer = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
  const peerFrames = collectFrames(peer)
  await new Promise<void>((resolve) => peer.on('open', () => resolve()))
  // Authenticate in-band (slice #4C) before the server-side Link forwards anything.
  await dialerHandshake(peer, process.env.CKN_MESH_TOKEN!)
  await until(() => wsPeerCount() === 1)

  // The link sends an initial hello + gossip on open.
  await until(() => peerFrames.some((f) => f.t === 'hello'))
  const hello = peerFrames.find((f) => f.t === 'hello')
  assert.equal(hello.node, nodeId(), 'link hello carries our node id')
  assert.ok(
    peerFrames.some((f) => f.t === 'gossip'),
    'link sends an initial gossip on open',
  )

  // ── (3) hello → backlog replays messagesOriginatedSince(theirCursorForUs) ───
  // The peer sends hello with cursor 0 for us → we should backlog the originated msg.
  peer.send(JSON.stringify({ t: 'hello', node: REMOTE, cursors: { [nodeId()]: 0 } }))
  await until(() => peerFrames.some((f) => f.t === 'backlog'))
  const backlog = peerFrames.find((f) => f.t === 'backlog')
  assert.ok(Array.isArray(backlog.messages), 'backlog carries a messages array')
  assert.ok(
    backlog.messages.some((m: any) => m.id === originatedId),
    'backlog replays the locally-originated message',
  )

  // ── (1) echo-guard: an event tagged with the link's learned peerNode (REMOTE)
  // must NOT be forwarded back to this peer; one tagged OTHER (or local) MUST. ──
  // The link learned peerNode=REMOTE from the hello above.
  const beforeEcho = peerFrames.filter((f) => f.t === 'msg').length
  const echoRow = {
    id: 'm_echo_guard',
    fromSession: 's',
    fromName: 'n',
    to: '*',
    kind: 'msg',
    ref: '',
    body: 'from remote, should not echo back',
    createdAt: Date.now(),
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
    originNode: REMOTE,
    meshSeq: 5,
  }
  emitBusMessage(echoRow as any, REMOTE) // arrived FROM this peer → echo-guarded
  await wait(50)
  const afterEcho = peerFrames.filter((f) => f.t === 'msg').length
  assert.equal(afterEcho, beforeEcho, 'message tagged with the link peerNode is NOT echoed back')

  // A message tagged with a DIFFERENT peer IS forwarded to this link.
  emitBusMessage({ ...echoRow, id: 'm_from_other', originNode: OTHER } as any, OTHER)
  await until(() => peerFrames.some((f) => f.t === 'msg' && f.msg?.id === 'm_from_other'))
  assert.ok(
    peerFrames.some((f) => f.t === 'msg' && f.msg?.id === 'm_from_other'),
    'message from a different peer IS forwarded over the link',
  )

  // ── (2) inbound msg frame ingests exactly once; a re-send is idempotent ─────
  const ingestEvents: string[] = []
  const unsub = onBusMessage((row) => ingestEvents.push(row.id))
  const inboundId = 'm_inbound_1'
  const inboundFrame = {
    t: 'msg',
    msg: {
      id: inboundId,
      fromSession: 'sess-remote',
      fromName: 'Remote',
      to: 'Local',
      kind: 'msg',
      ref: '',
      body: 'inbound over the wire',
      createdAt: Date.now(),
      deliveredTo: [],
      ackedBy: [],
      status: 'open',
      origTo: '',
      originNode: REMOTE,
      meshSeq: 7,
    },
  }
  peer.send(JSON.stringify(inboundFrame))
  await until(() => ingestEvents.includes(inboundId))
  peer.send(JSON.stringify(inboundFrame)) // duplicate delivery
  await wait(50)
  assert.equal(
    ingestEvents.filter((id) => id === inboundId).length,
    1,
    'inbound msg frame ingests exactly once (re-delivery is idempotent — no second emit)',
  )
  unsub()

  // ── (4) inbound gossip merges into the mesh presence view ───────────────────
  const gossipFrame = {
    t: 'gossip',
    node: REMOTE,
    sessions: [
      {
        sessionId: 'remote-sess-1',
        friendlyName: 'RemoteWorker',
        cwd: '/repo/remote',
        machine: 'remote-host',
        title: 'RemoteWorker',
        startedAt: Date.now(),
        lastSeen: Date.now(),
        rawStatus: 'live',
        supersedes: '',
        metaId: 'meta_remote_1',
        nameHistory: [],
      },
    ],
  }
  peer.send(JSON.stringify(gossipFrame))
  await until(() => getMeshState().gossipedPeers(Date.now()).some((s) => s.sessionId === 'remote-sess-1'))
  assert.ok(
    getMeshState().gossipedPeers(Date.now()).some((s) => s.sessionId === 'remote-sess-1'),
    'inbound gossip frame merged the remote presence',
  )

  // ── cursor advanced by a backlog frame from the peer ────────────────────────
  const backlogIn = {
    t: 'backlog',
    messages: [
      {
        id: 'm_backlog_in',
        fromSession: 'sr',
        fromName: 'R',
        to: 'Local',
        kind: 'msg',
        ref: '',
        body: 'backlog replay',
        createdAt: Date.now(),
        deliveredTo: [],
        ackedBy: [],
        status: 'open',
        origTo: '',
        originNode: REMOTE,
        meshSeq: 42,
      },
    ],
  }
  peer.send(JSON.stringify(backlogIn))
  await until(() => getCursor(REMOTE) === 42)
  assert.equal(getCursor(REMOTE), 42, 'backlog frame advanced the per-peer cursor to the max seq')

  // ── teardown ────────────────────────────────────────────────────────────────
  peer.close()
  stopWsMesh()
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log('ws-channel OK')
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
