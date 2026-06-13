#!/usr/bin/env tsx
/**
 * Unit test for the M2.1 WS-channel busEvents tagging (T1). Same temp-DB +
 * dynamic-import pattern as test/graph/bus.test.ts / test/bus/mesh-store.test.ts:
 * point db.ts at a fresh SQLite file via CKN_GRAPH_DB_PATH BEFORE importing the
 * modules under test.
 *
 * Proves the echo-guard tagging the WS forwarder depends on:
 *   1. a LOCAL send fires onBusMessage with NO peer tag (undefined = local
 *      origin; the forwarder pushes it to every peer).
 *   2. an ingestMeshMessage with originNode=X fires onBusMessage tagged X (so the
 *      forwarder skips peer X — no replication loop back to its source).
 *   3. a local ack fires onBusState (undefined peer tag) carrying the unioned
 *      delivered/acked/status — closing the ack-back gap as a `state` frame.
 *   4. markDelivered fires onBusState too.
 *   5. applyMeshState tagged with a source peer re-emits onBusState tagged that
 *      peer, and a no-op re-apply does NOT re-emit (loop guard).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-ws-events-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { sendMessage, markDelivered, ackMessage, ingestMeshMessage, applyMeshState } =
  await import('../../server/graph/bus.js')
const { onBusMessage, onBusState } = await import('../../server/bus/busEvents.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const REMOTE = 'peer-node-remote'

async function main() {
  // ── (1) local send → onBusMessage, NO peer tag ────────────────────────────
  const msgEvents: Array<{ id: string; fromPeerNode?: string }> = []
  const unsubMsg = onBusMessage((row, fromPeerNode) =>
    msgEvents.push({ id: row.id, fromPeerNode }),
  )

  const { id: localId } = await sendMessage({
    fromSession: 'sess-local',
    fromName: 'Local',
    to: 'Remote',
    kind: 'msg',
    body: 'hi from local',
  })
  const localEvt = msgEvents.find((e) => e.id === localId)
  assert.ok(localEvt, 'local send fired onBusMessage')
  assert.equal(localEvt!.fromPeerNode, undefined, 'local send is NOT tagged with a peer (local origin)')

  // ── (2) ingestMeshMessage(originNode=X) → onBusMessage tagged X ───────────
  const ingestId = 'rm_ingest_1'
  ingestMeshMessage({
    id: ingestId,
    fromSession: 'sess-remote',
    fromName: 'Remote',
    to: 'Local',
    kind: 'msg',
    ref: '',
    body: 'hi from afar',
    createdAt: Date.now(),
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
    originNode: REMOTE,
    meshSeq: 1,
  })
  const ingestEvt = msgEvents.find((e) => e.id === ingestId)
  assert.ok(ingestEvt, 'ingestMeshMessage fired onBusMessage')
  assert.equal(ingestEvt!.fromPeerNode, REMOTE, 'ingested message is tagged with its originNode (echo-guard)')

  unsubMsg()

  // ── (3) local ack → onBusState (undefined peer), carries unioned state ────
  const stateEvents: Array<{
    id: string
    deliveredTo: string[]
    ackedBy: string[]
    status: string
    fromPeerNode?: string
  }> = []
  const unsubState = onBusState((state, fromPeerNode) =>
    stateEvents.push({ ...state, fromPeerNode }),
  )

  await ackMessage('sess-local', localId, 'ack')
  const ackEvt = stateEvents.find((e) => e.id === localId && e.status === 'acked')
  assert.ok(ackEvt, 'ack fired onBusState')
  assert.equal(ackEvt!.fromPeerNode, undefined, 'local ack is NOT tagged with a peer (local origin)')
  assert.deepEqual(ackEvt!.ackedBy, ['sess-local'], 'ack state carries the unioned acked_by')
  assert.equal(ackEvt!.status, 'acked', 'ack state carries the advanced status')

  // ── (4) markDelivered → onBusState too ─────────────────────────────────────
  const beforeDeliver = stateEvents.length
  await markDelivered('sess-local', [localId])
  const deliverEvt = stateEvents.slice(beforeDeliver).find((e) => e.id === localId)
  assert.ok(deliverEvt, 'markDelivered fired onBusState')
  assert.equal(deliverEvt!.fromPeerNode, undefined, 'local delivered is not peer-tagged')
  assert.deepEqual(deliverEvt!.deliveredTo, ['sess-local'], 'delivered state carries the unioned delivered_to')

  // ── (5) applyMeshState(source peer) re-emits tagged; no-op re-apply silent ─
  const beforeApply = stateEvents.length
  applyMeshState(ingestId, ['sess-far'], ['sess-far'], 'acked', REMOTE)
  const applyEvt = stateEvents.slice(beforeApply).find((e) => e.id === ingestId)
  assert.ok(applyEvt, 'applyMeshState (a real change) fired onBusState')
  assert.equal(applyEvt!.fromPeerNode, REMOTE, 'applyMeshState is tagged with its source peer (echo-guard)')

  const afterFirstApply = stateEvents.length
  // Same delta again — already merged, nothing changes → must NOT re-emit (loop guard).
  applyMeshState(ingestId, ['sess-far'], ['sess-far'], 'acked', REMOTE)
  assert.equal(stateEvents.length, afterFirstApply, 'no-op re-apply does NOT re-emit (prevents loop)')

  // unknown id → no row, no emit.
  const beforeUnknown = stateEvents.length
  applyMeshState('does-not-exist', ['x'], [], 'done', REMOTE)
  assert.equal(stateEvents.length, beforeUnknown, 'applyMeshState on unknown id emits nothing')

  unsubState()

  console.log('ws-events OK')
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
