/**
 * The core scheduler: background jobs that modules declare in their manifest
 * (`schedule`), run by `cortex-schedule run-due` from a nightly systemd user
 * timer and, where there is no timer, when a session starts.
 *
 * Idle-only jobs run when no session transcript has been written for a while
 * (the starting session's own transcript excepted), so they never compete
 * with someone working. Each job's last run, duration and outcome are kept in
 * `<dataRoot>/schedule.json`.
 */
import fs from 'node:fs'
import path from 'node:path'

export type JobSpec = { module: string; dir: string; name: string; everyHours: number; command: string[]; idle: boolean; timeoutMinutes: number }
export type JobState = { lastRun?: number; lastOk?: boolean; ms?: number; note?: string }
export type ScheduleState = { checkedAt?: number; jobs: Record<string, JobState> }

export const IDLE_MINUTES = 30

export const stateFile = (dataRoot: string) => path.join(dataRoot, 'schedule.json')

export const readState = (dataRoot: string): ScheduleState => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dataRoot), 'utf-8')) as ScheduleState
  } catch {
    return { jobs: {} }
  }
}

export const writeState = (dataRoot: string, s: ScheduleState): void => {
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(stateFile(dataRoot), JSON.stringify(s, null, 2))
}

/** Every job declared by an installed module. */
export const declaredJobs = (modulesDir: string): JobSpec[] => {
  const out: JobSpec[] = []
  let mods: string[] = []
  try {
    mods = fs.readdirSync(modulesDir)
  } catch {
    return out
  }
  for (const m of mods.sort()) {
    try {
      const dir = path.join(modulesDir, m)
      const man = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf-8')) as {
        name?: string
        schedule?: { name: string; everyHours: number; command: string[]; idle?: boolean; timeoutMinutes?: number }[]
      }
      for (const j of man.schedule ?? []) {
        out.push({ ...j, idle: j.idle ?? true, timeoutMinutes: j.timeoutMinutes ?? 60, module: man.name ?? m, dir: fs.realpathSync(dir) })
      }
    } catch {
      /* no manifest */
    }
  }
  return out
}

export const jobKey = (j: Pick<JobSpec, 'module' | 'name'>) => `${j.module}/${j.name}`

export const isDue = (j: JobSpec, s: ScheduleState, now: number): boolean => {
  const last = s.jobs[jobKey(j)]?.lastRun
  return last === undefined || now - last >= j.everyHours * 3_600_000
}

/** No session transcript written in the last IDLE_MINUTES, the given one excepted. */
export const isIdle = (projectsDir: string, now: number, except?: string): boolean => {
  const quietSince = now - IDLE_MINUTES * 60_000
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth > 0) {
        if (!walk(p, depth - 1)) return false
      } else if (e.name.endsWith('.jsonl') && p !== except) {
        try {
          if (fs.statSync(p).mtimeMs > quietSince) return false
        } catch {
          /* gone */
        }
      }
    }
    return true
  }
  return walk(projectsDir, 3)
}

/** The systemd user units for the nightly runner: 03:00, and catch up after downtime (Persistent). */
export const unitText = (runner: string): { service: string; timer: string } => ({
  service: ['[Unit]', 'Description=Cortex scheduled jobs', '', '[Service]', 'Type=oneshot', `ExecStart=${runner} run-due`, ''].join('\n'),
  timer: ['[Unit]', 'Description=Cortex scheduled jobs, nightly', '', '[Timer]', 'OnCalendar=*-*-* 03:00:00', 'Persistent=true', 'RandomizedDelaySec=15min', '', '[Install]', 'WantedBy=timers.target', ''].join('\n'),
})
