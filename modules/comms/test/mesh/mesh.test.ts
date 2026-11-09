import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { MeshLog } from '../../server/mesh/log.js'
import { statusFile, type Status } from '../../server/mesh/daemon.js'
import { NodeTable } from '../../server/mesh/nodes.js'
import { announceable, computeRoutes, isDrop, isFlapping } from '../../server/mesh/routing.js'
import { isPrivateAddress } from '../../server/mesh/net.js'
import { addPeer, readPeers } from '../../server/mesh/peers.js'
import { isRunning, start, stop } from '../../server/mesh/control.js'
import { MeshTransport } from '../../server/transport.js'
import { diamond, freePort, member, node, payloads, readyLinks, tmp, until } from './harness.js'

// ── the log ──────────────────────────────────────────────────────────────────

test('a machine numbers its own records 1, 2, 3 and never re-adopts them', () => {
  const log = new MeshLog(tmp(), 'a')
  assert.equal(log.append('comms', 'x', 'one').seq, 1)
  assert.equal(log.append('comms', 'x', 'two').seq, 2)
  assert.equal(log.adopt([{ origin: 'a', seq: 3, kind: 'comms', address: 'x', key: '', payload: 'echo', stamp: 1, purged: 0 }]), 0)
  assert.equal(log.read('x').length, 2)
})

test('adopting is idempotent, and only the latest beat per member is kept', () => {
  const log = new MeshLog(tmp(), 'a')
  const r = { origin: 'b', seq: 1, kind: 'test-flood', address: 'x', key: '', payload: 'p', stamp: 1, purged: 0 }
  assert.equal(log.adopt([r]), 1)
  assert.equal(log.adopt([r]), 0)
  log.append('beat', 'beats', 'b1', 'crew-1')
  log.append('beat', 'beats', 'b2', 'crew-1')
  log.append('beat', 'beats', 'c1', 'crew-2')
  assert.deepEqual(log.read('beats').map((x) => x.payload).sort(), ['b2', 'c1'])
})

test('a seq is never reused, even after the newest record leaves the log', () => {
  const log = new MeshLog(tmp(), 'a')
  log.append('route-out', 'mesh:outbox', 'm1')
  const two = log.append('route-out', 'mesh:outbox', 'm2')
  log.db.prepare('DELETE FROM records WHERE origin = ? AND seq = ?').run('a', two.seq)
  assert.equal(log.append('route-out', 'mesh:outbox', 'm3').seq, 3)
})

test('a log from before the high-water mark starts above the ids its outbox already gave out', () => {
  const dir = tmp()
  const old = new MeshLog(dir, 'a')
  old.append('comms', 'role:x', 'kept')
  old.db.exec('DROP TABLE seqs')
  old.db.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY)')
  old.db.prepare('INSERT INTO outbox (id) VALUES (?), (?)').run('a.7', 'b.40')
  old.close()
  assert.equal(new MeshLog(dir, 'a').append('comms', 'role:x', 'next').seq, 8)
})

test('two processes on one machine append without colliding', () => {
  const dir = tmp()
  const a = new MeshLog(dir, 'm')
  const b = new MeshLog(dir, 'm')
  const seqs = [a.append('k', 'x', '1').seq, b.append('k', 'x', '2').seq, a.append('k', 'x', '3').seq]
  assert.deepEqual(seqs, [1, 2, 3])
})

// ── links ────────────────────────────────────────────────────────────────────

