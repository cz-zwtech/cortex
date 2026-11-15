import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { isRunning, runningPid, start, startProblem, unitFor, type Systemd, type UnitState } from '../../server/mesh/control.js'
import { acquirePid, pidFile, releasePid } from '../../server/mesh/daemon.js'
import { tmp } from './harness.js'

// One daemon per mesh dir, and on a machine with the unit enabled, the unit's. A second one beside
// it is refused by the mesh, and its exit took the pid file, so status no longer saw the survivor.

const DEAD = 2 ** 22 + 12_345 // above any pid_max a test machine runs with
const serving = () => true

const fakeUnit = (dir: string, state: UnitState, opts: { startOk?: boolean; mainPid?: number } = {}) => {
  const calls: string[] = []
  const sd: Systemd = {
    dir,
    state: () => state,
    start: () => (calls.push('start'), opts.startOk === false ? { ok: false, error: 'Failed to connect to bus' } : { ok: true }),
    mainPid: () => opts.mainPid,
  }
  return { sd, calls }
}

test('of two daemons taking one dir, the first holds it and the second is told who', () => {
  const dir = tmp()
  assert.deepEqual(acquirePid(dir, process.pid, serving), { ok: true })
  assert.deepEqual(acquirePid(dir, process.ppid, serving), { ok: false, holder: process.pid })
  assert.equal(fs.readFileSync(pidFile(dir), 'utf-8'), String(process.pid), 'the holder keeps its file')
})

test('a pid file naming a dead pid, or a pid reused by something else, is taken over', () => {
  const dir = tmp()
  fs.writeFileSync(pidFile(dir), String(DEAD))
  assert.deepEqual(acquirePid(dir, process.pid, serving), { ok: true })
  assert.equal(fs.readFileSync(pidFile(dir), 'utf-8'), String(process.pid))
  fs.writeFileSync(pidFile(dir), String(process.ppid)) // alive, but no mesh daemon
  assert.deepEqual(acquirePid(dir, process.pid, () => false), { ok: true })
})

test('a daemon removes the pid file only while it names that daemon', () => {
  const dir = tmp()
  fs.writeFileSync(pidFile(dir), String(process.ppid))
  releasePid(dir, process.pid)
  assert.equal(fs.readFileSync(pidFile(dir), 'utf-8'), String(process.ppid), 'another daemon\'s file stays')
  releasePid(dir, process.ppid)
  assert.equal(fs.existsSync(pidFile(dir)), false)
})

test('with the unit enabled, start starts the unit and spawns nothing beside it', async () => {
  const dir = tmp()
  const { sd, calls } = fakeUnit(dir, 'enabled')
  assert.equal(await start(dir, {}, sd), 'started')
  assert.deepEqual(calls, ['start'])
  assert.equal(fs.existsSync(path.join(dir, 'daemon.log')), false, 'no detached daemon was spawned')
})

test('a masked unit starts nothing; a unit the user manager cannot start is reported, with no spawn', async () => {
  const masked = tmp()
  assert.equal(await start(masked, {}, fakeUnit(masked, 'masked').sd), 'unit-masked')
  assert.match(startProblem('unit-masked', masked)!, /masked/)
  const down = tmp()
  assert.equal(await start(down, {}, fakeUnit(down, 'enabled', { startOk: false }).sd), 'no-user-manager')
  assert.match(startProblem('no-user-manager', down)!, /linger/)
  assert.equal(fs.existsSync(path.join(down, 'daemon.log')), false, 'it waits for the unit rather than racing it')
})

test('the unit serves only its own dir: any other dir has no unit, so it is started directly as before', () => {
  const unitDir = tmp()
  const { sd } = fakeUnit(unitDir, 'enabled')
  assert.equal(unitFor(unitDir, sd), 'enabled')
  assert.equal(unitFor(tmp(), sd), 'absent', 'a test\'s or a second checkout\'s dir is never refused for the unit\'s sake')
})

test('a unit daemon whose pid file is gone still counts as running', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ running: true, updatedAt: Date.now() }))
  assert.equal(runningPid(dir, fakeUnit(dir, 'disabled', { mainPid: process.pid }).sd), undefined)
  assert.equal(runningPid(dir, fakeUnit(dir, 'enabled', { mainPid: process.pid }).sd), process.pid)
  assert.equal(isRunning(dir, fakeUnit(dir, 'enabled', { mainPid: process.pid }).sd), true)
  assert.equal(isRunning(dir, fakeUnit(dir, 'enabled', { mainPid: DEAD }).sd), false)
})
