/**
 * Disk-free-space guard — the preventive for the SIGBUS / disk-full crash vector.
 *
 * The 2026-06-09 corrected RCA (see [[cortex-node-segfault-coredump-rca]]): the
 * ~daily `node` crashes were SIGBUS (signal 7) = memory-mapping faults caused by
 * the WSL host disk (C:) filling — core dumps + a fresh 5 GB swap.vhdx per crash.
 * Environmental, not a code defect. Corey's decision #3: monitor free space and
 * ALERT before it fills, rather than surgery on the embedding worker. This guard
 * periodically checks the relevant disks and logs LOUD (with a cooldown) when low.
 *
 * Pure decision (`diskAlertLevel`) is unit-tested; the I/O wrapper does `statfs` +
 * a `setInterval`. A missing/unreadable path (e.g. `/mnt/c` on a non-WSL box)
 * never alarms — silence beats crying wolf.
 */
import { statfs } from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as os from 'node:os'

const GB = 1024 ** 3

export type DiskLevel = 'ok' | 'warn' | 'critical'

export interface DiskPolicy {
  warnGb: number
  critGb: number
  warnPct: number
  critPct: number
}

/** Defaults: absolute-GB is the trigger (matches the failure — ran out of room
 *  for a 5 GB swap / large dump). Percent is OFF by default (0) because on a large
 *  disk a few-percent floor cries wolf at tens of GB free; enable the percent
 *  floors via env for genuinely small disks. All env-tunable. */
export const DEFAULT_DISK_POLICY: DiskPolicy = { warnGb: 10, critGb: 2, warnPct: 0, critPct: 0 }

export interface DiskReading {
  freeBytes: number
  totalBytes: number
}
export interface DiskStatus {
  level: DiskLevel
  freeGb: number
  freePct: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Classify a disk reading. `critical` if free is below EITHER the GB or the
 * percent critical threshold; else `warn` on either warn threshold; else `ok`.
 * A zero/unknown total is treated as 100% free so a failed/odd reading never
 * false-alarms.
 */
export function diskAlertLevel(r: DiskReading, policy: DiskPolicy = DEFAULT_DISK_POLICY): DiskStatus {
  const freeGb = r.freeBytes / GB
  // No valid total → can't assess; never alarm on a bogus/empty reading. (A truly
  // FULL disk has totalBytes > 0 and freeBytes 0 → still classified below.)
  if (!(r.totalBytes > 0)) return { level: 'ok', freeGb: round1(freeGb), freePct: 100 }
  const freePct = (r.freeBytes / r.totalBytes) * 100
  let level: DiskLevel = 'ok'
  if (freeGb < policy.warnGb || freePct < policy.warnPct) level = 'warn'
  if (freeGb < policy.critGb || freePct < policy.critPct) level = 'critical'
  return { level, freeGb: round1(freeGb), freePct: round1(freePct) }
}

/** Build a policy from env, falling back to DEFAULT_DISK_POLICY for any unset or
 *  non-numeric value. Env: CKN_DISK_{WARN,CRIT}_{GB,PCT}. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): DiskPolicy {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    warnGb: num(env.CKN_DISK_WARN_GB, DEFAULT_DISK_POLICY.warnGb),
    critGb: num(env.CKN_DISK_CRIT_GB, DEFAULT_DISK_POLICY.critGb),
    warnPct: num(env.CKN_DISK_WARN_PCT, DEFAULT_DISK_POLICY.warnPct),
    critPct: num(env.CKN_DISK_CRIT_PCT, DEFAULT_DISK_POLICY.critPct),
  }
}

export interface DiskPathStatus extends DiskStatus {
  path: string
  error?: string
}

/** statfs each path → classify. An unreadable path yields {level:'ok', error} so
 *  a not-present mount (e.g. /mnt/c off-WSL) never triggers an alert. */
export async function checkDiskPaths(
  paths: string[],
  policy: DiskPolicy = DEFAULT_DISK_POLICY,
): Promise<DiskPathStatus[]> {
  const out: DiskPathStatus[] = []
  for (const p of paths) {
    try {
      const s = await statfs(p)
      const freeBytes = Number(s.bavail) * Number(s.bsize)
      const totalBytes = Number(s.blocks) * Number(s.bsize)
      out.push({ path: p, ...diskAlertLevel({ freeBytes, totalBytes }, policy) })
    } catch (e: any) {
      out.push({ path: p, level: 'ok', freeGb: 0, freePct: 100, error: String(e?.message ?? e) })
    }
  }
  return out
}

/** Disks worth watching: the WSL disk holding the graph/home, plus `/mnt/c` (the
 *  Windows host drive where WSL core dumps + swap.vhdx land — the SIGBUS root). */
export function defaultDiskPaths(): string[] {
  const paths = [os.homedir()]
  try {
    if (fsSync.existsSync('/mnt/c')) paths.push('/mnt/c')
  } catch {
    /* ignore */
  }
  return paths
}

const ALERT_COOLDOWN_MS = 10 * 60 * 1000 // don't re-log the same path's alert more often
let _lastStatus: DiskPathStatus[] = []
const _lastAlertAt = new Map<string, number>()

/** Most recent check result (for a status surface / the UI). */
export function getLastDiskStatus(): DiskPathStatus[] {
  return _lastStatus
}

/** Run one check, cache it, and log warn/critical paths (cooldown-gated). Returns
 *  the readings. `now` is injectable for tests. */
export async function runDiskCheck(
  paths: string[],
  policy: DiskPolicy = DEFAULT_DISK_POLICY,
  now: number = Date.now(),
): Promise<DiskPathStatus[]> {
  const res = await checkDiskPaths(paths, policy)
  _lastStatus = res
  for (const r of res) {
    if (r.level === 'ok') continue
    const last = _lastAlertAt.get(r.path) ?? 0
    if (now - last < ALERT_COOLDOWN_MS) continue
    _lastAlertAt.set(r.path, now)
    const head = `[ckn disk] ${r.level.toUpperCase()}: ${r.path} — ${r.freeGb} GB free (${r.freePct}%)`
    if (r.level === 'critical') {
      console.error(
        `${head} !! free space NOW — this is the disk-full/SIGBUS crash vector (WSL writes dumps + swap.vhdx here).`,
      )
    } else {
      console.warn(`${head} — getting low; clear space before it reaches the crash threshold.`)
    }
  }
  return res
}

/**
 * Start the periodic guard (singleton-ish; returns the timer so callers can stop
 * it). Disabled via CKN_DISK_GUARD=off. Runs an immediate check at boot, then
 * every CKN_DISK_CHECK_MS (default 60 s). Unref'd so it never holds the process.
 */
export function startDiskGuard(opts?: {
  paths?: string[]
  policy?: DiskPolicy
  intervalMs?: number
}): NodeJS.Timeout | null {
  if ((process.env.CKN_DISK_GUARD ?? '').toLowerCase() === 'off') return null
  const paths = opts?.paths ?? defaultDiskPaths()
  const policy = opts?.policy ?? policyFromEnv()
  const intervalMs = opts?.intervalMs ?? Number(process.env.CKN_DISK_CHECK_MS ?? 60_000)
  void runDiskCheck(paths, policy).catch(() => {})
  const h = setInterval(() => {
    void runDiskCheck(paths, policy).catch(() => {})
  }, intervalMs)
  h.unref()
  return h
}
