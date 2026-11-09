/**
 * Discovery — find modules by looking, not by a list.
 *
 * This is the first requirement stated: "The core scaffold auto-recognizes
 * a module at launch because it sits in a designated folder path. Drop it in,
 * restart, it's live."
 *
 * The mechanism generalises the one V1 already got right (skills were
 * discovered by readdir while hooks and commands were hardcoded arrays).
 *
 * Nothing here executes module code. Discovery reads `module.json` and stops.
 * A mod that fails validation is REPORTED, never thrown — one malformed
 * manifest must not stop the others being found.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseManifest, type Manifest } from './manifest.js'

export type Discovered = {
  dir: string
  manifest: Manifest
}

export type Rejected = {
  dir: string
  name: string
  errors: string[]
}

export type DiscoveryResult = {
  found: Discovered[]
  rejected: Rejected[]
}

/**
 * Scan a modules directory.
 *
 * A missing directory is not an error — it is the normal state of a naked
 * scaffold, and treating it as a failure would make "boots with zero modules"
 * a special case instead of the default.
 */
export const discover = async (modulesDir: string): Promise<DiscoveryResult> => {
  const found: Discovered[] = []
  const rejected: Rejected[] = []

  let entries: string[]
  try {
    const dirents = await fs.readdir(modulesDir, { withFileTypes: true })
    entries = dirents.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { found, rejected }
    throw err
  }

  for (const entry of entries.sort()) {
    const dir = path.join(modulesDir, entry)
    const manifestPath = path.join(dir, 'module.json')

    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // No module.json means "not a module", not "a broken module" — a docs or
      // scratch directory sitting in modules/ should be ignored silently.
      if (e.code === 'ENOENT') continue
      rejected.push({ dir, name: entry, errors: [`module.json is not readable JSON: ${e.message}`] })
      continue
    }

    const result = parseManifest(raw)
    if (!result.ok) {
      rejected.push({ dir, name: entry, errors: result.errors })
      continue
    }

    // The directory name is the mod's identity on disk; a manifest claiming a
    // different name would make `status`, uninstall and the modules dir
    // disagree about what is installed.
    if (result.manifest.name !== entry) {
      rejected.push({
        dir,
        name: entry,
        errors: [`manifest name "${result.manifest.name}" does not match directory "${entry}"`],
      })
      continue
    }

    found.push({ dir, manifest: result.manifest })
  }

  return { found, rejected }
}
