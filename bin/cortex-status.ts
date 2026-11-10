#!/usr/bin/env tsx
/**
 * `status` — the naked scaffold's proof of life.
 *
 * The brief: "Slash doesn't have to do things, just show it works."
 *
 * Read-only. Takes no arguments. Mutates nothing. It must be meaningful with
 * zero modules installed — that is its entire job.
 */

import { EventBus } from '../core/events.js'
import { Storage } from '../core/storage.js'
import { Lifecycle } from '../core/lifecycle.js'
import { buildStatus } from '../core/status.js'
import path from 'node:path'

import { dataRoot, dbPath, modulesDir as resolveModulesDir, stateDir, claudeConfigDir } from '../core/paths.js'
import { commandGaps, importGaps } from '../core/harness.js'
import { hookedSettings } from '../core/serviceInstall.js'
import { traceEnabled, traceSummary } from '../core/trace.js'
import { LIFECYCLE_EVENTS } from '../core/manifest.js'
import { readPrefs } from '../core/update.js'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-status
  core's version, installed modules and what is missing. Read-only, no arguments`)

// State, not install — see core/paths.ts.
const modulesDir = resolveModulesDir()

const events = new EventBus()
const storage = new Storage(dbPath())
const lifecycle = new Lifecycle({
  modulesDir,
  dataRoot: dataRoot(),
  dbPath: storage.path,
  events,
  storage,
  // Discovery noise would drown the report this command exists to print.
  log: () => {},
})

await lifecycle.run()
const s = buildStatus({ lifecycle, events, storage, modulesDir })

const lines: string[] = []
lines.push(`Cortex core ${s.core.version} — ${s.core.status}`)
lines.push(`  contract ${s.core.contract} (hosts modules ${s.core.supports})`)
lines.push(`  storage: ${s.core.storage}`)
lines.push(`  state dir: ${stateDir()}`)
lines.push(`  modules dir: ${s.modulesDir}`)
lines.push('')

if (s.modules.started.length === 0) {
  lines.push('No modules installed.')
  lines.push('Core is a scaffold — drop a module into the modules directory and restart.')
} else {
  lines.push(`Started (${s.modules.started.length}):`)
  for (const name of s.modules.started) lines.push(`  - ${name}`)
}

if (s.modules.hostOnly.length) {
  lines.push(`Host only (they run in cortex-host, not here): ${s.modules.hostOnly.map((m) => m.name).join(', ')}`)
}

const problems = [
  ...s.modules.blocked.map((m) => ({ ...m, state: 'blocked' })),
  ...s.modules.failed.map((m) => ({ ...m, state: 'failed' })),
  ...s.modules.rejected.map((m) => ({ ...m, state: 'rejected' })),
]
if (problems.length) {
  lines.push('')
  lines.push('Not running:')
  for (const p of problems) lines.push(`  - ${p.name} (${p.state}): ${p.reason}`)
}

// MODULE SELF-REPORTS — core knows a module STARTED; only the module knows
// whether it is doing anything. A module can start cleanly, hold nothing, and
// have a queue nobody has read: green by every measure core can take.
if (s.health.length) {
  lines.push('')
  lines.push('Modules:')
  for (const h of s.health) lines.push(`  ${h.module}: ${h.summary}`)
}

// WARNINGS GO LAST AND LOUD. Everything above is inventory; this is the part
// that says something is wrong while the module is running — the state that has
// no other way to become visible.
const warnings = s.health.flatMap((h) => h.warnings.map((w) => `${h.module}: ${w}`))
// A user install's commands, checked against what its modules ship. A service node has no hooks
// and no commands by design, so it is not checked.
if (hookedSettings(claudeConfigDir())) {
  const gaps = await commandGaps({ claudeDir: claudeConfigDir(), repoRoot: path.resolve(import.meta.dirname, '..'), modulesDir })
  if (gaps.missing.length) warnings.push(`commands missing: ${gaps.missing.join(', ')}; run cortex-setup update to install them`)
  for (const f of await importGaps({ claudeDir: claudeConfigDir() })) warnings.push(`CLAUDE.md imports ${f}, which is missing or empty (the harness skips it silently); run cortex-setup commands`)
  if (gaps.shadowed.length) warnings.push(`commands shadowed by a file that is not Cortex V2's: ${gaps.shadowed.join(', ')}; move it aside, then cortex-setup update`)
}
if (warnings.length) {
  lines.push('')
  lines.push(`⚠ ${warnings.length} warning(s):`)
  for (const w of warnings) lines.push(`  - ${w}`)
}

if (s.capabilities.length) {
  lines.push('')
  lines.push(`Capabilities: ${s.capabilities.join(', ')}`)
}
if (s.events.topics.length) {
  lines.push(`Subscribed events: ${s.events.topics.join(', ')}`)
}

// HOOKS SEEN — the answer to "are the hooks even running", which is the first
// question anyone debugging an install asks and which nothing could answer
// before. Reported here rather than kept as a file only the UAT reads: a
// diagnostic nobody can reach is one nobody uses.
const seen = traceSummary()
const seenEvents = Object.keys(seen).sort()
lines.push('')
if (!traceEnabled()) {
  lines.push('Hooks seen: tracing disabled (CORTEX_TRACE=off)')
} else if (!seenEvents.length) {
  lines.push('Hooks seen: none yet — no lifecycle event has reached this install.')
  lines.push('  If a session is running, the hooks are not registered or not firing.')
} else {
  lines.push(`Hooks seen (${seenEvents.length}/${LIFECYCLE_EVENTS.length}):`)
  for (const e of seenEvents) lines.push(`  ${e} ×${seen[e]!.count}, last ${seen[e]!.last}`)
  const missing = LIFECYCLE_EVENTS.filter((e) => !seen[e])
  if (missing.length) lines.push(`  not yet seen: ${missing.join(', ')}`)
}

await lifecycle.stopAll()
storage.close()

// Updates are core's (setup was a module until 2 Nov; its data dir stays <data>/setup).
{
  const u = readPrefs(path.join(dataRoot(), 'setup'))
  const last = u.last
  lines.push(`Updates: ${u.mode ?? 'ask'}; ${last ? `${last.behind} behind ${last.branch} at last check (${new Date(last.checkedAt).toISOString().slice(0, 16)}Z)` : 'not checked yet'}`)
}
console.log(lines.join('\n'))
