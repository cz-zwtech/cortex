#!/usr/bin/env tsx
/**
 * Unit test for the SQLite-ported server/graph/bus.ts. Points the db.ts
 * singleton at a temp SQLite file via CKN_GRAPH_DB_PATH (set BEFORE importing
 * bus.ts), then exercises register/touch/heartbeat/signoff/send/inbox/
 * delivered/ack/peers and asserts the byte-compatible JSON shapes + the tricky
 * bits: alias-set inbox routing, metaId reclaim-by-title, rebind/supersede,
 * CSV-union delivered_to/acked_by, touch backfill, broadcast started_at gating.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const {
  registerSession,
  heartbeat,
  touchSession,
  signoff,
  sendMessage,
  inbox,
  markDelivered,
  ackMessage,
  listPeers,
} = await import('../../server/graph/bus.js')

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

async function main() {
  // ── registerSession: fresh create, presence shape, metaId minted ──────────
  const p1 = await registerSession({
    sessionId: 'sess-A',
    title: 'Alpha',
    cwd: '/repo/a',
    machine: 'host1',
  })
  assert.equal(p1.sessionId, 'sess-A', 'register returns sessionId')
  assert.equal(p1.friendlyName, 'Alpha', 'friendlyName from title')
  assert.equal(p1.cwd, '/repo/a')
  assert.equal(p1.machine, 'host1')
  assert.equal(p1.title, 'Alpha')
  assert.equal(p1.rawStatus, 'live', 'fresh register is live')
  assert.equal(p1.supersedes, '', 'no prior to supersede')
  assert.ok(p1.metaId.startsWith('meta_'), 'minted a durable metaId')
  assert.ok(Array.isArray(p1.nameHistory) && p1.nameHistory.length === 0, 'empty name history')
  assert.equal(typeof p1.startedAt, 'number')
  assert.equal(typeof p1.lastSeen, 'number')
  // Exact key set — the live bus + watcher depend on this shape.
  assert.deepEqual(
    Object.keys(p1).sort(),
    // Includes the mandate-in-presence (Item 1) fields: availability, mandate,
    // assignedBy, assignedRef, cadenceS.
    ['assignedBy', 'assignedRef', 'availability', 'cadenceS', 'cwd', 'friendlyName', 'lastSeen', 'machine', 'mandate', 'metaId', 'nameHistory', 'rawStatus', 'sessionId', 'startedAt', 'supersedes', 'title'].sort(),
    'SessionPresence key set is exact',
  )

  // ── resume (same id): keeps metaId, stays live ────────────────────────────
  const p1b = await registerSession({
    sessionId: 'sess-A',
    title: 'Alpha',
    cwd: '/repo/a',
    machine: 'host1',
  })
  assert.equal(p1b.metaId, p1.metaId, 'resume keeps the durable metaId')

  // ── ISOLATION: a NEW session sharing a LIVE session's title does NOT merge ─
  // sess-A/Alpha is live; sess-B renamed to Alpha is a DISTINCT concurrent voice
  // and must own its own identity — never inherit a live donor's metaId (the
  // metaId-collision bug).
  const p2 = await registerSession({
    sessionId: 'sess-B',
    title: 'Alpha', // same persona title as the LIVE sess-A
    cwd: '/repo/b', // different cwd
    machine: 'host1',
  })
  assert.notEqual(p2.metaId, p1.metaId, 'concurrent-live same-title session gets a DISTINCT metaId (isolation)')

  // reclaim-by-title is allowed ONLY from a NOT-live donor (a genuine resume):
  // sign a donor off, then a new same-title session inherits its identity.
  const z1 = await registerSession({ sessionId: 'sess-Z1', title: 'Zeta', cwd: '/repo/z', machine: 'host1' })
  await signoff('sess-Z1')
  const z2 = await registerSession({ sessionId: 'sess-Z2', title: 'Zeta', cwd: '/repo/zz', machine: 'host1' })
  assert.equal(z2.metaId, z1.metaId, 'reclaim-by-title inherits identity from a SIGNED_OFF donor (resume)')

  // cwd is NOT an identity key: two distinct sessions in one repo stay distinct
  // even when the prior signed off — a shared cwd is not a resume signal (this
  // was the 2-unnamed-same-cwd collision Fable surfaced).
  const cw1 = await registerSession({ sessionId: 'sess-CW1', cwd: '/repo/shared', machine: 'host1' })
  await signoff('sess-CW1')
  const cw2 = await registerSession({ sessionId: 'sess-CW2', cwd: '/repo/shared', machine: 'host1' })
  assert.notEqual(cw2.metaId, cw1.metaId, 'same-cwd distinct sessions do NOT merge (cwd is not an identity key)')

  // ── send + inbox alias routing ────────────────────────────────────────────
  // Message addressed to the friendly name resolves to the session's inbox.
  await sendMessage({
    fromSession: 'sess-C',
    fromName: 'Carol',
    to: 'Alpha', // friendly name alias of sess-A
    kind: 'msg',
    body: 'hi alpha',
  })
  // Message addressed to the metaId resolves too.
  const { id: mMeta } = await sendMessage({
    fromSession: 'sess-C',
    fromName: 'Carol',
    to: p1.metaId,
    kind: 'msg',
    body: 'via metaId',
  })
  // Message addressed to the raw sessionId resolves too.
  await sendMessage({
    fromSession: 'sess-C',
    fromName: 'Carol',
    to: 'sess-A',
    kind: 'msg',
    body: 'via sessionId',
  })
  // A message FROM the reader itself must be excluded.
  await sendMessage({
    fromSession: 'sess-A',
    fromName: 'Alpha',
    to: 'Alpha',
    kind: 'msg',
    body: 'self note',
  })

  const inA = await inbox('sess-A')
  const bodies = inA.map((m) => m.body).sort()
  assert.deepEqual(bodies, ['hi alpha', 'via metaId', 'via sessionId'].sort(), 'alias-set routes name+metaId+sessionId; self excluded')
  // BusMessage shape contract.
  const m0 = inA[0]!
  assert.deepEqual(
    Object.keys(m0).sort(),
    // Includes the m2m provenance fields: trust, originNode, meshVerified, humanProvenance.
    ['ackedBy', 'body', 'createdAt', 'deliveredTo', 'fromSession', 'fromName', 'humanProvenance', 'id', 'kind', 'meshVerified', 'origTo', 'originNode', 'ref', 'status', 'to', 'trust'].sort(),
    'BusMessageRow key set is exact',
  )
  assert.ok(Array.isArray(m0.deliveredTo) && Array.isArray(m0.ackedBy), 'CSV cols parse to arrays')
  assert.equal(m0.status, 'open', 'fresh message open')
  assert.equal(m0.kind, 'msg')

  // ── markDelivered: CSV union, undeliveredOnly filter ──────────────────────
  await markDelivered('sess-A', [mMeta])
  await markDelivered('sess-A', [mMeta]) // idempotent union — no dup
  const delivered = (await inbox('sess-A')).find((m) => m.id === mMeta)!
  assert.deepEqual(delivered.deliveredTo, ['sess-A'], 'delivered_to CSV union dedupes')
  const undeliv = await inbox('sess-A', { undeliveredOnly: true })
  assert.ok(!undeliv.some((m) => m.id === mMeta), 'undeliveredOnly hides delivered message')
  assert.equal(undeliv.length, 2, 'two still-undelivered messages remain')

  // ── ackMessage: acked_by union + status transitions ───────────────────────
  await ackMessage('sess-A', mMeta, 'ack')
  let acked = (await inbox('sess-A')).find((m) => m.id === mMeta)!
  assert.deepEqual(acked.ackedBy, ['sess-A'], 'acked_by union')
  assert.equal(acked.status, 'acked', 'ack → status acked')
  await ackMessage('sess-A', mMeta, 'done')
  acked = (await inbox('sess-A')).find((m) => m.id === mMeta)!
  assert.equal(acked.status, 'done', 'done → status done')
  assert.deepEqual(acked.ackedBy, ['sess-A'], 'acked_by stays deduped on second ack')

  // ── broadcast started_at gating: '*' before startedAt is filtered out ─────
  const before = await sendMessage({ fromSession: 'sess-X', fromName: 'X', to: '*', kind: 'msg', body: 'old broadcast' })
  // Backdate it to before sess-A started.
  const { getDb } = await import('../../server/graph/db.js')
  getDb().prepare('UPDATE bus_messages SET created_at = ? WHERE id = ?').run(p1.startedAt - 1000, before.id)
  await sendMessage({ fromSession: 'sess-X', fromName: 'X', to: '*', kind: 'msg', body: 'new broadcast' })
  const inAfter = await inbox('sess-A')
  assert.ok(inAfter.some((m) => m.body === 'new broadcast'), 'broadcast after startedAt delivered')
  assert.ok(!inAfter.some((m) => m.body === 'old broadcast'), 'broadcast before startedAt gated out')

  // ── heartbeat: bumps last_seen, does not revive signed_off ────────────────
  await signoff('sess-B')
  let peers = await listPeers()
  const bSignedOff = peers.find((p) => p.sessionId === 'sess-B')!
  assert.equal(bSignedOff.rawStatus, 'signed_off', 'signoff sets status')
  await heartbeat('sess-B')
  peers = await listPeers()
  assert.equal(peers.find((p) => p.sessionId === 'sess-B')!.rawStatus, 'signed_off', 'heartbeat does NOT revive signed_off')

  // ── touchSession: revives signed_off + backfills missing metaId ───────────
  await touchSession('sess-B', '/repo/b', 'host1')
  peers = await listPeers()
  assert.equal(peers.find((p) => p.sessionId === 'sess-B')!.rawStatus, 'live', 'touch revives signed_off → live')

  // touch-first (never registered) creates a row with short-id name + metaId.
  await touchSession('sess-DEADBEEF-extra', '/repo/d', 'host2')
  peers = await listPeers()
  const touched = peers.find((p) => p.sessionId === 'sess-DEADBEEF-extra')!
  assert.equal(touched.friendlyName, 'sess-DEA', 'touch-first uses 8-char short id')
  assert.ok(touched.metaId.startsWith('meta_'), 'touch-first claims a metaId')
  assert.equal(touched.rawStatus, 'live')

  // ── rebind/supersede: a new session, same name+cwd, supersedes the live one ─
  const r1 = await registerSession({ sessionId: 'sess-R1', title: 'Worker', cwd: '/repo/w', machine: 'host1' })
  assert.equal(r1.supersedes, '')
  const r2 = await registerSession({ sessionId: 'sess-R2', title: 'Worker', cwd: '/repo/w', machine: 'host1' })
  assert.equal(r2.supersedes, 'sess-R1', 'new same-name+cwd session supersedes the prior live one')
  peers = await listPeers()
  assert.equal(peers.find((p) => p.sessionId === 'sess-R1')!.rawStatus, 'signed_off', 'superseded prior is signed_off')

  // ── listPeers: ordered by last_seen DESC, only last_seen>0 ────────────────
  peers = await listPeers()
  for (let i = 1; i < peers.length; i++) {
    assert.ok(peers[i - 1]!.lastSeen >= peers[i]!.lastSeen, 'peers ordered last_seen DESC')
  }
  assert.ok(peers.every((p) => p.lastSeen > 0), 'only presences with last_seen>0')

  // ── no-op guards ──────────────────────────────────────────────────────────
  await heartbeat('') // empty id → no throw
  await signoff('')
  await touchSession('')
  await markDelivered('', ['x'])
  await markDelivered('sess-A', [])

  console.log('bus OK')
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
