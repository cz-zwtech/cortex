#!/usr/bin/env tsx
/**
 * FR #154 slice 4 — the relocatable hook shim must WARN LOUDLY (stderr) when the
 * ~/.config/ckn/home cache is missing and it has to use the baked fallback, so a
 * lost home pointer is visible instead of silently degrading. The fallback still
 * keeps hooks working (degrade-with-warn, not hard-fail). Drives the ACTUAL
 * shipped shim: take everything buildCommand emits before `exec` and run it under
 * sh -c with a temp HOME, printing the resolved H.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { buildCommand } from '../server/hookRegistrar.js'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const FALLBACK = '/opt/canonical/cortex'
const cmd = buildCommand('ckn-context.ts', FALLBACK)
// Replace the real `exec ...tsx...` tail with a probe that prints the resolved H.
const prefix = cmd.slice(0, cmd.indexOf('exec '))
const probe = `${prefix} printf 'H=%s' "$H"`

const run = (home: string) => {
  const r = spawnSync('sh', ['-c', probe], { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH ?? '' } })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ── 1. cache PRESENT: H = cache value, NO warning
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-shim-present-'))
  fs.mkdirSync(path.join(home, '.config', 'ckn'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'ckn', 'home'), '/live/install/cortex')
  const { stdout, stderr } = run(home)
  assert.equal(stdout.trim(), 'H=/live/install/cortex', 'resolves from the cache file')
  assert.doesNotMatch(stderr, /WARN/, 'no warning when the cache is present')
  fs.rmSync(home, { recursive: true, force: true })
  ok('cache present -> resolves from cache, silent')
}

// ── 2. cache MISSING: H = baked fallback, LOUD stderr warning
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-shim-missing-'))
  const { stdout, stderr } = run(home)
  assert.equal(stdout.trim(), `H=${FALLBACK}`, 'falls back to the baked canonical path')
  assert.match(stderr, /WARN/, 'warns loudly on stderr when the cache is missing')
  assert.match(stderr, /home cache/i, 'names the missing home cache')
  fs.rmSync(home, { recursive: true, force: true })
  ok('cache missing -> baked fallback + LOUD stderr warn (degrade, not silent)')
}

console.log(`\nOK hook-shim-fallback-warn.test.ts — ${passed} checks passed`)
process.exit(0)
