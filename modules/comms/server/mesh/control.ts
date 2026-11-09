/**
 * Start, stop and status for the daemon, from any process.
 *
 * start is idempotent: a live pid with a fresh status file means running.
 * stop releases everything: the daemon process, its port and its handles,
 * plus the systemd user unit if one runs it, so a machine with no sessions
 * open (a desktop used for gaming) has no Cortex process left.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_PORT, LIVE_MS, pidFile, statusFile, type Status } from './daemon.js'
import { effectiveNodeConfig } from './nodeConfig.js'

export const meshPort = (dir: string, env: NodeJS.ProcessEnv = process.env) => effectiveNodeConfig(dir, env).port ?? DEFAULT_PORT

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
export const UNIT = 'cortex-mesh.service'

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

export const runningPid = (dir: string): number | undefined => {
  try {
    const pid = Number(fs.readFileSync(pidFile(dir), 'utf-8'))
    return pid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

export const isRunning = (dir: string): boolean => {
  const s = readStatus(dir)
  return Boolean(runningPid(dir) && s?.running && Date.now() - s.updatedAt < 3 * LIVE_MS + 30_000)
}

/** Start the daemon unless it runs. Returns at once; `wait` polls for the status file. */
export const start = async (dir: string, opts: { wait?: boolean } = {}): Promise<'already' | 'started' | 'failed'> => {
  if (isRunning(dir)) return 'already'
  fs.mkdirSync(dir, { recursive: true })
  const out = fs.openSync(path.join(dir, 'daemon.log'), 'a')
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [path.join(REPO, 'bin', 'cortex-mesh.ts'), 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  if (!opts.wait) return 'started'
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (isRunning(dir)) return 'started'
  }
  return 'failed'
}

export const systemdUnitActive = (): boolean =>
  spawnSync('systemctl', ['--user', 'is-active', '--quiet', UNIT]).status === 0

export const stop = async (dir: string): Promise<'stopped' | 'not-running'> => {
  let did = false
  if (systemdUnitActive()) {
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
  fs.rmSync(pidFile(dir), { force: true })
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
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
