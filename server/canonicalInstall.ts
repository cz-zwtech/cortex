/**
 * FR #154 — "only the canonical install may register". A single predicate that
 * decides whether THIS server boot may write real user state (the ~/.config/ckn/home
 * cache, the settings.json CORTEX_HOME_DIR env, and the 7 hook-command fallbacks).
 * All three vectors live downstream of one gate in hookRegistrar.ensureStopHook, so
 * a non-canonical boot (a git worktree, a throwaway clone, a spawned test server)
 * writes NONE of them and cannot hijack the live install's home pointer.
 *
 * The core `isCanonicalInstall` is PURE (no FS/exec) so the full branch matrix is
 * unit-testable. Two impurities are pushed to the caller / a thin wrapper:
 *   - linked-worktree detection needs git  -> `detectLinkedWorktree` (exec).
 *   - symlink-equality of the two paths     -> the wiring realpath-resolves both
 *     sides before calling (realpath needs the FS). The pure predicate still
 *     normalizes trailing-slash / `.` / `..` via path.resolve so a lexical
 *     mismatch cannot make the canonical fail to self-identify (PM note A).
 *
 * Known limitation (PM note B): a canonical install that is ITSELF a linked git
 * worktree can never register — branch 1 wins even over CKN_CANONICAL_INSTALL.
 * Pathological and acceptable: canonical installs are the main checkout.
 */
import path from 'node:path'
import os from 'node:os'
import fsSync from 'node:fs'
import { execFileSync } from 'node:child_process'

export interface CanonicalInput {
  /** PROJECT_ROOT of this boot (the install's own path). */
  projectRoot: string
  /** Contents of ~/.config/ckn/home, or null if the file is absent/empty. */
  homeFileValue: string | null
  /** Whether homeFileValue resolves to an existing directory. */
  homeDirExists: boolean
  /** git-dir !== git-common-dir for projectRoot (a linked worktree). */
  isLinkedWorktree: boolean
  /** CKN_CANONICAL_INSTALL is truthy. */
  explicitCanonical: boolean
}

export type CanonicalReason =
  | 'linked-worktree'
  | 'explicit-flag'
  | 'first-install'
  | 'recovery'
  | 'canonical-heal'
  | 'different-canonical-exists'

export interface CanonicalDecision {
  register: boolean
  reason: CanonicalReason
}

/** Lexical normalization: strips trailing sep, resolves `.`/`..`. Pure. Symlink
 *  resolution is the caller's job (realpath before calling). */
const norm = (p: string): string => path.resolve(p)

export const isCanonicalInstall = (i: CanonicalInput): CanonicalDecision => {
  // 1. A linked worktree is NEVER the canonical install — wins over everything,
  //    even a coincident path or an explicit flag.
  if (i.isLinkedWorktree) return { register: false, reason: 'linked-worktree' }
  // 2. Explicit opt-in: a legitimately relocated copy whose old dir still exists.
  if (i.explicitCanonical) return { register: true, reason: 'explicit-flag' }
  // 3. No canonical yet (fresh install) or a dangling pointer (recovery) -> claim it.
  if (!i.homeFileValue) return { register: true, reason: 'first-install' }
  if (!i.homeDirExists) return { register: true, reason: 'recovery' }
  // 4. The known canonical re-registering — heals any drift. NORMALIZED compare.
  if (norm(i.projectRoot) === norm(i.homeFileValue)) return { register: true, reason: 'canonical-heal' }
  // 5. A different live canonical already owns the home pointer — do not steal it.
  return { register: false, reason: 'different-canonical-exists' }
}

/**
 * Whether `projectRoot` is a linked git worktree (git-dir !== git-common-dir).
 * Impure (shells out to git). git absent / not-a-repo -> false (a normal install).
 */
export const detectLinkedWorktree = (projectRoot: string): boolean => {
  try {
    const run = (arg: string): string =>
      execFileSync('git', ['-C', projectRoot, 'rev-parse', arg], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const gitDir = path.resolve(projectRoot, run('--git-dir'))
    const commonDir = path.resolve(projectRoot, run('--git-common-dir'))
    return gitDir !== commonDir
  } catch {
    return false
  }
}

/** Best-effort realpath; falls back to the input if the path does not exist. */
const realpathOr = (p: string): string => {
  try {
    return fsSync.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Impure composition: gather the FS/git/env inputs and defer to isCanonicalInstall.
 * Reads the home cache FILE, resolves its existence, realpath-resolves BOTH sides
 * (so a symlinked install still self-identifies — PM note A, complementing the
 * pure predicate's lexical normalization), detects a linked worktree, and reads
 * CKN_CANONICAL_INSTALL. Injectable (homeFilePath, env) for tests.
 */
export const decideCanonicalInstall = (opts: {
  projectRoot: string
  homeFilePath?: string
  env?: Record<string, string | undefined>
}): CanonicalDecision => {
  const env = opts.env ?? process.env
  const homeFilePath =
    opts.homeFilePath ?? path.join(os.homedir(), '.config', 'ckn', 'home')

  let homeFileValue: string | null = null
  try {
    homeFileValue = fsSync.readFileSync(homeFilePath, 'utf8').trim() || null
  } catch {
    homeFileValue = null
  }

  let homeDirExists = false
  let resolvedHome = homeFileValue
  if (homeFileValue) {
    try {
      homeDirExists = fsSync.statSync(homeFileValue).isDirectory()
    } catch {
      homeDirExists = false
    }
    if (homeDirExists) resolvedHome = realpathOr(homeFileValue)
  }

  return isCanonicalInstall({
    projectRoot: realpathOr(opts.projectRoot),
    homeFileValue: resolvedHome,
    homeDirExists,
    isLinkedWorktree: detectLinkedWorktree(opts.projectRoot),
    explicitCanonical: Boolean(env.CKN_CANONICAL_INSTALL),
  })
}
