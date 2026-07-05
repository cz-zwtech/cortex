#!/usr/bin/env tsx
/**
 * FR #154 slice 2 — the impure gatherer decideCanonicalInstall: reads the
 * ~/.config/ckn/home file, resolves existence, realpaths BOTH sides (symlink
 * equality, PM note A), detects a linked worktree, reads CKN_CANONICAL_INSTALL,
 * then defers to the pure isCanonicalInstall. Driven here over temp dirs (not
 * git repos, so isLinkedWorktree=false); the worktree branch is the e2e slice.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { decideCanonicalInstall } from '../server/canonicalInstall.js'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-canon-'))
const install = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'install-')))
const other = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'other-')))
const homeFile = path.join(tmp, 'home')
const writeHome = (v: string | null) => (v === null ? fs.rmSync(homeFile, { force: true }) : fs.writeFileSync(homeFile, v))

// ── first-install: no home file yet
{
  writeHome(null)
  const d = decideCanonicalInstall({ projectRoot: install, homeFilePath: homeFile, env: {} })
  assert.equal(d.register, true); assert.equal(d.reason, 'first-install')
  ok('no home file -> first-install REGISTER')
}

// ── canonical-heal: home file points at THIS install
{
  writeHome(install)
  const d = decideCanonicalInstall({ projectRoot: install, homeFilePath: homeFile, env: {} })
  assert.equal(d.register, true); assert.equal(d.reason, 'canonical-heal')
  ok('home == install -> canonical-heal REGISTER')
}

// ── different-canonical-exists: home points at another live install
{
  writeHome(other)
  const d = decideCanonicalInstall({ projectRoot: install, homeFilePath: homeFile, env: {} })
  assert.equal(d.register, false); assert.equal(d.reason, 'different-canonical-exists')
  ok('home == other live install -> SKIP (do not steal)')
}

// ── recovery: home points at a now-deleted dir
{
  const gone = path.join(tmp, 'gone')
  writeHome(gone)
  const d = decideCanonicalInstall({ projectRoot: install, homeFilePath: homeFile, env: {} })
  assert.equal(d.register, true); assert.equal(d.reason, 'recovery')
  ok('home -> deleted dir -> recovery REGISTER')
}

// ── explicit flag: relocated copy, old dir still exists, flag set
{
  writeHome(other)
  const d = decideCanonicalInstall({
    projectRoot: install, homeFilePath: homeFile, env: { CKN_CANONICAL_INSTALL: '1' },
  })
  assert.equal(d.register, true); assert.equal(d.reason, 'explicit-flag')
  ok('CKN_CANONICAL_INSTALL=1 -> explicit-flag REGISTER over a live other canonical')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nOK canonical-decide.test.ts — ${passed} checks passed`)
process.exit(0)
