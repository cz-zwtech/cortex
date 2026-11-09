import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChannelError } from '../server/channel.js'
import { parseConfig } from '../server/config.js'
import { NEVER } from '../server/db.js'
import { Gateway, Rejected } from '../server/gateway.js'
import { config, make } from './harness.js'

const page = { source: 'gpu-check', owner: 'globex-dev', severity: 'page', title: 'GPU missing', body: 'nvidia-smi found no device' }
const action = { ...page, severity: 'action' }

test('publish stores queued; bad source, owner, severity, title or dedupe key is refused', () => {
  const { gw } = make()
  const r = gw.publish(action)
  assert.equal(r.state, 'queued')
  for (const bad of [{ source: 'Bad Source' }, { owner: '' }, { severity: 'urgent' }, { title: '' }, { title: 'x'.repeat(201) }, { dedupe_key: 'has space' }, { title: 7 }]) {
    assert.throws(() => gw.publish({ ...action, ...bad }), Rejected, JSON.stringify(bad))
  }
  assert.throws(() => gw.publish({ ...action, body: 'x'.repeat(16 * 1024 + 1) }), (e: Rejected) => e.status === 413)
})

test('a tick routes the item to its owner by reference; the text never travels', async () => {
  const { gw, mesh } = make()
  const { id } = gw.publish(action)
  await gw.tick()
  assert.equal(mesh.sent.length, 1)
  assert.equal(mesh.sent[0]!.to, 'globex-dev')
  assert.match(mesh.sent[0]!.body, new RegExp(`cortex-telegram show ${id}`))
  assert.doesNotMatch(mesh.sent[0]!.body, /GPU missing|nvidia-smi/)
  assert.equal(gw.show(id!).state, 'routed')
})

test('a pinned owner is sent to its pinned address', async () => {
  const { gw, mesh } = make({ config: config({ owners: { known: [], pin: { 'globex-dev': 'node-a:globex-dev' } } }) })
  gw.publish(action)
  await gw.tick()
  assert.equal(mesh.sent[0]!.to, 'node-a:globex-dev')
})

test('a failed route stays queued and is retried with backoff', async () => {
  const { gw, mesh, clock } = make()
  mesh.up = false
  const { id } = gw.publish(action)
  await gw.tick()
  assert.equal(gw.show(id!).state, 'queued')
  mesh.up = true
  clock.advance(59)
  await gw.tick()
  assert.equal(mesh.sent.length, 0, 'not before the backoff')
  clock.advance(2)
  await gw.tick()
  assert.equal(gw.show(id!).state, 'routed')
})

test('a handled ack stops the fallback; action falls back at exactly 30 minutes, page at 5', async () => {
  const { gw, clock, channel } = make()
  const a = gw.publish(action)
  const handled = gw.publish({ ...action, title: 'handled one' })
  await gw.tick()
  await gw.ack(handled.id!, 'globex-dev', 'handled')
  clock.advance(29 * 60)
  await gw.tick()
  assert.equal(channel.sent.length, 0)
  clock.advance(60)
  await gw.tick()
  assert.equal(channel.sent.length, 1)
  assert.match(channel.sent[0]!.text, /^cortex -- unacknowledged, from gpu-check \[action\] GPU missing/)
  assert.equal(gw.show(a.id!).state, 'sent')
  assert.equal(gw.show(handled.id!).state, 'acked')

  const { gw: g2, clock: c2, channel: ch2 } = make()
  g2.publish(page)
  c2.advance(5 * 60)
  await g2.tick()
  assert.equal(ch2.sent.length, 1)
})

test('the fallback clock runs with comms down, and survives a restart', async () => {
  const { gw, clock, channel, mesh, db, cfg } = make()
  mesh.up = false
  gw.publish(page)
  const again = new Gateway({ db, config: cfg, bots: gw.bots, mesh, clock: clock.now })
  clock.advance(5 * 60)
  await again.tick()
  assert.equal(channel.sent.length, 1)
  assert.match(channel.sent[0]!.text, /\(owner unknown\)/, 'comms down: the owner cannot be confirmed')
})

test('forward sends now with the role as the prefix; an unknown or malformed sender is refused', async () => {
  const { gw, channel } = make()
  const { id } = gw.publish(action)
  const r = await gw.ack(id!, 'globex-dev', 'forward')
  assert.equal(r.changed, true)
  assert.match(channel.sent[0]!.text, /^globex-dev -- forwarded from gpu-check \[action\]/)
  await assert.rejects(gw.ack(gw.publish({ ...action, title: 'b' }).id!, 'stranger', 'handled'), (e: Rejected) => e.status === 403)
  // The prefix is the validated name, never the caller's raw string.
  const c = gw.publish({ ...action, title: 'c' })
  await gw.ack(c.id!, 'globex-dev (made up text)', 'forward')
  assert.match(channel.sent.at(-1)!.text, /^globex-dev -- forwarded/)
})

