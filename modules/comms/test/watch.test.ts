import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { handle, handleStop } from '../server/hooks.js'
import { Comms } from '../server/comms.js'
import { LocalIdentity } from '../server/identity.js'
import { MemoryTransport } from '../server/transport.js'
import { recordWatch, STOP_BLOCKS_PER_LAPSE, takeReminder, watchStatus, WATCH_STALE_MS } from '../server/watchState.js'
import { isolatedEnv } from '../../../test/isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-watch-'))
  dirs.push(d)
  return d
}

test('never armed, live, and lapsed are three different answers', () => {
  const dir = tmp()
  const now = Date.now()
  assert.equal(watchStatus(dir, 'a1', now).kind, 'never')
  recordWatch(dir, { member: 'a1', pid: 1, startedAt: now, beatAt: now })
  assert.equal(watchStatus(dir, 'a1', now + 1000).kind, 'live')
  assert.equal(watchStatus(dir, 'a1', now + WATCH_STALE_MS + 1).kind, 'lapsed', 'killed without a word: stale beat')
  recordWatch(dir, { member: 'a1', pid: 1, startedAt: now, beatAt: now, endedAt: now + 5 })
  assert.deepEqual(watchStatus(dir, 'a1', now + 10), { kind: 'lapsed', at: now + 5 })
})

test('a lapse is mentioned once, and a never-armed watcher once per session', () => {
  const dir = tmp()
  const lapse = { kind: 'lapsed', at: 42 } as const
  assert.equal(takeReminder(dir, 'a1', 's1', lapse), true)
  assert.equal(takeReminder(dir, 'a1', 's1', lapse), false, 'not on every prompt')
  assert.equal(takeReminder(dir, 'a1', 's1', { kind: 'lapsed', at: 99 }), true, 'a new lapse is new')

  const fresh = tmp()
  assert.equal(takeReminder(fresh, 'b1', 's1', { kind: 'never' }), true)
  assert.equal(takeReminder(fresh, 'b1', 's1', { kind: 'never' }), false)
  assert.equal(takeReminder(fresh, 'b1', 's2', { kind: 'never' }), true)
  assert.equal(takeReminder(fresh, 'b1', 's3', { kind: 'live', since: 1 }), false)
})

const member = async (dir: string) => {
  const t = new MemoryTransport()
  const local = new LocalIdentity(dir)
  const comms = new Comms(t, local)
  await comms.join('crew', { create: true, as: 'crew1' })
  local.bindSession('s1', 'crew1')
  return { local, comms }
}
const ctx = (dir: string) => ({ name: 'comms', dir, dataDir: dir, log: () => {} }) as never

test('start says how to listen; prompts stay quiet until the watcher actually lapses', async () => {
  const dir = tmp()
  const m = await member(dir)
  const env = { CKN_MEMBER: 'crew1' }
  const payload = { session_id: 's1', session_title: 'crew1' }

  const start = (await handle(payload, ctx(dir), 'SessionStart', () => m, env)) as { additionalContext: string }
  assert.match(start.additionalContext, /start a Monitor with command ".*cortex-role\.ts watch" and timeout_ms 1800000/)
  assert.equal(await handle(payload, ctx(dir), 'UserPromptSubmit', () => m, env), undefined, 'not repeated at the first prompt')

  const now = Date.now()
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: now, beatAt: now })
  assert.equal(await handle(payload, ctx(dir), 'UserPromptSubmit', () => m, env), undefined, 'live: nothing to say')

  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: now, beatAt: now, endedAt: now })
  const lapsed = (await handle(payload, ctx(dir), 'UserPromptSubmit', () => m, env)) as { additionalContext: string }
  assert.match(lapsed.additionalContext, /your watcher stopped at/)
  assert.equal(await handle(payload, ctx(dir), 'UserPromptSubmit', () => m, env), undefined, 'once per lapse')
})

test('a headless run is never told to arm a watcher', async () => {
  const dir = tmp()
  const m = await member(dir)
  const out = await handle({ session_id: 's1', session_title: 'crew1' }, ctx(dir), 'SessionStart', () => m, {
    CKN_MEMBER: 'crew1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
  })
  assert.equal(out, undefined)
})

