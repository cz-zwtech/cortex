#!/usr/bin/env tsx
/**
 * #97 blocker: a clone that dies mid-fetch-pack over altssh:443 leaves a PARTIAL .git.
 * The original code cloned straight into PRIVATE_MIND_PATH, so the retry would 128 on
 * the now-dirty dir ("destination path already exists and is not an empty directory")
 * — futile for the exact transient it targets. The fix clones into a TEMP sibling that
 * each attempt wipes first, then renames into place on success, so a partial never
 * blocks the retry and never lands in PRIVATE_MIND_PATH.
 *
 * Proves (real git): with a STALE partial left at the temp-clone path (simulating a
 * prior failed attempt), ensureClone still produces a valid clone — it wipes the
 * stale temp, clones fresh, and swaps it into the target. The temp is consumed; the
 * corpus is present; origin is configured.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-clone-recovery-'))
const clone = path.join(root, 'clone')
process.env.CKN_GRAPH_DB_PATH = path.join(root, 'graph.sqlite')
process.env.CKN_PRIVATE_MIND_PATH = clone
delete process.env.CKN_PRIVATE_MIND

const { ensureClone, mindStatus } = await import('../../server/privateMind.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' })

// A real bare remote with a corpus to clone.
const remote = path.join(root, 'remote.git')
const seed = path.join(root, 'seed')
execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', remote], { stdio: 'pipe' })
execFileSync('git', ['clone', remote, seed], { stdio: 'pipe' })
git(seed, 'config', 'user.email', 's@t')
git(seed, 'config', 'user.name', 's')
fs.mkdirSync(path.join(seed, 'memory', 'user'), { recursive: true })
fs.writeFileSync(path.join(seed, 'memory', 'user', 'a.md'), '# a')
git(seed, 'add', '-A')
git(seed, 'commit', '-m', 'seed corpus')
git(seed, 'push', '-u', 'origin', 'main')

// Simulate a prior failed attempt's leftover: a STALE partial at the temp-clone path
// the code will target. The old direct-into-target approach would have been blocked;
// the temp-dir approach must wipe this and proceed.
const stalePartial = `${clone}.tmp-clone-${process.pid}`
fs.mkdirSync(path.join(stalePartial, '.git'), { recursive: true })
fs.writeFileSync(path.join(stalePartial, 'garbage'), 'partial fetch-pack debris')

const res = await ensureClone(remote)
assert.equal(res.freshlyCloned, true, 'a fresh clone is reported even with a stale partial temp present')
assert.equal(fs.existsSync(path.join(clone, '.git')), true, 'the target holds a valid clone (.git present)')
assert.equal(fs.readFileSync(path.join(clone, 'memory', 'user', 'a.md'), 'utf-8'), '# a', 'the corpus landed in the target')
assert.equal(fs.existsSync(stalePartial), false, 'the stale temp was consumed (renamed into place), not left behind')

const st = await mindStatus()
assert.equal(st.enabled, true, 'origin is configured (mindStatus enabled) after the recovered clone')
assert.equal(st.memories, 1, 'corpus count surfaces the one cloned memory')

console.log('clone-temp-recovery OK — a stale partial no longer blocks the retried clone; it lands clean in the target')
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
