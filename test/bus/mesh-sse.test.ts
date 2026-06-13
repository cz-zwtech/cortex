#!/usr/bin/env tsx
/**
 * Smoke test for the SSE push channel (T9). Same temp-DB + dynamic-import
 * pattern as test/graph/bus.test.ts (set CKN_GRAPH_DB_PATH BEFORE importing the
 * modules under test). Proves the two load-bearing properties of the
 * server→watcher push path, independent of the HTTP wire (which the m2m gate
 * smoke-tests):
 *
 *   1. emitBusMessage REACHES an onBusMessage subscriber — sending a message (or
 *      ingesting one from a peer) fires the in-process emitter, so a subscribed
 *      SSE connection surfaces it instantly instead of on the next poll tick.
 *   2. The SSE alias filter (the exact predicate /api/bus/stream applies) lets
 *      through only rows addressed to one of the reader's aliases AND not sent by
 *      the reader itself — non-recipients and own-sends are excluded.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-sse-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { onBusMessage, emitBusMessage } = await import('../../server/bus/busEvents.js')
const { registerSession, sendMessage, ingestMeshMessage } = await import('../../server/graph/bus.js')
const { aliasSetFor } = await import('../../server/bus/identity.js')
import type { BusMessageRow } from '../../server/graph/_rows.js'

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

async function main() {
  // ── (1) emitBusMessage reaches an onBusMessage subscriber ──────────────────
  // A bare emit must land on a subscriber. This is the decoupling contract the
  // SSE endpoint relies on (sendMessage / ingestMeshMessage emit; /stream subs).
  const direct: BusMessageRow[] = []
  const unsubDirect = onBusMessage((row) => direct.push(row))
  const synthetic: BusMessageRow = {
    id: 'synthetic-1',
    fromSession: 'sess-X',
    fromName: 'X',
    to: 'Reader',
    kind: 'msg',
    ref: '',
    body: 'hello',
    createdAt: Date.now(),
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
  }
  emitBusMessage(synthetic)
  assert.equal(direct.length, 1, 'emitBusMessage reaches the subscriber')
  assert.equal(direct[0]!.id, 'synthetic-1', 'subscriber receives the exact row')
  unsubDirect()
  emitBusMessage({ ...synthetic, id: 'synthetic-2' })
  assert.equal(direct.length, 1, 'unsubscribe stops delivery')

  // ── set up a reader session so its alias set is real ───────────────────────
  const reader = await registerSession({
    sessionId: 'sess-Reader',
    title: 'Reader',
    cwd: '/repo/r',
    machine: 'host1',
  })
  const aliasSet = aliasSetFor({
    sessionId: reader.sessionId,
    metaId: reader.metaId,
    friendlyName: reader.friendlyName,
    nameHistory: reader.nameHistory,
  })
  // The exact predicate /api/bus/stream applies for this reader.
  const forwarded: BusMessageRow[] = []
  const unsub = onBusMessage((row) => {
    if (row.fromSession === reader.sessionId) return // never my own sends
    if (!aliasSet.has(row.to)) return // only my aliases
    forwarded.push(row)
  })

  // ── (2) sendMessage emits + alias filter routes correctly ──────────────────
  // Addressed to my friendly name → forwarded.
  await sendMessage({ fromSession: 'sess-Carol', fromName: 'Carol', to: 'Reader', kind: 'msg', body: 'to name' })
  // Addressed to my sessionId → forwarded.
  await sendMessage({ fromSession: 'sess-Carol', fromName: 'Carol', to: 'sess-Reader', kind: 'msg', body: 'to id' })
  // Addressed to my metaId → forwarded.
  await sendMessage({ fromSession: 'sess-Carol', fromName: 'Carol', to: reader.metaId, kind: 'msg', body: 'to meta' })
  // Broadcast '*' → forwarded ('*' is in every alias set).
  await sendMessage({ fromSession: 'sess-Carol', fromName: 'Carol', to: '*', kind: 'msg', body: 'broadcast' })
  // Addressed to SOMEONE ELSE → excluded.
  await sendMessage({ fromSession: 'sess-Carol', fromName: 'Carol', to: 'Someone-Else', kind: 'msg', body: 'not me' })
  // Sent BY the reader (even to its own name) → excluded (own send).
  await sendMessage({ fromSession: 'sess-Reader', fromName: 'Reader', to: 'Reader', kind: 'msg', body: 'self note' })

  const bodies = forwarded.map((m) => m.body).sort()
  assert.deepEqual(
    bodies,
    ['broadcast', 'to id', 'to meta', 'to name'].sort(),
    'alias filter forwards name/id/metaId/broadcast; excludes non-recipients + own sends',
  )

  // ── ingestMeshMessage also emits (a mesh-ingested message surfaces instantly) ─
  const before = forwarded.length
  ingestMeshMessage({
    id: 'mesh-ingest-1',
    fromSession: 'sess-Remote',
    fromName: 'Remote',
    to: 'Reader',
    kind: 'msg',
    ref: '',
    body: 'from a peer',
    createdAt: Date.now(),
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
    originNode: 'peer-node',
    meshSeq: 1,
  })
  assert.equal(forwarded.length, before + 1, 'ingestMeshMessage emits to the subscriber')
  assert.equal(forwarded.at(-1)!.body, 'from a peer', 'mesh-ingested message surfaces with correct body')

  // A state-only re-ingest of the same id must NOT re-emit (no re-surfacing).
  const afterIngest = forwarded.length
  ingestMeshMessage({
    id: 'mesh-ingest-1',
    fromSession: 'sess-Remote',
    fromName: 'Remote',
    to: 'Reader',
    kind: 'msg',
    ref: '',
    body: 'from a peer',
    createdAt: Date.now(),
    deliveredTo: ['sess-Reader'],
    ackedBy: [],
    status: 'acked',
    origTo: '',
    originNode: 'peer-node',
    meshSeq: 1,
  })
  assert.equal(forwarded.length, afterIngest, 're-ingest (state-only union) does NOT re-emit')

  unsub()
  console.log('mesh-sse OK')
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
