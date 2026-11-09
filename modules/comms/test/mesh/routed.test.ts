import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { MeshLog } from '../../server/mesh/log.js'
import { meshView } from '../../server/mesh/view.js'
import { ADDR, MeshTransport } from '../../server/transport.js'
import { Comms } from '../../server/comms.js'
import { LocalIdentity } from '../../server/identity.js'
import { commsOn, freePort, node, NOWHERE, outbox, pair, tmp, until } from './harness.js'

// ── routed comms (P4) ────────────────────────────────────────────────────────

test('a message routed to another node lands in its role mailbox, labelled with where it came from', async () => {
  const { nodeA, lap, z, l } = await pair()
  const sent = await l.send('pm-1', 'node-a:web-dev', 'build the brief')
  assert.ok(sent.ok, sent.outcome)
  assert.match(sent.outcome, /sent to node-a:web-dev \(routed/)
  let items: Awaited<ReturnType<typeof z.inbox>> = []
  await until('delivered on node-a', () => {
    void z.inbox('web-dev-1').then((x) => (items = x))
    return items.length === 1
  })
  assert.equal(items[0]!.from, 'laptop:pm/pm-1')
  assert.equal(items[0]!.node, 'laptop')
  assert.equal(items[0]!.body, 'build the brief')
  await until('DELIVERED at the origin', () => outbox(lap)[0]?.delivered_at != null)
  assert.equal(outbox(lap)[0]!.read_at, null, 'not read yet, so the origin still holds it')
  assert.equal(lap.log.read('mesh:outbox').length, 1)
  z.markSeen('web-dev-1', [items[0]!.id])
  await until('READ at the origin, and its copy gone', () => outbox(lap)[0]?.read_at != null && lap.log.read('mesh:outbox').length === 0)
  void nodeA
})

test('a send right after a read one gets a new id and is delivered (an id is never reused)', async () => {
  const { lap, z, l } = await pair()
  let items: Awaited<ReturnType<typeof z.inbox>> = []
  const has = (body: string) => {
    void z.inbox('web-dev-1').then((x) => (items = x))
    return items.some((i) => i.body === body)
  }
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'first')).ok)
  await until('first arrived', () => has('first'))
  z.markSeen('web-dev-1', [items[0]!.id])
  await until('first READ, its copy gone', () => outbox(lap)[0]?.read_at != null && lap.log.read('mesh:outbox').length === 0)
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'second')).ok)
  await until('second arrived', () => has('second'))
  const ids = outbox(lap).map((o) => o.id)
  assert.equal(new Set(ids).size, 2, `two distinct ids: ${ids.join(', ')}`)
  await until('second DELIVERED', () => outbox(lap).every((o) => o.delivered_at != null))
})

test('a reply routes back to the sender on its node', async () => {
  const { z, l } = await pair()
  await l.send('pm-1', 'node-a:web-dev', 'ping')
  let items: Awaited<ReturnType<typeof z.inbox>> = []
  await until('arrived', () => {
    void z.inbox('web-dev-1').then((x) => (items = x))
    return items.length === 1
  })
  const r = await z.reply('web-dev-1', items[0]!.id, 'pong')
  assert.ok(r.ok, r.outcome)
  let back: Awaited<ReturnType<typeof l.inbox>> = []
  await until('reply arrived', () => {
    void l.inbox('pm-1').then((x) => (back = x))
    return back.length === 1
  })
  assert.equal(back[0]!.from, 'node-a:web-dev/web-dev-1')
  assert.equal(back[0]!.body, 'pong')
})

test('a bare role on exactly one other node goes there; on two nodes it asks which', async () => {
  const { lap, l } = await pair()
  assert.match((await l.send('pm-1', 'web-dev', 'x')).outcome, /sent to node-a:web-dev/)
  const nodeC = await node('node-c-node', { comms: true, alias: 'node-c', peers: [lap.url] })
  await commsOn(nodeC, 'node-c-node').join('web-dev', { create: true, as: 'web-dev-1' })
  await until('laptop knows node-c has web-dev', () => meshView(lap.dir, 'lap-node').nodes.some((n) => n.alias === 'node-c' && n.reachable && n.roles.some((r) => r.role === 'web-dev')), 10_000)
  const r = await l.send('pm-1', 'web-dev', 'which one?')
  assert.equal(r.ok, false)
  assert.match(r.outcome, /"web-dev" is on 2 nodes: node-a:web-dev, node-c:web-dev\. Which node\?/)
  assert.ok((await l.send('pm-1', 'node-c:web-dev', 'this one')).ok)
})

