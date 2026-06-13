#!/usr/bin/env tsx
/**
 * §5.3 wiring: syncMemories runs incremental file-derivation for CHANGED files
 * ONLY. A memory whose body mentions a path it FORGOT to list in `mentions_files`
 * still gets a derived MENTIONS_FILE edge — and an UNCHANGED memory's derivation
 * does NOT re-run (the bounded, no-full-rescan constraint, §6 acceptance).
 *
 * Temp-DB + on-disk memory pattern; real syncMemories, embeddings off.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-filederiv-wire-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const memDir = path.join(dir, '.claude', 'memory')
fs.mkdirSync(memDir, { recursive: true })

const { getDb, run, get } = await import('../../server/graph/db.ts')
const { syncMemories, fileEntryId } = await import('../../server/graph/sync.ts')

getDb()

const memPath = (slug: string) => path.join(memDir, `${slug}.md`)
const writeMem = (slug: string, body: string) =>
  fs.writeFileSync(
    memPath(slug),
    `---\nname: ${slug}\ndescription: a ${slug} test memory\ntype: feedback\n---\n\n${body}\n`,
  )
const memIdOf = (slug: string) =>
  get<{ id: string }>(`SELECT id FROM entries WHERE source = ?`, memPath(slug))?.id
const fileEdge = (memId: string, p: string) =>
  get<{ provenance: string | null }>(
    `SELECT provenance FROM edges WHERE src=? AND dst=? AND rel='MENTIONS_FILE'`,
    memId,
    fileEntryId(p),
  )

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. a body path NOT in frontmatter → derived edge after sync ───────────────
{
  writeMem('alpha', 'While fixing this I edited `server/graph/sync.ts` directly.')
  await syncMemories(dir)
  const id = memIdOf('alpha')
  assert.ok(id, 'alpha memory synced')
  const e = fileEdge(id!, 'server/graph/sync.ts')
  assert.ok(e, 'derived MENTIONS_FILE edge created from the body path')
  assert.equal(e!.provenance, 'derived', 'provenance = derived (forgotten-frontmatter auto-link)')
  ok('sync derives a body-mentioned path the frontmatter forgot')
}

// ── 2. fires on a CHANGED file only: delete the edge, re-sync UNCHANGED → gone ─
{
  const id = memIdOf('alpha')!
  run(`DELETE FROM edges WHERE src=? AND rel='MENTIONS_FILE'`, id) // wipe the derived edge
  await syncMemories(dir) // alpha unchanged on disk → stat-skip → not in changedIds
  assert.equal(
    fileEdge(id, 'server/graph/sync.ts'),
    undefined,
    'unchanged memory is NOT re-derived (scoped to changedIds, no full rescan)',
  )
  ok('derivation fires on a changed file only')
}

// ── 3. editing the file re-derives its current body paths ─────────────────────
{
  writeMem('alpha', 'Now I also touched `server/graph/db.ts` here.')
  await syncMemories(dir)
  const id = memIdOf('alpha')!
  assert.ok(fileEdge(id, 'server/graph/db.ts'), 'edited body → new derived edge')
  ok('a changed file re-derives its current body paths')
}

console.log(`\nOK sync-file-derivation-wiring.test.ts — ${passed} assertions passed`)
