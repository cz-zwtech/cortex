/**
 * Which watcher lapses hold a Stop (handleStop, stopShouldHold), the stand-down
 * that lifts the hold, and how the reminders say a watcher ended.
 */
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
import { lapseText, LAPSE_GRACE_MS, recordPrompt, recordStandDown, recordWatch, STAND_DOWN_MS, STOP_BLOCKS_PER_LAPSE, standDown, watchStatus } from '../server/watchState.js'
import { isolatedEnv } from '../../../test/isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx')
const ROLE = path.join(REPO, 'bin', 'cortex-role.ts')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-stop-'))
  dirs.push(d)
  return d
}
const ctx = (dir: string) => ({ name: 'comms', dir, dataDir: dir, log: () => {} }) as never

const member = async (dir: string) => {
  const local = new LocalIdentity(dir)
  const comms = new Comms(new MemoryTransport(), local)
  await comms.join('crew', { create: true, as: 'crew1' })
  local.bindSession('s1', 'crew1')
  return { local, comms }
}

type Held = { decision?: string; reason?: string } | undefined
const rig = async () => {
  const dir = tmp()
  const { local } = await member(dir)
  const stop = (session = 's1') => handleStop({ session_id: session }, ctx(dir), () => ({ local }), {}, 0) as Promise<Held>
  const lapse = (at: number, endedBy?: 'window' | 'signal') =>
    recordWatch(dir, { member: 'crew1', pid: 1, startedAt: at - 60_000, beatAt: at, endedAt: at, ...(endedBy ? { endedBy } : {}) })
  return { dir, local, stop, lapse }
}

test('a watcher that lapsed during the turn is not held for: the Monitor notice and the next prompt cover it', async () => {
  const { dir, stop, lapse } = await rig()
  const now = Date.now()
  recordPrompt(dir, 'crew1', now - 20_000)
  lapse(now - 10_000, 'window')
  assert.equal(await stop(), undefined)
})

test('with no recorded prompt, a fresh lapse is not held for', async () => {
  const { stop, lapse } = await rig()
  lapse(Date.now() - 5_000, 'window')
  assert.equal(await stop(), undefined)
})

test('a watcher already down at the prompt and still down is held, once per lapse up to the cap, as a reminder', async () => {
  const { dir, stop, lapse } = await rig()
  const now = Date.now()
  lapse(now - 20_000, 'window')
  recordPrompt(dir, 'crew1', now - 10_000)
  for (let i = 0; i < STOP_BLOCKS_PER_LAPSE; i++) {
    const r = await stop()
    assert.equal(r?.decision, 'deny', `held ${i + 1}`)
    assert.match(r!.reason!, /^Cortex reminder \(not an error\): re-arm your watcher\. crew1 has no live watcher since .*Re-arm it now/)
  }
  assert.equal(await stop(), undefined, 'the cap')
})

test('a lapse older than the grace is held even after the last prompt; a 30 s one is not', async () => {
  const { dir, stop, lapse } = await rig()
  const now = Date.now()
  assert.equal(LAPSE_GRACE_MS, 2 * 60_000)
  recordPrompt(dir, 'crew1', now - 4 * 60_000)
  lapse(now - 3 * 60_000, 'window')
  assert.equal((await stop())?.decision, 'deny', 'a notice that arrived mid-turn and was ignored')

  const fresh = await rig()
  recordPrompt(fresh.dir, 'crew1', now - 60_000)
  fresh.lapse(now - 30_000, 'window')
  assert.equal(await fresh.stop(), undefined, 'the routine expiry just before the turn ends')
})

test('a silent death whose last beat came 10 s before the prompt is not taken as down before it', async () => {
  const { dir, stop } = await rig()
  const now = Date.now()
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: now - 5 * 60_000, beatAt: now - 70_000 })
  recordPrompt(dir, 'crew1', now - 60_000)
  assert.equal(await stop(), undefined, 'it may have been alive at the prompt')
  recordPrompt(dir, 'crew1', now - 50_000)
  assert.equal((await stop())?.decision, 'deny', 'more than a beat after the last one: down before the prompt')
})

test('a member that never armed a watcher is held once per session', async () => {
  const { local, stop } = await rig()
  local.bindSession('s2', 'crew1')
  assert.equal((await stop())?.decision, 'deny')
  for (let i = 1; i < STOP_BLOCKS_PER_LAPSE; i++) await stop()
  assert.equal(await stop(), undefined, 'not again in this session')
  assert.equal((await stop('s2'))?.decision, 'deny', 'another session is held')
})