test('asking which node comes with a suggestion inferred from prior work or members\' focus, or none', async () => {
  const { lap, l } = await pair()
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'build the landing page hero')).ok)
  const nodeC = await node('node-c-node', { comms: true, alias: 'node-c', peers: [lap.url] })
  await commsOn(nodeC, 'node-c-node').join('web-dev', { create: true, as: 'web-dev-1', meta: { cap: 'billing api', focus: 'payments' } })
  await until('laptop knows node-c has web-dev', () => meshView(lap.dir, 'lap-node').nodes.some((n) => n.alias === 'node-c' && n.reachable && n.roles.some((r) => r.role === 'web-dev')), 10_000)
  await until('the first send is in the outbox history', () => meshView(lap.dir, 'lap-node').history.length > 0)
  assert.match((await l.send('pm-1', 'web-dev', 'tweak the landing page')).outcome, /I suggest node-a:web-dev, since it worked on "build the landing page hero" before\. Send to node-a:web-dev to go ahead\./)
  assert.match((await l.send('pm-1', 'web-dev', 'the payments webhook is down')).outcome, /I suggest node-c:web-dev, since its members list payments/)
  const none = (await l.send('pm-1', 'web-dev', 'hello there')).outcome
  assert.match(none, /Which node\? Send to node:web-dev$/)
})

test('a node-qualified address to this node is local, and an unknown node or role is refused at send', async () => {
  const { l } = await pair()
  await l.join('notes', { create: true, as: 'notes-1' })
  assert.match((await l.send('pm-1', 'laptop:notes', 'to myself')).outcome, /role notes/)
  assert.deepEqual(await l.send('pm-1', 'nowhere:web-dev', 'x'), { ok: false, outcome: 'no such node: nowhere' })
  assert.deepEqual(await l.send('pm-1', 'node-a:ghost', 'x'), { ok: false, outcome: 'no role ghost on node node-a' })
})

test('a mailbox the destination does not have is refused back, and the sender is told', async () => {
  const { lap, l } = await pair()
  const t = new MeshTransport(new MeshLog(lap.dir, 'lap-node'))
  await t.postTo('node-a-node', ADDR.role('gone'), { v: 1, type: 'msg', stamp: Date.now(), from: 'pm/pm-1', to: 'node-a:gone', body: 'into the void' })
  let items: Awaited<ReturnType<typeof l.inbox>> = []
  await until('the notice arrived', () => {
    void l.inbox('pm-1').then((x) => (items = x))
    return items.length === 1
  })
  assert.match(items[0]!.body, /was not delivered: no role gone on node-a-node/)
  assert.ok(outbox(lap)[0]!.failed)
  assert.equal(lap.log.read('mesh:outbox').length, 0, 'a refused message is not held')
})

test('a message to a node that is down is held at the origin and delivered when it is back', async () => {
  const zDir = tmp()
  const port = await freePort()
  const nodeA1 = await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port })
  const lap = await node('lap-node', { comms: true, alias: 'laptop', peers: [nodeA1.url] })
  await commsOn(nodeA1, 'node-a-node').join('web-dev', { create: true, as: 'web-dev-1' })
  const l = commsOn(lap, 'lap-node')
  await l.join('pm', { create: true, as: 'pm-1' })
  await until('route', () => meshView(lap.dir, 'lap-node').nodes.some((n) => n.alias === 'node-a' && n.reachable && n.roles.length > 0), 10_000)
  await nodeA1.close()
  await until('node-a unreachable', () => !meshView(lap.dir, 'lap-node').nodes.find((n) => n.alias === 'node-a')!.reachable, 10_000)
  const sent = await l.send('pm-1', 'node-a:web-dev', 'while you were away')
  assert.match(sent.outcome, /queued for node-a:web-dev \(node unreachable now/)
  const nodeA2 = await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port })
  const z = commsOn(nodeA2, 'node-a-node')
  let items: Awaited<ReturnType<typeof z.inbox>> = []
  await until('delivered after it came back', () => {
    void z.inbox('web-dev-1').then((x) => (items = x))
    return items.length === 1
  }, 15_000)
  assert.equal(items[0]!.body, 'while you were away')
})

