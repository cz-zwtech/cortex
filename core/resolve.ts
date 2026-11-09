/**
 * Dependency resolution: what may start, in what order.
 *
 * This subsystem exists for exactly one reason: mod-on-mod
 * dependency is legal. A `requires` field with no resolver behind it is a broken
 * contract, not a lean one.
 *
 * Three jobs:
 *   1. Refuse cycles. Loudly, by name, before anything starts.
 *   2. Refuse mods whose hard dependencies are missing or themselves unstartable.
 *   3. Order the survivors so a dependency always starts before its dependent.
 *
 * Everything here is pure: manifests in, a plan out. No I/O, no imports of
 * module code. That keeps it exhaustively testable, which matters because a
 * resolver bug shows up as a mysterious startup order problem months later.
 */

import type { Manifest } from './manifest.js'

export type Blocked = {
  name: string
  /** Why this mod cannot start, phrased for a human reading `status`. */
  reason: string
}

export type ResolvePlan = {
  /** Start in this order. A dependency always precedes its dependents. */
  order: string[]
  /** Mods that will not start, each with a stated reason. */
  blocked: Blocked[]
  /** Cycles found, each as the member names in the order they chain. */
  cycles: string[][]
}

/**
 * Resolve a start plan.
 *
 * `optional` deliberately does NOT affect startability — an optional dependency
 * being absent means a feature is disabled, not that the mod is broken. It DOES
 * affect ordering when present, so an optional provider is up before its
 * consumer looks for it.
 */
export const resolve = (manifests: Manifest[]): ResolvePlan => {
  const byName = new Map(manifests.map((m) => [m.name, m]))
  const cycles = findCycles(manifests, byName)

  const inCycle = new Set(cycles.flat())
  const blocked: Blocked[] = []
  const blockedNames = new Set<string>()

  const block = (name: string, reason: string) => {
    if (blockedNames.has(name)) return
    blockedNames.add(name)
    blocked.push({ name, reason })
  }

  for (const name of inCycle) {
    const cycle = cycles.find((c) => c.includes(name))!
    block(name, `dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0]}`)
  }

  // Missing hard dependencies. Iterate to a fixed point: a mod requiring a
  // blocked mod is itself blocked, transitively.
  for (;;) {
    let changed = false
    for (const m of manifests) {
      if (blockedNames.has(m.name)) continue
      for (const dep of m.requires) {
        if (!byName.has(dep)) {
          block(m.name, `requires "${dep}", which is not installed`)
          changed = true
          break
        }
        if (blockedNames.has(dep)) {
          block(m.name, `requires "${dep}", which cannot start`)
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }

  const startable = manifests.filter((m) => !blockedNames.has(m.name))
  return { order: topoSort(startable), blocked, cycles }
}

/**
 * Kahn's algorithm over startable mods. Ties broken alphabetically so the order
 * is deterministic across runs — a plan that varies between boots is a plan
 * nobody can debug.
 */
const topoSort = (manifests: Manifest[]): string[] => {
  const present = new Set(manifests.map((m) => m.name))
  const deps = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()

  for (const m of manifests) {
    // Optional deps order when present; they never gate startability.
    const edges = [...m.requires, ...m.optional].filter((d) => present.has(d))
    deps.set(m.name, new Set(edges))
    for (const d of edges) {
      if (!dependents.has(d)) dependents.set(d, new Set())
      dependents.get(d)!.add(m.name)
    }
  }

  const ready = [...present].filter((n) => deps.get(n)!.size === 0).sort()
  const order: string[] = []

  while (ready.length) {
    const next = ready.shift()!
    order.push(next)
    for (const dependent of [...(dependents.get(next) ?? [])].sort()) {
      const remaining = deps.get(dependent)!
      remaining.delete(next)
      if (remaining.size === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }

  return order
}

/**
 * Cycle detection over BOTH requires and optional.
 *
 * Optional edges are included on purpose: they do not gate startability, but a
 * cycle through them still has no valid ordering, and silently ignoring that
 * would mean the order depends on iteration luck.
 */
const findCycles = (manifests: Manifest[], byName: Map<string, Manifest>): string[][] => {
  const cycles: string[][] = []
  const seen = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const visit = (name: string) => {
    if (onStack.has(name)) {
      const start = stack.indexOf(name)
      const cycle = stack.slice(start)
      // Normalise rotation so the same cycle is never reported twice under a
      // different starting member.
      const pivot = cycle.indexOf([...cycle].sort()[0]!)
      const normalised = [...cycle.slice(pivot), ...cycle.slice(0, pivot)]
      if (!cycles.some((c) => c.join() === normalised.join())) cycles.push(normalised)
      return
    }
    if (seen.has(name)) return

    seen.add(name)
    stack.push(name)
    onStack.add(name)

    const m = byName.get(name)
    if (m) {
      for (const dep of [...m.requires, ...m.optional]) {
        if (byName.has(dep)) visit(dep)
      }
    }

    stack.pop()
    onStack.delete(name)
  }

  for (const m of [...manifests].sort((a, b) => a.name.localeCompare(b.name))) visit(m.name)
  return cycles
}

/**
 * Each module whose `requires` names a module not in the set, with the names missing. The
 * installer refuses on any (2 Nov 2026: a module must fail to install without its hard
 * dependencies); `resolve` then blocks the same module at start if one is removed later.
 */
export const unmetRequires = (manifests: Manifest[]): { name: string; missing: string[] }[] => {
  const have = new Set(manifests.map((m) => m.name))
  return manifests.map((m) => ({ name: m.name, missing: m.requires.filter((d) => !have.has(d)) })).filter((u) => u.missing.length)
}
