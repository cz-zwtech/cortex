import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { CHUNK, chunksOf, Inbound, Outbound, sha256, snapshot } from '../../server/mesh/files.js'
import { meshView } from '../../server/mesh/view.js'
import { Comms } from '../../server/comms.js'
import { commsOn, inboxOf, node, NOWHERE, pair, tmp, until, writeFile } from './harness.js'

// ── files (P6) ───────────────────────────────────────────────────────────────

test('staging takes chunks only in order and only when their hash matches; a bad whole file starts over', () => {
  const root = tmp()
  const inb = new Inbound(root)
  const data = crypto.randomBytes(CHUNK + 100)
  const entry = { name: 'x.bin', size: data.length, sha256: sha256(data), chunks: chunksOf(data.length) }
  assert.deepEqual(inb.offer('o', 'id1', [entry], 'cortex-comms:role:r', 'b'), [0])
  const c0 = data.subarray(0, CHUNK)
  const c1 = data.subarray(CHUNK)
  assert.equal(inb.chunk('o', 'id1', { entry: 0, n: 1, data: c1.toString('base64'), sha256: sha256(c1) })!.upto, 0, 'out of order: ignored')
  assert.equal(inb.chunk('o', 'id1', { entry: 0, n: 0, data: c0.toString('base64'), sha256: 'wrong' })!.upto, 0, 'bad hash: ignored')
  assert.equal(inb.chunk('o', 'id1', { entry: 0, n: 0, data: c0.toString('base64'), sha256: sha256(c0) })!.upto, 1)
  assert.deepEqual(inb.offer('o', 'id1', [entry], 'cortex-comms:role:r', 'b'), [1], 'a resumed offer is told what is held')
  assert.deepEqual(inb.chunk('o', 'id1', { entry: 0, n: 1, data: c1.toString('base64'), sha256: sha256(c1) }), { upto: 2, complete: true })
  const lying = { ...entry, sha256: 'not-the-file' }
  inb.offer('o', 'id2', [lying], 'cortex-comms:role:r', 'b')
  inb.chunk('o', 'id2', { entry: 0, n: 0, data: c0.toString('base64'), sha256: sha256(c0) })
  assert.equal(inb.chunk('o', 'id2', { entry: 0, n: 1, data: c1.toString('base64'), sha256: sha256(c1) })!.upto, 0, 'whole-file hash failed: asked for again from the start')
})

test('only a small window of chunks is ever in flight, so messages are never queued behind a whole file', () => {
  const dir = tmp()
  const entries = snapshot([writeFile('f.bin', 40 * CHUNK)], dir)
  const out = new Outbound()
  out.offerDue('t', dir, entries, 0)
  assert.equal(out.due('t').length, 0, 'nothing before the destination says what it holds')
  out.need('t', [0], 1)
  const first = out.due('t')
  assert.ok(first.length > 0 && first.length < 40, `a window, not the file: ${first.length}`)
  assert.equal(out.due('t').length, 0, 'no more until progress')
  out.progress('t', 0, 2, 2)
  assert.equal(out.due('t').length, 2, 'progress opens the window by what was acknowledged')
})

test('the size limit is enforced before anything is sent', () => {
  const big = writeFile('big.bin', 2048)
  assert.throws(() => snapshot([big], tmp(), 1024), /over the 0 MB limit|over the .* MB limit/)
})

test('a file sent to another node lands in that mailbox\'s inbox, verified, and the origin drops its snapshot when it is read', async () => {
  const { nodeA, lap, z, l } = await pair()
  const src = writeFile('brief.md', 'x'.repeat(3 * CHUNK + 17))
  const sent = await l.send('pm-1', 'node-a:web-dev', 'the brief', { files: [src] })
  assert.ok(sent.ok, sent.outcome)
  const item = await inboxOf(z, 'web-dev-1')
  const f = item.files![0]!
  assert.equal(f.name, 'brief.md')
  assert.equal(path.dirname(f.path!), path.join(nodeA.dir, 'files', 'inbox', 'web-dev'))
  assert.equal(sha256(fs.readFileSync(f.path!)), sha256(fs.readFileSync(src)))
  assert.equal(item.body, 'the brief')
  const snapDir = () => fs.readdirSync(path.join(lap.dir, 'files', 'out'))
  assert.equal(snapDir().length, 1, 'held at the origin until read')
  z.markSeen('web-dev-1', [item.id])
  await until('the origin dropped its snapshot', () => snapDir().length === 0, 10_000)
})

test('files and folders: structure kept, and a second send never overwrites the first', async () => {
  const { nodeA, z, l } = await pair()
  const dir = tmp()
  writeFile('site/index.html', '<h1>hi</h1>', dir)
  writeFile('site/img/logo.png', 4000, dir)
  await l.send('pm-1', 'node-a:web-dev', 'the site', { files: [path.join(dir, 'site')] })
  const first = await inboxOf(z, 'web-dev-1')
  z.markSeen('web-dev-1', [first.id])
  assert.deepEqual(first.files!.map((f) => f.name).sort(), ['site/img/logo.png', 'site/index.html'])
  await l.send('pm-1', 'node-a:web-dev', 'the site again', { files: [path.join(dir, 'site')] })
  const second = await inboxOf(z, 'web-dev-1')
  const inbox = path.join(nodeA.dir, 'files', 'inbox', 'web-dev')
  assert.deepEqual(fs.readdirSync(inbox).sort(), ['site', 'site (1)'])
  assert.ok(second.files!.every((f) => f.path!.includes('site (1)')))
})

