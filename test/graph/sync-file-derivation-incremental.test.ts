#!/usr/bin/env tsx
/**
 * §5.3 incremental memory→file derivation at sync. For the entries CHANGED this
 * sync ONLY (bounded — never a full-graph rescan, the commit-1 constraint),
 * derive file mentions from body+description and reconcile MENTIONS_FILE edges so
 * a memory that mentions a path in prose WITHOUT listing it in `mentions_files`
 * still auto-links (provenance=derived) going forward. Frontmatter still wins.
 *
 * The discriminator (mirrors sync-name-mention-incremental): a memory NOT in the
 * changed set must NOT be derived — that is what keeps the pass O(changed), not a
 * full O(N) rescan every sync.
 *
 * Temp-DB pattern mirrors test/graph/linkage-backfill.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-filederiv-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { ensureStubEntry, fileEntryId, deriveFileEdgesForChanged } = await import('../../server/graph/sync.ts')

getDb()

const COLS =
  `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, authorship, outcome, outcome_text, agent_id, session_id, pinned, engagement, machine, content_hash)`
const insertEntry = (id: string, kind: string, content: string, description = '') =>
  run(
    `INSERT INTO entries ${COLS} VALUES (?, ?, ?, ?, ?, '', 'user', 0, 0, 'human', '', '', '', '', 0, 0, '', '')`,
    id, id, kind, description, content,
  )
const edge = (src: string, dst: string, prov: string | null) =>
  run(`INSERT INTO edges (src, dst, rel, provenance) VALUES (?, ?, 'MENTIONS_FILE', ?)`, src, dst, prov)
const edgeOf = (src: string, dst: string) =>
  get<{ provenance: string | null }>(
    `SELECT provenance FROM edges WHERE src=? AND dst=? AND rel='MENTIONS_FILE'`,
    src,
    dst,
  )
const edgeCount = (src: string, dst: string) =>
  get<{ c: number }>(
    `SELECT count(*) c FROM edges WHERE src=? AND dst=? AND rel='MENTIONS_FILE'`,
    src,
    dst,
  )!.c

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── fixture ──────────────────────────────────────────────────────────────────
// changed: body mentions a real repo path, no frontmatter edge → create DERIVED.
insertEntry('mem:changed', 'memory', 'I touched `server/graph/sync.ts` in this change.')
// fm: an existing frontmatter edge (NULL legacy) AND body mentions the same file
//     → stays frontmatter, no duplicate, never downgraded.
insertEntry('mem:fm', 'project', 'see `bin/ckn-bus.ts` for the wire.')
ensureStubEntry(null, fileEntryId('bin/ckn-bus.ts'), 'bin/ckn-bus.ts', 'file', 'file')
edge('mem:fm', fileEntryId('bin/ckn-bus.ts'), null) // legacy frontmatter edge
// unchanged: body mentions a path but it is NOT in the changed set → never derived.
insertEntry('mem:unchanged', 'memory', 'long ago I edited `server/index.ts` here.')

// ── 1. changed memory: body-only path → derived edge + file stub ──────────────
{
  deriveFileEdgesForChanged(['mem:changed', 'mem:fm'])
  const e = edgeOf('mem:changed', fileEntryId('server/graph/sync.ts'))
  assert.ok(e, 'changed memory → server/graph/sync.ts edge created')
  assert.equal(e!.provenance, 'derived', 'created as derived (body-sourced, no frontmatter)')
  assert.ok(get(`SELECT id FROM entries WHERE id=?`, fileEntryId('server/graph/sync.ts')), 'file stub created')
  ok('forgotten-frontmatter body path auto-links as derived')
}
// ── 2. frontmatter precedence: same file in frontmatter AND body → ONE edge ───
{
  const e = edgeOf('mem:fm', fileEntryId('bin/ckn-bus.ts'))
  assert.ok(e, 'fm frontmatter edge survives')
  assert.notEqual(e!.provenance, 'derived', 'frontmatter wins — body derivation never downgrades it')
  assert.equal(edgeCount('mem:fm', fileEntryId('bin/ckn-bus.ts')), 1, 'exactly one edge — no body-derived duplicate')
  ok('frontmatter precedence: one edge, frontmatter wins')
}
// ── 3. changed-file-only scope: a memory NOT in changedIds is never derived ───
{
  assert.equal(
    edgeOf('mem:unchanged', fileEntryId('server/index.ts')),
    undefined,
    'unchanged memory NOT derived (scoped to changedIds, not a full rescan)',
  )
  ok('fires on a changed file only — unchanged entries skipped')
}
// ── 4. empty changedIds → no-op ───────────────────────────────────────────────
{
  const r = deriveFileEdgesForChanged([])
  assert.equal(r.scanned, 0, 'empty changedIds scans nothing')
  assert.equal(r.created, 0, 'empty changedIds creates nothing')
  ok('empty changedIds is a no-op')
}
// ── 5. idempotent: re-run same changedIds creates ZERO new edges ──────────────
{
  const before = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  const r = deriveFileEdgesForChanged(['mem:changed', 'mem:fm'])
  const after = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  assert.equal(after, before, 're-run creates no new edges')
  assert.equal(r.created, 0, 'second run reports 0 created')
  ok('idempotent: re-run is a no-op')
}

console.log(`\nOK sync-file-derivation-incremental.test.ts — ${passed} assertions passed`)
