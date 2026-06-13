#!/usr/bin/env tsx
/**
 * Unit test: the MeshBroker remote tier in WS MODE (the live transport).
 *
 * Since the dial-list model (spec §2), the WS channel (meshWs.ts) is THE mesh
 * transport whenever mesh is enabled (CKN_MESH_TOKEN set ⇒ wsMode()), so the
 * MeshBroker is THIN: send/ack/markDelivered write-local-only and the busEvents→WS
 * forwarder replicates — the broker itself makes NO outbound HTTP. (The legacy
 * HTTP-broadcast branch is `!wsMode` and is guarded + minimally covered by
 * ws-roles.test.ts.) This test proves the live WS-mode behavior:
 *   - send returns the local id unchanged and makes no outbound fetch
 *   - markDelivered / ack make no outbound fetch
 *   - peers() reflects the gossiped MeshState view (source tag stripped)
 *   - inbox() is always empty (replicated messages live in the local store)
 *   - presence ops are no-ops and never throw
 *
 * Same env-before-import + temp-DB + fetch-stub convention as test/graph/bus.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-broker-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = 'http://node-b:3002,http://node-c:3003'
process.env.CKN_MESH_TOKEN = 'fleet-secret' // token set ⇒ wsMode() ⇒ no HTTP broadcast
process.env.CKN_MESH_GOSSIP_MS = '20000'
delete process.env.CKN_MESH_SELF

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const B = 'http://node-b:3002'

let fetchCalls: string[] = []
function installFetchStub() {
  global.fetch = (async (input: any) => {
    fetchCalls.push(String(input))
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
  }) as any
}

async function main() {
  installFetchStub()

  const { MeshBroker } = await import('../../server/bus/meshBroker.js')
  const { _resetMeshState } = await import('../../server/bus/meshState.js')
  const { wsMode } = await import('../../server/bus/meshGossip.js')
  const { sendMessage } = await import('../../server/graph/bus.js')

  assert.equal(wsMode(), true, 'token set ⇒ WS mode (broker is thin, no HTTP broadcast)')

  _resetMeshState([B])
  const broker = new MeshBroker()

  // ── send: write-local-only, returns the local id, NO outbound HTTP ──────────
  const { id } = await sendMessage({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Bravo',
    kind: 'msg',
    body: 'cross-node hello',
  })
  fetchCalls = []
  const sent = await broker.send({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Bravo',
    kind: 'msg',
    body: 'cross-node hello',
    id, // FederatedBroker passes the local id through
  })
  assert.equal(sent.id, id, 'send returns the local id unchanged (no remote minting)')
  assert.deepEqual(fetchCalls, [], 'WS-mode send makes no outbound HTTP (the WS forwarder replicates)')

  // ── markDelivered / ack: write-local-only, NO outbound HTTP ─────────────────
  fetchCalls = []
  await broker.markDelivered('sess-B', [id])
  await broker.ack('sess-B', id, 'done')
  await broker.ack('sess-B', id, 'ack')
  assert.deepEqual(fetchCalls, [], 'WS-mode markDelivered/ack make no outbound HTTP')

  // ── peers(): reflects the gossiped MeshState view (source tag stripped) ─────
  const ms2 = _resetMeshState([B])
  ms2.markReachable(B, 'node-b-id', 1, Date.now())
  ms2.mergeGossip(
    'node-b-id',
    [
      {
        sessionId: 'remote-1',
        friendlyName: 'Remote',
        cwd: '/repo',
        machine: 'host-b',
        title: 'Remote',
        startedAt: 1,
        lastSeen: Date.now(),
        rawStatus: 'live',
        supersedes: '',
        metaId: 'meta_remote-1',
        nameHistory: [],
      } as any,
    ],
    Date.now(),
  )
  const broker2 = new MeshBroker()
  const peers = await broker2.peers()
  assert.equal(peers.length, 1, 'peers() returns the gossiped view')
  assert.equal(peers[0]!.sessionId, 'remote-1', 'peers() surfaces the gossiped session')
  assert.equal((peers[0] as any).sourceNode, undefined, 'gossip source tag stripped from SessionPresence')

  // ── inbox(): always empty (replicated messages live in the local store) ─────
  assert.deepEqual(await broker2.inbox(), [], 'inbox() is empty on the mesh tier')

  // ── presence ops are no-ops and do not throw ───────────────────────────────
  await broker2.heartbeat('sess-A')
  await broker2.touch('sess-A', '/repo', 'host')
  await broker2.signoff('sess-A')

  console.log('mesh-broker OK')
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
