#!/usr/bin/env tsx
/**
 * Parity installer slice 3 — the bin/ckn-install-config.ts CLI. Run-as-self by
 * default; --home <dir> targets a path (OS-perm-gated for another user). Establishes
 * full parity for the target ~/.claude: hooks + commands + skills (registerForHome) +
 * env CKN_FORCE_SERVER=1/CKN_BIND=0.0.0.0 + aliases (run-as-self only). Idempotent.
 * Driven as a subprocess with --home <temp> (so it targets temp, never real ~/.claude,
 * and — since temp != os.homedir() — skips the real-shell alias install).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'bin', 'ckn-install-config.ts')
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-install-cli-'))
const settingsPath = path.join(home, '.claude', 'settings.json')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// pre-seed a personal settings.json
fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'mine' } }, null, 4))

const run = () => spawnSync(tsx, [cli, '--home', home], { cwd: repoRoot, encoding: 'utf8', env: process.env as any })

// ── 1. run the CLI ──────────────────────────────────────────────────────────
{
  const r = run()
  assert.equal(r.status, 0, `CLI exits 0 (stderr: ${r.stderr})`)
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(s.hooks.Stop[0].hooks[0].command.includes(`H="${repoRoot}"`), true, 'hook value = projectRoot')
  assert.ok(!s.hooks.Stop[0].hooks[0].command.includes(home), 'homeDir not leaked into hook')
  assert.equal(s.env.CORTEX_HOME_DIR, repoRoot, 'CORTEX_HOME_DIR = projectRoot')
  assert.equal(s.env.CKN_FORCE_SERVER, '1', 'CKN_FORCE_SERVER=1 set')
  assert.equal(s.env.CKN_BIND, '0.0.0.0', 'CKN_BIND=0.0.0.0 set')
  assert.equal(s.theme, 'dark', 'theme preserved')
  assert.deepEqual(s.statusLine, { type: 'command', command: 'mine' }, 'statusLine preserved')
  const cmds = fs.readdirSync(path.join(home, '.claude', 'commands')).filter((f) => f.endsWith('.md'))
  assert.ok(cmds.length >= 8, `commands installed (${cmds.length})`)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'codegraph', 'SKILL.md')), 'codegraph skill installed')
  assert.equal(fs.readFileSync(path.join(home, '.config', 'ckn', 'home'), 'utf8').trim(), repoRoot, 'home cache value = projectRoot')
  assert.match(r.stdout, /aliases NOT installed|run-as-self/i, 'aliases skipped for a --home target (documented)')
  ok('CLI installs full parity into --home target; values=projectRoot; env set; personal settings preserved; aliases run-as-self only')
}

// ── 2. idempotent / diff-stable ─────────────────────────────────────────────
{
  const before = fs.readFileSync(settingsPath)
  const r = run()
  assert.equal(r.status, 0, 'second run exits 0')
  assert.deepEqual(fs.readFileSync(settingsPath), before, 'second run leaves settings.json byte-identical')
  ok('second run is diff-stable')
}

fs.rmSync(home, { recursive: true, force: true })
console.log(`\nOK parity-install-config-cli.test.ts — ${passed} checks passed`)
process.exit(0)