test('past the offline limit: held messages fail with a notice, new sends are refused, every node is told, and it all lifts on return', async () => {
  const zDir = tmp()
  const port = await freePort()
  // Long enough that the send below still finds node-a merely unreachable, not yet expired, under load.
  const LIMIT = 5_000
  const nodeA1 = await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port, offlineMs: LIMIT })
  const lap = await node('lap-node', { comms: true, alias: 'laptop', peers: [nodeA1.url], offlineMs: LIMIT })
  const third = await node('third-node', { comms: true, alias: 'third', peers: [lap.url], offlineMs: 60_000 })
  await commsOn(nodeA1, 'node-a-node').join('web-dev', { create: true, as: 'web-dev-1' })
  await commsOn(third, 'third-node').join('ops', { create: true, as: 'ops-1' })
  const l = commsOn(lap, 'lap-node')
  await l.join('pm', { create: true, as: 'pm-1' })
  const zOnLap = () => meshView(lap.dir, 'lap-node').nodes.find((n) => n.alias === 'node-a')
  await until('route', () => !!zOnLap()?.reachable && zOnLap()!.roles.length > 0, 10_000)
  await nodeA1.close()
  await until('node-a unreachable', () => !zOnLap()!.reachable, 10_000)
  assert.match((await l.send('pm-1', 'node-a:web-dev', 'held, then expired')).outcome, /queued for node-a:web-dev/)

  let items: Awaited<ReturnType<typeof l.inbox>> = []
  await until('the sender is told once the limit passes', () => {
    void l.inbox('pm-1').then((x) => (items = x))
    return items.length === 1
  }, 15_000)
  assert.match(items[0]!.body, /was not delivered: node node-a has been offline since .*past its limit/)
  assert.equal(lap.log.read('mesh:outbox').length, 0, 'nothing is held for it any more')
  await until('the status says expired', () => !!zOnLap()?.expired, 5_000)
  assert.match((await l.send('pm-1', 'node-a:web-dev', 'refused')).outcome, /node node-a has been offline since .*it accepts no messages until it is back/)
  await until('the third node heard it too', () => !!meshView(third.dir, 'third-node').nodes.find((n) => n.alias === 'node-a')?.expired, 10_000)

  await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port, offlineMs: LIMIT })
  await until('back: no longer expired', () => !!zOnLap()?.reachable && !zOnLap()!.expired, 15_000)
  assert.match((await l.send('pm-1', 'node-a:web-dev', 'welcome back')).outcome, /sent to node-a:web-dev/)
  await until('the third node lifts it too', () => !meshView(third.dir, 'third-node').nodes.find((n) => n.alias === 'node-a')?.expired, 15_000)
  // The notice itself is withdrawn, for nodes that have no route of their own to judge by.
  const notice = () => lap.log.read('mesh:offline').find((r) => r.origin === 'lap-node' && r.key === 'node-a-node')
  await until('the laptop withdrew its notice', () => JSON.parse(notice()?.payload ?? '{}').since === null, 10_000)
})

test('comms reads only this node\'s own records, never leftovers replicated from elsewhere', async () => {
  const dir = tmp()
  const log = new MeshLog(dir, 'here')
  log.db
    .prepare('INSERT INTO records (origin, seq, kind, address, key, payload, stamp, purged) VALUES (?,?,?,?,?,?,?,0)')
    .run('elsewhere', 1, 'comms', ADDR.member('m-1'), '', 'cortex.comms/1 ' + JSON.stringify({ v: 1, type: 'msg', stamp: 1, from: 'x/y', to: 'm-1', body: 'old' }), 1)
  assert.equal((await new MeshTransport(log).read(ADDR.member('m-1'))).length, 0)
})

