#!/usr/bin/env tsx
/**
 * ckn-update — one-shot per-node "pull latest from origin (GitHub) + restart cleanly".
 * Idempotent. Codifies the fleet's 3 lifecycle shapes + a CLEAN offline no-op:
 *   - origin UNREACHABLE (e.g. laptop off-VLAN) → clean no-op, nothing fetched/touched,
 *     so a node can never land half-applied; it resumes on the next run when reachable.
 *   - origin != GitHub (a not-yet-repointed node) → first-time repoint (rename remotes
 *     + disjoint-history checkout of origin/main); otherwise a fast-forward update.
 *   - restart by lifecycle: systemd (zw1) → `systemctl --user restart` + Main-PID verify;
 *     non-systemd (zwd/laptop) → bin/ckn-reboot (coordinated). `--no-restart` leaves a
 *     clean tree for the nightly power-cycle.
 * Refuses (no half-apply) on a dirty tree or a non-fast-forward divergence; the manual
 * runbook (/personal/docs/cortex/runbooks/2026-06-14-fleet-repoint-zw2-laptop.md) is the
 * fallback for those.
 *
 * The decision is planUpdate() (pure, unit-tested); the git mechanics repoint()/apply()
 * are exported + integration-tested against throwaway repos; the executor below gathers
 * state, calls the planner, and runs the chosen git + restart mechanics.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── pure planner (unit-tested) ───────────────────────────────────────────────
export type Lifecycle = 'systemd' | 'process'
export type Restart = 'systemd' | 'reboot' | 'none'
export type UpdateAction =
  | 'noop-offline'
  | 'repoint'
  | 'up-to-date'
  | 'refuse-dirty'
  | 'refuse-diverged'
  | 'apply'

export interface UpdateState {
  originReachable: boolean
  originIsGithub: boolean
  behind: number
  dirty: boolean
  ffable: boolean
  lifecycle: Lifecycle
  noRestart: boolean
  /** package.json differs from the target tree → a down-window `npm ci` is required. */
  depsChanged: boolean
}
export interface UpdatePlan {
  action: UpdateAction
  restart: Restart
  /** true when the chosen restart must run `npm ci` in its down window (deps changed). */
  npmCi: boolean
  message: string
}

export function planUpdate(s: UpdateState): UpdatePlan {
  const lcRestart: Restart = s.noRestart ? 'none' : s.lifecycle === 'systemd' ? 'systemd' : 'reboot'
  // 1. Offline = clean no-op. Nothing is fetched/touched → never half-applied; the run
  //    is simply retried later when the origin is reachable (the laptop off-VLAN case).
  if (!s.originReachable)
    return {
      action: 'noop-offline',
      restart: 'none',
      npmCi: false,
      message: 'origin unreachable — skipped (no changes applied); rerun when on-network',
    }
  // 2. Not yet repointed (origin still GitLab) → first-time repoint, but NEVER over a
  //    dirty tree (the disjoint-history checkout would clobber/refuse).
  if (!s.originIsGithub) {
    if (s.dirty)
      return {
        action: 'refuse-dirty',
        restart: 'none',
        npmCi: false,
        message: 'working tree dirty — refusing first-time repoint; commit/stash or use the manual runbook',
      }
    return applying('repoint', lcRestart, s, 'origin not on GitHub — performing first-time repoint to origin/main')
  }
  // 3. Already on GitHub → fast-forward update path.
  if (s.behind === 0) return { action: 'up-to-date', restart: 'none', npmCi: false, message: 'already up to date' }
  if (s.dirty)
    return {
      action: 'refuse-dirty',
      restart: 'none',
      npmCi: false,
      message: 'working tree dirty — refusing update; commit/stash first',
    }
  if (!s.ffable)
    return {
      action: 'refuse-diverged',
      restart: 'none',
      npmCi: false,
      message: 'local diverged from origin (not fast-forward) — refusing; reconcile manually',
    }
  return applying('apply', lcRestart, s, `applying ${s.behind} new commit(s) via fast-forward`)
}

