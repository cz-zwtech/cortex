#!/usr/bin/env tsx
/**
 * ckn-install-config — establish full Cortex parity for a user's ~/.claude in ONE
 * idempotent command. Fixes the multi-user gap: a headless install registers config
 * for the server user only, so an interactive session for another user (e.g. corey on
 * an interactive zw1) has no hooks / slash commands / skills.
 *
 * Run AS the target user (the clean, no-extra-auth path): writes YOUR OWN config,
 * Corey-authorized. `--home <dir>` / `--user <name>` target another home — naturally
 * OS-perm-gated (you cannot write another user's ~/.claude without privileges).
 *
 * TWO orthogonal params (see registerForHome): `homeDir` = WHERE files land; the
 * canonical install = WHERE THIS CLI RUNS FROM (PROJECT_ROOT) = WHAT the hooks point at.
 * So on zw1: `cd /home/claude/cortex && tsx bin/ckn-install-config.ts` writes
 * /home/corey/.claude but every hook execs under /home/claude/cortex.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerForHome, writeSettings } from '../server/hookRegistrar.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const parseArgs = (argv: string[]): { home?: string; user?: string } => {
  const out: { home?: string; user?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') out.home = argv[++i]
    else if (argv[i] === '--user') out.user = argv[++i]
  }
  return out
}

const resolveHome = (a: { home?: string; user?: string }): string => {
  if (a.home) return path.resolve(a.home)
  if (a.user) {
    try {
      const line = execFileSync('getent', ['passwd', a.user], { encoding: 'utf8' }).trim()
      const h = line.split(':')[5]
      if (h) return h
    } catch {
      /* fall through to the error below */
    }
    throw new Error(`could not resolve home for --user ${a.user} (getent passwd failed)`)
  }
  return os.homedir()
}

/** Merge the interactive-host env posture into the target settings (preserve other env). */
const ensureInstallEnv = async (homeDir: string): Promise<boolean> => {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json')
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    /* registerForHome should have created it; start from {} if not */
  }
  settings.env = settings.env ?? {}
  let changed = false
  for (const [k, v] of [['CKN_FORCE_SERVER', '1'], ['CKN_BIND', '0.0.0.0']] as const) {
    if (settings.env[k] !== v) {
      settings.env[k] = v
      changed = true
    }
  }
  if (changed) await writeSettings(settings, settingsPath)
  return changed
}

const main = async (): Promise<void> => {
  const homeDir = resolveHome(parseArgs(process.argv.slice(2)))
  const runAsSelf = path.resolve(homeDir) === path.resolve(os.homedir())
  console.log(`[ckn] installing config into ${homeDir} (canonical install: ${PROJECT_ROOT})`)

  // Hooks + slash commands + skills + home cache (values all point at PROJECT_ROOT).
  await registerForHome({ homeDir, projectRoot: PROJECT_ROOT })

  // Interactive-host env posture.
  if (await ensureInstallEnv(homeDir)) {
    console.log('[ckn] set env CKN_FORCE_SERVER=1 + CKN_BIND=0.0.0.0')
  }

  // Shell aliases — ckn-install-aliases targets the INVOKING user's shell rc
  // (os.homedir()), so it is meaningful only run-as-self. For a --home target, skip
  // and tell the user to run this AS that user to get aliases.
  if (runAsSelf) {
    try {
      execFileSync(path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'), ['bin/ckn-install-aliases.ts'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      })
    } catch (e) {
      console.warn(`[ckn] alias install failed (non-fatal): ${(e as Error).message}`)
    }
  } else {
    console.log(
      `[ckn] aliases NOT installed: ckn-install-aliases only targets the invoking user's shell. ` +
        `Run this AS ${path.basename(homeDir)} (run-as-self) to get ckn-start/stop/etc.`,
    )
  }

  console.log(`[ckn] parity install complete for ${homeDir}. Start a new session (or restart) to load hooks + commands.`)
}

const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  main().catch((e) => {
    console.error(`[ckn] install-config failed: ${(e as Error).message}`)
    process.exit(1)
  })
}