test('a routed message delivered twice is stored once, and both times acknowledged', async () => {
  const { nodeA, lap, z, l } = await pair()
  const sent = await l.send('pm-1', 'node-a:web-dev', 'once only')
  await until('delivered', () => outbox(lap)[0]?.delivered_at != null)
  const body = JSON.parse(lap.log.read('mesh:outbox')[0]!.payload) as { address: string; body: string }
  nodeA.daemon.router.receive({ t: 'route', kind: 'msg', id: (sent as { id: string }).id, from: 'lap-node', to: 'node-a-node', hops: 1, address: body.address, body: body.body })
  assert.equal((await z.inbox('web-dev-1')).length, 1)
})

test('a routed message crosses a relay to a node it cannot link to', async () => {
  const b = await node('node-b', { comms: true })
  const a = await node('node-a', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const d = await node('node-d', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const ca = commsOn(a, 'node-a')
  const cd = commsOn(d, 'node-d')
  await commsOn(b, 'node-b').join('relay-crew', { create: true, as: 'relay-crew-1' })
  await ca.join('pm', { create: true, as: 'pm-1' })
  await cd.join('ops', { create: true, as: 'ops-1' })
  await until('a routes to d via b', () => a.daemon.routes().get('node-d')?.nextHop === 'node-b' && meshView(a.dir, 'node-a').nodes.some((n) => n.node === 'node-d' && n.reachable && n.roles.length > 0), 10_000)
  assert.ok((await ca.send('pm-1', 'node-d:ops', 'via the relay')).ok)
  let items: Awaited<ReturnType<typeof cd.inbox>> = []
  await until('arrived at d', () => {
    void cd.inbox('ops-1').then((x) => (items = x))
    return items.length === 1
  })
  assert.equal(items[0]!.from, 'node-a:pm/pm-1')
  assert.equal(b.log.read(ADDR.role('ops')).length, 0, 'the relay stored nothing')
})

test('a frame at the hop limit is dropped, not forwarded', async () => {
  const { nodeA, lap } = await pair()
  const before = lap.log.read(ADDR.role('pm')).length
  nodeA.daemon.router.receive({ t: 'route', kind: 'msg', id: 'x.1', from: 'someone', to: 'lap-node', hops: 7, address: ADDR.role('pm'), body: 'cortex.comms/1 {"v":1,"type":"msg","stamp":1,"from":"a/b","body":"too far"}' })
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(lap.log.read(ADDR.role('pm')).length, before)
})

test('per-node claims: five sessions claim one message at once, exactly one wins, and all agree who', async () => {
  const dir = tmp()
  const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  const c = new Comms(new MeshTransport(new MeshLog(dir, 'n1')), new LocalIdentity(tmp()), { liveMs: 60_000, settleMs: 0, sleep: async () => {} })
  await c.join('crew', { create: true, as: 'crew-0' })
  for (let i = 1; i <= 5; i++) await c.join('crew', { as: `crew-${i}` })
  const sent = await c.send('crew-0', 'crew', 'one job')
  assert.ok(sent.ok)
  const id = (sent as { id: string }).id
  // All five start the claim at the same instant, after their (slow) startups,
  // so they really race into the same transaction rather than taking turns.
  const at = Date.now() + 4_000
  const script = (i: number) => `
    import { Comms } from '${REPO}/modules/comms/server/comms.ts'; import { LocalIdentity } from '${REPO}/modules/comms/server/identity.ts';
    import { MeshTransport } from '${REPO}/modules/comms/server/transport.ts'; import { MeshLog } from '${REPO}/modules/comms/server/mesh/log.ts';
    const c = new Comms(new MeshTransport(new MeshLog('${dir}', 'n1')), new LocalIdentity('${tmp()}'), { liveMs: 60000, settleMs: 0, sleep: async () => {} });
    void (async () => {
      await c.inbox('crew-${i}') // warm up: modules loaded and the log opened before the start
      while (Date.now() < ${at}) await new Promise((r) => setTimeout(r, 1))
      console.log(JSON.stringify(await c.claim('crew-${i}', '${id}')))
    })()`
  const { spawn } = await import('node:child_process')
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(
      (i) =>
        new Promise<{ won: boolean; owner: string }>((ok, fail) => {
          const p = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['-e', script(i)], { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          p.stdout.on('data', (d) => (out += d))
          p.stderr.on('data', (d) => (err += d))
          p.on('close', (code) => (code === 0 ? ok(JSON.parse(out.trim().split('\n').pop()!)) : fail(new Error(err))))
        }),
    ),
  )
  assert.equal(results.filter((r) => r.won).length, 1, JSON.stringify(results))
  assert.equal(new Set(results.map((r) => r.owner)).size, 1, 'every claimant names the same owner')
  assert.ok(results.every((r) => !(r as { waited?: boolean }).waited), 'decided by the transaction: nobody waits a settle window')
  const m = await c.manifest('crew')
  assert.deepEqual(m!.members.filter((x) => x.claims.includes(id)).map((x) => x.name), [results.find((r) => r.won)!.owner])
  assert.equal((await c.claim('crew-0', id)).won, false, 'a later claim loses without waiting')
})

test('D1: with --queue-anyway, a bare role that only a down node carries is queued there and delivered when it is back', async () => {
  const zDir = tmp()
  const port = await freePort()
  const nodeA1 = await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port })
  const lap = await node('lap-node', { comms: true, alias: 'laptop', peers: [nodeA1.url] })
  await commsOn(nodeA1, 'node-a-node').join('pm', { create: true, as: 'pm-1' })
  const l = commsOn(lap, 'lap-node')
  await l.join('linear', { create: true, as: 'linear-1' })
  await until('route', () => meshView(lap.dir, 'lap-node').nodes.some((n) => n.alias === 'node-a' && n.reachable && n.roles.some((r) => r.role === 'pm')), 10_000)
  await nodeA1.close()
  await until('node-a unreachable', () => !meshView(lap.dir, 'lap-node').nodes.find((n) => n.alias === 'node-a')!.reachable, 10_000)
  assert.equal((await l.send('linear-1', 'pm', 'no flag')).ok, false, 'without the flag it still refuses, and says how')
  const sent = await l.send('linear-1', 'pm', 'weekly report', { queueAnyway: true })
  assert.ok(sent.ok, sent.outcome)
  assert.match(sent.outcome, /queued for node-a:pm \(node unreachable now/)
  const nodeA2 = await node('node-a-node', { comms: true, alias: 'node-a', dir: zDir, port })
  const z = commsOn(nodeA2, 'node-a-node')
  let items: Awaited<ReturnType<typeof z.inbox>> = []
  await until('delivered after it came back', () => {
    void z.inbox('pm-1').then((x) => (items = x))
    return items.length === 1
  }, 15_000)
  assert.equal(items[0]!.body, 'weekly report')
  assert.equal(items[0]!.from, 'laptop:linear/linear-1')
})

test('a bare role ignores nodes that are unreachable now, and says so when only they have it', async () => {
  const { lap, l } = await pair()
  const zDir = tmp()
  const port = await freePort()
  const nodeC = await node('node-c-node', { comms: true, alias: 'node-c', peers: [lap.url], dir: zDir, port })
  await commsOn(nodeC, 'node-c-node').join('web-dev', { create: true, as: 'web-dev-1' })
  await commsOn(nodeC, 'node-c-node').join('qa', { create: true, as: 'qa-1' })
  const nodeCOn = () => meshView(lap.dir, 'lap-node').nodes.find((n) => n.alias === 'node-c')
  await until('laptop knows node-c', () => !!nodeCOn()?.reachable && nodeCOn()!.roles.some((r) => r.role === 'qa'), 10_000)
  await nodeC.close()
  await until('node-c unreachable', () => !nodeCOn()!.reachable, 10_000)
  assert.match((await l.send('pm-1', 'web-dev', 'only node-a now')).outcome, /sent to node-a:web-dev/)
  assert.deepEqual(await l.send('pm-1', 'qa', 'x'), { ok: false, outcome: '"qa" is only on node-c:qa, unreachable now. Send to node-c:qa by name, or with --queue-anyway, to queue it until it is back' })
  assert.match((await l.send('pm-1', 'node-c:qa', 'queued')).outcome, /queued for node-c:qa/)
})
