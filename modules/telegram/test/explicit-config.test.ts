/**
 * The module has no built-in bot (31 Oct 2026): an install names each bot by
 * the identity Telegram must report, where its token comes from, and the
 * operators' chats. Anything missing or mismatched refuses the bot.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseConfig } from '../server/config.js'
import { resolver } from '../server/secrets.js'
import { TelegramService } from '../server/service.js'
import { FakeChannel } from '../server/channel.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-explicit-'))
const until = async (what: string, check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`timed out: ${what}`)
}
const bot = (over: Record<string, unknown> = {}) => ({
  id: 'dev',
  identity: { username: '@my_cortex_bot' },
  token: { from: 'bao', path: 'kv/cortex/secrets', key: 'TG_DEV_TOKEN' },
  operators: [{ name: 'alex', chat: { from: 'bao', path: 'kv/cortex/secrets', key: 'TG_CHAT' } }],
  fallbackTo: 'alex',
  ...over,
})
const cfg = (over: Record<string, unknown> = {}) => ({ http: { listen: [] }, bots: [bot()], ...over })

test('config: every bot names its identity and its token source; a token value, the old shape, or a listener without a publish token is refused', () => {
  assert.ok(parseConfig(cfg()))
  assert.throws(() => parseConfig(cfg({ bots: [bot({ identity: undefined })] })), /identity/)
  assert.throws(() => parseConfig(cfg({ bots: [bot({ token: undefined })] })), /token/)
  assert.throws(() => parseConfig(cfg({ bots: [bot({ token: { from: 'bao', path: 'x/y', key: 'K', note: '123456789:AAEhBP0av18Zxyz_abcdefghijklmnopqrstuv' } })] })), /holds a bot token/)
  assert.throws(() => parseConfig({ bots: [{ id: 'dev', tokenEnv: 'TG', operators: [{ name: 'c', chatEnv: 'C' }], fallbackTo: 'c' }] }), /old shape .* cortex-telegram-admin migrate/)
  assert.throws(() => parseConfig({ bots: [bot()] }), /publishToken: required while http.listen is set/)
})

test('a bao reference is read through bao-run, never from an environment variable of the same name', () => {
  const dir = tmp()
  const stub = path.join(dir, 'bao-run')
  // A stand-in for bao-run: it sets the key from a fake vault keyed by BAO_SECRET_PATH, then runs the command.
  fs.writeFileSync(stub, '#!/bin/sh\nk="$1"; shift; shift\nif [ "$BAO_SECRET_PATH" = "kv/cortex/secrets" ] && [ "$k" = "TG_DEV_TOKEN" ]; then export TG_DEV_TOKEN=from-vault; fi\nexec "$@"\n', { mode: 0o755 })
  const resolve = resolver({ ...process.env, CKN_BAO_RUN: stub, TG_DEV_TOKEN: 'from-env-must-not-be-used' })
  assert.equal(resolve({ from: 'bao', path: 'kv/cortex/secrets', key: 'TG_DEV_TOKEN' }), 'from-vault')
  assert.equal(resolve({ from: 'bao', path: 'other/path', key: 'TG_DEV_TOKEN' }), undefined, 'the env copy is not a fallback')
  assert.equal(resolve({ from: 'env', name: 'TG_DEV_TOKEN' }), 'from-env-must-not-be-used', 'env only when the config says env')
})

test('a bot whose token source gives nothing is refused, not run', async () => {
  const s = new TelegramService({ dataDir: tmp(), config: parseConfig(cfg()), resolve: () => undefined, channel: () => new FakeChannel(), log: () => {}, http: false })
  assert.match(s.warnings.join('\n'), /bot dev is refused: no token from OpenBao kv\/cortex\/secrets TG_DEV_TOKEN/)
  assert.equal(s.gateway.bots.length, 0)
  await s.stop()
})

test('cortex-telegram-admin migrate: the old shape becomes OpenBao references and a named identity; dry run, then apply with the old file kept', async () => {
  const { spawnSync } = await import('node:child_process')
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const state = tmp()
  const dir = path.join(state, 'data', 'telegram')
  fs.mkdirSync(dir, { recursive: true })
  const old = { http: { listen: ['127.0.0.1:7320'], publishTokenEnv: 'NOTIFY_PUBLISH_TOKEN' }, bots: [{ id: 'dev', default: true, tokenEnv: 'TG_MY_BOT_TOKEN', poll: true, operators: [{ name: 'alex', chatEnv: 'TG_CHAT_ID' }], fallbackTo: 'alex' }] }
  fs.writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify(old))
  const run = (...args: string[]) =>
    spawnSync(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'modules', 'telegram', 'bin', 'cortex-telegram-admin.ts'), 'migrate', ...args], {
      encoding: 'utf-8',
      env: { ...process.env, CKN_STATE_DIR: state },
    })
  assert.match(run('--username', 'dev=@my_cortex_bot').stdout, /--secrets-path/, 'no default path')
  assert.match(run('--secrets-path', 'kv/cortex/secrets').stdout, /--username dev=@its_bot_name/, 'no default identity')
  const dry = JSON.parse(run('--secrets-path', 'kv/cortex/secrets', '--username', 'dev=@my_cortex_bot').stdout)
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.next.bots[0].token, { from: 'bao', path: 'kv/cortex/secrets', key: 'TG_MY_BOT_TOKEN' })
  assert.deepEqual(dry.next.bots[0].operators[0].chat, { from: 'bao', path: 'kv/cortex/secrets', key: 'TG_CHAT_ID' })
  assert.deepEqual(dry.next.bots[0].identity, { username: '@my_cortex_bot' })
  assert.deepEqual(dry.next.http.publishToken, { from: 'bao', path: 'kv/cortex/secrets', key: 'NOTIFY_PUBLISH_TOKEN' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'telegram.json'), 'utf-8')), old, 'a dry run writes nothing')
  const applied = JSON.parse(run('--secrets-path', 'kv/cortex/secrets', '--username', 'dev=@my_cortex_bot', '--apply').stdout)
  assert.ok(applied.applied && fs.existsSync(applied.kept))
  assert.ok(parseConfig(JSON.parse(fs.readFileSync(path.join(dir, 'telegram.json'), 'utf-8'))))
})

test('identity: nothing goes out or is polled until getMe confirms the configured bot; a different bot is refused for good', async () => {
  const live = (username: string, fail = 0) => {
    const ch = new FakeChannel()
    ch.username = username
    for (let i = 0; i < fail; i++) ch.meFail.push(new Error('network down'))
    ch.updates.push({ update_id: 1, message: { message_id: 1, chat: { id: 555 }, from: { id: 555 }, text: 'hello', date: 0 } } as never)
    return ch
  }
  const config = parseConfig(cfg({ bots: [bot({ poll: true })] }))
  const resolve = (r: { key?: string; name?: string }) => (r.key === 'TG_CHAT' ? '555' : 'a-token')

  const wrong = live('some_old_test_bot')
  const s1 = new TelegramService({ dataDir: tmp(), config, resolve: resolve as never, channel: () => wrong, log: () => {}, http: false, pollTimeoutS: 0 })
  await s1.start()
  try {
    await until('refused', () => s1.identities.get('dev')?.state === 'refused')
    assert.match(s1.warnings.join('\n'), /Telegram says its token is @some_old_test_bot, the config names @my_cortex_bot/)
    await s1.gateway.alert('dev', 'test', 'must not go out')
    await s1.gateway.deliverDue()
    assert.equal(wrong.sent.length, 0, 'nothing sent through the wrong bot, not even an alert')
    assert.equal(s1.pollers.get('dev'), undefined, 'never polled')
  } finally {
    await s1.stop()
  }

  const flaky = live('my_cortex_bot', 2)
  const s2 = new TelegramService({ dataDir: tmp(), config, resolve: resolve as never, channel: () => flaky, log: () => {}, http: false, pollTimeoutS: 0, verifyRetryMs: 20 })
  await s2.start()
  try {
    assert.equal(s2.gateway.bots[0]!.verified, false, 'not confirmed while getMe fails')
    await until('verified after Telegram answers', () => s2.identities.get('dev')?.state === 'verified')
    await until('then it polls', () => s2.gateway.replies().length > 0)
  } finally {
    await s2.stop()
  }
})

test('cortex-telegram-admin init writes telegram.json only when every reference resolves and Telegram names the same bot', async () => {
  const { spawn } = await import('node:child_process')
  const http = await import('node:http')
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { username: req.url?.includes('right-token') ? 'my_cortex_bot' : 'old_test_bot' } })))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const state = tmp()
  const file = path.join(state, 'data', 'telegram', 'telegram.json')
  const run = (env: Record<string, string>, ...args: string[]) =>
    new Promise<{ status: number | null; out: Record<string, unknown> }>((resolve) => {
      const p = spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'modules', 'telegram', 'bin', 'cortex-telegram-admin.ts'), 'init', ...args], {
        env: { ...process.env, CKN_STATE_DIR: state, CKN_TELEGRAM_API: `http://127.0.0.1:${port}`, TG_CHAT: '555', ...env },
      })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (status) => resolve({ status, out: JSON.parse(out || '{}') }))
    })
  const args = ['--bot', 'dev', '--username', '@my_cortex_bot', '--token', 'env:TG_TOKEN', '--operator', 'me', '--chat', 'env:TG_CHAT']
  try {
    assert.match(String((await run({}, '--bot', 'dev', '--token', 'env:TG_TOKEN')).out.error), /--username/)
    assert.match(String((await run({}, ...args.slice(0, 4), '--token', 'TG_TOKEN', '--operator', 'me', '--chat', 'env:TG_CHAT')).out.error), /bao:<path>#<KEY> or env:<NAME>/)
    const wrong = await run({ TG_TOKEN: 'wrong-token' }, ...args)
    assert.equal(wrong.status, 1)
    assert.deepEqual(wrong.out.identity, { telegram: '@old_test_bot', config: '@my_cortex_bot', match: false })
    assert.ok(!fs.existsSync(file), 'nothing written for another bot')
    const right = await run({ TG_TOKEN: 'right-token' }, ...args)
    assert.equal(right.status, 0, JSON.stringify(right.out))
    assert.equal(right.out.written, file)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(!fs.readFileSync(file, 'utf-8').includes('right-token'), 'the reference, never the token')
    assert.match(String((await run({ TG_TOKEN: 'right-token' }, ...args)).out.error), /exists; run check, or pass --force/)
  } finally {
    server.close()
  }
})

test('cortex-telegram-admin unit: OpenBao only when a reference uses it; env references name their file, never a value', async () => {
  const { spawnSync } = await import('node:child_process')
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const unitFor = (config: unknown) => {
    const state = tmp()
    fs.mkdirSync(path.join(state, 'data', 'telegram'), { recursive: true })
    fs.writeFileSync(path.join(state, 'data', 'telegram', 'telegram.json'), JSON.stringify(config))
    return spawnSync(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'modules', 'telegram', 'bin', 'cortex-telegram-admin.ts'), 'unit'], {
      encoding: 'utf-8',
      env: { ...process.env, CKN_STATE_DIR: state },
    }).stdout
  }
  const envOnly = unitFor(cfg({ bots: [bot({ token: { from: 'env', name: 'TG_TOKEN' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'TG_CHAT' } }] })] }))
  assert.doesNotMatch(envOnly, /\.claude\/\.env/, 'no OpenBao bootstrap without a bao reference')
  assert.match(envOnly, /# provides TG_TOKEN, TG_CHAT\nEnvironmentFile=%h\/\.config\/ckn\/telegram\.env/)
  const withBao = unitFor(cfg())
  assert.match(withBao, /EnvironmentFile=%h\/\.claude\/\.env/)
  assert.doesNotMatch(withBao, /telegram\.env/)
})

test('cortex-telegram-admin import has no built-in operator: with no config naming one, it asks for --operator', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const state = tmp()
  const legacy = path.join(state, 'legacy.sqlite3')
  fs.writeFileSync(legacy, '')
  const r = spawnSync(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'modules', 'telegram', 'bin', 'cortex-telegram-admin.ts'), 'import', legacy], {
    encoding: 'utf-8',
    env: { ...process.env, CKN_STATE_DIR: state },
  })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(JSON.parse(r.stdout).error, /--operator/)
})