test('a file that trips the secret gate is refused, the sender is told, and nothing lands', async () => {
  const { nodeA, l } = await pair()
  const key = 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 16)
  const src = writeFile('notes.txt', `deploy with ${key} and go`)
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'notes', { files: [src] })).ok)
  let items: Awaited<ReturnType<Comms['inbox']>> = []
  await until('the sender is told', () => {
    void l.inbox('pm-1').then((x) => (items = x))
    return items.length === 1
  }, 15_000)
  assert.match(items[0]!.body, /not delivered: notes\.txt: refused by the secret gate/)
  assert.ok(!items[0]!.body.includes(key), 'the notice never carries the secret')
  assert.ok(!fs.existsSync(path.join(nodeA.dir, 'files', 'inbox', 'web-dev')))
})

test('a file crosses a relay that stores none of it', async () => {
  const b = await node('node-b', { comms: true })
  const a = await node('node-a', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const d = await node('node-d', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const ca = commsOn(a, 'node-a')
  const cd = commsOn(d, 'node-d')
  await commsOn(b, 'node-b').join('relay-crew', { create: true, as: 'relay-crew-1' })
  await ca.join('pm', { create: true, as: 'pm-1' })
  await cd.join('ops', { create: true, as: 'ops-1' })
  await until('a reaches d', () => meshView(a.dir, 'node-a').nodes.some((n) => n.node === 'node-d' && n.reachable && n.roles.length > 0), 10_000)
  const src = writeFile('data.bin', 2 * CHUNK + 5)
  assert.ok((await ca.send('pm-1', 'node-d:ops', 'via b', { files: [src] })).ok)
  const item = await inboxOf(cd, 'ops-1')
  assert.equal(sha256(fs.readFileSync(item.files![0]!.path!)), sha256(fs.readFileSync(src)))
  assert.ok(!fs.existsSync(path.join(b.dir, 'files', 'in')) || fs.readdirSync(path.join(b.dir, 'files', 'in')).length === 0, 'the relay staged nothing')
})

test('a transfer cut off part-way resumes from the last good chunk, not from the start', async () => {
  const { nodeA, lap, z, l } = await pair()
  const src = writeFile('big.bin', 40 * CHUNK)
  let chunks = 0
  let cut = false
  const receive = nodeA.daemon.router.receive.bind(nodeA.daemon.router)
  nodeA.daemon.router.receive = (f) => {
    if (f.kind === 'chunk') {
      chunks++
      if (chunks === 12 && !cut) {
        cut = true
        lap.daemon.links().find((k) => k.node === 'node-a-node')?.ws.terminate()
        return
      }
    }
    receive(f)
  }
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'big one', { files: [src] })).ok)
  const item = await inboxOf(z, 'web-dev-1')
  assert.equal(sha256(fs.readFileSync(item.files![0]!.path!)), sha256(fs.readFileSync(src)))
  assert.ok(cut, 'the link was cut mid-transfer')
  assert.ok(chunks <= 40 + 2 * 4 + 1, `resumed rather than restarted: ${chunks} chunks for 40`)
})

test('a message sent during a large transfer is not held behind it', async () => {
  const { nodeA, z, l } = await pair()
  // Slow the destination's chunk handling so the transfer is still running when the message goes.
  const receive = nodeA.daemon.router.receive.bind(nodeA.daemon.router)
  nodeA.daemon.router.receive = (f) => (f.kind === 'chunk' ? void setTimeout(() => receive(f), 40) : receive(f))
  const src = writeFile('large.bin', 40 * CHUNK)
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'large', { files: [src] })).ok)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok((await l.send('pm-1', 'node-a:web-dev', 'urgent: stop')).ok)
  await inboxOf(z, 'web-dev-1')
  const order = nodeA.log.read('cortex-comms:role:web-dev').map((r) => [r.seq, r.payload.includes('urgent: stop') ? 'message' : 'files'] as const)
  const at = (what: string) => order.find(([, w]) => w === what)![0]
  assert.ok(at('message') < at('files'), `the message landed first: ${JSON.stringify(order)}`)
})

test('a transfer cut beyond a relay resumes: retransmissions are not mistaken for loops', async () => {
  const b = await node('node-b', { comms: true })
  const a = await node('node-a', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const d = await node('node-d', { comms: true, addresses: NOWHERE, peers: [b.url] })
  const ca = commsOn(a, 'node-a')
  const cd = commsOn(d, 'node-d')
  await commsOn(b, 'node-b').join('relay-crew', { create: true, as: 'relay-crew-1' })
  await ca.join('pm', { create: true, as: 'pm-1' })
  await cd.join('ops', { create: true, as: 'ops-1' })
  await until('a reaches d', () => meshView(a.dir, 'node-a').nodes.some((n) => n.node === 'node-d' && n.reachable && n.roles.length > 0), 10_000)
  // Cut d's link to the relay after some chunks have crossed: a's own links never drop, so a
  // only notices the stall, and must resend through the same relay.
  let chunks = 0
  const receive = d.daemon.router.receive.bind(d.daemon.router)
  d.daemon.router.receive = (f) => {
    if (f.kind === 'chunk' && ++chunks === 6) {
      d.daemon.links().find((k) => k.node === 'node-b')?.ws.terminate()
      return
    }
    receive(f)
  }
  const src = writeFile('far.bin', 30 * CHUNK)
  assert.ok((await ca.send('pm-1', 'node-d:ops', 'across a cut', { files: [src] })).ok)
  const item = await inboxOf(cd, 'ops-1')
  assert.equal(sha256(fs.readFileSync(item.files![0]!.path!)), sha256(fs.readFileSync(src)))
})
