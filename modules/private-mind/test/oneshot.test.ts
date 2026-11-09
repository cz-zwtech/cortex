/**
 * The one-shot sync's hook and its files: when a session starts one, when it does not, and that
 * two never run at once.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { handle } from '../server/on-session-sync.js'
import { due, hostRunning, lockHeld, markHost, noteStart, releaseLock, takeLock, unmarkHost } from '../server/oneshot.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-oneshot-'))
  dirs.push(d)
  return d
}
const mind = (dir: string, cfg: object) => fs.writeFileSync(path.join(dir, 'mind.json'), JSON.stringify(cfg))
const env = { CKN_MACHINE: 'node-a' } as NodeJS.ProcessEnv
const quiet = { log: () => {} }

test('one at a time: a live holder keeps the lock, a dead one loses it', async () => {
  const dir = tmp()
  assert.equal(takeLock(dir), true)
  assert.equal(takeLock(dir), false, 'this process holds it')
  assert.equal(lockHeld(dir), true)
  releaseLock(dir)
  assert.equal(lockHeld(dir), false)
  const gone = spawn(process.execPath, ['-e', '0'])
  await new Promise((r) => gone.on('exit', r))
  assert.equal(takeLock(dir, gone.pid!), true)
  assert.equal(takeLock(dir), true, 'a dead holder\'s lock is taken over')
  releaseLock(dir)
})

test('a prompt is due after syncEveryMin; session start and end always are', () => {
  const dir = tmp()
  const t = 1_000_000_000
  assert.equal(due(dir, 'UserPromptSubmit', 15, t), true, 'never ran')
  noteStart(dir, t)
  assert.equal(due(dir, 'UserPromptSubmit', 15, t + 14 * 60_000), false)
  assert.equal(due(dir, 'UserPromptSubmit', 15, t + 15 * 60_000), true)
  assert.equal(due(dir, 'SessionStart', 15, t + 1), true)
  assert.equal(due(dir, 'SessionEnd', 15, t + 1), true)
})

test('the hook starts a one-shot on an enabled node, and only there', () => {
  const dir = tmp()
  let runs = 0
  const run = () => void runs++
  assert.equal(handle({ hook_event_name: 'SessionStart' }, { dataDir: dir, ...quiet }, env, run), undefined, 'no mind.json')
  mind(dir, { central: 'node-b', enabled: false })
  assert.equal(handle({ hook_event_name: 'SessionStart' }, { dataDir: dir, ...quiet }, env, run), undefined, 'not enabled')
  mind(dir, { central: 'node-a', enabled: true })
  assert.equal(handle({ hook_event_name: 'SessionStart' }, { dataDir: dir, ...quiet }, env, run), undefined, 'central: its host serves')
  mind(dir, { central: 'node-b', enabled: true })
  assert.equal(handle({ hook_event_name: 'SessionStart' }, { dataDir: dir, ...quiet }, env, run), 'started')
  assert.equal(handle({ hook_event_name: 'UserPromptSubmit' }, { dataDir: dir, ...quiet }, env, run), undefined, 'a prompt right after: not due')
  assert.equal(handle({ hook_event_name: 'SessionEnd' }, { dataDir: dir, ...quiet }, env, run), 'started', 'session end always')
  assert.equal(runs, 2)
})

test('the hook steps aside for a subagent, a headless run, CKN_MIND_AUTOSYNC=0, a running one-shot and a host', () => {
  const dir = tmp()
  mind(dir, { central: 'node-b', enabled: true })
  let runs = 0
  const run = () => void runs++
  const at = (payload: object, e = env) => handle({ hook_event_name: 'SessionStart', ...payload }, { dataDir: dir, ...quiet }, e, run)
  assert.equal(at({ agent_id: 'sub-1' }), undefined)
  assert.equal(at({}, { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), undefined)
  assert.equal(at({}, { ...env, CKN_MIND_AUTOSYNC: '0' }), undefined)
  takeLock(dir)
  assert.equal(at({}), undefined, 'one already running')
  releaseLock(dir)
  markHost(dir)
  assert.equal(hostRunning(dir), true)
  assert.equal(at({}), undefined, 'a host runs the sync here')
  unmarkHost(dir)
  assert.equal(at({}), 'started')
  assert.equal(runs, 1)
})
