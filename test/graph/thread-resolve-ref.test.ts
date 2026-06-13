#!/usr/bin/env tsx
/**
 * s2a resume-arg normalization — resolveThreadRef.
 *
 * /cortex-continue passes whatever the user typed. The thread's graph id may be
 * the pretty `thread:<slug>` (from frontmatter id) OR an entryId-scheme
 * `<encoded-project>/<slug>` (no frontmatter id). The user naturally types the
 * bare slug. resolveThreadRef accepts: exact id, bare slug (→ thread:<slug>),
 * an entryId suffix (…/<slug>), or the thread name — and resolves to the thread,
 * or null when missing/ambiguous.
 *
 * Temp-DB pattern mirrors test/graph/thread-claim.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-resolveref-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { resolveThreadRef } = await import('../../server/graph/threads.js')
getDb()

const NOW = 1_700_000_000_000
const thread = (id: string, name: string) =>
  run(
    `INSERT INTO entries (id, name, kind, content, source, scope, updatedAt, syncedAt, machine)
     VALUES (?, ?, 'thread', '{"status":"open","next_step":"go"}', 'src', 'thread:p', ?, ?, 'box-A')`,
    id, name, NOW, NOW,
  )

thread('thread:cortex-memory-build', 'cortex-memory-design-build')   // pretty id (frontmatter)
thread('-mnt-e-Repos-personal/some-workstream', 'Some Workstream')    // entryId-scheme id
thread('thread:dup', 'dup-name')
thread('-other-proj/dup', 'dup-name')                                 // same trailing slug 'dup' + same name
run(`INSERT INTO entries (id,name,kind,content,source,scope,updatedAt,syncedAt) VALUES ('mem:x','M','memory','','s','memory:auto',?,?)`, NOW, NOW)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. exact id
{
  assert.equal(resolveThreadRef('thread:cortex-memory-build')?.id, 'thread:cortex-memory-build', 'exact id')
  ok('resolves an exact id')
}

// ── 2. bare slug → thread:<slug>
{
  assert.equal(resolveThreadRef('cortex-memory-build')?.id, 'thread:cortex-memory-build', 'bare slug prepends thread:')
  ok('resolves a bare slug to thread:<slug>')
}

// ── 3. entryId-scheme suffix (.../slug)
{
  assert.equal(resolveThreadRef('some-workstream')?.id, '-mnt-e-Repos-personal/some-workstream', 'suffix match')
  ok('resolves an entryId-scheme thread by its trailing slug')
}

// ── 4. by name
{
  assert.equal(resolveThreadRef('Some Workstream')?.id, '-mnt-e-Repos-personal/some-workstream', 'name match')
  ok('resolves by thread name')
}

// ── 5. missing → null
{
  assert.equal(resolveThreadRef('does-not-exist'), null, 'missing ref → null')
  assert.equal(resolveThreadRef(''), null, 'empty ref → null')
  ok('missing/empty ref → null')
}

// ── 6. thread:<slug> prefix wins for a bare slug, even when another id shares
//      the trailing token — the pretty id is unambiguous, not a guess.
{
  assert.equal(resolveThreadRef('dup')?.id, 'thread:dup', 'bare slug resolves to thread:<slug> (prefix wins)')
  ok('thread:<slug> prefix takes precedence over a suffix collision')
}

// ── 7. genuinely ambiguous NAME (shared by two threads, neither is thread:<name>) → null
{
  assert.equal(resolveThreadRef('dup-name'), null, 'ambiguous name → null (no guess)')
  ok('ambiguous name resolves to null, not a guess')
}

// ── 8. never resolves a non-thread entry
{
  assert.equal(resolveThreadRef('mem:x'), null, 'a memory id is not a thread')
  ok('does not resolve a non-thread entry')
}

console.log(`\nOK thread-resolve-ref.test.ts — ${passed} assertions passed`)
