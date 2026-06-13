#!/usr/bin/env tsx
/**
 * syncWorktreeToRemote heals a stranded private-mind clone instead of leaving it
 * broken. Simulates the exact fleet failure: a clone that is BOTH dirty
 * (uncommitted regenerable changes, incl. .cortex/manifest.json) AND diverged
 * (a local commit not on the remote), while the remote has moved ahead. The old
 * `git pull --no-rebase` would conflict / refuse / push-reject and strand it;
 * the fetch + hard-reset transport must leave it clean and at origin/main.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mindsync-'))
// Decouple the module from real graph/mind state before import (defensive).
process.env.CKN_GRAPH_DB_PATH = path.join(root, 'graph.sqlite')
process.env.CKN_PRIVATE_MIND_PATH = path.join(root, 'unused-clone')

const { syncWorktreeToRemote } = await import('../../server/privateMind.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' })

const remote = path.join(root, 'remote.git')
const A = path.join(root, 'A')
const B = path.join(root, 'B')

// Bare remote on `main`.
execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', remote], { stdio: 'pipe' })

// Clone A — seed memory + manifest, push.
execFileSync('git', ['clone', remote, A], { stdio: 'pipe' })
git(A, 'config', 'user.email', 'a@t')
git(A, 'config', 'user.name', 'a')
fs.writeFileSync(path.join(A, 'mem.md'), 'v1')
fs.mkdirSync(path.join(A, '.cortex'), { recursive: true })
fs.writeFileSync(path.join(A, '.cortex', 'manifest.json'), '{"v":1}')
git(A, 'add', '-A')
git(A, 'commit', '-m', 'seed')
git(A, 'push', '-u', 'origin', 'main')

// Clone B from the remote (has the seed).
execFileSync('git', ['clone', remote, B], { stdio: 'pipe' })
git(B, 'config', 'user.email', 'b@t')
git(B, 'config', 'user.name', 'b')

// Strand B: dirty (uncommitted tracked edits, incl. the manifest) AND diverged
// (a local commit not on the remote).
fs.writeFileSync(path.join(B, 'mem.md'), 'B-local-uncommitted')
fs.writeFileSync(path.join(B, '.cortex', 'manifest.json'), '{"v":99}')
fs.writeFileSync(path.join(B, 'b-only.md'), 'b-committed')
git(B, 'add', 'b-only.md')
git(B, 'commit', '-m', 'B diverge')

// Remote moves ahead (A pushes v2).
fs.writeFileSync(path.join(A, 'mem.md'), 'v2-remote')
git(A, 'add', '-A')
git(A, 'commit', '-m', 'A v2')
git(A, 'push', 'origin', 'main')

// Heal B.
const res = await syncWorktreeToRemote(B)
assert.equal(res.atRemote, true, 'reports worktree at remote')

// Clean — not stranded in a merge/dirty state.
assert.equal(git(B, 'status', '--porcelain').trim(), '', 'worktree clean after heal')
// HEAD == origin/main (adopted remote, discarded divergence).
assert.equal(git(B, 'rev-parse', 'HEAD').trim(), git(B, 'rev-parse', 'origin/main').trim(), 'B at origin/main')
// Remote content present; local dirt gone.
assert.equal(fs.readFileSync(path.join(B, 'mem.md'), 'utf-8'), 'v2-remote', 'adopted remote mem.md')
assert.equal(fs.readFileSync(path.join(B, '.cortex', 'manifest.json'), 'utf-8'), '{"v":1}', 'manifest reset to remote')
assert.equal(fs.existsSync(path.join(B, 'b-only.md')), false, 'diverged local commit dropped from worktree')

// Idempotent — a second heal on a clean clone is a no-op success.
const again = await syncWorktreeToRemote(B)
assert.equal(again.atRemote, true, 'second heal still at remote')
assert.equal(git(B, 'status', '--porcelain').trim(), '', 'still clean')

console.log('worktree-sync OK — dirty+diverged clone healed to origin/main, not stranded')
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
