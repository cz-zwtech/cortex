#!/usr/bin/env tsx
/**
 * ckn-uninstall — removes Cortex's hooks + slash commands from
 * ~/.claude/. Leaves the graph DB and shared-mind clone alone (those are
 * the user's data; if they want them gone too, they delete
 * ~/.config/ckn/ themselves).
 *
 * Detects Cortex registrations by marker substrings (ckn-sync, ckn-aware,
 * ckn-context, ckn-recall) so it works even when the repo has been
 * moved. Idempotent — safe to run multiple times.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands')

const CKN_MARKERS = ['ckn-sync', 'ckn-recall', 'ckn-aware', 'ckn-context', 'ckn-sync-shared']
// All Cortex slash commands are now `cortex-`-prefixed. Sweep the current names
// plus the pre-rename names so an uninstall after a partial migration is clean.
const CKN_COMMANDS = [
  'cortex-sync-shared.md',
  'cortex-snapshot.md',
  'cortex-rename.md',
  'cortex-bus.md',
  'cortex-available.md',
  'cortex-blast.md',
  'cortex-codegraph-diff.md',
  'cortex-profile-setup.md',
  // legacy (pre-`cortex-` rename)
  'sync-shared.md',
  'snapshot.md',
  'rename.md',
  'bus.md',
  'available.md',
  'blast.md',
  'codegraph-diff.md',
  'profile-setup.md',
]

const main = async () => {
  const removed = { hooks: 0, commands: 0 }

  // Hooks
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'))
  } catch {
    // No settings.json — nothing to clean up.
  }
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const event of Object.keys(settings.hooks)) {
      const groups: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
      const filteredGroups: any[] = []
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) {
          filteredGroups.push(group)
          continue
        }
        const filteredHooks = group.hooks.filter((h: any) => {
          const cmd = String(h.command ?? '')
          const isCkn = CKN_MARKERS.some((m) => cmd.includes(m))
          if (isCkn) removed.hooks++
          return !isCkn
        })
        if (filteredHooks.length > 0) {
          filteredGroups.push({ ...group, hooks: filteredHooks })
        }
      }
      if (filteredGroups.length > 0) {
        settings.hooks[event] = filteredGroups
      } else {
        delete settings.hooks[event]
      }
    }
    if (removed.hooks > 0) {
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8')
    }
  }

  // Commands
  for (const cmd of CKN_COMMANDS) {
    const target = path.join(COMMANDS_DIR, cmd)
    try {
      await fs.unlink(target)
      removed.commands++
    } catch {
      // not installed
    }
  }

  console.log(
    `[ckn-uninstall] removed ${removed.hooks} hook${removed.hooks === 1 ? '' : 's'} and ${removed.commands} slash command${removed.commands === 1 ? '' : 's'}.`,
  )
  console.log(`[ckn-uninstall] data preserved: ~/.config/ckn/ (graph DB, shared-mind clone, ui-state).`)
  console.log(`[ckn-uninstall]                  delete that directory yourself if you want a full clean.`)
}

void main().catch((e) => {
  console.error('[ckn-uninstall] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
