/**
 * The seams private mind needs from mesh and comms (design 3.2, 5.7): a kind
 * policy that keeps records from gateways (fail closed), home-only routing
 * enforced at every hop, adopted-record notices, and a member's work context.
 */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'

import { AdoptedWatch } from '../../server/mesh/adopted.js'
import { isReplicated, MeshLog, registerDeclaredKinds, registerKind, sendableTo } from '../../server/mesh/log.js'
import { computeRoutes } from '../../server/mesh/routing.js'
import { meshView } from '../../server/mesh/view.js'
import { ADDR, MeshTransport } from '../../server/transport.js'
import { commsOn, node, outbox, readyLinks, tmp, until } from './harness.js'

test('a replicated kind is kept from gateways unless it says otherwise; an undeclared kind does not flood at all', () => {
  registerKind('seam-mind')
  registerKind('seam-open', { never: [] })
  assert.equal(sendableTo('seam-mind', 'node'), true)
  assert.equal(sendableTo('seam-mind', 'gateway'), false, 'fail closed: no policy given means home only')
  assert.equal(sendableTo('seam-open', 'gateway'), true)
  assert.equal(isReplicated('memory'), false, "V1's memory kind is retired: neither sent nor kept")
  assert.equal(sendableTo('test-flood', 'gateway'), false, 'a home kind never reaches a gateway')
  assert.equal(sendableTo('announce', 'gateway'), true, 'a gateway still learns the mesh')
  assert.equal(isReplicated('seam-undeclared'), false)
  assert.equal(sendableTo('seam-undeclared', 'node'), false)
  assert.deepEqual(registerDeclaredKinds([{ module: 'm', kinds: { announce: { never: [] }, 'seam-declared': {} } }]), ['m: announce is a built-in mesh kind'])
  assert.equal(sendableTo('seam-declared', 'gateway'), false)
})

test('routes for home-only traffic pass no gateway, and reach none', () => {
  const announced = new Map([
    ['g', ['a', 'c']],
    ['c', ['g']],
  ])
  assert.deepEqual(computeRoutes('a', ['g'], announced).get('c')?.path, ['g', 'c'])
  assert.equal(computeRoutes('a', ['g'], announced, new Set(['g'])).get('c'), undefined)
  assert.equal(computeRoutes('a', ['g'], announced, new Set(['g'])).get('g'), undefined)
})

test('a gateway peer is sent only the kinds that allow it, and a home node gets them all', async () => {
  registerKind('seam-open', { never: [] })
  const a = await node('seam-a')
  const g = await node('seam-g', { peers: [a.url], intent: 'gateway' })
  const b = await node('seam-b', { peers: [a.url] })
  await until('both linked to a', () => readyLinks(a).length === 2)
  a.log.append('test-flood', 'mind:x', 'a home record')
  a.log.append('seam-open', 'open:x', 'for everyone')
  a.log.append('seam-undeclared', 'undeclared:x', 'stays here')
  await until('b has both replicated kinds', () => b.log.read('mind:x').length === 1 && b.log.read('open:x').length === 1)
  await until('g has the open kind', () => g.log.read('open:x').length === 1)
  await sleep(500)
  assert.equal(g.log.read('mind:x').length, 0, 'the gateway never got the memory record')
  assert.equal(b.log.read('undeclared:x').length + g.log.read('undeclared:x').length, 0, 'an undeclared kind never left a')
})

/** A member's inbox bodies, refreshed in the background so a synchronous wait can test them. */
const watchInbox = (c: ReturnType<typeof commsOn>, member: string) => {
  let bodies: string[] = []
  return () => {
    void c.inbox(member).then((x) => (bodies = x.map((m) => m.body)))
    return bodies
  }
}

