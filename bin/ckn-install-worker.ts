#!/usr/bin/env tsx
/**
 * ckn-install-worker — automate the worker-mode setup that the
 * a headless-server deploy walked through manually.
 *
 *   - Generates ~/.config/systemd/user/cortex.service pointing at
 *     bin/cortex-runner.sh (nvm-agnostic launcher).
 *   - Runs `loginctl enable-linger <user>` so user services persist
 *     across logout (requires sudo — falls back to printing the
 *     command if no sudo).
 *   - Reloads systemd and enables + starts cortex.service.
 *   - Optionally configures the cortex-mind remote and syncs via the
 *     --remote flag.
 *
 * Reduces a 30-min manual sequence to one CLI invocation:
 *
 *     npx tsx bin/ckn-install-worker.ts
 *     npx tsx bin/ckn-install-worker.ts --remote git@github.com:<your-org>/your-shared-mind.git
 *
 * Idempotent — safe to re-run. Skips work that's already done.
 *
 * Designed for Linux only (uses systemd). macOS workers would need a
 * launchd equivalent — not built; flag and bail.
 */
import * as fsp from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const UNIT_NAME = 'cortex.service'
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user')
const UNIT_PATH = path.join(UNIT_DIR, UNIT_NAME)

interface CliArgs {
  remote: string | null
  skipShared: boolean
  dryRun: boolean
}

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2)
  const out: CliArgs = { remote: null, skipShared: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') out.remote = argv[++i] ?? null
    else if (a === '--skip-shared') out.skipShared = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage:\n' +
          '  ckn-install-worker                              install systemd unit + start\n' +
          '  ckn-install-worker --remote <git-url>           also configure cortex-mind + sync\n' +
          '  ckn-install-worker --skip-shared                skip the shared-mind step\n' +
          '  ckn-install-worker --dry-run                    print actions, do nothing\n',
      )
      process.exit(0)
    }
  }
  return out
}

const exec = async (
  cmd: string,
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
    child.on('error', (e) => {
      if (opts.allowFail) resolve({ code: 127, stdout: '', stderr: String(e) })
      else throw e
    })
  })

const log = (msg: string): void => console.log(`[ckn-install-worker] ${msg}`)
const warn = (msg: string): void => console.warn(`[ckn-install-worker] ⚠ ${msg}`)

// ── platform check ─────────────────────────────────────────────────────────

const checkPlatform = (): void => {
  if (os.platform() !== 'linux') {
    console.error(
      `[ckn-install-worker] this CLI is Linux-only (uses systemd user units). ` +
        `Detected platform: ${os.platform()}. ` +
        `For macOS workers, see the README's manual setup section.`,
    )
    process.exit(2)
  }
  // systemctl must exist
  if (!fsSync.existsSync('/usr/bin/systemctl') && !fsSync.existsSync('/bin/systemctl')) {
    console.error(
      `[ckn-install-worker] systemctl not found. This box doesn't appear to use systemd.`,
    )
    process.exit(2)
  }
}

// ── linger ─────────────────────────────────────────────────────────────────

const checkLinger = async (): Promise<boolean> => {
  const username = os.userInfo().username
  const r = await exec('loginctl', ['show-user', username, '--property=Linger'], { allowFail: true })
  return r.stdout.trim() === 'Linger=yes'
}

const enableLinger = async (dryRun: boolean): Promise<void> => {
  if (await checkLinger()) {
    log('linger: already enabled — skipping')
    return
  }
  const username = os.userInfo().username
  log(`linger: enabling for user '${username}' (requires sudo)`)
  if (dryRun) {
    log(`  (dry-run) sudo loginctl enable-linger ${username}`)
    return
  }
  const r = await exec('sudo', ['loginctl', 'enable-linger', username], { allowFail: true })
  if (r.code !== 0) {
    warn(
      `linger enable failed (exit ${r.code}). Run manually:\n` +
        `   sudo loginctl enable-linger ${username}\n` +
        `Without linger, the cortex service will stop when you log out.`,
    )
  } else {
    log('linger: enabled')
  }
}

// ── unit file ──────────────────────────────────────────────────────────────

