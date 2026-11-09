#!/usr/bin/env tsx
/**
 * cortex-setup: keep the harness surface current.
 *
 *   commands                re-sync this user's Cortex commands to the checkout
 *   statusline [status]     what the status line has: empty, none or v2
 *   statusline apply        bring it onto the V2 segment, keeping the user's own
 *   statusline decline      do not offer again (for what it has now)
 *
 *   update                  pull the latest, reinstall deps if the lockfile changed,
 *                           rerun install and migrations; hooks pause meanwhile
 *   update check            fetch and record how far behind this checkout is
 *   update skip             stop offering the version currently available
 *   update mode off|ask|auto   how sessions treat an available update (default ask)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dataRoot, stateDir, claudeConfigDir } from '../core/paths.js'
import { apply, decline, detect } from '../core/statuslineSetup.js'
import { check, readPrefs, update, writePrefs, type Mode } from '../core/update.js'

const repo = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(dataRoot(), 'setup')
const claudeDir = claudeConfigDir()
const settingsFile = path.join(claudeDir, 'settings.json')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const [area, verb, arg] = process.argv.slice(2)

const die = (msg: string): never => {
  console.error(`cortex-setup: ${msg}`)
  process.exit(1)
}

const readSettings = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Every write backs up what it replaces, once per run. */
let backedUp = false
const writeSettings = (s: Record<string, unknown>) => {
  if (!backedUp && fs.existsSync(settingsFile)) {
    fs.copyFileSync(settingsFile, `${settingsFile}.bak-cortex-${stamp}`)
    backedUp = true
  }
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2) + '\n')
}

if (area === 'commands') {
  // This user's commands, re-synced to the checkout's modules (what a deploy run as another user cannot do).
  const { resyncCommands } = await import('../core/harness.js')
  const { hookedSettings } = await import('../core/serviceInstall.js')
  const { modulesDir } = await import('../core/paths.js')
  const r = await resyncCommands({ claudeDir, repoRoot: repo, modulesDir: modulesDir() }, !!hookedSettings(claudeDir))
  console.log(!r ? 'commands: none here (no Cortex hooks: a service account)' : r.installed.length ? `commands installed: ${r.installed.join(', ')}` : 'commands: up to date')
  if (r?.skipped.length) console.log(`commands not installed, the name is taken by a file that is not Cortex V2's: ${r.skipped.join(', ')}`)
} else if (area === 'statusline') {
  const found = detect(readSettings() as { statusLine?: { command?: string } })
  if (!verb || verb === 'status') {
    console.log(
      {
        v2: 'status line: on the Cortex V2 segment',
        none: 'status line: yours, with no Cortex segment; "statusline apply" appends it',
        empty: 'status line: none set; "statusline apply" adds the Cortex segment',
      }[found.kind],
    )
  } else if (verb === 'apply') {
    const r = apply(found, { claudeDir, v2Script: path.join(repo, 'bin', 'cortex-statusline.sh'), readSettings, writeSettings, stamp })
    if (!r.ok) die(r.reason)
    if (r.ok && !r.changed.length) console.log('status line: already on the Cortex V2 segment')
    else if (r.ok) {
      console.log(`status line updated: ${r.changed.join(', ')}`)
      if (backedUp) console.log(`  backup: ${settingsFile}.bak-cortex-${stamp}`)
      for (const b of r.backups) console.log(`  backup: ${b}`)
      console.log('It shows from the next status line refresh.')
    }
  } else if (verb === 'decline') {
    decline(dataDir, found.kind)
    console.log('noted; sessions will not offer the status line again unless it changes')
  } else die('usage: statusline [status|apply|decline]')
} else if (area === 'update') {
  if (verb === 'check') {
    const c = check(repo)
    writePrefs(dataDir, { last: c })
    console.log(c.behind ? `${c.behind} commit(s) behind origin/${c.branch}` : `up to date with origin/${c.branch} (${c.local.slice(0, 7)})`)
  } else if (verb === 'skip') {
    const last = readPrefs(dataDir).last
    writePrefs(dataDir, { skipped: last?.remote })
    console.log(last ? `will not offer ${last.remote.slice(0, 7)} again` : 'nothing to skip')
  } else if (verb === 'mode') {
    if (!['off', 'ask', 'auto'].includes(arg ?? '')) die('usage: update mode off|ask|auto')
    writePrefs(dataDir, { mode: arg as Mode })
    console.log(`updates: ${arg}`)
  } else if (!verb) {
    try {
      const r = update(repo, stateDir())
      if (r.status === 'refused') die(r.reason)
      if (r.status === 'up-to-date') console.log(`Cortex is up to date (${r.at})`)
      if (r.status === 'updated') {
        console.log(`Cortex updated ${r.from} -> ${r.to}${r.depsReinstalled ? ' (dependencies reinstalled)' : ''}:`)
        for (const c of r.commits) console.log(`  ${c}`)
        console.log('New sessions use it fully; this one picks up hook changes from its next prompt.')
      }
      // Commands are re-synced even when up to date: an install that skipped one (a name V1 held)
      // gets it here once the name is free, without a full reinstall.
      const { resyncCommands } = await import('../core/harness.js')
      const { hookedSettings } = await import('../core/serviceInstall.js')
      const { modulesDir } = await import('../core/paths.js')
      const cmds = await resyncCommands({ claudeDir, repoRoot: repo, modulesDir: modulesDir() }, !!hookedSettings(claudeDir))
      if (cmds?.installed.length) console.log(`Commands installed: ${cmds.installed.join(', ')}`)
      if (cmds?.skipped.length) console.log(`Commands not installed, the name is taken by a file that is not Cortex V2's: ${cmds.skipped.join(', ')}`)
      writePrefs(dataDir, { last: check(repo) })
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  } else die('usage: update [check|skip|mode off|ask|auto]')
} else {
  die('usage: cortex-setup commands | statusline [status|apply|decline] | update [check|skip|mode off|ask|auto]')
}
