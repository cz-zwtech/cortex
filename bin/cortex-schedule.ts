#!/usr/bin/env tsx
/**
 * cortex-schedule: run the background jobs modules declare (core/schedule.ts).
 *
 *   run-due [--except <transcript>] [--force]   run every job that is due (and idle, where it asks to be)
 *   status                                      each job: last run, outcome, duration, next due
 *   install                                     the nightly systemd user timer (03:00, catches up after downtime)
 *   unit                                        print the units instead of installing them
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { claudeConfigDir, dataRoot, modulesDir, runScript, tsxBin } from '../core/paths.js'
import { declaredJobs, isDue, isIdle, jobKey, readState, unitText, writeState, type JobSpec } from '../core/schedule.js'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-schedule run-due [--except <transcript>] [--force] | status | install | unit
  run-due   run every job that is due (and idle, where it asks to be)
  status    each job: last run, outcome, duration, next due
  install   the nightly systemd user timer; unit prints the units instead`)

const REPO = path.resolve(import.meta.dirname, '..')
const [verb, ...rest] = process.argv.slice(2)
const flag = (f: string) => {
  const i = rest.indexOf(f)
  return i >= 0 ? rest[i + 1] : undefined
}

const commandOf = (j: JobSpec): string[] => {
  const [script, ...args] = j.command
  const file = script!.startsWith('core:') ? path.join(REPO, script!.slice(5)) : path.join(j.dir, script!)
  return [tsxBin(REPO), file, ...args]
}

switch (verb) {
  case 'run-due': {
    const now = Date.now()
    const state = readState(dataRoot())
    state.checkedAt = now
    const force = rest.includes('--force')
    const idle = isIdle(path.join(claudeConfigDir(), 'projects'), now, flag('--except'))
    for (const j of declaredJobs(modulesDir())) {
      if (!force && !isDue(j, state, now)) continue
      if (!force && j.idle && !idle) {
        console.log(`${jobKey(j)}: due, but a session is active; next check`)
        continue
      }
      const [bin, ...args] = commandOf(j)
      const t0 = Date.now()
      const r = spawnSync(bin!, args, { encoding: 'utf-8', timeout: j.timeoutMinutes * 60_000, env: process.env })
      const ok = r.status === 0
      const note = (ok ? r.stdout : r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n').slice(-3).join(' | ').slice(0, 400)
      state.jobs[jobKey(j)] = { lastRun: t0, lastOk: ok, ms: Date.now() - t0, note }
      console.log(`${jobKey(j)}: ${ok ? 'ok' : 'FAILED'} in ${Date.now() - t0} ms${note ? `: ${note}` : ''}`)
    }
    writeState(dataRoot(), state)
    break
  }
  case 'status': {
    const state = readState(dataRoot())
    const jobs = declaredJobs(modulesDir())
    if (!jobs.length) console.log('no scheduled jobs declared by installed modules')
    for (const j of jobs) {
      const s = state.jobs[jobKey(j)]
      const next = s?.lastRun ? new Date(s.lastRun + j.everyHours * 3_600_000).toISOString().slice(0, 16) : 'now'
      console.log(`${jobKey(j)}  every ${j.everyHours} h${j.idle ? ', idle only' : ''}; last ${s?.lastRun ? `${new Date(s.lastRun).toISOString().slice(0, 16)} ${s.lastOk ? 'ok' : 'FAILED'} (${s.ms} ms)` : 'never'}; next ${next}`)
      if (s?.note) console.log(`  ${s.note}`)
    }
    console.log(`last check: ${state.checkedAt ? new Date(state.checkedAt).toISOString().slice(0, 16) : 'never'}`)
    break
  }
  case 'unit':
  case 'install': {
    const units = unitText(runScript(REPO, 'cortex-schedule.ts'))
    if (verb === 'unit') {
      console.log(`# cortex-schedule.service\n${units.service}\n# cortex-schedule.timer\n${units.timer}`)
      break
    }
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'cortex-schedule.service'), units.service)
    fs.writeFileSync(path.join(dir, 'cortex-schedule.timer'), units.timer)
    const sd = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf-8' })
    const ok = sd('daemon-reload').status === 0 && sd('enable', '--now', 'cortex-schedule.timer').status === 0
    console.log(ok ? 'installed: cortex-schedule.timer (nightly at 03:00, catches up after downtime)' : `units written to ${dir}; systemctl --user is not available here, so jobs run when a session starts instead`)
    break
  }
  default:
    console.error('usage: cortex-schedule run-due [--except <transcript>] [--force] | status | install | unit')
    process.exit(2)
}