const renderUnit = (): string => {
  const home = os.homedir()
  const localBin = path.join(home, '.local', 'bin')
  return [
    '[Unit]',
    'Description=Cortex (CKN) — graph memory + monitoring server',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${PROJECT_ROOT}`,
    'Environment=CKN_BIND=0.0.0.0',
    'Environment=CKN_FORCE_SERVER=1',
    `Environment=NVM_DIR=${path.join(home, '.nvm')}`,
    // Belt-and-suspenders PATH — cortex-runner.sh sources nvm.sh which
    // adjusts PATH dynamically, but we set a sane default in case.
    `Environment=PATH=${localBin}:/usr/local/bin:/usr/bin:/bin`,
    `ExecStart=${path.join(PROJECT_ROOT, 'bin', 'cortex-runner.sh')}`,
    'Restart=on-failure',
    'RestartSec=5',
    `StandardOutput=append:${path.join(PROJECT_ROOT, 'cortex.log')}`,
    `StandardError=append:${path.join(PROJECT_ROOT, 'cortex.log')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

const writeUnit = async (dryRun: boolean): Promise<'created' | 'updated' | 'unchanged'> => {
  const desired = renderUnit()
  let existing: string | null = null
  try {
    existing = await fsp.readFile(UNIT_PATH, 'utf-8')
  } catch {
    // not yet
  }
  if (existing === desired) {
    log(`unit: unchanged at ${UNIT_PATH}`)
    return 'unchanged'
  }
  if (dryRun) {
    log(`(dry-run) would write ${UNIT_PATH}:`)
    console.log(desired.split('\n').map((l) => `  | ${l}`).join('\n'))
    return existing ? 'updated' : 'created'
  }
  await fsp.mkdir(UNIT_DIR, { recursive: true })
  await fsp.writeFile(UNIT_PATH, desired, 'utf-8')
  log(`unit: ${existing ? 'updated' : 'created'} at ${UNIT_PATH}`)
  return existing ? 'updated' : 'created'
}

// ── runner script perms ────────────────────────────────────────────────────

const ensureRunnerExecutable = async (dryRun: boolean): Promise<void> => {
  const runnerPath = path.join(PROJECT_ROOT, 'bin', 'cortex-runner.sh')
  if (!fsSync.existsSync(runnerPath)) {
    console.error(
      `[ckn-install-worker] missing ${runnerPath} — pull latest from git, then re-run.`,
    )
    process.exit(2)
  }
  const stat = await fsp.stat(runnerPath)
  // Need executable bit on owner; 0o100 = owner-execute.
  if ((stat.mode & 0o100) !== 0) return
  if (dryRun) {
    log(`(dry-run) chmod +x ${runnerPath}`)
    return
  }
  await fsp.chmod(runnerPath, stat.mode | 0o755)
  log('runner: chmod +x applied')
}

// ── systemctl ──────────────────────────────────────────────────────────────

const reloadEnableStart = async (dryRun: boolean): Promise<void> => {
  if (dryRun) {
    log('(dry-run) systemctl --user daemon-reload')
    log(`(dry-run) systemctl --user enable --now ${UNIT_NAME}`)
    return
  }
  const reload = await exec('systemctl', ['--user', 'daemon-reload'], { allowFail: true })
  if (reload.code !== 0) {
    warn(`systemctl daemon-reload failed: ${reload.stderr.trim() || reload.code}`)
    return
  }
  const enable = await exec(
    'systemctl',
    ['--user', 'enable', '--now', UNIT_NAME],
    { allowFail: true },
  )
  if (enable.code !== 0) {
    warn(
      `enable --now failed (exit ${enable.code}): ${enable.stderr.trim()}\n` +
        `   Try: journalctl --user -u ${UNIT_NAME} --no-pager | tail`,
    )
    return
  }
  log(`systemctl: ${UNIT_NAME} enabled + started`)
}

const showStatus = async (): Promise<void> => {
  const r = await exec('systemctl', ['--user', '--no-pager', 'status', UNIT_NAME], { allowFail: true })
  // Status non-zero just means the unit isn't active yet — print whatever it gave us.
  const lines = r.stdout.split('\n').slice(0, 6)
  for (const line of lines) console.log(`    ${line}`)
}

// ── shared-mind bootstrap ──────────────────────────────────────────────────

const bootstrapShared = async (remoteUrl: string, dryRun: boolean): Promise<void> => {
  log(`shared-mind: configuring + syncing ${remoteUrl}`)
  if (dryRun) {
    log(`(dry-run) would run ckn-sync-shared --remote ${remoteUrl}`)
    return
  }
  // Server should be up after enable+start. Give it a moment.
  await new Promise((r) => setTimeout(r, 2000))
  const tsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
  const script = path.join(PROJECT_ROOT, 'bin', 'ckn-sync-shared.ts')
  const r = await exec(tsx, [script, '--remote', remoteUrl], { allowFail: true })
  // Forward output for visibility.
  if (r.stdout) console.log(r.stdout.trimEnd())
  if (r.stderr) console.error(r.stderr.trimEnd())
  if (r.code !== 0) warn(`ckn-sync-shared exited ${r.code}`)
}

// ── main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const args = parseArgs()
  log(`starting${args.dryRun ? ' (dry-run)' : ''}`)
  log(`project root: ${PROJECT_ROOT}`)

  checkPlatform()
  await ensureRunnerExecutable(args.dryRun)
  await enableLinger(args.dryRun)
  const unitChange = await writeUnit(args.dryRun)
  await reloadEnableStart(args.dryRun)
  if (!args.dryRun) {
    log('status:')
    await showStatus()
  }

  if (args.remote && !args.skipShared) {
    await bootstrapShared(args.remote, args.dryRun)
  } else if (!args.skipShared) {
    log(
      'shared-mind: skipped (no --remote provided). To configure later:\n' +
        `   npx tsx ${PROJECT_ROOT}/bin/ckn-sync-shared.ts --remote <git-url>`,
    )
  }

  log('done.')
  if (!args.dryRun) {
    log('next steps:')
    log('  - ensure your firewall allows ports 3001 + 1420 from the LAN')
    log('  - browse http://<this-host-lan-ip>:1420 from your dev machine')
    log(`  - logs: tail -f ${path.join(PROJECT_ROOT, 'cortex.log')}`)
    log(`  - manage: systemctl --user {status,restart,stop} ${UNIT_NAME}`)
    void unitChange
  }
}

main().catch((e) => {
  console.error('[ckn-install-worker] fatal:', e?.message ?? e)
  process.exit(1)
})
