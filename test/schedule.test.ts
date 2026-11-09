import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { declaredJobs, isDue, isIdle, IDLE_MINUTES } from '../core/schedule.js'
import { isolatedEnv } from './isolatedEnv.js'

const REPO = path.resolve(import.meta.dirname, '..')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

test('jobs are due by interval, and idle means no transcript written lately but the one excepted', () => {
  const { root } = isolatedEnv()
  dirs.push(root)
  const job = { module: 'm', dir: root, name: 'j', everyHours: 24, command: ['x.ts'], idle: true, timeoutMinutes: 1 }
  assert.ok(isDue(job, { jobs: {} }, 1_000))
  assert.ok(!isDue(job, { jobs: { 'm/j': { lastRun: 0 } } }, 3_600_000))
  assert.ok(isDue(job, { jobs: { 'm/j': { lastRun: 0 } } }, 24 * 3_600_000))

  const projects = path.join(root, 'projects', 'p')
  fs.mkdirSync(projects, { recursive: true })
  const live = path.join(projects, 'live.jsonl')
  fs.writeFileSync(live, '{}\n')
  const now = Date.now()
  assert.equal(isIdle(path.join(root, 'projects'), now), false)
  assert.equal(isIdle(path.join(root, 'projects'), now, live), true, 'the starting session does not count')
  const old = new Date(now - (IDLE_MINUTES + 5) * 60_000)
  fs.utimesSync(live, old, old)
  assert.equal(isIdle(path.join(root, 'projects'), now), true)
})

test('run-due runs what installed modules declare, records the outcome, and not again until due', () => {
  const { env, root } = isolatedEnv()
  dirs.push(root)
  const mods = path.join(root, 'mods')
  fs.mkdirSync(path.join(mods, 'demo'), { recursive: true })
  const marker = path.join(root, 'ran.txt')
  fs.writeFileSync(path.join(mods, 'demo', 'job.ts'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'x'); console.log('did it')\n`)
  fs.writeFileSync(path.join(mods, 'demo', 'module.json'), JSON.stringify({ name: 'demo', schedule: [{ name: 'tick', everyHours: 24, command: ['job.ts'], idle: false }] }))
  assert.deepEqual(declaredJobs(mods).map((j) => `${j.module}/${j.name}`), ['demo/tick'])
  const run = () => spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-schedule.ts'), 'run-due'], { env: { ...env, CKN_MODULES_DIR: mods }, encoding: 'utf-8' })
  assert.match(run().stdout, /demo\/tick: ok/)
  run()
  assert.equal(fs.readFileSync(marker, 'utf-8'), 'x', 'ran once: not due again within 24 h')
  const status = spawnSync(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-schedule.ts'), 'status'], { env: { ...env, CKN_MODULES_DIR: mods }, encoding: 'utf-8' }).stdout
  assert.match(status, /demo\/tick {2}every 24 h; last .* ok/)
})
