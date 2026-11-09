import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChannelError, FakeChannel, PollConflict } from '../server/channel.js'
import { kvGet } from '../server/db.js'
import { config, make, update } from './harness.js'

const twoBots = () =>
  config({
    bots: [
      { id: 'dev', default: true, identity: { username: '@test_bot' }, token: { from: 'env', name: 'TG_DEV' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'C1' } }], fallbackTo: 'alex', poll: true, routes: [{ prefix: 'note ', to: { event: 'telegram.inbound' } }], conflictingUnits: ['old-gateway.service'] },
      { id: 'home', identity: { username: '@test_bot' }, token: { from: 'env', name: 'TG_HOME' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'C1' } }, { name: 'partner', chat: { from: 'env', name: 'C2' } }], fallbackTo: 'alex', poll: true, routes: [{ prefix: 'play', to: { role: 'helper' } }], senders: ['helper'] },
    ],
  })

const setup = (emit?: (p: unknown) => void) =>
  make({
    config: twoBots(),
    channels: { dev: new FakeChannel(), home: new FakeChannel() },
    operators: { dev: [{ name: 'alex', chatId: '111' }], home: [{ name: 'alex', chatId: '111' }, { name: 'partner', chatId: '222' }] },
    emit,
  })

test('two bots keep their operators, offsets and threads apart', async () => {
  const { gw, db, channels } = setup()
  // The partner may talk to the home bot, not the dev bot.
  assert.equal(await gw.handleUpdate('dev', update('hi', { chat: '222', from: '222', id: 5 })), undefined)
  assert.ok(await gw.handleUpdate('home', update('hi', { chat: '222', from: '222', id: 5 })), 'the same update id on another bot is its own row')
  assert.equal(kvGet(db, 'dev:offset'), '6')
  assert.equal(kvGet(db, 'home:offset'), '6')
  assert.equal(kvGet(db, 'dev:dropped_unauthorised'), '1')
  // A thread on one bot is not a thread on the other, even with the same message id.
  await gw.send({ bot: 'dev', sender: 'ops-dev', text: 'q', topic: 'T' })
  const mid = channels.dev!.sent[0]!.message_id
  const onHome = await gw.handleUpdate('home', update('answer', { replyTo: mid }))
  assert.equal(gw.replies({ id: onHome })[0]!.route_to, null)
})

test('a bot sends only for its permitted roles, and only to its own operators', async () => {
  const { gw, channels } = setup()
  await assert.rejects(gw.send({ bot: 'home', sender: 'ops-dev', text: 'x' }), /may not send through bot home/)
  await assert.rejects(gw.send({ bot: 'dev', sender: 'ops-dev', text: 'x', to: 'partner' }), /no operator partner on bot dev/)
  ;(gw as unknown as { config: { owners: { known: string[] } } }).config.owners.known.push('helper')
  await gw.send({ bot: 'home', sender: 'helper', text: 'now playing', to: 'partner' })
  assert.equal(channels.home!.sent[0]!.chat, '222')
})

test('a prefix route on the dev bot reaches an in-host consumer through telegram.inbound, never a comms body', async () => {
  const events: unknown[] = []
  const { gw, mesh } = setup((p) => events.push(p))
  const id = await gw.handleUpdate('dev', update('note buy milk', { chat: '111', from: '111' }))
  assert.ok(id)
  assert.deepEqual(events, [{ bot: 'dev', inboundId: id, route: 'note' }])
  assert.equal(mesh.sent.length, 0)
  assert.equal(gw.replies({ id })[0]!.text, 'note buy milk', 'the consumer reads the text through replies (the telegram.replies capability)')
})

test('a role prefix route sends the role a reference', async () => {
  const { gw, mesh } = setup()
  const id = await gw.handleUpdate('home', update('play something calm', { chat: '222', from: '222' }))
  assert.equal(mesh.sent[0]!.to, 'helper')
  assert.match(mesh.sent[0]!.body, new RegExp(`replies --id ${id}`))
})

test('a 409 stops that bot\'s poller with ONE alert through its own sendMessage, then one recovered note; the other bot polls on (addition A)', async () => {
  const { gw, channels } = setup()
  channels.dev!.pollFail.push(new PollConflict(), new PollConflict())
  assert.equal(await gw.pollOnce('dev', 0), 'stop')
  assert.equal(await gw.pollOnce('dev', 0), 'stop')
  const alerts = channels.dev!.sent.filter((s) => s.text.includes('ALERT'))
  assert.equal(alerts.length, 1, 'deduplicated per cause')
  assert.match(alerts[0]!.text, /another process is polling its token\. Stop the other poller \(for example old-gateway\.service\), then restart cortex-host/)
  assert.equal(channels.home!.sent.length, 0)
  channels.home!.updates.push(update('ok', { chat: '111', from: '111', id: 1 }))
  assert.equal(await gw.pollOnce('home', 0), 'ok', 'the home bot is unaffected')
  assert.equal(await gw.pollOnce('dev', 0), 'ok')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(channels.dev!.sent.filter((s) => s.text.includes('recovered')).length, 1)
  assert.deepEqual(gw.health().bots[0]!.alerts, [])
})

test('a dead token alerts through ANOTHER bot with the same operator (addition A)', async () => {
  const { gw, channels } = setup()
  channels.dev!.pollFail.push(new ChannelError('getUpdates: HTTP 401 Unauthorized', true, undefined, 401))
  assert.equal(await gw.pollOnce('dev', 0), 'stop')
  assert.equal(channels.dev!.sent.length, 0)
  assert.match(channels.home!.sent[0]!.text, /ALERT: the dev bot stopped listening: Telegram refused its token .*TG_DEV/)
})

test('with no other bot to carry it, the alert goes to pm over comms and stays in health', async () => {
  const { gw, channel, mesh } = make()
  channel.pollFail.push(new ChannelError('getUpdates: HTTP 401', true, undefined, 401))
  await gw.pollOnce('dev', 0)
  assert.equal(channel.sent.length, 0)
  assert.equal(mesh.sent[0]!.to, 'pm')
  assert.deepEqual(gw.health().bots[0]!.alerts, ['auth'])
})