/**
 * Shared tail for the two tree-changing actions (apply, repoint). Folds in the
 * dependency-sync decision: when package.json changed, a `npm ci` must run in a DOWN
 * window (nothing on the boot path runs it, and `npm ci` while the server is UP hits
 * EACCES on tsx-in-use). systemd satisfies it in-band (stop→ci→start); the SHARED
 * non-systemd box can't slot a ci inside ckn-reboot's announce-protected window, so it
 * applies the git change but REFUSES the auto-restart and hands back the manual sequence.
 */
function applying(action: 'apply' | 'repoint', lcRestart: Restart, s: UpdateState, base: string): UpdatePlan {
  if (!s.depsChanged) return { action, restart: lcRestart, npmCi: false, message: base }
  if (lcRestart === 'systemd')
    return { action, restart: 'systemd', npmCi: true, message: `${base}; deps changed → stop, npm ci, start` }
  if (lcRestart === 'reboot')
    return {
      action,
      restart: 'none',
      npmCi: true,
      message: `${base}; deps changed → applied, but NOT auto-restarting: run a coordinated down-window (announce, stop, npm ci, start) — the boot path does not npm ci`,
    }
  // --no-restart: tree changed + deps changed, restart deferred to the next boot
  return {
    action,
    restart: 'none',
    npmCi: true,
    message: `${base}; deps changed → run npm ci in a down-window before the next boot (boot loads stale node_modules otherwise)`,
  }
}

// ── git mechanics (integration-tested against throwaway repos) ────────────────
export type GitRun = (args: string[], timeout?: number) => Promise<string>

/**
 * First-time repoint of a node's `origin` to GitHub. Idempotent: re-derives remote state
 * at EACH step (never trusts a stale snapshot — the bug that broke the single-remote
 * zw2/laptop case) and uses `checkout -B`, so a re-run, or a re-run after a partial/failed
 * repoint, converges to origin=GitHub instead of dead-ending.
 */
export async function repoint(git: GitRun, githubUrl: string, branch: string, backupStamp: string): Promise<void> {
  const remotes = async (): Promise<string[]> => (await git(['remote']).catch(() => '')).split('\n').filter(Boolean)
  const urlOf = async (r: string): Promise<string> => git(['remote', 'get-url', r]).catch(() => '')

  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  await git(['branch', `backup-pre-repoint-${backupStamp}`, current]).catch(() => {})

  // 1. If origin still points at a non-GitHub remote, move it aside to `gitlab`
  //    (or drop it if a gitlab remote already preserves that url).
  if ((await remotes()).includes('origin') && !(await urlOf('origin')).includes('github.com')) {
    if (!(await remotes()).includes('gitlab')) await git(['remote', 'rename', 'origin', 'gitlab'])
    else await git(['remote', 'remove', 'origin'])
  }
  // 2. Ensure origin == GitHub: promote an existing `github` remote, else add/repoint it.
  if (!(await remotes()).includes('origin')) {
    if ((await remotes()).includes('github')) await git(['remote', 'rename', 'github', 'origin'])
    else await git(['remote', 'add', 'origin', githubUrl])
  } else if (!(await urlOf('origin')).includes('github.com')) {
    await git(['remote', 'set-url', 'origin', githubUrl])
  }
  await git(['fetch', 'origin', '--prune'], 120_000)
  // disjoint-history swap; -B = create-or-reset → idempotent on re-run.
  await git(['checkout', '-B', branch, `origin/${branch}`])
}

/** Fast-forward the current branch onto origin/<branch>. */
export async function apply(git: GitRun, branch: string): Promise<void> {
  await git(['merge', '--ff-only', `origin/${branch}`])
}

// ── executor (runs only when invoked directly as a CLI, never on import) ──────
const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')
const GITHUB_URL = 'git@github.com:cz-zwtech/cortex.git'
const execFileP = promisify(execFile)

