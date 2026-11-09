/**
 * `status` — the scaffold's proof of life.
 *
 * The brief: "We can have a version slash command as a bare bones install… which
 * shows it's installed and functional, or a status that shows all the above
 * with version info. Slash doesn't have to do things, just show it works."
 *
 * So this is READ-ONLY and takes no arguments. It is the minimum tier of the
 * command surface, and it must be meaningful with zero modules installed —
 * a naked scaffold saying "I am here, I am version N, I have nothing loaded,
 * and here is where modules go" is the whole deliverable.
 */

import { CORE_VERSION, CONTRACT_VERSION, SUPPORTS } from './compat.js'
import type { Lifecycle } from './lifecycle.js'
import type { EventBus } from './events.js'
import type { Storage } from './storage.js'

export type StatusReport = {
  core: {
    version: string
    contract: string
    supports: string
    status: 'healthy'
    storage: 'open' | 'not opened'
  }
  modules: {
    started: string[]
    blocked: { name: string; reason: string }[]
    failed: { name: string; reason: string }[]
    rejected: { name: string; reason: string }[]
    hostOnly: { name: string; reason: string }[]
  }
  capabilities: string[]
  /**
   * Per-module self-reports.
   *
   * Core reports whether a module STARTED; only the module can report whether it
   * is doing its job. The two are routinely different — a module can start
   * cleanly, hold nothing, and have a queue nobody has read.
   */
  health: { module: string; summary: string; warnings: string[] }[]
  events: { topics: string[] }
  modulesDir: string
  notes: string[]
}

export const buildStatus = (opts: {
  lifecycle: Lifecycle
  events: EventBus
  storage: Storage
  modulesDir: string
}): StatusReport => {
  const statuses = opts.lifecycle.statuses
  const pick = (state: string) =>
    statuses
      .filter((s) => s.state === state)
      .map((s) => ({ name: s.name, reason: s.reason ?? '' }))

  const started = statuses.filter((s) => s.state === 'started').map((s) => s.name)
  const notes: string[] = []

  if (statuses.length === 0) {
    notes.push('No modules installed. Core is a scaffold — drop a module into the modules directory and restart.')
    notes.push(`Modules directory: ${opts.modulesDir}`)
  }
  for (const s of statuses) {
    if (s.state !== 'started' && s.state !== 'host-only') notes.push(`${s.name} is ${s.state}: ${s.reason}`)
  }

  // ── PER-MODULE SELF-REPORTS ──────────────────────────────────────────────
  //
  // Core can report that a module STARTED. Only the module can report whether
  // it is doing anything — that needs domain knowledge core deliberately does
  // not have, and the two answers are routinely different. Memory can start
  // cleanly, hold an empty corpus, and have a quarantine nobody has read: green
  // by every measure core can take, broken by every measure that matters.
  //
  // A throwing `status()` is isolated and REPORTED as a warning rather than
  // swallowed. `status` is the command people run when something is already
  // wrong; it failing silently would be the worst possible moment for silence.
  const health: StatusReport['health'] = []
  for (const mod of opts.lifecycle.started) {
    if (!mod.impl.status) continue
    try {
      const h = mod.impl.status(mod.ctx)
      health.push({
        module: mod.manifest.name,
        summary: h.summary,
        warnings: h.warnings ?? [],
      })
      for (const w of h.warnings ?? []) notes.push(`${mod.manifest.name}: ${w}`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      health.push({ module: mod.manifest.name, summary: 'status unavailable', warnings: [reason] })
      notes.push(`${mod.manifest.name}: status() threw — ${reason}`)
    }
  }

  return {
    core: {
      version: CORE_VERSION,
      contract: CONTRACT_VERSION,
      supports: SUPPORTS,
      status: 'healthy',
      // Proves "zero overhead when unused" is real: with no mod using the
      // storage amenity, the scaffold never opened a database.
      storage: opts.storage.opened ? 'open' : 'not opened',
    },
    modules: {
      started,
      blocked: pick('blocked'),
      failed: pick('failed'),
      rejected: pick('rejected'),
      hostOnly: pick('host-only'),
    },
    health,
    capabilities: opts.lifecycle.capabilities.list(),
    events: { topics: opts.events.topics() },
    modulesDir: opts.modulesDir,
    notes,
  }
}
