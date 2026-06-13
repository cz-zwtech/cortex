#!/usr/bin/env tsx
/**
 * #97 fresh-clone path: syncWorktreeToRemote must SKIP the redundant fetch when the
 * worktree was just cloned (origin/main is already current straight out of the clone).
 * Retrying a no-op fetch only re-adds the altssh:443 failure surface, so on the
 * fresh-clone path we drop it entirely. On the incremental path the fetch stays
 * (covered by worktree-sync.test.ts) so a real remote delta is still adopted.
 *
 * Proves: with skipFetch, a worktree does NOT learn a commit the remote gained after
 * the clone (the fetch was genuinely skipped) — it resets to its existing origin/main.
 * Without skipFetch (default), the same worktree DOES advance (sanity contrast).
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-skipfetch-'))
process.env.CKN_GRAPH_DB_PATH = path.join(root, 'graph.sqlite')
process.env.CKN_PRIVATE_MIND_PATH = path.join(root, 'unused-clone')

const { syncWorktreeToRemote } = await import('../../server/privateMind.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' })

const remote = path.join(root, 'remote.git')
const A = path.join(root, 'A')
const B = path.join(root, 'B')

execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', remote], { stdio: 'pipe' })

// A seeds v1 and pushes.
execFileSync('git', ['clone', remote, A], { stdio: 'pipe' })
git(A, 'config', 'user.email', 'a@t')
git(A, 'config', 'user.name', 'a')
fs.writeFileSync(path.join(A, 'mem.md'), 'v1')
git(A, 'add', '-A')
git(A, 'commit', '-m', 'seed')
git(A, 'push', '-u', 'origin', 'main')

// B clones (origin/main → c1). Capture c1.
execFileSync('git', ['clone', remote, B], { stdio: 'pipe' })
git(B, 'config', 'user.email', 'b@t')
git(B, 'config', 'user.name', 'b')
const c1 = git(B, 'rev-parse', 'HEAD').trim()

// Remote moves ahead to c2 (B has NOT fetched it).
fs.writeFileSync(path.join(A, 'mem.md'), 'v2-remote')
git(A, 'add', '-A')
git(A, 'commit', '-m', 'A v2')
git(A, 'push', 'origin', 'main')

// skipFetch: must NOT fetch → B stays at c1 (never learns c2).
const skipped = await syncWorktreeToRemote(B, { skipFetch: true })
assert.equal(skipped.atRemote, true, 'skipFetch still reports at (the already-cloned) remote')
assert.equal(git(B, 'rev-parse', 'HEAD').trim(), c1, 'skipFetch did NOT advance to c2 — the fetch was skipped')
assert.equal(fs.readFileSync(path.join(B, 'mem.md'), 'utf-8'), 'v1', 'worktree holds the cloned v1, not the unfetched v2')

// Default (no skip): fetches → B advances to c2 (sanity contrast; proves the remote really moved).
const fetched = await syncWorktreeToRemote(B)
assert.equal(fetched.atRemote, true, 'default path reports at remote')
assert.notEqual(git(B, 'rev-parse', 'HEAD').trim(), c1, 'default path fetched and advanced past c1')
assert.equal(fs.readFileSync(path.join(B, 'mem.md'), 'utf-8'), 'v2-remote', 'default path adopted v2 (fetch happened)')

console.log('skip-fetch OK — fresh-clone path skips the redundant fetch; incremental path still fetches')
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