test('a record streams over an open link as soon as it is appended, with no polling', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  await until('the link is ready', () => readyLinks(b).length === 1)
  const t0 = Date.now()
  a.log.append('test-flood', 'role:x', 'first')
  await until('b has it', () => payloads(b.log).length === 1, 8_000)
  // Pushed, not picked up by a periodic resync: those run every 10 s or more. The bound leaves room
  // for a slow or loaded machine (a 1 s bound failed once at 1.7 s under WSL load).
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`)
})

test('one side dials and the link carries both directions (the NAT shape)', async () => {
  const hub = await node('node-hub') // has no peer entry and never dials
  const nat = await node('node-nat', { peers: [hub.url] })
  await until('linked', () => readyLinks(hub).length === 1)
  nat.log.append('test-flood', 'role:x', 'from behind NAT')
  hub.log.append('test-flood', 'role:x', 'reply from hub')
  await until('both sides hold both', () => payloads(hub.log).length === 2 && payloads(nat.log).length === 2)
  const hubTable = new NodeTable(hub.log.db)
  const natTable = new NodeTable(nat.log.db)
  assert.equal(hubTable.get('node-nat')?.source, 'accepted')
  assert.equal(natTable.get('node-hub')?.source, 'configured')
  assert.equal(readyLinks(hub)[0]!.node, 'node-nat')
})

test('a node with no role is linked but unvalidated, and nothing crosses until it announces one', async () => {
  const a = await node('node-a')
  const c = await node('node-c', { peers: [a.url], roles: [] })
  await until('linked', () => a.daemon.links().some((l) => l.live && l.node === 'node-c'))
  a.log.append('test-flood', 'role:x', 'not yet')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(payloads(c.log).length, 0, 'an unvalidated node receives nothing')
  assert.equal(new NodeTable(a.log.db).get('node-c')?.validated, false)
  c.roles.current = ['r-node-c']
  new MeshLog(c.dir, 'node-c').append('comms', 'role:y', 'a session joined') // any write from another process wakes the daemon
  await until('validated and synced', () => payloads(c.log).length === 1)
  assert.equal(new NodeTable(a.log.db).get('node-c')?.validated, true)
})

test('a relay-intent node with no roles is validated and carries records', async () => {
  const a = await node('node-a')
  const r = await node('node-r', { peers: [a.url], intent: 'relay' })
  const c = await node('node-c', { peers: [r.url] })
  a.log.append('test-flood', 'role:x', 'through the relay')
  await until('c has it via r', () => payloads(c.log).length === 1)
  assert.equal(new NodeTable(a.log.db).get('node-r')?.intent, 'relay')
})

test('records relay along a chain and never echo back to their origin', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  const c = await node('node-c', { peers: [b.url] }) // c only knows b
  a.log.append('test-flood', 'role:x', 'from a')
  c.log.append('test-flood', 'role:x', 'from c')
  await until('everyone has both', () => [a, b, c].every((n) => payloads(n.log).length === 2))
  assert.equal(a.log.read('role:x').filter((r) => r.origin === 'node-a').length, 1, 'no echo')
})

test('when both sides dial, one link survives: the one dialed by the lower node id', async () => {
  const pa = await freePort()
  const pb = await freePort()
  const a = await node('node-a', { port: pa, peers: [`http://127.0.0.1:${pb}`] })
  const b = await node('node-b', { port: pb, peers: [`http://127.0.0.1:${pa}`] })
  await until('one live link each', () => readyLinks(a).length === 1 && readyLinks(b).length === 1)
  await new Promise((r) => setTimeout(r, 1_500)) // redials must not create a second link
  assert.equal(readyLinks(a).length, 1)
  assert.equal(a.daemon.links().filter((l) => l.live)[0]!.direction, 'out', 'node-a < node-b, so a\'s outbound link is kept')
})

test('a node that moves to a new address is still the same node', async () => {
  const a = await node('node-a')
  const bDir = tmp()
  const b1 = await node('node-b', { dir: bDir, peers: [a.url] })
  await until('linked', () => readyLinks(a).length === 1)
  const first = new NodeTable(a.log.db).get('node-b')!
  await b1.close()
  const b2 = await node('node-b', { dir: bDir }) // same identity and peers, new port
  await until('the new address is recorded', () => !!new NodeTable(a.log.db).get('node-b')?.addresses.includes(b2.url))
  const rows = new NodeTable(a.log.db).list().filter((n) => n.node === 'node-b')
  assert.equal(rows.length, 1)
  assert.ok(rows[0]!.addresses.includes(b1.url) && rows[0]!.addresses.includes(b2.url), JSON.stringify(rows[0]))
  assert.equal(rows[0]!.firstSeen, first.firstSeen)
})

test('after an outage the link resumes and catches up both ways', async () => {
  const aDir = tmp()
  const port = await freePort()
  const a1 = await node('node-a', { dir: aDir, port })
  const b = await node('node-b', { peers: [a1.url] })
  await until('linked', () => readyLinks(b).length === 1)
  await a1.close()
  b.log.append('test-flood', 'role:x', 'written while a was down')
  const a2 = await node('node-a', { dir: aDir, port })
  a2.log.append('test-flood', 'role:x', 'written by a after restart')
  await until('caught up', () => payloads(a2.log).length === 2 && payloads(b.log).length === 2, 10_000)
})

