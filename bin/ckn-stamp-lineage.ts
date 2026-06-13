#!/usr/bin/env tsx
/**
 * ckn-stamp-lineage — one-time backfill of `machine:` frontmatter into existing
 * memory files that lack it, making lineage greppable in the .md itself.
 *
 * Lineage is forward-accurate from the day it was introduced: memories created
 * after that carry their authoring machine natively (stamped by ckn-extract).
 * Pre-existing memories have no recorded origin, so this stamps them with the
 * LOCAL machine — i.e. "this machine had it at backfill time." Run it once per
 * machine, ideally on the machine that authored the bulk of the backlog.
 *
 * Only touches files missing a `machine:` key. Idempotent. Does NOT modify
 * `visibility: local` files differently — they get stamped too (lineage is
 * orthogonal to whether a memory syncs).
 *
 * Usage:
 *   ckn-stamp-lineage --dry-run   # list what would be stamped
 *   ckn-stamp-lineage             # stamp + (if server up) trigger a re-index
 */
import * as fsSync from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { getMachineId } from '../server/privateMind.js'

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')
const USER_MEM = path.join(os.homedir(), '.claude', 'memory')

const dryRun = process.argv.includes('--dry-run')

const memoryDirs = (): string[] => {
  const dirs = [USER_MEM, path.join(USER_MEM, 'concepts')]
  try {
    for (const e of fsSync.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(PROJECTS_ROOT, e.name, 'memory'))
    }
  } catch {
    // none
  }
  return dirs
}

/** Insert `machine: <id>` as the last line inside the frontmatter fence. */
const stampMachine = (raw: string, machine: string): string | null => {
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/)
  if (!m) return null // no frontmatter — leave it alone
  const fmBody = m[2] ?? ''
  if (/^machine\s*:/m.test(fmBody)) return null // already stamped
  const line = `machine: ${/^[\w.-]+$/.test(machine) ? machine : JSON.stringify(machine)}`
  return `${m[1]}${fmBody}\n${line}${m[3]}${raw.slice(m[0].length)}`
}

const main = async () => {
  const machine = getMachineId()
  let stamped = 0
  let skipped = 0
  for (const dir of memoryDirs()) {
    let entries: fsSync.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md') continue
      const file = path.join(dir, e.name)
      let raw: string
      try {
        raw = await fsp.readFile(file, 'utf-8')
      } catch {
        continue
      }
      const next = stampMachine(raw, machine)
      if (!next) {
        skipped++
        continue
      }
      if (dryRun) {
        console.log(`[dry] would stamp ${file}`)
      } else {
        await fsp.writeFile(file, next, 'utf-8')
      }
      stamped++
    }
  }
  console.log(
    `[ckn stamp-lineage] machine=${machine} — ${stamped} stamped, ${skipped} already-tagged/no-frontmatter${dryRun ? ' (dry-run)' : ''}`,
  )
  if (!dryRun && stamped > 0) {
    console.log('[ckn stamp-lineage] run `ckn-sync` (or it will fold in on the next Stop hook) to update the graph.')
  }
}

main().catch((e) => {
  console.error('[ckn stamp-lineage] fatal:', e?.message ?? e)
  process.exit(1)
})
