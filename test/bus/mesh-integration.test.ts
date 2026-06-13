#!/usr/bin/env tsx
/**
 * T10 integration test: the FederatedBroker composing the REAL graphBroker
 * (local SQLite) with a REAL MeshBroker (remote tier), `global.fetch` stubbed so
 * no network is touched. Same env-before-import + temp-DB convention as
 * test/graph/bus.test.ts: point db.ts at a fresh SQLite via CKN_GRAPH_DB_PATH and
 * configure the mesh env BEFORE dynamic-importing any module that reads them.
 *
 * Proves the end-to-end seam the unit tests only cover in isolation:
 *   1. send — writes LOCALLY (stamped origin_node/mesh_seq in the row); in WS mode
 *      the busEvents→WS forwarder replicates, so the broker makes NO HTTP fan-out.
 *   2. peers — MERGES the local presence (a registered session) with the gossiped
 *      remote-presence view (deduped by sessionId).
 *   3. ingest — a remote message ingested via ingestMeshMessage lands in THIS
 *      node's local store and surfaces through the NORMAL local inbox() for the
 *      addressed session (the whole point of push-replicate: reads stay local).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-integration-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = 'http://node-b:3002,http://node-c:3003'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_GOSSIP_MS = '20000'
delete process.env.CKN_MESH_SELF

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const B = 'http://node-b:3002'
const C = 'http://node-c:3003'

interface Captured {
  url: string
  method: string
  body: any
}

let calls: Captured[] = []

function installFetchStub() {
  global.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
  }) as any
}

async function main() {
  installFetchStub()

  const { graphBroker } = await import('../../server/bus/broker.js')
  const { FederatedBroker } = await import('../../server/bus/federatedBroker.js')
  const { MeshBroker } = await import('../../server/bus/meshBroker.js')
  const { _resetMeshState } = await import('../../server/bus/meshState.js')
  const { ingestMeshMessage } = await import('../../server/graph/bus.js')
  const { nodeId } = await import('../../server/bus/meshIdentity.js')
  const { getDb } = await import('../../server/graph/db.js')

  // Seed mesh state with both peers reachable so they're broadcast targets, and
  // gossip a remote presence so peers() has a remote row to merge.
  const ms = _resetMeshState([B, C])
  const now = Date.now()
  ms.markReachable(B, 'node-b-id', 1, now)
  ms.markReachable(C, 'node-c-id', 1, now)
  ms.mergeGossip('node-b-id', [
    {
      sessionId: 'remote-sess',
      friendlyName: 'Remote',
      cwd: '/repo/remote',
      machine: 'host-b',
      title: 'Remote',
      startedAt: 1,
      lastSeen: now,
      rawStatus: 'live',
      supersedes: '',
      metaId: 'meta_remote',
      nameHistory: [],
    },
  ], now)

  const fed = new FederatedBroker(graphBroker, new MeshBroker())

  // Register a LOCAL session so its alias set resolves an inbound 'Local' address
  // (both for the gossip-merge dedupe and for the mesh-ingest inbox surfacing).
  const local = await graphBroker.register({
    sessionId: 'sess-local',
    title: 'Local',
    cwd: '/repo/local',
    machine: 'host-a',
  })
  assert.equal(local.friendlyName, 'Local', 'local session registered with the Local persona')

  // ── 1. send: writes LOCALLY (stamped) AND fans out to every peer ────────────
  calls = []
  const { id } = await fed.send({
    fromSession: 'sess-local',
    fromName: 'Local',
    to: 'Bravo',
    kind: 'msg',
    body: 'cross-node hello',
  })
  assert.ok(id, 'send returns a minted local id')

  // Local write: the row exists and is stamped with THIS node's origin + a seq.
  const stored = getDb()
    .prepare(`SELECT body, origin_node, mesh_seq FROM bus_messages WHERE id = ?`)
    .get(id) as any
  assert.equal(stored.body, 'cross-node hello', 'send persisted the row locally')
  assert.equal(stored.origin_node, nodeId(), 'local send stamped origin_node = this node')
  assert.ok(Number(stored.mesh_seq) > 0, 'local send stamped a monotonic mesh_seq')

  // Replication in WS mode rides the busEvents→WS forwarder, NOT an HTTP fan-out:
  // the broker's remote.send is a no-op (wsMode), so the FederatedBroker send is a
  // local-write only here, with zero outbound HTTP. (Cross-node delivery over the
  // persistent WS link is proven by ws-channel.test.ts + the 3-node gate.)
  const ingestCalls = calls.filter((c) => c.url.endsWith('/api/mesh/ingest'))
  assert.equal(ingestCalls.length, 0, 'WS mode: send makes no HTTP fan-out (WS forwarder replicates)')

  // ── 2. peers: merges LOCAL presence + GOSSIPED remote presence ──────────────
  const peers = await fed.peers()
  const ids = peers.map((p) => p.sessionId).sort()
  assert.deepEqual(ids, ['remote-sess', 'sess-local'].sort(), 'peers merges local + gossiped, deduped by sessionId')
  const remotePeer = peers.find((p) => p.sessionId === 'remote-sess')!
  assert.equal(remotePeer.machine, 'host-b', 'gossiped remote presence carries its machine')
  assert.equal((remotePeer as any).sourceNode, undefined, 'gossip source tag stripped from the merged presence')
  const localPeer = peers.find((p) => p.sessionId === 'sess-local')!
  assert.equal(localPeer.friendlyName, 'Local', 'local presence surfaced from the graph tier')

  // ── 3. ingest: a remote message lands locally + surfaces via local inbox ────
  // A peer (node-b) broadcasts a message addressed to our Local session. ingest
  // writes it into THIS node's store; the FederatedBroker then reads it back
  // through the NORMAL local inbox (the mesh tier's own inbox() returns []).
  ingestMeshMessage({
    id: 'rm_from_peer',
    fromSession: 'remote-sess',
    fromName: 'Remote',
    to: 'Local', // resolves to sess-local's alias set
    kind: 'msg',
    ref: '',
    body: 'hello from node-b',
    createdAt: Date.now(),
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
    originNode: 'node-b-id',
    meshSeq: 5,
  })

  const inLocal = await fed.inbox('sess-local')
  const ingested = inLocal.find((m) => m.id === 'rm_from_peer')
  assert.ok(ingested, 'mesh-ingested remote message surfaces in the LOCAL inbox for the addressed session')
  assert.equal(ingested!.body, 'hello from node-b', 'ingested message body intact')
  assert.equal(ingested!.fromSession, 'remote-sess', 'ingested message preserves the remote sender')
  // The remote message must appear exactly once (the mesh tier's inbox() is []
  // so the FederatedBroker doesn't double-deliver it on top of the local read).
  assert.equal(
    inLocal.filter((m) => m.id === 'rm_from_peer').length,
    1,
    'ingested message appears exactly once (no double-delivery from the remote tier)',
  )

  console.log('mesh-integration OK')
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