test('a purge empties the payload on every linked node', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  const r = a.log.append('test-flood', 'role:x', 'oops, a secret')
  await until('b has it', () => payloads(b.log).length === 1)
  a.log.purgeEverywhere(r.origin, r.seq)
  await until('purged on b', () => payloads(b.log).length === 0)
  assert.equal((b.log.db.prepare('SELECT payload FROM records WHERE origin = ? AND seq = ?').get('node-a', 1) as { payload: string }).payload, '')
})

test('a configured peer that cannot be reached shows in status with the dial error, never silently', async () => {
  const a = await node('node-a', { peers: ['http://127.0.0.1:1'] })
  await until('the failed dial is in status', () => {
    try {
      const st = JSON.parse(fs.readFileSync(statusFile(a.dir), 'utf-8')) as Status
      return st.dials.some((d) => d.url === 'http://127.0.0.1:1' && !!d.lastError)
    } catch {
      return false
    }
  }, 8_000)
})

test('a link to itself is refused', async () => {
  const pa = await freePort()
  const a = await node('node-a', { port: pa, peers: [`http://127.0.0.1:${pa}`] })
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(readyLinks(a).length, 0)
  assert.equal(new NodeTable(a.log.db).get('node-a'), undefined, 'a node never records itself as a peer')
})

test('status lists each link by node, with direction and readiness', async () => {
  const hub = await node('node-hub')
  await node('node-nat', { peers: [hub.url] })
  await until('linked', () => readyLinks(hub).length === 1)
  await new Promise((r) => setTimeout(r, 2_200))
  const s = JSON.parse(fs.readFileSync(statusFile(hub.dir), 'utf-8')) as Status
  const l = s.links.find((x) => x.node === 'node-nat')
  assert.ok(l && l.live && l.ready && l.direction === 'in', JSON.stringify(s.links))
  assert.deepEqual(s.roles, ['r-node-hub'])
})

// ── announcements and gossip (P2) ───────────────────────────────────────────

test('every node learns every other through announcements, with roles and capabilities', async () => {
  const a = await node('node-a', { caps: 'deploys, reviews' })
  const b = await node('node-b', { peers: [a.url] })
  const c = await node('node-c', { peers: [b.url] }) // c configured only b
  const table = new NodeTable(c.log.db)
  await until('c knows a', () => table.get('node-a')?.members[0]?.members[0]?.capabilities === 'deploys, reviews')
  assert.deepEqual(table.get('node-a')!.roles, ['r-node-a'])
  await until('a knows c', () => !!new NodeTable(a.log.db).get('node-c'))
})

test('The triangle: C told only of A meets B through gossip and links to it', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  const c = await node('node-c', { peers: [a.url] }) // nobody configures b for c
  await until('c links b directly', () => readyLinks(c).some((l) => l.node === 'node-b'), 10_000)
  await until('a full triangle', () => [a, b, c].every((n) => readyLinks(n).length === 2), 10_000)
  assert.ok(['gossiped', 'accepted'].includes(new NodeTable(c.log.db).get('node-b')!.source), 'b was never configured on c')
})

test('D cannot reach A but A can reach D: A learns D through B and dials it', async () => {
  const pa = await freePort()
  const a = await node('node-a', { port: pa, addresses: ['http://127.0.0.1:1'] }) // a advertises an address nobody can reach
  const b = await node('node-b', { peers: [`http://127.0.0.1:${pa}`] }) // b reaches a by its configured address
  const d = await node('node-d', { peers: [b.url] })
  await until('a and d linked', () => readyLinks(a).some((l) => l.node === 'node-d'), 10_000)
  const ad = a.daemon.links().find((l) => l.live && l.node === 'node-d')!
  assert.equal(ad.direction, 'out', 'a dialed d, because d had no way to reach a')
  // d may not have handled a's hello yet when a already counts the link ready.
  await until('d records a as accepted', () => new NodeTable(d.log.db).get('node-a')?.source === 'accepted')
  assert.equal(new NodeTable(a.log.db).get('node-d')?.source, 'gossiped', 'a dialed d from gossip; nobody configured it')
})

