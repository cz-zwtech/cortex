#!/usr/bin/env tsx
/**
 * cortex-backup: memory backups taken before risky operations.
 *
 *   list                 backups on this machine, newest last
 *   now [reason]         take one now
 *   restore <file>       put a backup's files back (backs up the current state first)
 */
import path from 'node:path'

import { backupMemory, listBackups, restoreBackup } from '../core/backup.js'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-backup list | now [reason] | restore <file>
  list            backups on this machine, newest last
  now [reason]    take one now
  restore <file>  put a backup's files back (backs up the current state first)`)

const repo = path.resolve(import.meta.dirname, '..')
const [cmd, arg] = process.argv.slice(2)
try {
  if (!cmd || cmd === 'list') {
    const all = listBackups()
    if (!all.length) console.log('no backups yet')
    for (const b of all) console.log(`${b.at}  ${b.reason.padEnd(14)} ${b.file}`)
  } else if (cmd === 'now') {
    const b = backupMemory(arg ?? 'manual', repo)
    console.log(`backup: ${b.file}\nrestore: ${b.restore}`)
  } else if (cmd === 'restore') {
    if (!arg) throw new Error('usage: restore <file>')
    const before = restoreBackup(arg, repo)
    console.log(`restored ${arg}\nthe state before the restore was saved to ${before.file}`)
  } else throw new Error('usage: cortex-backup list | now [reason] | restore <file>')
} catch (err) {
  console.error(`cortex-backup: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
