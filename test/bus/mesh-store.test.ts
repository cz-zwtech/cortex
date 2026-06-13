#!/usr/bin/env tsx
/**
 * Unit test for the mesh-transport store methods on server/graph/bus.ts (T2).
 * Same temp-DB + dynamic-import pattern as test/graph/bus.test.ts: point the
 * db.ts singleton at a fresh SQLite file via CKN_GRAPH_DB_PATH BEFORE importing
 * the module under test. Proves the upsert-with-union convergence properties:
 *   - fresh ingest INSERTS (preserving the sender's origin_node/mesh_seq)
 *   - re-ingest the same id UNIONS delivered_to (no dupes) and NEVER regresses
 *     status (open→done sticks; a stale 'open' re-ingest can't undo it)
 *   - messagesOriginatedSince returns only LOCAL-origin rows, in seq order
 *   - getCursor/setCursor round-trips per peer
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-store-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const {
  sendMessage,
  inbox,
  ingestMeshMessage,
  applyMeshState,
  messagesOriginatedSince,
  nextMeshSeq,
  getCursor,
  setCursor,
} = await import('../../server/graph/bus.js')
const { nodeId } = await import('../../server/bus/meshIdentity.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const REMOTE = 'peer-node-remote'

function wire(over: Partial<Parameters<typeof ingestMeshMessage>[0]> = {}) {
  return {
    id: 'rm_1',
    fromSession: 'sess-remote',
    fromName: 'Remote',
    to: 'Local',
    kind: 'msg',
    ref: '',
    body: 'hello from afar',
    createdAt: Date.now(),
    deliveredTo: [] as string[],
    ackedBy: [] as string[],
    status: 'open',
    origTo: '',
    originNode: REMOTE,
    meshSeq: 7,
    ...over,
  }
}

async function main() {
  // ── fresh ingest INSERTS, preserving the sender's origin_node/mesh_seq ──────
  ingestMeshMessage(wire())
  const { getDb } = await import('../../server/graph/db.js')
  const stored = getDb()
    .prepare(
      `SELECT origin_node, mesh_seq, delivered_to, acked_by, status, body FROM bus_messages WHERE id = ?`,
    )
    .get('rm_1') as any
  assert.equal(stored.body, 'hello from afar', 'fresh ingest inserted the row')
  assert.equal(stored.origin_node, REMOTE, 'preserves sender origin_node (not re-stamped)')
  assert.equal(stored.mesh_seq, 7, 'preserves sender mesh_seq')
  assert.equal(stored.status, 'open', 'status open on fresh ingest')

  // It is now readable through the normal LOCAL inbox path (mesh-ingested
  // messages live in the local store; that is the whole point of push-replicate).
  const inLocal = await inbox('sess-local-A')
  // The reader's alias set won't include 'Local' unless registered; assert by id
  // on a broad read instead — query the row exists and routes when addressed.
  assert.ok(
    getDb().prepare(`SELECT 1 FROM bus_messages WHERE id = 'rm_1'`).get(),
    'ingested message persisted to local store',
  )

  // ── re-ingest same id: UNION delivered_to, no dupes, status NEVER regresses ─
  ingestMeshMessage(wire({ deliveredTo: ['sess-B'], status: 'acked' }))
  ingestMeshMessage(wire({ deliveredTo: ['sess-B', 'sess-C'], status: 'done' }))
  // A stale re-ingest carrying the lowest status + a repeat recipient: must not
  // regress status and must not duplicate the CSV entry.
  ingestMeshMessage(wire({ deliveredTo: ['sess-B'], status: 'open' }))

  const merged = getDb()
    .prepare(`SELECT delivered_to, acked_by, status, origin_node, mesh_seq FROM bus_messages WHERE id = ?`)
    .get('rm_1') as any
  const deliveredSet = merged.delivered_to.split(',').filter(Boolean).sort()
  assert.deepEqual(deliveredSet, ['sess-B', 'sess-C'], 'delivered_to UNIONed without dupes')
  assert.equal(merged.status, 'done', 'status advanced to done and never regressed to open/acked')
  assert.equal(merged.origin_node, REMOTE, 'immutable origin_node unchanged across unions')
  assert.equal(merged.mesh_seq, 7, 'immutable mesh_seq unchanged across unions')

  // ── applyMeshState: same union, no-op on unknown id, no status regression ───
  applyMeshState('rm_1', ['sess-D'], ['sess-B'], 'acked')
  const afterState = getDb()
    .prepare(`SELECT delivered_to, acked_by, status FROM bus_messages WHERE id = ?`)
    .get('rm_1') as any
  assert.deepEqual(
    afterState.delivered_to.split(',').filter(Boolean).sort(),
    ['sess-B', 'sess-C', 'sess-D'],
    'applyMeshState unions delivered_to',
  )
  assert.deepEqual(afterState.acked_by.split(',').filter(Boolean), ['sess-B'], 'applyMeshState unions acked_by')
  assert.equal(afterState.status, 'done', 'applyMeshState cannot regress done→acked')
  // unknown id is a silent no-op.
  applyMeshState('does-not-exist', ['x'], [], 'done')
  assert.ok(!getDb().prepare(`SELECT 1 FROM bus_messages WHERE id = 'does-not-exist'`).get(), 'no-op on unknown id')

  // ── messagesOriginatedSince: only LOCAL-origin rows, in seq order ───────────
  // Local sends are stamped with origin_node = nodeId() + a monotonic mesh_seq.
  const s1 = await sendMessage({ fromSession: 'sess-local-A', fromName: 'A', to: 'Bob', kind: 'msg', body: 'm1' })
  const s2 = await sendMessage({ fromSession: 'sess-local-A', fromName: 'A', to: 'Bob', kind: 'msg', body: 'm2' })
  const s3 = await sendMessage({ fromSession: 'sess-local-A', fromName: 'A', to: 'Bob', kind: 'msg', body: 'm3' })

  const originated = messagesOriginatedSince(0)
  assert.ok(
    originated.every((m) => m.originNode === nodeId()),
    'messagesOriginatedSince returns ONLY local-origin rows (the remote rm_1 excluded)',
  )
  assert.ok(!originated.some((m) => m.id === 'rm_1'), 'remote-origin message excluded from /since source')
  const bodies = originated.map((m) => m.body)
  assert.deepEqual(bodies, ['m1', 'm2', 'm3'], 'returned in mesh_seq ASC (send order)')
  // seqs are strictly increasing.
  const seqs = originated.map((m) => m.meshSeq ?? 0)
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, 'mesh_seq strictly monotonic per local send')
  }
  // `after` cursor windows correctly: after m1's seq returns only m2,m3.
  const m1Seq = originated[0]!.meshSeq!
  const afterM1 = messagesOriginatedSince(m1Seq)
  assert.deepEqual(afterM1.map((m) => m.body), ['m2', 'm3'], 'after=<m1.seq> returns only later originated rows')
  void s1, void s2, void s3

  // nextMeshSeq advances past the last send.
  const nx = nextMeshSeq()
  assert.ok(nx > seqs[seqs.length - 1]!, 'nextMeshSeq advances the monotonic counter')

  // ── getCursor / setCursor round-trip per peer ───────────────────────────────
  assert.equal(getCursor(REMOTE), 0, 'unknown peer cursor is 0')
  setCursor(REMOTE, 42)
  assert.equal(getCursor(REMOTE), 42, 'cursor round-trips after setCursor')
  setCursor(REMOTE, 99)
  assert.equal(getCursor(REMOTE), 99, 'cursor upsert advances on a second set')
  assert.equal(getCursor('other-peer'), 0, 'cursors are per-peer (other peer still 0)')

  console.log('mesh-store OK')
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
