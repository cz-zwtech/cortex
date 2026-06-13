#!/usr/bin/env tsx
/**
 * T4 unit test: WS-mode roles for the gossip loop + the MeshBroker.
 *
 * In WS mode (mesh enabled — CKN_MESH_TOKEN set; the dial-list model, not the old
 * role flags) the persistent WS frames (meshWs.ts) carry presence/messages/state,
 * so the HTTP transport must stand down to avoid double-send:
 *   - `startMeshGossip()` is a NO-OP — it neither schedules an interval nor runs
 *     the immediate kick tick (a passive node opens NO outbound, and the gossip
 *     loop is the only HTTP outbound it would have).
 *   - `MeshBroker.send` (and ack/markDelivered) write-local-only — NO outbound
 *     fetch, even with a reachable broadcast target seeded.
 *
 * Same env-before-import + fetch-stub convention as test/bus/mesh-broker.test.ts
 * and test/bus/mesh-gossip.test.ts. Standalone tsx + node:assert/strict (no
 * vitest). A temp SQLite is used because the broker.send path reads the stamped
 * row back via getMessageById.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ws-roles-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = 'http://node-b:3002'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_GOSSIP_MS = '20000'
delete process.env.CKN_MESH_SELF
delete process.env.CKN_MESH_INITIATOR
delete process.env.CKN_MESH_PASSIVE

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const B = 'http://node-b:3002'

let fetchCalls: string[] = []

function installFetchStub() {
  global.fetch = (async (input: any) => {
    fetchCalls.push(String(input))
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
  }) as any
}

/** Let any fire-and-forget `void tick()` / async work settle. */
const tickYield = () => new Promise((r) => setTimeout(r, 10))

async function main() {
  installFetchStub()

  const { startMeshGossip, stopMeshGossip, wsMode } = await import(
    '../../server/bus/meshGossip.js'
  )
  const { MeshBroker } = await import('../../server/bus/meshBroker.js')
  const { _resetMeshState } = await import('../../server/bus/meshState.js')
  const { sendMessage } = await import('../../server/graph/bus.js')

  // ── 1. WS mode (mesh enabled via token): startMeshGossip is a no-op ──────────
  assert.equal(wsMode(), true, 'mesh enabled (token set) ⇒ WS mode')

  _resetMeshState([B]) // a seeded peer the HTTP loop WOULD gossip if it started
  fetchCalls = []
  startMeshGossip()
  await tickYield() // give the immediate `void tick()` a chance to fire (it must not)
  assert.deepEqual(
    fetchCalls,
    [],
    'passive startMeshGossip starts no gossip loop — zero outbound fetches',
  )
  stopMeshGossip() // idempotent even when nothing was started

  // ── 2. WS mode: broker.send makes no outbound HTTP fetch ─────────────────────
  assert.equal(wsMode(), true, 'mesh enabled (token set) ⇒ WS mode')

  // Seed a REACHABLE broadcast target — in legacy HTTP mode send() would POST to
  // it; in WS mode the busEvents→WS forwarder replicates instead, so no HTTP.
  const ms = _resetMeshState([B])
  ms.markReachable(B, 'node-b-id', 1, Date.now())
  assert.deepEqual(ms.broadcastTargets(), [B], 'peer B is a live broadcast target')

  // Write a real local row first (stamps origin_node/mesh_seq + persists), as the
  // FederatedBroker does before invoking remote.send.
  const { id } = await sendMessage({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Bravo',
    kind: 'msg',
    body: 'ws-mode send',
  })

  const broker = new MeshBroker()
  fetchCalls = []
  const sent = await broker.send({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Bravo',
    kind: 'msg',
    body: 'ws-mode send',
    id,
  })
  assert.equal(sent.id, id, 'send returns the local id unchanged')
  assert.deepEqual(fetchCalls, [], 'WS-mode send does NOT HTTP-POST to peers')

  // ack / markDelivered are likewise write-local-only in WS mode.
  fetchCalls = []
  await broker.ack('sess-B', id, 'done')
  await broker.markDelivered('sess-B', [id])
  assert.deepEqual(fetchCalls, [], 'WS-mode ack/markDelivered do NOT HTTP-POST to peers')

  // ── 3. Sanity: mesh DISABLED (no token) ⇒ wsMode() false and the legacy HTTP
  //     broadcast path is reachable — proving wsMode() GATES the HTTP transport (a
  //     conditional), not a blanket removal. WS mode is token-driven now, not
  //     flag-driven: CKN_MESH_INITIATOR/PASSIVE no longer affect wsMode.
  delete process.env.CKN_MESH_TOKEN
  assert.equal(wsMode(), false, 'mesh disabled (no token) ⇒ wsMode false')
  const ms2 = _resetMeshState([B])
  ms2.markReachable(B, 'node-b-id', 1, Date.now())
  const httpBroker = new MeshBroker()
  fetchCalls = []
  await httpBroker.send({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Bravo',
    kind: 'msg',
    body: 'http-mode send',
    id,
  })
  assert.ok(
    fetchCalls.some((u) => u.endsWith('/api/mesh/ingest')),
    'legacy HTTP mode DOES broadcast — guards the wsMode() gate, not a blanket disable',
  )

  console.log('ws-roles OK')
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
