#!/usr/bin/env tsx
/**
 * Integration test for the ckn-update git mechanics (repoint / apply) against THROWAWAY
 * repos — the executor paths that the pure planner can't cover and where the stale-remote-
 * snapshot bug hid. Exercises the two fleet shapes:
 *   - single-remote: a node with only a gitlab `origin` and NO github remote (zw2/laptop).
 *   - two-remote: a node with gitlab `origin` + a `github` remote already (zwd).
 *   - idempotent re-run: repoint twice converges, never throws.
 *   - apply: a fast-forward advances HEAD.
 * Uses real `git` over local bare repos (file:// paths) — no network.
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { repoint, apply, type GitRun } from '../bin/ckn-update.js'

const execFileP = promisify(execFile)
let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const ROOT = mkdtempSync(path.join(tmpdir(), 'ckn-update-it-'))
const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
const ident = (dir: string) => {
  sh(dir, ['config', 'user.email', 't@t'])
  sh(dir, ['config', 'user.name', 't'])
}
/** a GitRun bound to a working dir (mirrors the CLI's REPO_ROOT-bound runner). */
const gitIn =
  (dir: string): GitRun =>
  async (args, _timeout) => {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { encoding: 'utf-8' })
    return stdout.trim()
  }

/** make a bare repo with one commit on `branch` carrying `file`. returns its abs path. */
const makeBare = (name: string, branch: string, file: string): string => {
  const bare = path.join(ROOT, `${name}.git`)
  sh(ROOT, ['init', '--bare', '-b', branch, `${name}.git`])
  const seed = path.join(ROOT, `${name}-seed`)
  sh(ROOT, ['init', '-b', branch, `${name}-seed`])
  ident(seed)
  writeFileSync(path.join(seed, file), `${name}\n`)
  sh(seed, ['add', '.'])
  sh(seed, ['commit', '-m', `seed ${name}`])
  sh(seed, ['remote', 'add', 'o', bare])
  sh(seed, ['push', 'o', branch])
  return bare
}

try {
  const github = makeBare('github', 'main', 'gh.txt')
  const gitlab = makeBare('gitlab', 'master', 'gl.txt')

  // ── single-remote (zw2/laptop): origin=gitlab only, no github remote ──────────
  {
    const dir = path.join(ROOT, 'node-single')
    sh(ROOT, ['clone', gitlab, 'node-single'])
    ident(dir)
    await repoint(gitIn(dir), github, 'main', '20260614')
    assert.equal(sh(dir, ['remote', 'get-url', 'origin']), github, 'origin → github')
    assert.equal(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'on main')
    assert.ok(existsSync(path.join(dir, 'gh.txt')), 'github tree checked out (gh.txt present)')
    ok('single-remote (gitlab origin, no github) → origin repointed to github on main')
  }

  // ── two-remote (zwd): origin=gitlab + github remote already present ───────────
  {
    const dir = path.join(ROOT, 'node-two')
    sh(ROOT, ['clone', gitlab, 'node-two'])
    ident(dir)
    sh(dir, ['remote', 'add', 'github', github])
    await repoint(gitIn(dir), github, 'main', '20260614')
    assert.equal(sh(dir, ['remote', 'get-url', 'origin']), github, 'origin → github')
    assert.equal(sh(dir, ['remote', 'get-url', 'gitlab']), gitlab, 'gitlab remote preserved')
    assert.equal(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'on main')
    ok('two-remote (gitlab origin + github) → origin=github, gitlab preserved')
  }

  // ── idempotent: a second repoint converges, never throws ──────────────────────
  {
    const dir = path.join(ROOT, 'node-idem')
    sh(ROOT, ['clone', gitlab, 'node-idem'])
    ident(dir)
    await repoint(gitIn(dir), github, 'main', '20260614')
    await repoint(gitIn(dir), github, 'main', '20260615') // re-run
    assert.equal(sh(dir, ['remote', 'get-url', 'origin']), github, 'origin still github after re-run')
    assert.equal(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'still on main')
    ok('repoint is idempotent (second run converges, no throw)')
  }

  // ── apply: fast-forward advances HEAD ─────────────────────────────────────────
  {
    const dir = path.join(ROOT, 'node-apply')
    sh(ROOT, ['clone', '-b', 'main', github, 'node-apply'])
    ident(dir)
    const head0 = sh(dir, ['rev-parse', 'HEAD'])
    // advance github main with a new commit
    const seed = path.join(ROOT, 'github-seed')
    writeFileSync(path.join(seed, 'gh2.txt'), 'more\n')
    sh(seed, ['add', '.'])
    sh(seed, ['commit', '-m', 'advance'])
    sh(seed, ['push', 'o', 'main'])
    sh(dir, ['fetch', 'origin', 'main'])
    await apply(gitIn(dir), 'main')
    const head1 = sh(dir, ['rev-parse', 'HEAD'])
    assert.notEqual(head1, head0, 'HEAD advanced')
    assert.ok(existsSync(path.join(dir, 'gh2.txt')), 'new file present after ff')
    ok('apply fast-forwards HEAD onto origin/main')
  }

  console.log(`\n${passed} assertions passed.`)
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
process.exit(0)