test('an announcement follows role and link changes', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  const t = new NodeTable(a.log.db)
  await until('a knows b links to a', () => (t.get('node-b')?.links ?? []).includes('node-a'))
  b.roles.current = ['r-node-b', 'web-dev']
  new MeshLog(b.dir, 'node-b').append('comms', 'role:y', 'wake') // any write from another process wakes the daemon
  await until('a sees the new role', () => (t.get('node-b')?.roles ?? []).includes('web-dev'))
  assert.equal(a.log.read('mesh:announce').filter((r) => r.origin === 'node-b').length, 1, 'only the latest announcement is kept')
})

// ── routing, relay and liveness (P3) ────────────────────────────────────────

test('routes: fewest hops, ties broken by the lowest next hop, edges only when both ends announce them', () => {
  const ann = new Map([
    ['b', ['a', 'c', 'd']],
    ['c', ['a', 'b', 'd']],
    ['d', ['b', 'c']],
    ['e', ['d']], // d does not announce e: a one-sided claim is no edge
  ])
  const r = computeRoutes('a', ['b', 'c'], ann)
  assert.deepEqual(r.get('d'), { node: 'd', nextHop: 'b', hops: 2, path: ['b', 'd'] })
  assert.equal(r.get('b')!.hops, 1)
  assert.equal(r.has('e'), false)
  const r2 = computeRoutes('a', ['c'], ann) // a lost its link to b
  assert.deepEqual(r2.get('d')!.path, ['c', 'd'])
})

test('closing the duplicate of a live link is not a drop; losing the node is', () => {
  assert.equal(isDrop(true, true), false)
  assert.equal(isDrop(true, false), true)
  assert.equal(isDrop(false, false), false, 'an unvalidated peer never counted')
})

test('flap damping: three drops in five minutes hold a link back until it has been up a minute', () => {
  const now = 1_000_000
  assert.equal(isFlapping([now - 1000, now - 2000], now), false)
  assert.equal(isFlapping([now - 1000, now - 2000, now - 3000], now), true)
  assert.equal(isFlapping([now - 1000, now - 2000, now - 400_000], now), false, 'old drops age out')
  assert.equal(announceable([now - 1000, now - 2000, now - 3000], now - 10_000, now), false)
  assert.equal(announceable([now - 1000, now - 2000, now - 3000], now - 61_000, now), true)
})

test('two nodes that cannot link reach each other through a relay, and records cross', async () => {
  const { a, d, route } = await diamond()
  assert.deepEqual(route(a, 'node-d'), { node: 'node-d', nextHop: 'node-b', hops: 2, path: ['node-b', 'node-d'] })
  assert.equal(route(d, 'node-a')!.nextHop, 'node-b')
  assert.ok(!readyLinks(a).some((l) => l.node === 'node-d'), 'no direct link exists')
  a.log.append('test-flood', 'role:x', 'a to d via a relay')
  await until('d has it', () => payloads(d.log).length === 1)
})

test('a relay that goes offline is withdrawn everywhere, and routes move to the other relay', async () => {
  const { a, b, route } = await diamond()
  await b.close()
  await until('a routes around b', () => route(a, 'node-d')?.nextHop === 'node-c', 10_000)
  await until('b is unreachable from a', () => !route(a, 'node-b'), 10_000)
  const s = () => JSON.parse(fs.readFileSync(statusFile(a.dir), 'utf-8')) as Status
  await until('status shows b without a route', () => s().nodes.some((n) => n.node === 'node-b' && !n.route), 5_000)
})

test('a link that keeps dropping is held out of the announcement while it is up', async () => {
  const a = await node('node-a')
  await node('node-b', { peers: [a.url] })
  const announced = () => JSON.parse(a.log.read('mesh:announce').find((r) => r.origin === 'node-a')?.payload ?? '{"links":[]}').links as string[]
  for (let i = 0; i < 3; i++) {
    await until('linked', () => readyLinks(a).some((l) => l.node === 'node-b'), 10_000)
    await until('announced', () => announced().includes('node-b'), 5_000)
    a.daemon.links().find((l) => l.node === 'node-b')!.ws.terminate()
    await until('dropped', () => !readyLinks(a).some((l) => l.node === 'node-b'))
  }
  await until('relinked', () => readyLinks(a).some((l) => l.node === 'node-b'), 10_000)
  await new Promise((r) => setTimeout(r, 600))
  assert.ok(!announced().includes('node-b'), 'a flapping link is not announced until it has been up a minute')
})