const arg = (f: string): string | undefined => {
  const i = process.argv.indexOf(f)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const hasFlag = (f: string): boolean => process.argv.includes(f)

const git: GitRun = async (args, timeout = 60_000) => {
  const { stdout } = await execFileP('git', ['-C', REPO_ROOT, ...args], { timeout, encoding: 'utf-8' })
  return stdout.trim()
}
const gitOk = async (args: string[], timeout = 60_000): Promise<boolean> => {
  try {
    await git(args, timeout)
    return true
  } catch {
    return false
  }
}

/** systemd lifecycle iff a `cortex.service` --user unit is active. */
const userEnv = (): NodeJS.ProcessEnv => {
  const xdg = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}`
  return {
    ...process.env,
    XDG_RUNTIME_DIR: xdg,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${xdg}/bus`,
  }
}
const detectLifecycle = async (): Promise<Lifecycle> => {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'is-active', 'cortex.service'], {
      env: userEnv(),
      encoding: 'utf-8',
      timeout: 10_000,
    })
    return stdout.trim() === 'active' ? 'systemd' : 'process'
  } catch {
    return 'process'
  }
}

/** true iff <file> differs between HEAD and the target ref. */
const pathChanged = async (target: string, file: string): Promise<boolean> =>
  !(await gitOk(['diff', '--quiet', 'HEAD', target, '--', file]))

