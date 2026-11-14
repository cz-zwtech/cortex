/**
 * A node reachable at several addresses ends up with one stable link, and its peers route through it.
 * Found on a container behind its host's NAT: the host advertised its LAN address and every bridge,
 * the container could reach them all, and the links it opened churned until flap damping kept the
 * edge out of both announcements, so nodes two hops away had no route to it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ownAddresses, pickDials } from '../../server/mesh/daemon.js'
import { duplicateVerdict } from '../../server/mesh/routing.js'
import { NodeTable } from '../../server/mesh/nodes.js'
import { node, readyLinks, until } from './harness.js'

const ipv4 = (address: string, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` })

test('a machine does not advertise its container and VM bridges', () => {
  const addrs = ownAddresses(3021, {
    lo: [ipv4('127.0.0.1', true)],
    enp6s0: [ipv4('10.0.0.5')],
    docker0: [ipv4('172.17.0.1')],
    'br-3f2a9c': [ipv4('172.20.0.1')],
    incusbr0: [ipv4('10.66.0.1')],
    virbr0: [ipv4('192.168.122.1')],
  })
  assert.deepEqual(addrs, ['http://10.0.0.5:3021'])
})

/**
 * Two links, both dialed by `dialer`, arrive at each end in its own order. Each end judges the
 * second against the first; the survivors are the links neither end closed.
 */
const survivors = (dialer: string, acceptor: string, dialerOrder: string[], acceptorOrder: string[]) => {
  const closed = new Set<string>()
  const judge = (self: string, peer: string, order: string[], out: boolean) => {
    const [first, second] = order as [string, string]
    const v = duplicateVerdict(self, peer, out, out)
    if (v === 'close-new') closed.add(second)
    if (v === 'close-old') closed.add(first)
  }
  judge(dialer, acceptor, dialerOrder, true)
  judge(acceptor, dialer, acceptorOrder, false)
  return ['L1', 'L2'].filter((l) => !closed.has(l))
}

test('two links dialed by one end: exactly one survives whatever order each end saw them in', () => {
  for (const [dialer, acceptor] of [['container-a', 'host-b'], ['host-b', 'container-a']] as const)
    for (const a of [['L1', 'L2'], ['L2', 'L1']])
      for (const b of [['L1', 'L2'], ['L2', 'L1']])
        assert.equal(survivors(dialer, acceptor, a, b).length, 1, `${dialer} saw ${a}, ${acceptor} saw ${b}`)
})

test('links dialed from both ends: both ends keep the one dialed by the lower id', () => {
  assert.equal(duplicateVerdict('a', 'b', true, false), 'close-old', 'a dialed the new one and a is lower')
  assert.equal(duplicateVerdict('b', 'a', false, true), 'close-old', 'from b: the new one called in from a')
  assert.equal(duplicateVerdict('a', 'b', false, true), 'close-new')
  assert.equal(duplicateVerdict('b', 'a', true, false), 'close-new')
})

const dials = (o: Partial<Parameters<typeof pickDials>[0]> = {}) =>
  pickDials({
    self: 'box',
    peers: [],
    configuredAs: () => undefined,
    known: [],
    linked: new Set(),
    dialing: new Set(),
    waiting: () => false,
    own: new Set(),
    ...o,
  })
const hub = { node: 'hub', addresses: ['http://10.0.0.5:3021', 'http://172.20.0.1:3021'], validated: true }

test('a node known at several addresses is dialed at one at a time', () => {
  assert.deepEqual(dials({ known: [hub] }), ['http://10.0.0.5:3021'])
  assert.deepEqual(dials({ known: [hub], dialing: new Set(['http://10.0.0.5:3021']) }), [], 'one is in flight')
  assert.deepEqual(dials({ known: [hub], waiting: (a) => a.includes('10.0.0.5') }), ['http://172.20.0.1:3021'], 'the next gets its turn')
  assert.deepEqual(dials({ known: [hub], linked: new Set(['hub']) }), [])
})

test('a node with a configured address due gets no gossiped dial beside it', () => {
  const peers = ['http://hub.lab:3021']
  const configuredAs = (u: string) => (u === peers[0] ? 'hub' : undefined)
  assert.deepEqual(dials({ peers, configuredAs, known: [hub] }), peers)
  assert.deepEqual(dials({ peers, configuredAs, known: [hub], waiting: (a) => a === peers[0] }), [...peers, 'http://10.0.0.5:3021'], 'its configured address backs off: try gossip')
})

/** Watch a pair for a while: the link it holds must be one, and the same one throughout. */
const steady = async (n: Awaited<ReturnType<typeof node>>, peer: string, ms = 2_500) => {
  const held = () => readyLinks(n).filter((l) => l.node === peer)
  await until(`linked to ${peer}`, () => held().length === 1)
  const first = held()[0]
  const end = Date.now() + ms
  while (Date.now() < end) {
    const now = held()
    assert.equal(now.length, 1, `exactly one live link to ${peer}`)
    assert.equal(now[0], first, `the link to ${peer} was not replaced`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('two configured addresses of one node give one link that stays', async () => {
  const hub = await node('hub')
  const other = hub.url.replace('127.0.0.1', 'localhost')
  const box = await node('box', { peers: [hub.url, other], addresses: [] })
  await steady(box, 'hub')
  await steady(hub, 'box')
})

test('a node gossiped at several addresses is dialed at one, and a relay routes to it', async () => {
  const hub = await node('hub')
  const box = await node('box', { peers: [hub.url], addresses: [] })
  const far = await node('far', { peers: [hub.url], addresses: [] })
  await steady(box, 'hub')
  await until('far routes to box through hub', () => far.daemon.routes().get('box')?.nextHop === 'hub', 10_000)
  await until('box routes to far through hub', () => box.daemon.routes().get('far')?.nextHop === 'hub', 10_000)

  const multi = await node('multi', { peers: [hub.url] })
  const alias = multi.url.replace('127.0.0.1', 'localhost')
  await multi.close()
  const again = await node('multi', { dir: multi.dir, port: multi.port, peers: [hub.url], addresses: [multi.url, alias] })
  await until('box knows both addresses', () => (new NodeTable(box.log.db).get('multi')?.addresses.length ?? 0) === 2, 10_000)
  void again
  await steady(box, 'multi')
})
