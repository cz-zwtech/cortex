#!/usr/bin/env tsx
/**
 * FR #154 slice 1 — the pure isCanonicalInstall predicate: only the canonical
 * install may register hooks/home. Ordered branches (first match wins):
 *   1 linked-worktree        -> SKIP  (a worktree is NEVER canonical; wins over all)
 *   2 explicit-flag          -> REGISTER (CKN_CANONICAL_INSTALL on a relocated copy)
 *   3 first-install/recovery -> REGISTER (no/dangling canonical yet — claim it)
 *   4 projectRoot==home      -> REGISTER (canonical heal; NORMALIZED compare)
 *   5 else                   -> SKIP  (a different live canonical exists — don't steal)
 *
 * detectLinkedWorktree (git exec) is impure and covered by the e2e regression slice;
 * here we drive the pure predicate over the whole matrix.
 */
import assert from 'node:assert/strict'
import { isCanonicalInstall } from '../server/canonicalInstall.js'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const base = {
  projectRoot: '/mnt/e/Repos/personal/claude-config-dashboard',
  homeFileValue: '/mnt/e/Repos/personal/claude-config-dashboard' as string | null,
  homeDirExists: true,
  isLinkedWorktree: false,
  explicitCanonical: false,
}

// ── 1. linked-worktree SKIP wins even when path matches AND explicit flag set
{
  const d = isCanonicalInstall({ ...base, isLinkedWorktree: true, explicitCanonical: true })
  assert.equal(d.register, false, 'linked worktree never registers')
  assert.equal(d.reason, 'linked-worktree', 'reason = linked-worktree')
  ok('branch 1: linked-worktree SKIP wins over coincident path + explicit flag')
}

// ── 2. explicit flag registers (not a worktree)
{
  const d = isCanonicalInstall({
    ...base, projectRoot: '/opt/moved/cortex', homeFileValue: '/old/cortex',
    homeDirExists: true, explicitCanonical: true,
  })
  assert.equal(d.register, true, 'explicit flag registers')
  assert.equal(d.reason, 'explicit-flag', 'reason = explicit-flag')
  ok('branch 2: CKN_CANONICAL_INSTALL registers a relocated copy')
}

// ── 3a. first install — no home file yet
{
  const d = isCanonicalInstall({ ...base, homeFileValue: null })
  assert.equal(d.register, true, 'fresh user self-registers')
  assert.equal(d.reason, 'first-install', 'reason = first-install')
  ok('branch 3a: first install (no ckn/home) REGISTERs')
}

// ── 3b. recovery — home file present but its dir is gone (dangling)
{
  const d = isCanonicalInstall({ ...base, homeFileValue: '/deleted/worktree', homeDirExists: false })
  assert.equal(d.register, true, 'dangling home recovered by a real boot')
  assert.equal(d.reason, 'recovery', 'reason = recovery')
  ok('branch 3b: dangling home pointer -> REGISTER (recovery)')
}

// ── 4. canonical heal — projectRoot == home
{
  const d = isCanonicalInstall({ ...base })
  assert.equal(d.register, true, 'the known canonical re-registers (heals drift)')
  assert.equal(d.reason, 'canonical-heal', 'reason = canonical-heal')
  ok('branch 4: projectRoot == home -> REGISTER (heal)')
}

// ── 4-norm. PM note A: trailing slash + ./.. must normalize, else canonical
//           fails to self-identify -> falls to branch 5 SKIP -> never self-heals.
{
  const trailing = isCanonicalInstall({
    ...base, projectRoot: '/mnt/e/Repos/personal/claude-config-dashboard/',
    homeFileValue: '/mnt/e/Repos/personal/claude-config-dashboard',
  })
  assert.equal(trailing.register, true, 'trailing-slash mismatch still self-identifies')
  assert.equal(trailing.reason, 'canonical-heal', 'trailing slash -> canonical-heal')

  const dotdot = isCanonicalInstall({
    ...base, projectRoot: '/mnt/e/Repos/personal/x/../claude-config-dashboard',
    homeFileValue: '/mnt/e/Repos/personal/claude-config-dashboard',
  })
  assert.equal(dotdot.register, true, '.. mismatch still self-identifies')
  assert.equal(dotdot.reason, 'canonical-heal', 'dotdot -> canonical-heal')
  ok('branch 4 (norm): trailing-slash + .. normalize to canonical-heal')
}

// ── 5. different canonical exists — don't steal (the zw1 dev-clone protection)
{
  const d = isCanonicalInstall({
    ...base, projectRoot: '/home/claude/cortex-dev-clone',
    homeFileValue: '/home/claude/cortex', homeDirExists: true,
  })
  assert.equal(d.register, false, 'a dev-clone does NOT steal the live canonical')
  assert.equal(d.reason, 'different-canonical-exists', 'reason = different-canonical-exists')
  ok('branch 5: different live canonical -> SKIP (zw1 dev-clone protection)')
}

console.log(`\nOK canonical-install.test.ts — ${passed} checks passed`)
process.exit(0)
