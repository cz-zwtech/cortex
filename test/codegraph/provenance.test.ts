#!/usr/bin/env tsx
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readGitProvenance, inferBaseBranch } from '../../server/git/provenance.js'

// Throwaway git repo.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-prov-'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@t')
git('config', 'user.name', 't')
fs.writeFileSync(path.join(dir, 'a.txt'), 'one')
git('add', '.')
git('commit', '-qm', 'first')

// Clean tree on main.
let p = readGitProvenance(dir)
assert.equal(p.branch, 'main')
assert.match(p.commitSha, /^[0-9a-f]{40}$/)
assert.equal(p.dirty, false)
assert.equal(p.dirtyFiles, '')

// Dirty tree.
fs.writeFileSync(path.join(dir, 'a.txt'), 'two')
p = readGitProvenance(dir)
assert.equal(p.dirty, true)
assert.match(p.dirtyFiles, /a\.txt/)

// Feature branch.
git('checkout', '-q', '-b', 'feat/x')
p = readGitProvenance(dir)
assert.equal(p.branch, 'feat/x')

// inferBaseBranch: no origin remote → fallback 'main'.
assert.equal(inferBaseBranch(dir), 'main')

// Non-git directory degrades cleanly.
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-nongit-'))
const np = readGitProvenance(plain)
assert.equal(np.branch, '')
assert.equal(np.commitSha, '')
assert.equal(np.dirty, false)
assert.equal(inferBaseBranch(plain), 'main')

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(plain, { recursive: true, force: true })
console.log('provenance OK')
