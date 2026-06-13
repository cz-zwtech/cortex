#!/usr/bin/env tsx
/**
 * #96 reassurance counts. On a fresh laptop the boot pull-only sync adopts the whole
 * corpus BEFORE the user's explicit `ckn-mind-sync` run, so the watched run shows
 * "adopted from remote: 0" and reads as "sync broken/empty" even though the full mind
 * is present. The fix surfaces the actual corpus size: countMindMemories() counts the
 * memory/*.md files in the clone, and mindStatus() reports it so `--status` proves the
 * mind is there regardless of this run's delta.
 *
 * Proves: countMindMemories() counts ONLY memory/*.md (recursively), ignoring non-md
 * and non-memory files; mindStatus() surfaces that count as `memories`.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-corpus-'))
const clone = path.join(root, 'clone')
process.env.CKN_GRAPH_DB_PATH = path.join(root, 'graph.sqlite')
process.env.CKN_PRIVATE_MIND_PATH = clone
delete process.env.CKN_PRIVATE_MIND // ensure not hard-disabled

const { mindStatus, countMindMemories } = await import('../../server/privateMind.js')

// A clone with an origin remote (so mindStatus().enabled is true) + a corpus.
fs.mkdirSync(clone, { recursive: true })
execFileSync('git', ['init'], { cwd: clone, stdio: 'pipe' })
execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:me/private-cortex.git'], { cwd: clone, stdio: 'pipe' })

// Realistic corpus structure (memory/user/*.md, memory/proj/<proj>/*.md).
const memDir = path.join(clone, 'memory')
fs.mkdirSync(path.join(memDir, 'user'), { recursive: true })
fs.mkdirSync(path.join(memDir, 'proj', 'some-project'), { recursive: true })
fs.writeFileSync(path.join(memDir, 'user', 'a.md'), '# a')
fs.writeFileSync(path.join(memDir, 'user', 'b.md'), '# b')
fs.writeFileSync(path.join(memDir, 'proj', 'some-project', 'c.md'), '# c') // nested .md counts
fs.writeFileSync(path.join(memDir, 'user', 'notes.txt'), 'not a memory') // non-md ignored
fs.mkdirSync(path.join(clone, '.cortex'), { recursive: true })
fs.writeFileSync(path.join(clone, '.cortex', 'manifest.json'), '{}') // outside memory/ ignored

const n = await countMindMemories()
assert.equal(n, 3, 'counts exactly the 3 memory/*.md files (nested included, non-md + non-memory excluded)')

const st = await mindStatus()
assert.equal(st.enabled, true, 'a clone with an origin remote is enabled')
assert.equal(st.memories, 3, 'mindStatus surfaces the corpus size so --status proves the mind is present')

console.log('corpus-count OK — countMindMemories + mindStatus.memories surface the real corpus size')
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
