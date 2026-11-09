/**
 * The harness settings file.
 *
 * This is the single most dangerous thing Cortex writes: it is the user's own
 * Claude Code configuration, it contains things we did not put there, and
 * corrupting it breaks their tooling rather than ours.
 *
 * Three rules, each earned from V1:
 *
 *  1. NEVER partial-write. Write a temp file next to the target, fsync, then
 *     rename. Rename is atomic within a filesystem, so a crash mid-write leaves
 *     the old file intact rather than a truncated one.
 *  2. ALWAYS back up before the first modification of a run.
 *  3. MERGE, never replace. Everything we did not put there survives untouched.
 *     Our own entries are identified by an explicit marker, not by position or
 *     by guessing from the command string.
 *
 * Read failures return an empty object rather than throwing: a missing settings
 * file is a fresh install, not an error.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** Identifies entries this tool owns. Never match on anything else. */
export const CORTEX_MARKER = 'cortex:managed'

export type HookEntry = {
  type: 'command'
  command: string
  timeout?: number
  /** Our ownership marker. Its presence is what makes an entry ours to touch. */
  _marker?: string
}

export type HookMatcher = {
  matcher?: string
  hooks: HookEntry[]
}

export type Settings = {
  env?: Record<string, string>
  hooks?: Record<string, HookMatcher[]>
  [key: string]: unknown
}

export const readSettings = async (file: string): Promise<Settings> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Settings
  } catch {
    return {}
  }
}

/**
 * Atomic write with a one-per-run backup.
 *
 * The temp file is created in the SAME directory as the target on purpose:
 * rename() is only atomic within a filesystem, and /tmp is frequently a
 * different one.
 */
export const writeSettings = async (file: string, settings: Settings): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })

  try {
    const existing = await fs.readFile(file, 'utf-8')
    await fs.writeFile(`${file}.bak-cortex`, existing, 'utf-8')
  } catch {
    // No existing file to back up — a fresh install.
  }

  const tmp = `${file}.tmp-cortex-${process.pid}`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
}

/**
 * Install exactly one hook registration per lifecycle event.
 *
 * This is the coordination model in code: core registers ONE entry per event
 * and dispatches in-process to subscribers. Module installs do not come through
 * here at all, which is what makes settings.json stable across them.
 *
 * Idempotent — running it twice with the same inputs produces a byte-identical
 * file. That property is what the UAT's stage-2 assertion depends on, so it is
 * a requirement, not a nicety.
 */
export const registerHooks = (
  settings: Settings,
  events: readonly string[],
  command: (event: string) => string,
  timeout: number,
): Settings => {
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } }

  for (const event of events) {
    const existing = next.hooks![event] ?? []

    // Drop only OUR entries; anything the user added survives untouched.
    const foreign = existing
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((h) => h._marker !== CORTEX_MARKER),
      }))
      .filter((group) => group.hooks.length > 0)

    next.hooks![event] = [
      ...foreign,
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: command(event), timeout, _marker: CORTEX_MARKER },
        ],
      },
    ]
  }

  return next
}

/** Remove every hook this tool owns, leaving user entries in place. */
export const unregisterHooks = (settings: Settings): Settings => {
  if (!settings.hooks) return settings
  const next: Settings = { ...settings, hooks: { ...settings.hooks } }

  for (const [event, groups] of Object.entries(next.hooks!)) {
    const foreign = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((h) => h._marker !== CORTEX_MARKER) }))
      .filter((group) => group.hooks.length > 0)

    if (foreign.length === 0) delete next.hooks![event]
    else next.hooks![event] = foreign
  }

  if (Object.keys(next.hooks!).length === 0) delete next.hooks
  return next
}

/**
 * Allow rules core owns. A permissions entry is a bare string, so it cannot
 * carry the marker hooks do: ownership is the rule's own shape, matched by
 * `ours`, which must recognise every rule core has ever written (a checkout
 * that moved leaves the old path behind) and nothing a user wrote.
 */
export const registerAllow = (settings: Settings, rules: readonly string[], ours: (rule: string) => boolean): Settings => {
  const permissions = (settings.permissions ?? {}) as { allow?: string[]; [key: string]: unknown }
  const foreign = (permissions.allow ?? []).filter((r) => !ours(r))
  return { ...settings, permissions: { ...permissions, allow: [...foreign, ...rules] } }
}

export const unregisterAllow = (settings: Settings, ours: (rule: string) => boolean): Settings => {
  const permissions = settings.permissions as { allow?: string[]; [key: string]: unknown } | undefined
  if (!permissions?.allow) return settings
  const allow = permissions.allow.filter((r) => !ours(r))
  if (allow.length === permissions.allow.length) return settings
  const { allow: _, ...rest } = permissions
  const next: Settings = { ...settings, permissions: allow.length ? { ...rest, allow } : rest }
  if (Object.keys(next.permissions as object).length === 0) delete next.permissions
  return next
}
