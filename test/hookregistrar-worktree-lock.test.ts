#!/usr/bin/env tsx
/**
 * FR #154 slice 6 — the regression LOCK (the real proof). Reproduce the exact
 * hijack that broke zwd: boot a real server/index.ts from a REAL linked git
 * worktree, with NO ephemeral flag, and prove the canonical gate auto-skips so
 * ALL THREE vectors are byte-unchanged:
 *   (1) ~/.config/ckn/home FILE  (2) settings.json CORTEX_HOME_DIR  (3) hook fallbacks
 *
 * Fully hermetic: HOME points at a temp dir seeded with a KNOWN canonical state,
 * so even a regression could only scribble under the temp HOME — never real
 * ~/.claude. The strongest assertion is dual: the skip LOG fired (ensureStopHook
 * ran + chose to skip) AND the seeded vectors are byte-identical afterward.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-wtlock-'))
const home = path.join(tmp, 'home')
const CANON = '/opt/canonical/cortex' // synthetic live canonical the vectors point at
const worktree = path.join(tmp, 'wt')
const dbDir = path.join(tmp, 'db')
const logFile = path.join(tmp, 'server.log')
let proc: ReturnType<typeof spawn> | null = null

const cleanup = () => {
  try { if (proc?.pid) process.kill(-proc.pid, 'SIGKILL') } catch {}
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' }) } catch {}
  try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'ignore' }) } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

try {
  // ── seed a KNOWN canonical state under the temp HOME ──────────────────────
  fs.mkdirSync(path.join(home, '.config', 'ckn'), { recursive: true })
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const homeFile = path.join(home, '.config', 'ckn', 'home')
  const settingsPath = path.join(home, '.claude', 'settings.json')
  fs.writeFileSync(homeFile, CANON)
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        env: { CORTEX_HOME_DIR: CANON },
        hooks: {
          Stop: [{
            matcher: '',
            hooks: [{
              type: 'command',
              command: `H="$(cat "$HOME/.config/ckn/home" 2>/dev/null)"; if [ -z "$H" ]; then H="${CANON}"; fi; exec "$H/node_modules/.bin/tsx" "$H/bin/ckn-sync.ts"`,
              timeout: 30,
            }],
          }],
        },
      },
      null,
      4,
    ),
  )
  const homeBefore = fs.readFileSync(homeFile)
  const settingsBefore = fs.readFileSync(settingsPath)

  // ── a REAL linked worktree off the current HEAD (the fixed server code) ────
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', worktree, 'HEAD'], { stdio: 'ignore' })
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(worktree, 'node_modules'))

  // ── boot FROM the worktree, NO CKN_FORBID_DEFAULT_DB (the exact #154 boot) ─
  fs.mkdirSync(dbDir, { recursive: true })
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CKN_HOME: home,
    CKN_CONFIG_DIR: path.join(home, '.config', 'ckn'),
    CKN_GRAPH_DB_PATH: path.join(dbDir, 'graph.sqlite'),
    CKN_PORT: '3099',
    CKN_BIND: '127.0.0.1',
    CKN_PRIVATE_MIND: 'off',
    CKN_EMBEDDINGS: 'off',
    CKN_MESH_PEERS: '',
    CKN_MESH_TOKEN: '',
  }
  delete env.CKN_FORBID_DEFAULT_DB
  delete env.CKN_NO_HOOK_REGISTER
  const logFd = fs.openSync(logFile, 'w')
  proc = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: worktree, env, stdio: ['ignore', logFd, logFd], detached: true,
  })
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch('http://127.0.0.1:3099/api/home')).ok) break } catch {}
    await sleep(150)
  }
  await sleep(400) // let any (would-be) registration writes flush

  // ── the LOCK: gate ran + skipped, and the three vectors are byte-identical ─
  const log = fs.readFileSync(logFile, 'utf8')
  assert.match(log, /non-canonical boot \(linked-worktree\)/, 'ensureStopHook ran and skipped (linked-worktree)')
  ok('worktree boot logged the #154 auto-skip')

  assert.deepEqual(fs.readFileSync(homeFile), homeBefore, 'home FILE byte-unchanged (vector 1)')
  assert.deepEqual(fs.readFileSync(settingsPath), settingsBefore, 'settings.json byte-unchanged (vectors 2+3)')
  ok('all three hijack vectors byte-unchanged after a worktree boot')

  const homeAfter = fs.readFileSync(homeFile, 'utf8')
  const settingsAfter = fs.readFileSync(settingsPath, 'utf8')
  assert.ok(!homeAfter.includes(worktree) && !settingsAfter.includes(worktree), 'the worktree path never leaked into home/settings')
  ok('worktree path did not hijack any vector')

  console.log(`\nOK hookregistrar-worktree-lock.test.ts — ${passed} checks passed`)
  cleanup()
  process.exit(0)
} catch (e) {
  console.error(e)
  cleanup()
  process.exit(1)
}