test('a stand-down within ten minutes lifts the hold; an older one does not', async () => {
  const { dir, stop, lapse } = await rig()
  const now = Date.now()
  lapse(now - 20_000, 'signal')
  recordPrompt(dir, 'crew1', now - 10_000)
  recordStandDown(dir, { member: 'crew1', sessionId: 'sess-a', at: now - 60_000 })
  assert.equal(await stop(), undefined)
  recordStandDown(dir, { member: 'crew1', sessionId: 'sess-a', at: now - STAND_DOWN_MS - 1_000 })
  assert.equal((await stop())?.decision, 'deny')
})

test('the prompt reminder says whether the watch was stood down, stopped, or its window ended', async () => {
  const dir = tmp()
  const m = await member(dir)
  const env = { CKN_MEMBER: 'crew1' }
  const prompt = async () =>
    ((await handle({ session_id: 's1', session_title: 'crew1' }, ctx(dir), 'UserPromptSubmit', () => m, env)) as { additionalContext?: string } | undefined)
      ?.additionalContext ?? ''
  const t = Date.UTC(2026, 0, 2, 3, 4)
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: t - 60_000, beatAt: t, endedAt: t, endedBy: 'window' })
  assert.match(await prompt(), /your watcher's window ended at 03:04Z, so messages arrive only at prompts/)
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: t - 60_000, beatAt: t, endedAt: t + 60_000, endedBy: 'signal' })
  assert.match(await prompt(), /your watcher stopped at 03:05Z/)
  recordStandDown(dir, { member: 'crew1', sessionId: 'sess-a', at: t + 120_000 })
  recordWatch(dir, { member: 'crew1', pid: 1, startedAt: t - 60_000, beatAt: t, endedAt: t + 180_000, endedBy: 'signal' })
  assert.match(await prompt(), /your watcher was stood down at 03:06Z by sess-a/)
  const start = (await handle({ session_id: 's3', session_title: 'crew1' }, ctx(dir), 'SessionStart', () => m, env)) as { additionalContext: string }
  assert.match(start.additionalContext, /Cortex comms: your watcher was stood down at 03:06Z by sess-a, more than ten minutes ago\. To receive messages/)
})

test('a stand-down past its ten minutes says so', () => {
  const dir = tmp()
  const t = Date.UTC(2026, 0, 2, 3, 4)
  const status = { kind: 'lapsed', at: t, endedBy: 'signal' } as const
  recordStandDown(dir, { member: 'crew1', sessionId: 'sess-a', at: t })
  assert.equal(lapseText(dir, 'crew1', status, t + 60_000), 'your watcher was stood down at 03:04Z by sess-a')
  assert.equal(lapseText(dir, 'crew1', status, t + STAND_DOWN_MS + 1), 'your watcher was stood down at 03:04Z by sess-a, more than ten minutes ago')
})

test('the watch records a signal end and a window end; standdown is recorded and a new watch clears it', async () => {
  const { env, root } = isolatedEnv({ CLAUDE_CODE_SESSION_ID: 'sess-b' })
  dirs.push(root)
  const commsDir = path.join(env.CKN_STATE_DIR!, 'data', 'comms')
  const f = path.join(commsDir, 'watch', 'crew1.json')
  const ended = () => JSON.parse(fs.readFileSync(f, 'utf-8')).endedBy as string | undefined

  const sd = spawnSync(TSX, [ROLE, 'standdown', '--as', 'crew1'], { env, encoding: 'utf-8' })
  assert.equal(sd.status, 0, sd.stderr)
  assert.match(sd.stdout, /stood down; stop your watcher Monitor now \(TaskStop\)/)
  assert.equal(standDown(commsDir, 'crew1')?.sessionId, 'sess-b')

  const child = spawn(TSX, [ROLE, 'watch', '--as', 'crew1'], { env, stdio: 'ignore' })
  const deadline = Date.now() + 20_000
  while (!fs.existsSync(f) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.equal(watchStatus(commsDir, 'crew1').kind, 'live')
  assert.equal(standDown(commsDir, 'crew1'), null, 'a new watch clears the stand-down')
  const exited = new Promise((r) => child.on('exit', r))
  child.kill('SIGTERM')
  await exited
  assert.equal(ended(), 'signal')

  const w = spawnSync(TSX, [ROLE, 'watch', '--as', 'crew1'], { env: { ...env, CKN_WATCH_WINDOW_MS: '500' }, encoding: 'utf-8', timeout: 30_000 })
  assert.match(w.stdout, /watch window ended/)
  assert.equal(ended(), 'window')
})
