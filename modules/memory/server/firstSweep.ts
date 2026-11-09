/**
 * The first sweep on a machine rewrites every memory file it ingests, so it
 * runs only after a backup (a standing rule). The backup is taken once
 * and recorded; if it fails, this run ingests and changes no file, and the
 * next run tries again.
 */
import fs from 'node:fs'
import path from 'node:path'

import { backupMemory } from '../../../core/backup.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')

export const firstSweepBackedUp = (dataDir: string, log: (m: string) => void = () => {}): boolean => {
  const marker = path.join(dataDir, 'first-sweep-backup.json')
  if (fs.existsSync(marker)) return true
  try {
    const b = backupMemory('first-sweep', REPO)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(marker, JSON.stringify(b))
    log(`first sweep on this machine: memory backed up to ${b.file}`)
    return true
  } catch (err) {
    log(`first sweep held: backup failed (${err instanceof Error ? err.message : String(err)}); ingest runs, no file is changed`)
    return false
  }
}
