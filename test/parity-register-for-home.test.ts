#!/usr/bin/env tsx
/**
 * Parity installer slice 1 — registerForHome({homeDir, projectRoot}). The TWO
 * orthogonal params (PM confirmation A):
 *   homeDir    = WHERE files land (this user's ~/.claude + ~/.config/ckn)
 *   projectRoot= WHAT the writes point at (the canonical install: hook tsx paths,
 *                CORTEX_HOME_DIR value, home-cache VALUE, skills source)
 * homeDir must NEVER leak into the command/value side. Proves: destinations land
 * under homeDir; values = projectRoot; a fresh user (no ~/.config/ckn) doesn't
 * fail; personal settings (theme/statusLine) are PRESERVED; a second run is
 * diff-stable.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerForHome } from '../server/hookRegistrar.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // real cortex install
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-parity-home-'))

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// pre-seed a PERSONAL settings.json (theme + statusLine) that must survive
fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
const settingsPath = path.join(homeDir, '.claude', 'settings.json')
fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'my-statusline' } }, null, 4))

await registerForHome({ homeDir, projectRoot })

// ── destinations land under homeDir ─────────────────────────────────────────
{
  assert.ok(fs.existsSync(settingsPath), 'settings.json under homeDir')
  assert.ok(fs.existsSync(path.join(homeDir, '.config', 'ckn', 'home')), 'home cache under homeDir (fresh ~/.config/ckn created)')
  const cmds = fs.readdirSync(path.join(homeDir, '.claude', 'commands')).filter((f) => f.endsWith('.md'))
  assert.ok(cmds.length >= 8, `slash commands installed under homeDir (${cmds.length})`)
  assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'codegraph', 'SKILL.md')), 'codegraph skill under homeDir')
  ok('all destinations land under homeDir (fresh user, dirs auto-created)')
}

// ── values point at projectRoot, NOT homeDir (the critical no-leak) ─────────
{
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const cmd = s.hooks.Stop[0].hooks[0].command as string
  // The shim execs via $H (resolved from the cache, whose VALUE = projectRoot); the
  // literal projectRoot is baked as the FALLBACK. Both must be projectRoot, never homeDir.
  assert.ok(cmd.includes(`H="${projectRoot}"`), 'baked fallback = canonical projectRoot (not homeDir)')
  assert.ok(cmd.includes('$H/node_modules/.bin/tsx') && cmd.includes('$H/bin/ckn-sync.ts'), 'execs the script via $H')
  assert.ok(!cmd.includes(homeDir), 'homeDir NEVER leaks into the hook command')
  assert.equal(s.env.CORTEX_HOME_DIR, projectRoot, 'CORTEX_HOME_DIR = projectRoot')
  assert.equal(fs.readFileSync(path.join(homeDir, '.config', 'ckn', 'home'), 'utf8').trim(), projectRoot, 'home cache VALUE = projectRoot')
  ok('every value/bin path = projectRoot; homeDir does not leak in')
}

// ── personal settings preserved (merge, not clobber) ────────────────────────
{
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(s.theme, 'dark', 'theme preserved')
  assert.deepEqual(s.statusLine, { type: 'command', command: 'my-statusline' }, 'statusLine preserved')
  ok('personal theme + statusLine preserved (merge not clobber)')
}

// ── idempotent / diff-stable second run ─────────────────────────────────────
{
  const before = fs.readFileSync(settingsPath)
  await registerForHome({ homeDir, projectRoot })
  assert.deepEqual(fs.readFileSync(settingsPath), before, 'second run leaves settings.json byte-identical')
  ok('second run is diff-stable (idempotent)')
}

fs.rmSync(homeDir, { recursive: true, force: true })
console.log(`\nOK parity-register-for-home.test.ts — ${passed} checks passed`)
process.exit(0)
