/**
 * A backup before anything that could change real memory: installs, updates,
 * migrations, retire, and the first sweep on a machine (a standing rule
 * after the 2026-10-13 incident). The caller refuses to proceed if it throws.
 *
 * What it holds: every memory directory under the memory roots (never the
 * transcripts beside them), plus the V2 store: cortex.sqlite with its WAL
 * files, and data/memory (the journal). One tarball per run, with absolute
 * paths stored relative to /, so restore puts every file back where it was.
 */
import { spawnSync } from 'node:child_process'
import { runScript } from './paths.js'
import fs from 'node:fs'
import path from 'node:path'

import { dataRoot, dbPath, memoryRoots, memoryRootsAreDeclared, stateDir } from './paths.js'

export type Backup = { file: string; reason: string; at: string; paths: string[]; restore: string }

const KEEP = 10
export const backupDir = () => path.join(stateDir(), 'backups')

/** Directories named `memory` under a search root, as the sweep finds them. */
const memoryDirsUnder = (root: string, depth = 3): string[] => {
  if (path.basename(root) === 'memory') return [root]
  if (depth < 0) return []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).flatMap((e) => memoryDirsUnder(path.join(root, e.name), depth - 1))
}

export const backupMemory = (reason: string, repoRoot: string): Backup => {
  const roots = memoryRoots()
  const dirs = memoryRootsAreDeclared() ? roots : roots.flatMap((r) => memoryDirsUnder(r))
  const store = [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`, path.join(dataRoot(), 'memory')]
  const paths = [...dirs, ...store].filter((p) => fs.existsSync(p))

  fs.mkdirSync(backupDir(), { recursive: true })
  const at = new Date().toISOString()
  const file = path.join(backupDir(), `memory-${at.replace(/[:.]/g, '-')}-${reason.replace(/\W+/g, '-')}.tgz`)
  const rel = paths.map((p) => path.relative('/', path.resolve(p)))
  const r = rel.length
    ? spawnSync('tar', ['czf', file, '-C', '/', ...rel], { encoding: 'utf-8' })
    : spawnSync('tar', ['czf', file, '-T', '/dev/null'], { encoding: 'utf-8' })
  if (r.status !== 0) {
    fs.rmSync(file, { force: true })
    throw new Error(`backup failed (tar exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`)
  }
  // A tarball that cannot be listed is not a backup.
  if (spawnSync('tar', ['tzf', file], { encoding: 'utf-8' }).status !== 0) {
    fs.rmSync(file, { force: true })
    throw new Error('backup failed: the archive does not read back')
  }

  const restore = `${runScript(repoRoot, 'cortex-backup.ts')} restore ${file}`
  const rec: Backup = { file, reason, at, paths, restore }
  fs.appendFileSync(path.join(backupDir(), 'index.jsonl'), JSON.stringify(rec) + '\n')

  const all = fs.readdirSync(backupDir()).filter((f) => f.startsWith('memory-') && f.endsWith('.tgz')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(backupDir(), old), { force: true })
  return rec
}

export const listBackups = (): Backup[] => {
  try {
    return fs
      .readFileSync(path.join(backupDir(), 'index.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Backup)
      .filter((b) => fs.existsSync(b.file))
  } catch {
    return []
  }
}

/** Put a backup's files back. Takes a fresh backup of the current state first. */
export const restoreBackup = (file: string, repoRoot: string): Backup => {
  if (!fs.existsSync(file)) throw new Error(`no such backup: ${file}`)
  const before = backupMemory('pre-restore', repoRoot)
  const r = spawnSync('tar', ['xzf', file, '-C', '/'], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`restore failed (tar exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`)
  return before
}
