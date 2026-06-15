#!/usr/bin/env tsx
/**
 * #68 hermetic regression-lock: the boot-time registration (ensureStopHook) must
 * write NOTHING to ~/.claude or ~/.config/ckn/home on an ephemeral/test boot — so
 * a server spawned from a worktree (every bus integration test) can no longer
 * hijack the real hooks + home pointer onto itself.
 *
 * Runs the exact boot call (_run-ensure-stophook.ts) in a CHILD process with
 * HOME=tmp, so every os.homedir()-derived path (settings.json, commands, skills,
 * the home cache) lands under that temp HOME and NEVER real ~/.claude — verified
 * os.homedir() honors $HOME. Per PM's reinforcement, BOTH the suppress branches
 * AND the negative-control (writes ARE made) branch are hermetic.
 *
 * The inherited CKN_FORBID_DEFAULT_DB / CKN_NO_HOOK_REGISTER are stripped per
 * case so the negative control is a true "no flags" boot even when this test is
 * run under the bus runner (which sets CKN_FORBID_DEFAULT_DB=1 globally).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const runner = path.join(here, '_run-ensure-stophook.ts')
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const bootInto = (home: string, flags: Record<string, string>): { stdout: string } => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CKN_PRIVATE_MIND: 'off',
    CKN_EMBEDDINGS: 'off',
  }
  delete env.CKN_FORBID_DEFAULT_DB
  delete env.CKN_NO_HOOK_REGISTER
  Object.assign(env, flags)
  const r = spawnSync(tsx, [runner], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`runner exited ${r.status}: ${r.stderr || r.stdout}`)
  return { stdout: r.stdout }
}
const exists = (p: string): boolean => fs.existsSync(p)
const claudeArtifacts = (home: string) => ({
  settings: path.join(home, '.claude', 'settings.json'),
  homeCache: path.join(home, '.config', 'ckn', 'home'),
  commands: path.join(home, '.claude', 'commands'),
  skills: path.join(home, '.claude', 'skills'),
})

// ── 1. ephemeral boot (CKN_FORBID_DEFAULT_DB=1) writes NOTHING ────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-hookgate-skip-'))
  const a = claudeArtifacts(home)
  const { stdout } = bootInto(home, { CKN_FORBID_DEFAULT_DB: '1' })
  assert.equal(exists(a.settings), false, 'no settings.json written')
  assert.equal(exists(a.homeCache), false, 'no ~/.config/ckn/home written')
  assert.equal(exists(a.commands), false, 'no commands dir written')
  assert.equal(exists(a.skills), false, 'no skills dir written')
  assert.match(stdout, /ephemeral boot/, 'logged the skip')
  fs.rmSync(home, { recursive: true, force: true })
  ok('CKN_FORBID_DEFAULT_DB=1 → ensureStopHook writes nothing to ~/.claude / home cache')
}

// ── 2. explicit hatch CKN_NO_HOOK_REGISTER=1 also suppresses ─────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-hookgate-hatch-'))
  const a = claudeArtifacts(home)
  bootInto(home, { CKN_NO_HOOK_REGISTER: '1' })
  assert.equal(exists(a.settings), false, 'explicit hatch suppresses settings.json')
  assert.equal(exists(a.homeCache), false, 'explicit hatch suppresses home cache')
  fs.rmSync(home, { recursive: true, force: true })
  ok('CKN_NO_HOOK_REGISTER=1 → also writes nothing')
}

// ── 3. negative control: a real boot (no flags) DOES register (into tmp) ──────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-hookgate-real-'))
  const a = claudeArtifacts(home)
  bootInto(home, {})
  assert.equal(exists(a.settings), true, 'real boot writes settings.json (into tmp HOME, never real ~/.claude)')
  fs.rmSync(home, { recursive: true, force: true })
  ok('no flags → ensureStopHook registers as today (hermetic, into tmp HOME)')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
