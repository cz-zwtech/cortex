/**
 * The update lock. Lives in core because the dispatcher reads it before it
 * loads any module: while `cortex-update` swaps code and dependencies, a hook
 * that fires exits quietly instead of running half-updated files.
 */
import fs from 'node:fs'
import path from 'node:path'

export const lockPath = (stateDir: string) => path.join(stateDir, 'update.lock')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** True while another process is updating. A lock whose owner died is removed. */
export const updateInProgress = (stateDir: string): boolean => {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockPath(stateDir), 'utf-8')) as { pid: number }
    if (alive(pid)) return true
    fs.rmSync(lockPath(stateDir), { force: true })
  } catch {
    /* no lock */
  }
  return false
}