interface Gathered {
  state: UpdateState
  /** package-lock changed but package.json did not (node_modules still satisfies) — hygiene-only. */
  lockOnly: boolean
}
const gatherState = async (branch: string, repointBranch: string, noRestart: boolean): Promise<Gathered> => {
  const originUrl = await git(['remote', 'get-url', 'origin']).catch(() => '')
  const originIsGithub = originUrl.includes('github.com')
  // reachability of the GitHub target (origin when already github, else the canonical url)
  const reachTarget = originIsGithub ? 'origin' : GITHUB_URL
  const originReachable = await gitOk(['ls-remote', '--exit-code', reachTarget, 'HEAD'], 15_000)
  const dirty = (await git(['status', '--porcelain']).catch(() => '')) !== ''
  let behind = 0
  let ffable = true
  let depsChanged = false
  let lockOnly = false
  let target = ''
  if (originReachable && originIsGithub) {
    await gitOk(['fetch', 'origin', branch], 60_000)
    behind = Number(await git(['rev-list', '--count', `HEAD..origin/${branch}`]).catch(() => '0')) || 0
    ffable = await gitOk(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`])
    if (behind > 0) target = `origin/${branch}`
  } else if (originReachable && !originIsGithub && !dirty) {
    // repoint path: peek the GitHub target tree to decide if a down-window npm ci is needed.
    // If the peek fetch fails (transient), fail SAFE — assume deps changed so the ci path runs,
    // rather than silently restarting against possibly-stale node_modules.
    if (await gitOk(['fetch', GITHUB_URL, repointBranch], 120_000)) target = 'FETCH_HEAD'
    else depsChanged = true
  }
  if (target) {
    depsChanged = await pathChanged(target, 'package.json')
    lockOnly = !depsChanged && (await pathChanged(target, 'package-lock.json'))
  }
  return {
    state: { originReachable, originIsGithub, behind, dirty, ffable, depsChanged, lifecycle: await detectLifecycle(), noRestart },
    lockOnly,
  }
}

const stamp = (): string => {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

const mainPid = (): Promise<string> =>
  execFileP('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'cortex.service'], { env: userEnv(), encoding: 'utf-8' })
    .then((r) => r.stdout.trim())
    .catch(() => '?')

const restartSystemd = async (): Promise<string> => {
  const before = await mainPid()
  await execFileP('systemctl', ['--user', 'restart', 'cortex.service'], { env: userEnv(), timeout: 60_000 })
  const after = await mainPid()
  const warn = before !== '?' && before === after ? ' (WARNING: unchanged — restart may have no-opped; check XDG_RUNTIME_DIR)' : ''
  return `Main PID ${before} → ${after}${warn}`
}
/** deps-changed systemd path: stop → npm ci (down window, server off) → start. */
const restartSystemdWithCi = async (): Promise<string> => {
  const before = await mainPid()
  await execFileP('systemctl', ['--user', 'stop', 'cortex.service'], { env: userEnv(), timeout: 60_000 })
  await execFileP('npm', ['ci'], { cwd: REPO_ROOT, timeout: 600_000, env: process.env })
  await execFileP('systemctl', ['--user', 'start', 'cortex.service'], { env: userEnv(), timeout: 60_000 })
  return `stop → npm ci → start; Main PID ${before} → ${await mainPid()}`
}
const restartReboot = async (): Promise<string> => {
  await execFileP(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [path.join(REPO_ROOT, 'bin', 'ckn-reboot.ts'), '--reason', 'ckn-update'], { cwd: REPO_ROOT, timeout: 120_000, env: process.env })
  return 'ckn-reboot completed'
}

const verify = async (): Promise<{ ok: boolean; text: string }> => {
  try {
    const { stdout } = await execFileP('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:3001/api/bus/mesh-status'], { timeout: 10_000, encoding: 'utf-8' })
    const code = stdout.trim()
    return { ok: code.startsWith('2'), text: `:3001 → HTTP ${code}` }
  } catch {
    return { ok: false, text: ':3001 → unreachable' }
  }
}

async function main(): Promise<void> {
  const branch = arg('--branch') ?? ((await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main')) || 'main')
  const noRestart = hasFlag('--no-restart')
  const dryRun = hasFlag('--dry-run')
  const repointBranch = !((await git(['remote', 'get-url', 'origin']).catch(() => '')).includes('github.com')) ? 'main' : branch

  const { state, lockOnly } = await gatherState(branch, repointBranch, noRestart)
  const plan = planUpdate(state)
  console.log(
    `[ckn-update] repo=${REPO_ROOT}\n  state: ${JSON.stringify(state)}\n  plan:  ${plan.action} (restart=${plan.restart}, npmCi=${plan.npmCi}) — ${plan.message}`,
  )
  if (lockOnly)
    console.log('[ckn-update] note: package-lock.json changed (package.json unchanged) — node_modules still satisfies; optional `npm ci` hygiene in a future down-window.')
  if (dryRun) {
    console.log('[ckn-update] --dry-run: no changes made.')
    return
  }
  // refusals / no-ops: print + exit (non-zero only for the refuse-* guards)
  if (plan.action === 'noop-offline' || plan.action === 'up-to-date') return
  if (plan.action === 'refuse-dirty' || plan.action === 'refuse-diverged') {
    console.error(`[ckn-update] ${plan.action}: ${plan.message}`)
    process.exit(2)
  }
  if (plan.action === 'repoint') {
    if (!hasFlag('--yes')) {
      console.error('[ckn-update] first-time repoint is structural — re-run with --yes (or use the manual runbook).')
      process.exit(3)
    }
    await repoint(git, GITHUB_URL, repointBranch, stamp())
    console.log('[ckn-update] repointed origin → GitHub, on', repointBranch)
  } else if (plan.action === 'apply') {
    await apply(git, branch)
    console.log('[ckn-update] fast-forwarded', branch)
  }
  // restart per lifecycle (+ dependency sync)
  if (plan.restart === 'systemd') {
    console.log('[ckn-update] systemd', plan.npmCi ? 'stop→ci→start:' : 'restart:', plan.npmCi ? await restartSystemdWithCi() : await restartSystemd())
  } else if (plan.restart === 'reboot') {
    console.log('[ckn-update] reboot:', await restartReboot())
  } else if (plan.npmCi) {
    // tree applied, but deps changed on a shared/non-systemd box → can't auto-restart safely
    console.log(`[ckn-update] DEPS-CHANGED — manual restart required: ${plan.message}`)
  } else {
    console.log('[ckn-update] tree updated; restart deferred (power-cycle or ckn-reboot will load it).')
  }
  // health-check after any restart; fail LOUD (non-zero) so a fleet run can't report success
  // over a down server. Recovery = the backup branch (repoint) / pre-merge HEAD (apply).
  if (plan.restart !== 'none') {
    const v = await verify()
    console.log('[ckn-update] verify:', v.text)
    if (!v.ok) {
      console.error(
        `[ckn-update] HEALTHCHECK FAILED — :3001 not healthy after restart. Recover from backup-pre-repoint-${stamp()} (repoint) or the pre-merge HEAD (apply), then investigate.`,
      )
      process.exit(4)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error('[ckn-update]', e?.message ?? e)
    process.exit(1)
  })
}
