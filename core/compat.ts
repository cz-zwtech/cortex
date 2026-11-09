/**
 * Version compatibility: a two-way contract, per the core-versioning
 * requirement: "keep proper semantic versioning and ensure backwards
 * compatibility or list a breaking change so community can adapt and consumers
 * can target versions. This versioning needs to be core."
 *
 * The load-bearing decision here is that CONTRACT version is separate from CORE
 * version. Core can ship 2.3.1 -> 2.4.0 with bugfixes without touching the
 * module contract, and no mod needs to care. Conflating the two forces the whole
 * ecosystem to re-release every time core fixes a typo, and it is the single
 * most common way platform versioning goes wrong. Separating them costs nothing
 * on day one and cannot be retrofitted cheaply.
 *
 * Both directions are checked:
 *   - the mod declares which cores it works with (`requiresCore`)
 *   - core declares which mod-contract versions it supports (`SUPPORTS`)
 * Either side may refuse. Refusal is always reported with a reason and never
 * kills the process — an incompatible mod is a mod that does not start, not an
 * outage.
 */

import semver from 'semver'

/** The core build. Bugfixes and features move this without moving the contract. */
export const CORE_VERSION = '2.0.0'

/**
 * The module-contract version. Moves ONLY when the manifest shape, lifecycle,
 * or ctx surface changes in a way mods can observe.
 */
export const CONTRACT_VERSION = '2.0.0'

/** Mod-contract versions this core can host. */
export const SUPPORTS = '>=2.0.0 <3.0.0'

/**
 * Breaking changes, keyed by the contract version that introduced them. This is
 * the artifact the community reads. It must be core-owned and machine-readable,
 * or in practice it does not exist.
 */
export const BREAKING_CHANGES: Record<string, string[]> = {
  '2.0.0': ['Initial module contract.'],
}

export type CompatVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Check a mod against this core, both directions.
 *
 * `modContract` is the contract version the mod was authored against; it
 * defaults to the mod's `requiresCore` floor when not stated separately, which
 * keeps simple manifests simple.
 */
export const checkCompat = (opts: {
  moduleName: string
  requiresCore: string
  coreVersion?: string
  supports?: string
}): CompatVerdict => {
  const core = opts.coreVersion ?? CORE_VERSION
  const supports = opts.supports ?? SUPPORTS

  if (!semver.validRange(opts.requiresCore)) {
    return {
      ok: false,
      reason: `"${opts.moduleName}" declares requiresCore "${opts.requiresCore}", which is not a valid semver range`,
    }
  }

  // Direction 1: does this core satisfy what the mod asked for?
  if (!semver.satisfies(core, opts.requiresCore)) {
    return {
      ok: false,
      reason: `"${opts.moduleName}" requires core ${opts.requiresCore}, but this core is ${core}`,
    }
  }

  // Direction 2: is the mod inside the window this core will host? A mod
  // written against a future contract can satisfy direction 1 by accident
  // (e.g. ">=2.0.0") while still expecting surface this core does not have.
  const floor = semver.minVersion(opts.requiresCore)
  if (floor && !semver.satisfies(floor, supports)) {
    return {
      ok: false,
      reason: `"${opts.moduleName}" targets contract ${floor.version}, outside this core's supported range ${supports}`,
    }
  }

  return { ok: true }
}

/** Breaking changes introduced after `from`, for upgrade reporting. */
export const breakingChangesSince = (from: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const [version, changes] of Object.entries(BREAKING_CHANGES)) {
    if (semver.valid(version) && semver.gt(version, from)) out[version] = changes
  }
  return out
}