test('the watch command records itself live, and records the end when it is stopped', async () => {
  const { env, root } = isolatedEnv()
  dirs.push(root)
  const state = env.CKN_STATE_DIR!
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-role.ts'), 'watch', '--as', 'crew1'], {
    env,
    stdio: 'ignore',
  })
  const f = path.join(state, 'data', 'comms', 'watch', 'crew1.json')
  const deadline = Date.now() + 20_000
  while (!fs.existsSync(f) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.ok(fs.existsSync(f), 'started')
  assert.equal(watchStatus(path.join(state, 'data', 'comms'), 'crew1').kind, 'live')

  const exited = new Promise((r) => child.on('exit', r))
  child.kill('SIGTERM')
  await exited
  assert.equal(watchStatus(path.join(state, 'data', 'comms'), 'crew1').kind, 'lapsed')
})

test('a mid-session join tells the session to arm the watcher in the same turn', () => {
  const { env, root } = isolatedEnv({ CKN_COMMS_TRANSPORT: 'mesh', CLAUDE_CODE_SESSION_ID: 'sess-join' })
  dirs.push(root)
  const run = (...args: string[]) =>
    spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-role.ts'), ...args], { env, encoding: 'utf-8' })
  const r = run('join', 'general', '--as', 'laptop-sesh-2', '--create')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Do this now: To receive messages as they arrive, start a Monitor with command ".*cortex-role\.ts watch"/)
})

test('join creates a missing role without --create, and says which happened', () => {
  const { env, root } = isolatedEnv({ CKN_COMMS_TRANSPORT: 'mesh' })
  dirs.push(root)
  const run = (sid: string, ...args: string[]) =>
    spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-role.ts'), ...args], {
      // Two sessions on one machine: their own state dirs, one node id and one mesh log.
      env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CKN_STATE_DIR: path.join(root, sid), CKN_MESH_DIR: path.join(root, 'mesh'), CKN_MACHINE: 'one-node' },
      encoding: 'utf-8',
    })
  const first = run('s1', 'join', 'docs', '--as', 'docs-dev')
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /created role docs \(it did not exist\) and joined as docs-dev/)
  const second = run('s2', 'join', 'docs')
  assert.match(second.stdout, /^joined role docs as docs-1/m)
})

test('STOP: a member with no live watcher cannot end the turn; the hold is bounded per lapse; a live watcher passes', async () => {
  const dir = tmp()
  const { local } = await member(dir)
  const open = () => ({ local })
  const stop = () => handleStop({ session_id: 's1' }, ctx(dir), open, {}, 0)

  // The expiry case: the watch ended (the Monitor window closed) and the woken session declines to re-arm.
  const t0 = Date.now()
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: t0 - 60_000, beatAt: t0 - 1000, endedAt: t0 - 500 })
  for (let i = 0; i < STOP_BLOCKS_PER_LAPSE; i++) {
    const r = (await stop()) as { decision: string; reason: string }
    assert.equal(r.decision, 'deny', `held ${i + 1}`)
    assert.match(r.reason, /crew1 has no live watcher since .*Re-arm it now.*never unreachable.*watch" and timeout_ms 1800000/)
  }
  assert.equal(await stop(), undefined, 'bounded: a session that cannot run Monitor is not looped')

  // Re-armed: the turn ends normally.
  recordWatch(dir, { member: 'crew1', pid: 2, startedAt: Date.now(), beatAt: Date.now() })
  assert.equal(await stop(), undefined)

  // The next lapse is held again.
  recordWatch(dir, { member: 'crew1', pid: 2, startedAt: Date.now(), beatAt: Date.now(), endedAt: Date.now() + 1 })
  assert.equal(((await stop()) as { decision: string }).decision, 'deny')
})

