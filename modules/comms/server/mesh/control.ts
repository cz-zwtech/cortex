/**
 * Start, stop and status for the daemon, from any process.
 *
 * start is idempotent: a live pid with a fresh status file means running.
 * stop releases everything: the daemon process, its port and its handles,
 * plus the systemd user unit when the unit runs that daemon, so a machine
 * with no sessions open (a desktop used for gaming) has no Cortex process left.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { underTest } from '../../../../core/paths.js'

import { DEFAULT_PORT, LIVE_MS, pidFile, releasePid, statusFile, type Status } from './daemon.js'
import { effectiveNodeConfig } from './nodeConfig.js'

export const meshPort = (dir: string, env: NodeJS.ProcessEnv = process.env) => effectiveNodeConfig(dir, env).port ?? DEFAULT_PORT

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
export const UNIT = 'cortex-mesh.service'
/** The exit when another live instance holds this node's id: the unit does not restart it. */
export const EXIT_CONFLICT = 78
/** The exit when another daemon already serves this dir on this machine: the unit does not restart it either. */
export const EXIT_LOCKED = 79

/** What systemd says of the user unit. Only `enabled` makes the unit the daemon's owner. */
export type UnitState = 'enabled' | 'disabled' | 'masked' | 'absent'

/** The user unit, as control sees it; tests pass their own. */
export type Systemd = {
  /** The mesh dir the unit serves: its ExecStart runs serve with no overrides. */
  dir: string
  state: () => UnitState
  start: () => { ok: true } | { ok: false; error: string }
  /** The unit's main process while it is active. */
  mainPid: () => number | undefined
}

// A timeout: the watch loop asks once a minute, and a user manager in a bad state must not hang it.
const systemctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf-8', timeout: 5_000 })

export const systemd: Systemd = {
  dir: path.join(os.homedir(), '.config', 'ckn', 'data', 'mesh'),
  state: () => {
    // A test never drives the real user manager, whatever this machine runs.
    if (underTest()) return 'absent'
    const out = (systemctl('is-enabled', UNIT).stdout ?? '').trim()
    if (out === 'enabled' || out === 'enabled-runtime') return 'enabled'
    if (out.startsWith('masked')) return 'masked'
    return out ? 'disabled' : 'absent'
  },
  start: () => {
    const r = systemctl('start', UNIT)
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim() }
  },
  mainPid: () => {
    const pid = Number((systemctl('show', '-p', 'MainPID', '--value', UNIT).stdout ?? '').trim())
    return pid > 0 ? pid : undefined
  },
}

/** The unit's state when it serves this dir; any other dir (a test's, a second checkout's) has none. */
export const unitFor = (dir: string, sd: Systemd = systemd): UnitState => (path.resolve(dir) === path.resolve(sd.dir) ? sd.state() : 'absent')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const readStatus = (dir: string): Status | undefined => {
  try {
    return JSON.parse(fs.readFileSync(statusFile(dir), 'utf-8')) as Status
  } catch {
    return undefined
  }
}

export const runningPid = (dir: string, sd: Systemd = systemd): number | undefined => {
  try {
    const pid = Number(fs.readFileSync(pidFile(dir), 'utf-8'))
    if (pid && alive(pid)) return pid
  } catch {
    /* no pid file: the unit may still run it */
  }
  // A unit daemon whose pid file went (a refused second start removed it) is still running.
  if (unitFor(dir, sd) !== 'enabled') return undefined
  const main = sd.mainPid()
  return main && alive(main) ? main : undefined
}

export const isRunning = (dir: string, sd: Systemd = systemd): boolean => {
  const s = readStatus(dir)
  return Boolean(runningPid(dir, sd) && s?.running && Date.now() - s.updatedAt < 3 * LIVE_MS + 30_000)
}

export type StartResult = 'already' | 'started' | 'failed' | 'unit-masked' | 'no-user-manager'

/**
 * Start the daemon unless it runs. Returns at once; `wait` polls for the status file. When the unit
 * is enabled it owns the daemon: start the unit, never a process beside it, which would race the
 * unit and leave one of the two refused by the mesh.
 */
export const start = async (dir: string, opts: { wait?: boolean } = {}, sd: Systemd = systemd): Promise<StartResult> => {
  if (isRunning(dir, sd)) return 'already'
  const unit = unitFor(dir, sd)
  if (unit === 'masked') return 'unit-masked'
  if (unit === 'enabled') {
    // No spawn when the user manager is down: the unit would start beside it at the next login.
    if (!sd.start().ok) return 'no-user-manager'
  } else {
    fs.mkdirSync(dir, { recursive: true })
    const out = fs.openSync(path.join(dir, 'daemon.log'), 'a')
    const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-mesh.ts'), 'serve'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
  }
  if (!opts.wait) return 'started'
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (isRunning(dir, sd)) return 'started'
  }
  return 'failed'
}

/** Why a start did not bring the daemon up, for a person to act on. */
export const startProblem = (r: StartResult, dir: string): string | undefined =>
  r === 'unit-masked'
    ? `${UNIT} is masked, so nothing was started (systemctl --user unmask ${UNIT})`
    : r === 'no-user-manager'
      ? `${UNIT} is enabled but the user manager is not running: enable linger (loginctl enable-linger) or log in`
      : r === 'failed'
        ? `the daemon did not come up; see ${path.join(dir, 'daemon.log')}`
        : undefined

export const systemdUnitActive = (): boolean =>
  spawnSync('systemctl', ['--user', 'is-active', '--quiet', UNIT]).status === 0

/**
 * Whether the systemd unit runs this process: its cgroup names the unit. Off Linux, or with no
 * such process, never.
 */
export const ownedByUnit = (pid: number, readCgroup = (p: number) => fs.readFileSync(`/proc/${p}/cgroup`, 'utf-8')): boolean => {
  try {
    return readCgroup(pid).split('\n').some((line) => line.endsWith(`/${UNIT}`))
  } catch {
    return false
  }
}

/**
 * Stop the daemon of this dir. When the systemd unit runs it, stop the unit, or systemd would count
 * the exit as the unit's. Only then: a daemon in some other dir (a test's, a second checkout's) on a
 * machine whose unit runs the live one must never stop the live one.
 */
export const stop = async (dir: string): Promise<'stopped' | 'not-running'> => {
  let did = false
  const unitPid = runningPid(dir)
  if (unitPid && ownedByUnit(unitPid) && systemdUnitActive()) {
    spawnSync('systemctl', ['--user', 'stop', UNIT])
    did = true
  }
  const pid = runningPid(dir)
  if (pid) {
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100))
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    did = true
  }
  if (pid) releasePid(dir, pid)
  return did ? 'stopped' : 'not-running'
}

/** A systemd user unit for an always-on machine (home). Printed, never installed silently. */
export const unitText = (): string =>
  [
    '[Unit]',
    'Description=Cortex mesh daemon',
    '',
    '[Service]',
    `ExecStart=${path.join(REPO, 'node_modules', '.bin', 'tsx')} ${path.join(REPO, 'bin', 'cortex-mesh.ts')} serve`,
    'Restart=on-failure',
    `RestartPreventExitStatus=${EXIT_CONFLICT} ${EXIT_LOCKED}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')

