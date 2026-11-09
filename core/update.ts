/**
 * Updating a Cortex checkout in place, without breaking the sessions using it.
 *
 * Every Cortex hook runs `<checkout>/node_modules/.bin/tsx <checkout>/bin/cortex-hook.ts`, so the
 * checkout IS the running system. Two moments in an update would break a hook
 * that fires during them: files changing under `git merge`, and node_modules
 * disappearing under `npm ci`. Both are handled:
 *
 *   - THE LOCK. The update writes <state>/update.lock. The dispatcher checks it
 *     first and, while the updating process is alive, exits without output:
 *     a skipped hook is a missed injection, never a broken session. A stale
 *     lock (its pid gone) is ignored and removed.
 *   - DEPENDENCIES ARE BUILT ASIDE. Only when the lockfile changed: `npm ci`
 *     runs in a staging directory, then node_modules is swapped by rename.
 *     The window with no node_modules is two renames, not the whole install.
 *
 * A dirty checkout is refused: an update must never merge over local edits.
 * If any step after the merge fails, the checkout is reset to where it was,
 * so the next hook runs the old, working code.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type Mode = 'off' | 'ask' | 'auto'
export { lockPath, updateInProgress } from './updateLock.js'
import { lockPath, updateInProgress } from './updateLock.js'
import { backupMemory } from './backup.js'
import { modulesDir } from './paths.js'

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

const hashFile = (f: string) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  } catch {
    return ''
  }
}

export type Check = { branch: string; local: string; remote: string; behind: number; checkedAt: number }

export const check = (repo: string, now = Date.now()): Check => {
  const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  git(repo, 'fetch', '--quiet', 'origin', branch)
  const local = git(repo, 'rev-parse', 'HEAD')
  const remote = git(repo, 'rev-parse', `origin/${branch}`)
  const behind = Number(git(repo, 'rev-list', '--count', `HEAD..origin/${branch}`))
  return { branch, local, remote, behind, checkedAt: now }
}

export type ModuleStep = { module: string; dir: string; command: string }

/** The installed modules' `update.before` or `update.after` commands, read straight from their manifests (sync). */
export const moduleSteps = (dir: string, when: 'before' | 'after'): ModuleStep[] => {
  const out: ModuleStep[] = []
  for (const name of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).sort()) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name, 'module.json'), 'utf-8')) as { name: string; update?: { before?: string; after?: string } }
      const command = m.update?.[when]
      if (command) out.push({ module: m.name, dir: fs.realpathSync(path.join(dir, name)), command })
    } catch {
      /* not a module, or a broken link: nothing to run */
    }
  }
  return out
}

export type Steps = {
  /** Before anything changes; throwing refuses the update. */
  backup: (repo: string) => { file: string }
  /** Install dependencies for the new lockfile into `dir` (default: npm ci there). */
  installDeps: (dir: string) => void
  /** After the code is in place: cortex-install, then any data migration. */
  postUpdate: (repo: string) => void
}

const defaultSteps: Steps = {
  backup: (repo) => backupMemory('update', repo),
  installDeps: (dir) => {
    const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf-8', timeout: 600_000 })
    if (r.status !== 0) throw new Error(`npm ci: ${(r.stderr || r.stdout).trim().slice(-400)}`)
  },
  postUpdate: (repo) => {
    // Core names no module: each installed module says what it needs around an update (`update` in its
    // manifest): comms pauses and resumes its mesh daemon, memory reindexes.
    const tsx = path.join(repo, 'node_modules', '.bin', 'tsx')
    const run = (step: ModuleStep) => {
      const [script, ...args] = step.command.split(/\s+/)
      const file = script!.startsWith('core:') ? path.join(repo, script!.slice('core:'.length)) : path.join(step.dir, script!)
      const r = spawnSync(tsx, [file, ...args], { cwd: repo, encoding: 'utf-8', timeout: 300_000 })
      if (r.status !== 0) throw new Error(`${step.module} ${step.command}: ${(r.stderr || r.stdout).trim().slice(-400)}`)
    }
    for (const step of moduleSteps(modulesDir(), 'before')) run(step)
    const r = spawnSync(tsx, ['bin/cortex-install.ts', 'install', '--no-mesh-start'], { cwd: repo, encoding: 'utf-8', timeout: 300_000 })
    if (r.status !== 0) throw new Error(`cortex-install: ${(r.stderr || r.stdout).trim().slice(-400)}`)
    for (const step of moduleSteps(modulesDir(), 'after')) run(step)
  },
}

export type UpdateResult =
  | { status: 'up-to-date'; at: string }
  | { status: 'updated'; from: string; to: string; commits: string[]; depsReinstalled: boolean }
  | { status: 'refused'; reason: string }

export const update = (repo: string, stateDir: string, steps: Steps = defaultSteps): UpdateResult => {
  if (git(repo, 'status', '--porcelain')) return { status: 'refused', reason: `${repo} has local changes; commit or stash them first` }
  const nm = path.join(repo, 'node_modules')
  if (fs.existsSync(nm) && fs.statSync(nm).dev !== fs.statSync(repo).dev) {
    return { status: 'refused', reason: `${nm} is a mount point (a container's volume); this is not a deploy checkout` }
  }
  const c = check(repo)
  if (c.behind === 0) return { status: 'up-to-date', at: c.local.slice(0, 7) }
  if (updateInProgress(stateDir)) return { status: 'refused', reason: 'another update is running' }
  try {
    steps.backup(repo)
  } catch (err) {
    return { status: 'refused', reason: `no update without a backup: ${err instanceof Error ? err.message : String(err)}` }
  }

  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(lockPath(stateDir), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  const lockfile = path.join(repo, 'package-lock.json')
  const before = hashFile(lockfile)
  try {
    const commits = git(repo, 'log', '--oneline', `HEAD..origin/${c.branch}`).split('\n').filter(Boolean)
    git(repo, 'merge', '--ff-only', '--quiet', `origin/${c.branch}`)
    try {
      const depsChanged = hashFile(lockfile) !== before
      if (depsChanged) {
        const stage = fs.mkdtempSync(path.join(repo, '.deps-staging-'))
        try {
          for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, f), path.join(stage, f))
          steps.installDeps(stage)
          const old = `${nm}.old-${process.pid}`
          if (fs.existsSync(nm)) fs.renameSync(nm, old)
          fs.renameSync(path.join(stage, 'node_modules'), nm)
          fs.rmSync(old, { recursive: true, force: true })
        } finally {
          fs.rmSync(stage, { recursive: true, force: true })
        }
      }
      steps.postUpdate(repo)
      return { status: 'updated', from: c.local.slice(0, 7), to: c.remote.slice(0, 7), commits, depsReinstalled: depsChanged }
    } catch (err) {
      git(repo, 'reset', '--hard', '--quiet', c.local)
      throw new Error(`${err instanceof Error ? err.message : String(err)}; the checkout was reset to ${c.local.slice(0, 7)}`)
    }
  } finally {
    fs.rmSync(lockPath(stateDir), { force: true })
  }
}

// ── the session-start offer ─────────────────────────────────────────────────

type Prefs = { mode?: Mode; skipped?: string; last?: Check }
const prefsFile = (dataDir: string) => path.join(dataDir, 'update.json')

export const readPrefs = (dataDir: string): Prefs => {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(dataDir), 'utf-8')) as Prefs
  } catch {
    return {}
  }
}

export const writePrefs = (dataDir: string, patch: Prefs): void => {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(prefsFile(dataDir), JSON.stringify({ ...readPrefs(dataDir), ...patch }))
}

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