test('STOP: a watcher that starts during the grace counts as live; non-members, subagents and headless runs are never held', async () => {
  const dir = tmp()
  const { local } = await member(dir)
  const open = () => ({ local })
  setTimeout(() => recordWatch(dir, { member: 'crew1', pid: 3, startedAt: Date.now(), beatAt: Date.now() }), 300)
  assert.equal(await handleStop({ session_id: 's1' }, ctx(dir), open, {}, 2_000), undefined, 'the Monitor started late in the turn')

  const other = tmp()
  const o = await member(other)
  assert.equal(await handleStop({ session_id: 'not-a-member' }, ctx(other), () => ({ local: o.local }), {}, 0), undefined)
  assert.equal(await handleStop({ session_id: 's1', agent_id: 'sub' }, ctx(other), () => ({ local: o.local }), {}, 0), undefined)
  assert.equal(await handleStop({ session_id: 's1' }, ctx(other), () => ({ local: o.local }), { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, 0), undefined)
})

test('a routed send says when nobody at the address is listening, and says nothing when someone is', async () => {
  const { notListening } = await import('../server/comms.js')
  const roles = [
    { role: 'cortex-dev', members: [{ name: 'cortex-dev-1' }] },
    { role: 'pm', members: [{ name: 'pm', live: true as const }] },
  ]
  assert.match(notListening(roles, { kind: 'role', role: 'cortex-dev' }), /no member of cortex-dev is listening now, so it waits until one is back/)
  assert.match(notListening(roles, { kind: 'member', role: 'cortex-dev', member: 'cortex-dev-1' }), /cortex-dev-1 is not listening now/)
  assert.match(notListening(roles, { kind: 'role', role: 'cortex-dev-1' }), /cortex-dev-1 is not listening now/, 'a bare member name')
  assert.equal(notListening(roles, { kind: 'role', role: 'pm' }), '')
  assert.equal(notListening(roles, { kind: 'member', role: 'pm', member: 'pm' }), '')
})

test('STOP: with its default grace, the hold is decided inside the dispatcher budget (1750 ms), or it would be cut off', async () => {
  const dir = tmp()
  const { local } = await member(dir)
  const t0 = Date.now()
  const r = (await handleStop({ session_id: 's1' }, ctx(dir), () => ({ local }), {})) as { decision: string }
  assert.equal(r.decision, 'deny')
  assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0} ms`)
})

test('STOP: a seen message that awaits an answer elsewhere holds the turn once per key, and never once answered', async () => {
  const dir = tmp()
  const m = await member(dir)
  await m.comms.join('svc', { create: true, as: 'svc1' })
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: Date.now(), beatAt: Date.now() })
  const stop = () => handleStop({ session_id: 's1' }, ctx(dir), () => m, {}, 0)
  const how = 'answer on Telegram with: cortex-telegram send --reply-to 7 (text on stdin)'
  await m.comms.send('svc1', 'crew', 'operator message 7 is yours', { awaits: { key: 'telegram:7', how } })
  await m.comms.send('svc1', 'crew', 'operator message 8 is yours', { awaits: { key: 'telegram:8', how: 'reply 8' } })

  assert.equal(await stop(), undefined, 'not yet shown to the session: nothing owed')
  const items = await m.comms.inbox('crew1')
  assert.equal(items[0]!.awaits?.key, 'telegram:7')
  m.comms.markSeen('crew1', [items[0]!.id])
  const r = (await stop()) as { decision: string; reason: string }
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /answer is still expected.*reminded once.*\n- from svc\/svc1: answer on Telegram with: cortex-telegram send --reply-to 7/s)
  assert.doesNotMatch(r.reason, /reply 8/, 'only what the session has seen')
  assert.equal(await stop(), undefined, 'once, never a second hold')

  m.local.markAwait('crew1', 'telegram:8', 'answered')
  m.comms.markSeen('crew1', [items[1]!.id])
  assert.equal(await stop(), undefined, 'answered before Stop: no reminder')
  m.local.markAwait('crew1', 'telegram:8', 'reminded')
  assert.deepEqual(m.local.awaits('crew1'), { 'telegram:7': 'reminded', 'telegram:8': 'answered' }, 'answered is final')
})
