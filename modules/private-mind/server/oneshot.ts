/**
 * Private mind without a long-running host (the hub, a desktop PC, 2 Nov): session hooks start a
 * one-shot `cortex-mind sync` that runs a round, takes the answers and exits. These are the files
 * that keep it to one at a time, say when one is due, and step aside where a host runs the sync.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Set in the one-shot's own process: private mind starts without timers. */
export const ONESHOT_ENV = 'CKN_MIND_ONESHOT'

const LOCK = 'sync.lock'
const LAST = 'last-sync-start'
const HOST = 'host.pid'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const pidIn = (file: string): number | undefined => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf-8').trim())
    return pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Take the one-shot lock; false when a live one-shot holds it. A dead holder's lock is taken over. */
export const takeLock = (dir: string, pid = process.pid): boolean => {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, LOCK)
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' })
      return true
    } catch {
      const holder = pidIn(file)
      if (holder && alive(holder)) return false
      fs.rmSync(file, { force: true })
    }
  }
  return false
}

export const releaseLock = (dir: string, pid = process.pid): void => {
  const file = path.join(dir, LOCK)
  if (pidIn(file) === pid) fs.rmSync(file, { force: true })
}

export const lockHeld = (dir: string): boolean => {
  const holder = pidIn(path.join(dir, LOCK))
  return holder !== undefined && alive(holder)
}

/** A long-running host runs private mind on this node: it marks itself, and hooks leave the sync to it. */
export const markHost = (dir: string, pid = process.pid): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, HOST), String(pid))
}
export const unmarkHost = (dir: string, pid = process.pid): void => {
  if (pidIn(path.join(dir, HOST)) === pid) fs.rmSync(path.join(dir, HOST), { force: true })
}
export const hostRunning = (dir: string): boolean => {
  const pid = pidIn(path.join(dir, HOST))
  return pid !== undefined && alive(pid)
}

export const noteStart = (dir: string, at = Date.now()): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, LAST), String(at))
}

/** Session start and end always sync; a prompt does when the last one-shot began syncEveryMin ago or more. */
export const due = (dir: string, event: string | undefined, everyMin: number, now = Date.now()): boolean => {
  if (event !== 'UserPromptSubmit') return true
  let last = 0
  try {
    last = Number(fs.readFileSync(path.join(dir, LAST), 'utf-8')) || 0
  } catch {
    /* never ran */
  }
  return now - last >= everyMin * 60_000
}
