#!/usr/bin/env tsx
/**
 * CORTEX_HOME_DIR resolver (server/cortexHome.ts).
 *   - looksLikeCortexHome: exists + package.json + bin/ (req 2 validate)
 *   - resolveAndWriteHomeCache: bao-or-derived source; empty/absent bao → derived
 *     (note 1); validate-before-write keep-last-good on bad path (req 2); atomic
 *     temp+rename (req 1); idempotent no-op when unchanged.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { looksLikeCortexHome, readHomeCache, resolveAndWriteHomeCache, homeSource, refreshHomeCache } =
  await import('../server/cortexHome.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-home-test-'))
const mkHome = (name: string): string => {
  const d = path.join(tmp, name)
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"cortex"}')
  return d
}
const homeA = mkHome('homeA')
const homeB = mkHome('homeB')
const notHome = path.join(tmp, 'notHome')
fs.mkdirSync(notHome) // no package.json / bin
const missingBin = path.join(tmp, 'missingBin')
fs.mkdirSync(missingBin)
fs.writeFileSync(path.join(missingBin, 'package.json'), '{}')
const cacheFile = path.join(tmp, 'home-cache')

// ── looksLikeCortexHome ─────────────────────────────────────────────────────
assert.equal(looksLikeCortexHome(homeA), true, 'valid home')
assert.equal(looksLikeCortexHome(notHome), false, 'missing package.json + bin')
assert.equal(looksLikeCortexHome(missingBin), false, 'missing bin dir')
assert.equal(looksLikeCortexHome(path.join(tmp, 'nope')), false, 'nonexistent')
assert.equal(looksLikeCortexHome(''), false, 'empty string')
assert.equal(looksLikeCortexHome('   '), false, 'blank string')
ok('looksLikeCortexHome validates exist + package.json + bin')

// ── no bao → derived home, creates cache atomically (no temp leftover) ───────
{
  const r = resolveAndWriteHomeCache({ derivedHome: homeA, baoValue: null, file: cacheFile })
  assert.equal(r.wrote, true, 'wrote')
  assert.equal(r.value, homeA)
  assert.equal(readHomeCache(cacheFile), homeA, 'cache has derived home')
  assert.equal(
    fs.readdirSync(tmp).some((f) => f.startsWith('home-cache.tmp')),
    false,
    'no temp file left behind (atomic rename)',
  )
  ok('no bao → writes derived home, atomic')
}

// ── valid bao value → wins over derived ─────────────────────────────────────
{
  const r = resolveAndWriteHomeCache({ derivedHome: homeA, baoValue: homeB, file: cacheFile })
  assert.equal(r.wrote, true)
  assert.equal(readHomeCache(cacheFile), homeB, 'bao value written')
  ok('valid bao value → written')
}

// ── unchanged → no write ────────────────────────────────────────────────────
{
  const r = resolveAndWriteHomeCache({ derivedHome: homeA, baoValue: homeB, file: cacheFile })
  assert.equal(r.wrote, false, 'unchanged no-op')
  ok('candidate == current cache → no write')
}

// ── empty/blank bao → fall through to derived home (note 1) ──────────────────
{
  const r = resolveAndWriteHomeCache({ derivedHome: homeA, baoValue: '   ', file: cacheFile })
  assert.equal(r.value, homeA, 'blank bao → derived home')
  assert.equal(readHomeCache(cacheFile), homeA)
  ok('empty/blank bao → falls through to derived home')
}

// ── invalid bao path → keep last-good, NEVER write (req 2) ───────────────────
{
  // cache currently homeA; bao points at an invalid path; derived is valid homeB
  const r = resolveAndWriteHomeCache({ derivedHome: homeB, baoValue: notHome, file: cacheFile })
  assert.equal(r.wrote, false, 'invalid bao → no write')
  assert.equal(readHomeCache(cacheFile), homeA, 'cache unchanged (last-good preserved)')
  ok('invalid bao path → keep last-good, never write (req 2)')
}

// ── invalid derived + no bao → no write (defensive) ─────────────────────────
{
  const freshCache = path.join(tmp, 'home-cache-2')
  const r = resolveAndWriteHomeCache({ derivedHome: notHome, baoValue: null, file: freshCache })
  assert.equal(r.wrote, false, 'invalid derived → no write')
  assert.equal(readHomeCache(freshCache), null, 'no cache created from invalid path')
  ok('invalid derived + no bao → no write, no empty cache')
}

// ── readHomeCache: trims, null on missing/empty ─────────────────────────────
{
  assert.equal(readHomeCache(path.join(tmp, 'absent')), null, 'missing → null')
  const blank = path.join(tmp, 'blank')
  fs.writeFileSync(blank, '\n  \n')
  assert.equal(readHomeCache(blank), null, 'blank file → null')
  ok('readHomeCache trims and nulls missing/blank')
}

// ── CKN_HOME_SOURCE knob: default local; parse; case-insensitive; unknown→local ─
{
  delete process.env.CKN_HOME_SOURCE
  assert.equal(homeSource(), 'local', 'default = local')
  process.env.CKN_HOME_SOURCE = 'bao'
  assert.equal(homeSource(), 'bao')
  process.env.CKN_HOME_SOURCE = 'BAO'
  assert.equal(homeSource(), 'bao', 'case-insensitive')
  process.env.CKN_HOME_SOURCE = 'auto'
  assert.equal(homeSource(), 'local', 'auto dropped → local')
  process.env.CKN_HOME_SOURCE = 'garbage'
  assert.equal(homeSource(), 'local', 'unknown → local')
  ok('homeSource parses CKN_HOME_SOURCE (local | bao, default local)')
}

// ── source=local: NEVER attempts bao (offline-safe), writes derived ──────────
{
  process.env.CKN_HOME_SOURCE = 'local'
  let called = false
  const f = path.join(tmp, 'cache-local')
  refreshHomeCache({ derivedHome: homeA, fetchBao: () => ((called = true), homeB), file: f })
  assert.equal(called, false, 'local must NOT call fetchBao')
  assert.equal(readHomeCache(f), homeA, 'local writes derived home')
  ok('source=local: no bao attempt, derived home written')
}

// ── source=bao: bao value wins when reachable ───────────────────────────────
{
  process.env.CKN_HOME_SOURCE = 'bao'
  const f = path.join(tmp, 'cache-bao')
  refreshHomeCache({ derivedHome: homeA, fetchBao: () => homeB, file: f })
  assert.equal(readHomeCache(f), homeB, 'bao value written')
  ok('source=bao: bao value written when reachable')
}

// ── source=bao: bao unreachable (throws) → derived fallback ─────────────────
{
  process.env.CKN_HOME_SOURCE = 'bao'
  const f = path.join(tmp, 'cache-bao-fail')
  refreshHomeCache({
    derivedHome: homeA,
    fetchBao: () => {
      throw new Error('offline')
    },
    file: f,
  })
  assert.equal(readHomeCache(f), homeA, 'derived fallback on bao failure')
  ok('source=bao: bao unreachable → derived fallback (never throws)')
}

delete process.env.CKN_HOME_SOURCE

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} assertions passed.`)
process.exit(0)
