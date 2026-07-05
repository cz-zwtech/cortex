#!/usr/bin/env tsx
/**
 * FR #154 slice 3 — writeSettings must be crash/concurrency-safe: back up the
 * prior settings.json once before overwriting, then replace atomically (temp +
 * rename) so a concurrent reader/editor never sees a half-written file or loses
 * an out-of-band edit without a recoverable copy. (PM gate req 3.)
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { writeSettings } from '../server/hookRegistrar.js'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-settings-'))
const target = path.join(dir, 'settings.json')
const backup = `${target}.bak-cortex`

// ── 1. first write: creates a valid file, no backup (nothing to back up)
{
  await writeSettings({ env: { A: '1' } }, target)
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { env: { A: '1' } }, 'first write lands')
  assert.equal(fs.existsSync(backup), false, 'no backup on first write (no prior file)')
  ok('first write: valid JSON, no spurious backup')
}

// ── 2. second write: prior content is backed up, new content lands, both valid
{
  await writeSettings({ env: { A: '2' }, extra: true }, target)
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { env: { A: '2' }, extra: true }, 'new content lands')
  assert.ok(fs.existsSync(backup), 'a backup was taken before overwrite')
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), { env: { A: '1' } }, 'backup holds the PRIOR content')
  ok('overwrite: prior content backed up, new content atomic')
}

// ── 3. no temp turds left behind
{
  const turds = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(turds, [], 'no .tmp-* files left after atomic rename')
  ok('atomic rename leaves no temp file')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\nOK settings-atomic-write.test.ts — ${passed} checks passed`)
process.exit(0)
