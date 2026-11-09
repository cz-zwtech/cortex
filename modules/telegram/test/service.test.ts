import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { FakeChannel, PollConflict, TelegramChannel } from '../server/channel.js'
import { parseConfig } from '../server/config.js'
import { openDb } from '../server/db.js'
import { TelegramService, takePollLock } from '../server/service.js'
import { config, FakeMesh, tmp, update } from './harness.js'

const until = async (what: string, check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`timed out waiting for: ${what}`)
}

const env = { TG_DEV: 'not-a-real-token', TG_CHAT: '12345' }

test('guards: a live channel and the real data dir are refused under test', () => {
  assert.throws(() => new TelegramChannel('t'), /a test tried to use a live Telegram channel/)
  // A path outside the temp dir that could not be created anyway, so a broken guard fails the test, not the machine.
  assert.throws(() => openDb('/var/lib/cortex-telegram-guard-test/telegram.sqlite'), /refusing the telegram store outside the temp dir/)
})

test('config: problems are named; a poll needs live mode; fallbackTo must be an operator; ids are unique', () => {
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [] }), /bots/)
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [{ id: 'd', identity: { username: '@test_bot' }, token: { from: 'env', name: 'T' }, operators: [{ name: 'c', chat: { from: 'env', name: 'C' } }], fallbackTo: 'x' }] }), /fallbackTo x is not one of its operators/)
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [{ id: 'd', identity: { username: '@test_bot' }, token: { from: 'env', name: 'T' }, mode: 'dry-run', poll: true, operators: [{ name: 'c', chat: { from: 'env', name: 'C' } }], fallbackTo: 'c' }] }), /poll needs mode live/)
  const b = { identity: { username: '@test_bot' }, token: { from: 'env', name: 'T' }, operators: [{ name: 'c', chat: { from: 'env', name: 'C' } }], fallbackTo: 'c' }
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [{ id: 'd', ...b }, { id: 'd', ...b }] }), /unique/)
  assert.throws(() => parseConfig({ http: { publishToken: { from: 'env', name: 'TG_PUBLISH' } }, bots: [{ id: 'd', ...b, token: 'x' }] }), /token: Expected object/, 'a token is a reference, never a value')
})

test('the poll lock admits one holder per bot; a dead holder is taken over', () => {
  const dir = tmp()
  const a = takePollLock(dir, 'dev')
  assert.ok(a.ok)
  fs.writeFileSync(path.join(dir, 'poll-dev.lock'), '1') // pid 1 is alive and is not us
  assert.deepEqual(takePollLock(dir, 'dev'), { ok: false, holder: 1 })
  fs.writeFileSync(path.join(dir, 'poll-dev.lock'), '999999999')
  assert.ok(takePollLock(dir, 'dev').ok, 'a dead pid does not hold it')
})

test('the service: a missing chat id is a warning; a bot does not poll while a conflicting unit runs, then polls when it stops', async () => {
  const cfg = config({ bots: [{ id: 'dev', identity: { username: '@test_bot' }, token: { from: 'env', name: 'TG_DEV' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'TG_CHAT' } }], fallbackTo: 'alex', poll: true, conflictingUnits: ['old-gateway.service'] }] })
  const ch = new FakeChannel()
  let unitUp = true
  const s = new TelegramService({ dataDir: tmp(), config: cfg, env, mesh: new FakeMesh(), channel: () => ch, unitActive: () => unitUp, log: () => {}, http: false, pollTimeoutS: 0 })
  await s.start()
  try {
    await until('waiting for the conflicting unit', () => s.pollers.get('dev')?.state === 'waiting for a conflicting unit')
    assert.match(ch.sent[0]!.text, /not listening while old-gateway\.service runs/)
    const missing = new TelegramService({ dataDir: tmp(), config: cfg, env: { TG_DEV: 'x' }, channel: () => new FakeChannel(), log: () => {}, http: false })
    assert.match(missing.warnings[0]!, /operator alex has no chat id \(env TG_CHAT gave nothing\)/)
    await missing.stop()
    void unitUp
  } finally {
    await s.stop()
  }
  // A fresh service with the unit stopped polls, stores an operator message, and stops on a conflict.
  unitUp = false
  const ch2 = new FakeChannel()
  ch2.updates.push(update('hello', { id: 3 }))
  const s2 = new TelegramService({ dataDir: tmp(), config: cfg, env, mesh: new FakeMesh(), channel: () => ch2, unitActive: () => false, log: () => {}, http: false, pollTimeoutS: 0 })
  await s2.start()
  try {
    await until('the update is stored', () => s2.gateway.replies().length === 1)
    ch2.pollFail.push(new PollConflict())
    await until('the poller stops on a conflict', () => s2.pollers.get('dev')?.state === 'stopped')
  } finally {
    await s2.stop()
  }
})

test('stop waits for a poll in flight and writes nothing after it (no store write after close)', async () => {
  // A poll that ignores the abort and returns late, as a fetch might: the race general-dev found.
  class SlowChannel extends FakeChannel {
    polls = 0
    override async poll(offset: number) {
      this.polls++
      await new Promise((r) => setTimeout(r, 150))
      this.updates.push(update('arrived during shutdown', { id: 90 }))
      return super.poll(offset)
    }
  }
  const ch = new SlowChannel()
  const errors: unknown[] = []
  const onError = (e: unknown) => errors.push(e)
  process.on('unhandledRejection', onError)
  try {
    const cfg = config()
    const s = new TelegramService({ dataDir: tmp(), config: cfg, env, mesh: new FakeMesh(), channel: () => ch, unitActive: () => false, log: () => {}, http: false, pollTimeoutS: 0 })
    await s.start()
    await until('a poll is in flight', () => ch.polls > 0)
    await s.stop()
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(errors, [], 'nothing ran into the closed store')
  } finally {
    process.off('unhandledRejection', onError)
  }
})
