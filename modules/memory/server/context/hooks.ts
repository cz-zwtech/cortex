/**
 * The hook side of capture. Hooks do bounded work only: Stop captures this
 * session's own transcript for a few hundred milliseconds, and the session
 * edges hand the full catch-up to a detached `cortex-memory capture --all`,
 * which outlives the CLI (the SessionEnd lesson in on-session.ts).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { ModuleCtx } from '../../../../core/ctx.js'
import { underTest } from '../../../../core/paths.js'

export const contextStorePath = (dataDir: string) => path.join(dataDir, 'context.sqlite')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One catch-up at a time per user: a second start while one runs is a no-op. */
export const spawnCatchUp = (ctx: ModuleCtx, trigger: string): boolean => {
  if (underTest()) return false
  const lock = path.join(ctx.dataDir, 'capture.lock')
  try {
    const pid = Number(fs.readFileSync(lock, 'utf-8'))
    if (pid && alive(pid)) return false
  } catch {
    /* no lock */
  }
  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const out = fs.openSync(path.join(ctx.dataDir, 'capture-detached.log'), 'a')
    const child = spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'bin', 'cortex-memory.ts'), 'capture', '--all', '--trigger', trigger], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
    return true
  } catch (err) {
    ctx.log(`could not start the transcript catch-up (${err instanceof Error ? err.message : String(err)}); the next session start tries again`)
    return false
  }
}

/**
 * Where no systemd timer runs the scheduler (WSL, a laptop), the start of a
 * session does: at most every 6 hours, detached, and only jobs that are due
 * and idle-safe run. The starting session's own transcript does not count as
 * activity.
 */
export const spawnScheduleCheck = (ctx: ModuleCtx, transcript: string | undefined): boolean => {
  if (underTest()) return false
  try {
    const { checkedAt } = JSON.parse(fs.readFileSync(path.join(path.dirname(ctx.dataDir), 'schedule.json'), 'utf-8')) as { checkedAt?: number }
    if (checkedAt && Date.now() - checkedAt < 6 * 3_600_000) return false
  } catch {
    /* never checked */
  }
  try {
    const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const out = fs.openSync(path.join(ctx.dataDir, 'schedule-detached.log'), 'a')
    spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'bin', 'cortex-schedule.ts'), 'run-due', ...(transcript ? ['--except', transcript] : [])], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    }).unref()
    return true
  } catch {
    return false
  }
}