test('home-only messages never pass a gateway: refused while it is the only route, delivered once a home route exists', async () => {
  const g = await node('home-g', { intent: 'gateway' })
  // Neither advertises an address (behind NAT), so they cannot dial each other: the gateway is their only path.
  const a = await node('home-a', { comms: true, alias: 'a', peers: [g.url], addresses: [] })
  const c = await node('home-c', { comms: true, alias: 'c', peers: [g.url], addresses: [] })
  const ca = commsOn(a, 'home-a')
  const cc = commsOn(c, 'home-c')
  await ca.join('pm', { create: true, as: 'pm-1' })
  await cc.join('dev', { create: true, as: 'dev-1' })
  await until('a reaches c, through the gateway only', () => meshView(a.dir, 'home-a').nodes.some((n) => n.alias === 'c' && n.reachable && n.roles.some((r) => r.role === 'dev')), 15_000)
  assert.equal(meshView(a.dir, 'home-a').nodes.find((n) => n.alias === 'c')!.homeReachable, false)

  const refused = await ca.send('pm-1', 'c:dev', 'private', { homeOnly: true })
  assert.equal(refused.ok, false)
  assert.match(refused.outcome, /only route to c now goes through a gateway/)
  const plain = await ca.send('pm-1', 'c:dev', 'ordinary')
  assert.ok(plain.ok, plain.outcome)
  const inbox = watchInbox(cc, 'dev-1')
  await until('the ordinary one arrives through the gateway', () => inbox().includes('ordinary'), 15_000)

  // Queued home-only at the mesh level (as a send made while c looked unreachable would be): it must wait, not take the gateway.
  const t = new MeshTransport(new MeshLog(a.dir, 'home-a'))
  await t.postTo('home-c', ADDR.role('dev'), { v: 1, type: 'msg', stamp: Date.now(), from: 'home-a:pm/pm-1', to: 'c:dev', body: 'held for a home route' }, { home: true })
  await sleep(3_000)
  assert.equal((await cc.inbox('dev-1')).length, 1, 'not delivered through the gateway')
  assert.ok(outbox(a).some((r) => r.delivered_at == null))

  const b = await node('home-b', { peers: [a.url, c.url] })
  await until('a home route to c exists', () => meshView(a.dir, 'home-a').nodes.find((n) => n.alias === 'c')?.homeReachable === true, 15_000)
  await until('the held message arrives by the home route', () => inbox().includes('held for a home route'), 15_000)
  const sent = await ca.send('pm-1', 'c:dev', 'private now', { homeOnly: true })
  assert.ok(sent.ok, sent.outcome)
  await until('and a home-only send goes through', () => inbox().includes('private now'), 15_000)
  void b
})

test('records adopted from elsewhere are told to subscribers by kind, once, and never our own', () => {
  const dir = tmp()
  const host = new MeshLog(dir, 'me')
  const daemon = new MeshLog(dir, 'me')
  const watch = new AdoptedWatch(host, 60_000)
  const got: string[] = []
  const stop = watch.subscribe(['test-flood'], (rs) => got.push(...rs.map((r) => `${r.origin}:${r.payload}`)))
  daemon.adopt([
    { origin: 'b', seq: 1, kind: 'test-flood', address: 'x', key: '', payload: 'one', stamp: 1, purged: 0 },
    { origin: 'b', seq: 2, kind: 'announce', address: 'mesh:announce', key: '', payload: '{}', stamp: 1, purged: 0 },
  ])
  daemon.append('test-flood', 'x', 'mine')
  watch.check()
  watch.check()
  assert.deepEqual(got, ['b:one'])
  stop()
  daemon.adopt([{ origin: 'b', seq: 3, kind: 'test-flood', address: 'x', key: '', payload: 'two', stamp: 2, purged: 0 }])
  watch.check()
  assert.deepEqual(got, ['b:one'], 'nothing after unsubscribing')
  watch.close()
})

test("a member's work context is its open claim, and ends when the work is done", async () => {
  const a = await node('ctx-a', { comms: true, alias: 'a' })
  const c = commsOn(a, 'ctx-a')
  await c.join('dev', { create: true, as: 'dev-1' })
  await c.join('pm', { create: true, as: 'pm-1' })
  assert.equal(await c.workContext('dev-1'), undefined)
  const sent = await c.send('pm-1', 'dev', 'build it')
  assert.ok(sent.ok && sent.id, sent.outcome)
  const id = (await c.inbox('dev-1')).find((m) => m.body === 'build it')!.id
  assert.equal((await c.claim('dev-1', id)).won, true)
  assert.deepEqual(await c.workContext('dev-1'), { msgId: id, role: 'dev' })
  await c.done('dev-1', id)
  assert.equal(await c.workContext('dev-1'), undefined)
})

test("the retired memory kind: refused on receipt, and a purge takes only the named origins' leftovers", () => {
  const log = new MeshLog(tmp(), 'me')
  assert.equal(log.adopt([{ origin: 'peer', seq: 1, kind: 'memory', address: 'm', key: '', payload: 'x', stamp: 1, purged: 0 }]), 0, 'not kept on receipt')
  const leftover = log.db.prepare('INSERT INTO records (origin, seq, kind, address, key, payload, stamp, purged) VALUES (?,?,?,?,?,?,?,0)')
  leftover.run('old-a', 1, 'memory', 'm', '', 'a1', 1)
  leftover.run('old-a', 2, 'memory', 'm', '', 'a2', 1)
  leftover.run('old-b', 1, 'memory', 'm', '', 'b1', 1)
  log.append('comms', 'role:x', 'not a memory record')
  assert.deepEqual(log.countKind('memory'), { 'old-a': 2, 'old-b': 1 })
  assert.equal(log.purgeKind('memory', []), 0, 'no origin named: nothing selected')
  assert.equal(log.purgeKind('memory', ['old-a']), 2)
  assert.deepEqual(log.countKind('memory'), { 'old-b': 1 }, 'the other origin untouched')
  assert.equal(log.read('role:x').length, 1, 'other kinds untouched')
  assert.throws(() => log.purgeKind('announce', ['me']), /live mesh kind/)
})