test('when the last relay goes, the far node and its roles are unreachable', async () => {
  const { a, b, c, route } = await diamond()
  await b.close()
  await c.close()
  await until('d unreachable from a', () => !route(a, 'node-d'), 10_000)
})

// ── the replicated plane (P5) ───────────────────────────────────────────────

test('a purge that arrives before its record still purges it: the record lands empty', () => {
  const log = new MeshLog(tmp(), 'c')
  log.adopt([{ origin: 'a', seq: 1, kind: 'purge', address: 'mesh:purge', key: '', payload: JSON.stringify({ origin: 'b', seq: 7 }), stamp: 1, purged: 0 }])
  log.adopt([{ origin: 'b', seq: 7, kind: 'test-flood', address: 'm', key: '', payload: 'a leaked secret', stamp: 2, purged: 0 }])
  assert.equal(log.read('m').length, 0)
  assert.equal((log.db.prepare("SELECT payload FROM records WHERE origin = 'b' AND seq = 7").get() as { payload: string }).payload, '')
})

test('a purge relayed through a third node empties the record wherever it went first', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  const c = await node('node-c', { peers: [b.url] })
  const r = a.log.append('test-flood', 'role:x', 'redact me')
  await until('c has it', () => payloads(c.log).length === 1)
  c.log.purgeEverywhere(r.origin, r.seq) // the redaction starts at c, not at the record's origin
  await until('purged on a', () => payloads(a.log).length === 0)
  await until('purged on b', () => payloads(b.log).length === 0)
})

test('a node that was away catches up a large backfill in batches', async () => {
  const a = await node('node-a')
  const N = 2_500
  a.log.db.transaction(() => {
    for (let i = 0; i < N; i++) a.log.append('test-flood', 'bulk', `record ${i}`)
  })()
  const b = await node('node-b', { peers: [a.url] })
  await until('all of it arrived', () => b.log.read('bulk').length === N, 30_000)
})

test('only private addresses may talk to the daemon', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:10.0.0.12', '192.168.1.168', '172.20.0.5', '100.101.1.2', 'fd00::1']) assert.ok(isPrivateAddress(a), a)
  for (const a of ['8.8.8.8', '::ffff:1.1.1.1', '172.32.0.1', '2001:4860::1', undefined]) assert.equal(isPrivateAddress(a), false, String(a))
})

test('peers are stored normalised and once', () => {
  const dir = tmp()
  addPeer(dir, '10.0.0.12:3021')
  addPeer(dir, 'http://10.0.0.12:3021/')
  assert.deepEqual(readPeers(dir), ['http://10.0.0.12:3021'])
})

// ── comms on the mesh ────────────────────────────────────────────────────────

test('two sessions on one machine talk through the local bus, with no daemon at all', async () => {
  const dir = tmp()
  const a = member(dir, 'laptop')
  const b = member(dir, 'laptop')
  await a.join('crew', { create: true, as: 'crew-1' })
  await b.join('crew', { as: 'crew-2' })
  const sent = await a.send('crew-1', 'crew/crew-2', 'hello on one machine')
  assert.ok(sent.ok)
  assert.deepEqual((await b.inbox('crew-2')).map((i) => i.body), ['hello on one machine'])
})

test('the log offers peers only replicated kinds (the sending side of the plane split)', () => {
  const log = new MeshLog(tmp(), 'a')
  log.append('comms', 'cortex-comms:role:x', 'local')
  log.append('route-out', 'mesh:outbox', '{}')
  log.append('test-flood', 'm', 'shared')
  assert.deepEqual(log.since('a', 0).map((r) => r.kind), ['test-flood'])
  assert.deepEqual(log.origins(), [{ origin: 'a', maxSeq: 3 }])
})

test('local kinds never cross by replication', async () => {
  const a = await node('node-a')
  const b = await node('node-b', { peers: [a.url] })
  a.log.append('comms', 'cortex-comms:role:x', 'stays on a')
  a.log.append('test-flood', 'role:x', 'replicates')
  await until('the replicated one arrived', () => payloads(b.log).length === 1)
  assert.equal(b.log.read('cortex-comms:role:x').length, 0)
  assert.equal(b.log.adopt([{ origin: 'node-a', seq: 99, kind: 'comms', address: 'cortex-comms:role:x', key: '', payload: 'forged', stamp: 1, purged: 0 }]), 0, 'a peer cannot write into a mailbox by replication')
})

