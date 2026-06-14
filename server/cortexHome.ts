/**
 * CORTEX_HOME_DIR resolver — keeps a fast LOCAL CACHE FILE (`~/.config/ckn/home`)
 * that the relocatable hook shims read on the hot path. bao is an OPTIONAL central
 * source-of-truth that feeds the cache OFF the hot path; the cache file (re-read by
 * each hook fire) is what makes a mid-session relocation reach RUNNING sessions
 * without a restart.
 *
 * Design constraints (all enforced here):
 *   - HOT PATH never touches bao: hooks only `cat` the cache file (sub-ms, offline-safe).
 *   - VALIDATE-BEFORE-WRITE: a candidate must exist + look like a cortex home
 *     (package.json + bin/). A bad/stale source can NEVER overwrite a good cache and
 *     brick the hooks — on failure we keep last-good and log.
 *   - ATOMIC write: temp + fsync + rename, so a hook reading mid-rewrite never sees a
 *     torn/empty file.
 *   - Never write an empty/blank cache; an absent/empty source falls through to the
 *     derived (install) home.
 *   - CKN_HOME_SOURCE per-node knob (local | bao, default local). The home path is
 *     intrinsically per-machine + local, so there is NO remote/central bao-for-path:
 *     `local` (DEFAULT — mesh + community + laptop) derives the home from the install
 *     and NEVER attempts bao; `bao` (opt-in, scoped to a single-machine LOCAL/co-located
 *     bao) sources from bao then falls back to the derived home. The HOT PATH is identical
 *     either way — only the refresh source differs. Since a bao-for-path is always
 *     local/co-located, it is never remote-unreachable; the no-op-on-unreachable below is
 *     a cheap safety net, not load-bearing.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const HOME_CACHE_PATH = path.join(os.homedir(), '.config', 'ckn', 'home')

export type HomeSource = 'local' | 'bao'

/** Read the per-node source knob. Default + any unknown value → 'local' (offline-first,
 *  the mesh/community/laptop case). 'bao' is opt-in for a single-machine local bao. */
export function homeSource(): HomeSource {
  const raw = (process.env.CKN_HOME_SOURCE ?? '').trim().toLowerCase()
  return raw === 'bao' ? 'bao' : 'local'
}

/** Does `dir` exist and look like a cortex home (package.json + bin/)? */
export function looksLikeCortexHome(dir: string): boolean {
  if (!dir || !dir.trim()) return false
  try {
    if (!fs.statSync(dir).isDirectory()) return false
    if (!fs.existsSync(path.join(dir, 'package.json'))) return false
    return fs.statSync(path.join(dir, 'bin')).isDirectory()
  } catch {
    return false
  }
}

/** The current cached home, or null if the file is missing/blank. */
export function readHomeCache(file: string = HOME_CACHE_PATH): string | null {
  try {
    const v = fs.readFileSync(file, 'utf-8').trim()
    return v || null
  } catch {
    return null
  }
}

/** Atomic write: temp file in the same dir → fsync → rename over the target. */
function writeHomeCacheAtomic(value: string, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, value + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export interface ResolveResult {
  value: string | null
  wrote: boolean
  reason: string
}

/**
 * Pure resolve+write: choose the candidate (non-empty bao value, else derived home),
 * validate it, and atomically refresh the cache only if it changed. Never writes an
 * empty/invalid value — on failure the existing cache (last-good) is preserved.
 */
export function resolveAndWriteHomeCache(opts: {
  derivedHome: string
  baoValue?: string | null
  file?: string
}): ResolveResult {
  const file = opts.file ?? HOME_CACHE_PATH
  const bao = opts.baoValue?.trim()
  const candidate = bao ? bao : opts.derivedHome // absent/empty bao → derived (note 1)
  if (!looksLikeCortexHome(candidate)) {
    return { value: readHomeCache(file), wrote: false, reason: `not a cortex home: ${candidate || '(empty)'}` }
  }
  const current = readHomeCache(file)
  if (current === candidate) return { value: current, wrote: false, reason: 'unchanged' }
  writeHomeCacheAtomic(candidate, file)
  return { value: candidate, wrote: true, reason: current ? 'updated' : 'created' }
}

/**
 * Orchestrate a cache refresh per the CKN_HOME_SOURCE knob. `local` never calls
 * `fetchBao` (no network attempt at all); `bao`/`auto` attempt it and fall back to the
 * derived home on any failure. `fetchBao` returns the bao node-key value (or null);
 * it may throw — we swallow and fall back. Never throws.
 */
export function refreshHomeCache(opts: {
  derivedHome: string
  fetchBao?: () => string | null
  file?: string
}): ResolveResult {
  let baoValue: string | null = null
  if (homeSource() !== 'local' && opts.fetchBao) {
    try {
      baoValue = opts.fetchBao()
    } catch {
      baoValue = null // unreachable/misconfigured bao → fall back to derived
    }
  }
  return resolveAndWriteHomeCache({ derivedHome: opts.derivedHome, baoValue, file: opts.file })
}

/**
 * Best-effort fetch of the home key from a LOCAL/co-located bao — used as the default
 * `fetchBao` at boot. Only invoked when CKN_HOME_SOURCE=bao (refreshHomeCache gates it),
 * so a `local` node never shells out. The KV key is configurable (CKN_HOME_BAO_KEY,
 * default CORTEX_HOME_DIR). Returns the value or null; never throws.
 */
export function baoHomeFetcher(): string | null {
  const key = (process.env.CKN_HOME_BAO_KEY ?? 'CORTEX_HOME_DIR').trim() || 'CORTEX_HOME_DIR'
  try {
    const out = execFileSync('bao-run', [key, '--', 'printenv', key], {
      encoding: 'utf-8',
      timeout: 8000,
    })
    return out.trim() || null
  } catch {
    return null
  }
}