test('dedupe counts repeats while open; a new item after close', async () => {
  const { gw } = make()
  const a = gw.publish({ ...action, dedupe_key: 'gpu:1' })
  const b = gw.publish({ ...action, dedupe_key: 'gpu:1' })
  assert.equal(b.repeat, true)
  assert.equal(b.id, a.id)
  assert.equal(gw.show(a.id!).repeat_count, 1)
  await gw.ack(a.id!, 'globex-dev', 'handled')
  assert.notEqual(gw.publish({ ...action, dedupe_key: 'gpu:1' }).id, a.id)
})

test('a transient error retries later; retry_after is honoured; a permanent one fails and can be retried', async () => {
  const { gw, clock, channel } = make()
  channel.failNext.push(new ChannelError('HTTP 502', false))
  const { id } = gw.publish(page)
  clock.advance(5 * 60)
  await gw.tick()
  assert.equal(gw.show(id!).state, 'routed', 'the operator copy is still owed')
  clock.advance(30)
  await gw.tick()
  assert.equal(gw.show(id!).state, 'sent')

  const x = make()
  x.channel.failNext.push(new ChannelError('HTTP 429', false, 120))
  x.gw.publish(page)
  x.clock.advance(5 * 60)
  await x.gw.tick()
  x.clock.advance(60)
  await x.gw.tick()
  assert.equal(x.channel.sent.length, 0)
  x.clock.advance(61)
  await x.gw.tick()
  assert.equal(x.channel.sent.length, 1)

  const y = make()
  y.channel.failNext.push(new ChannelError('HTTP 400 chat not found', true, undefined, 400))
  const f = y.gw.publish(page)
  y.clock.advance(5 * 60)
  await y.gw.tick()
  assert.equal(y.gw.show(f.id!).state, 'failed')
  assert.deepEqual(y.gw.health(true).bots[0]!.failed_items, [f.id])
  assert.equal((await y.gw.retryItem(f.id!)).state, 'sent')
})

test('a long body is cut to fit with a pointer, and stored in full; the event trail is complete', async () => {
  const { gw, clock, channel } = make()
  const { id } = gw.publish({ ...page, body: 'y'.repeat(10_000) })
  await gw.tick()
  clock.advance(5 * 60)
  await gw.tick()
  assert.ok(channel.sent[0]!.text.length <= 4096)
  assert.match(channel.sent[0]!.text, new RegExp(`\\[cut; full text: cortex-telegram show ${id}\\]`))
  assert.equal(gw.show(id!).body, 'y'.repeat(10_000))
  assert.deepEqual((gw.show(id!).events as { to_state: string }[]).map((e) => e.to_state), ['queued', 'routed', 'routed', 'sent'])
})

test('the prefix is applied exactly once', async () => {
  const { gw, channel } = make()
  await gw.send({ sender: 'globex-dev', text: 'globex-dev -- already looks prefixed' })
  assert.equal(channel.sent[0]!.text, 'globex-dev -- globex-dev -- already looks prefixed')
  assert.equal(channel.sent[0]!.text.split(' -- ')[0], 'globex-dev')
})

test('info is routed, never sent to the operator, listed in the digest, and marked reviewed', async () => {
  const { gw, clock, channel, mesh } = make()
  const { id, fallback_due_at } = gw.publish({ ...action, severity: 'info' })
  assert.equal(fallback_due_at, NEVER)
  await gw.tick()
  assert.match(mesh.sent[0]!.body, /never sent to the operator/)
  clock.advance(30 * 86400)
  await gw.tick()
  assert.equal(channel.sent.length, 0)
  const d = gw.digest() as { id: string }[]
  assert.deepEqual(d.map((x) => x.id), [id])
  assert.deepEqual(gw.markReviewed([id, 'it_nope'], 'pm'), { marked: [id], not_found_or_already_reviewed: ['it_nope'] })
  assert.equal(gw.digest().length, 0)
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [{ id: 'dev', identity: { username: '@test_bot' }, token: { from: 'env', name: 'T' }, operators: [{ name: 'c', chat: { from: 'env', name: 'C' } }], fallbackTo: 'c', fallbackMinutes: { info: 240 } }] }), /info/)
})

test('info whose owner cannot be reached stops routing after its cap, and the digest says so (addition B)', async () => {
  const { gw, clock, mesh } = make()
  mesh.up = false
  const { id } = gw.publish({ ...action, severity: 'info', owner: 'acme-dev' })
  for (let i = 0; i < 40; i++) {
    await gw.tick()
    clock.advance(600)
  }
  const item = gw.show(id!)
  assert.equal(item.next_route_at, null)
  assert.ok(item.unrouted_at)
  assert.ok((item.route_attempts as number) <= 12)
  const d = gw.digest() as { id: string; note: string }[]
  assert.match(d[0]!.note, /owner acme-dev unreachable since/)
  mesh.up = true
  await gw.tick()
  assert.equal(mesh.sent.length, 0, 'no more routing once given up')
})