// ── lifecycle ────────────────────────────────────────────────────────────────

test('start is idempotent and stop leaves nothing running', async () => {
  const state = tmp()
  const saved = { CKN_STATE_DIR: process.env.CKN_STATE_DIR, CKN_MESH_PORT: process.env.CKN_MESH_PORT }
  process.env.CKN_STATE_DIR = state
  process.env.CKN_MESH_PORT = String(await freePort())
  const dir = path.join(state, 'data', 'mesh')
  try {
    assert.equal(await start(dir, { wait: true }), 'started')
    assert.ok(isRunning(dir))
    assert.equal(await start(dir, { wait: true }), 'already')
    assert.equal(await stop(dir), 'stopped')
    assert.equal(isRunning(dir), false)
    assert.equal(fs.existsSync(path.join(dir, 'daemon.pid')), false)
  } finally {
    await stop(dir)
    Object.assign(process.env, saved)
    if (saved.CKN_STATE_DIR === undefined) delete process.env.CKN_STATE_DIR
    if (saved.CKN_MESH_PORT === undefined) delete process.env.CKN_MESH_PORT
  }
})

test('a mesh message id survives the CLI: no colon, no whitespace', async () => {
  // "sent <id>: outcome" is how a sender learns the id; a colon inside the id split it.
  const t = new MeshTransport(new MeshLog(tmp(), 'node-a-56cdc6'))
  const id = await t.post('a', { v: 1, type: 'msg', stamp: 1, from: 'r/m', body: 'x' } as never)
  assert.match(id, /^[^\s:]+$/)
})

test('a forgotten node is emptied here and on arrival, never this node, and heard again with newer records', () => {
  const log = new MeshLog(tmp(), 'a')
  const rec = (seq: number, stamp: number) => ({ origin: 'ghost', seq, kind: 'announce', address: 'mesh:announce', key: 'ghost', payload: `p${seq}`, stamp, purged: 0 })
  log.adopt([rec(1, 100)])
  assert.equal(log.read('mesh:announce').length, 1)
  log.forgetEverywhere('ghost', 200)
  assert.equal(log.read('mesh:announce').length, 0)
  log.adopt([rec(2, 150)]) // an older copy by another link: stays forgotten
  assert.equal(log.read('mesh:announce').length, 0)
  log.adopt([rec(1, 300)]) // back with a fresh log: seqs restart, stamps do not
  assert.deepEqual(payloads(log, 'mesh:announce'), ['p1'])
  assert.equal(log.forget('a', 400), false)

  const peer = new MeshLog(tmp(), 'b')
  peer.adopt([rec(1, 100)])
  peer.adopt(log.since('a', 0))
  assert.equal(peer.read('mesh:announce').length, 0, 'the forget replicates')
})

test('forget drops a gone node from every daemon, and it is known again when it comes back', async () => {
  const b = await node('b')
  const a = await node('a', { peers: [b.url] })
  let c = await node('c', { peers: [b.url] })
  const knows = (n: { log: MeshLog }, who: string) => new NodeTable(n.log.db).list().some((x) => x.node === who)
  await until('a hears of c', () => knows(a, 'c'))
  await c.close()
  await until('b loses c', () => !readyLinks(b).some((l) => l.node === 'c'))

  new MeshLog(b.dir, 'b').forgetEverywhere('c')
  await until('b drops c', () => !knows(b, 'c'))
  await until('a drops c', () => !knows(a, 'c'))

  c = await node('c', { peers: [b.url] })
  await until('a hears of c again', () => knows(a, 'c'))
})

test('a node that leaves is forgotten two hops away once it is gone', async () => {
  const b = await node('b')
  const a = await node('a', { peers: [b.url] })
  const c = await node('c', { peers: [b.url] })
  const knows = (n: { log: MeshLog }, who: string) => new NodeTable(n.log.db).list().some((x) => x.node === who)
  await until('a hears of c', () => knows(a, 'c'))
  new MeshLog(c.dir, 'c').leave()
  await until('the notice reaches a', () => a.log.forgotten().some((f) => f.node === 'c'))
  await c.close()
  await until('b drops c', () => !knows(b, 'c'))
  await until('a drops c', () => !knows(a, 'c'))
})
