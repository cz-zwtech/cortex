#!/usr/bin/env tsx
/**
 * §3 backfill migration (memory→file linkage). Scans non-session/file/tool
 * entries, derives file mentions from body+description (§1), reconciles edges
 * with provenance (§2), then a REFERENTIAL triage pass (§4): remove dangling
 * src/dst edges + empty file-stubs ONLY. Idempotent — a re-run creates 0 edges.
 * NEVER removes a memory; NEVER touches a valid session-sourced edge.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-linkage-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { run, get, all } = await import('../../server/graph/db.ts')
const { ensureStubEntry, fileEntryId } = await import('../../server/graph/sync.ts')
const { backfillLinkage } = await import('../../server/graph/linkageBackfill.ts')

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
  get<{ provenance: string | null }>(`SELECT provenance FROM edges WHERE src=? AND dst=? AND rel='MENTIONS_FILE'`, src, dst)

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── fixture ──────────────────────────────────────────────────────────────────
// m1: body mentions a real repo path, no edge yet → should create a DERIVED edge.
insertEntry('mem:m1', 'memory', 'I changed `server/graph/bus.ts` and a bare config.json (excluded).')
// m2: has an existing legacy (NULL provenance) frontmatter edge AND body mentions it → stays frontmatter.
insertEntry('mem:m2', 'project', 'see `bin/ckn-bus.ts` for the wire.')
ensureStubEntry(null, fileEntryId('bin/ckn-bus.ts'), 'bin/ckn-bus.ts', 'file', 'file')
edge('mem:m2', fileEntryId('bin/ckn-bus.ts'), null) // legacy frontmatter edge
// session edge: valid session-sourced MENTIONS_FILE → must be KEPT.
insertEntry('sess:s1', 'session', 'session transcript')
ensureStubEntry(null, fileEntryId('server/index.ts'), 'server/index.ts', 'file', 'file')
edge('sess:s1', fileEntryId('server/index.ts'), null)
// m2 also has a STALE derived edge (body no longer mentions it) → §2 reconcile REMOVE.
edge('mem:m2', 'file:server_graph_gone.ts', 'derived')
// genuinely dangling edge — src is NOT a scanned entry (a deleted memory) → triage REMOVE.
edge('mem:ghost', 'file:ghost_y.ts', 'derived')
// empty orphan file stub (no inbound edge) → triage REMOVE (pruneOrphanStubs).
ensureStubEntry(null, fileEntryId('orphan/x.ts'), 'orphan/x.ts', 'file', 'file')

// ── run ──────────────────────────────────────────────────────────────────────
const r1 = await backfillLinkage()

// 1. derived edge created for m1's body path
{
  const e = edgeOf('mem:m1', fileEntryId('server/graph/bus.ts'))
  assert.ok(e, 'm1 → server/graph/bus.ts edge created')
  assert.equal(e!.provenance, 'derived', 'created as derived (body-sourced)')
  assert.ok(get(`SELECT id FROM entries WHERE id=?`, fileEntryId('server/graph/bus.ts')), 'file stub created')
  ok('derived edge + file stub created from a body mention')
}
// 2. legacy frontmatter edge survives, stays frontmatter-equivalent (NOT downgraded/removed)
{
  const e = edgeOf('mem:m2', fileEntryId('bin/ckn-bus.ts'))
  assert.ok(e, 'm2 frontmatter edge survives')
  assert.notEqual(e!.provenance, 'derived', 'a legacy frontmatter edge is never downgraded by the backfill')
  ok('legacy frontmatter edge preserved (explicit never auto-removed)')
}
// 3. session-sourced edge KEPT
{
  assert.ok(edgeOf('sess:s1', fileEntryId('server/index.ts')), 'session-sourced edge kept (valid provenance)')
  ok('session-sourced edge kept')
}
// 4. m2's stale derived edge is gone (reconcile); the dangling ghost edge + the
//    empty orphan stub are gone (referential triage). No memory was removed.
{
  assert.equal(edgeOf('mem:m2', 'file:server_graph_gone.ts'), undefined, 'stale derived edge reconciled away')
  assert.equal(edgeOf('mem:ghost', 'file:ghost_y.ts'), undefined, 'dangling-src edge removed by triage')
  assert.equal(get(`SELECT id FROM entries WHERE id=?`, fileEntryId('orphan/x.ts')), undefined, 'empty orphan stub removed')
  assert.ok(get(`SELECT id FROM entries WHERE id='mem:m2'`), 'the memory itself is NEVER removed')
  ok('reconcile + referential triage clean edges/stubs, never a memory')
}
// 5. bare basename excluded (no edge for config.json)
{
  assert.equal(edgeOf('mem:m1', 'file:config.json'), undefined, 'bare basename not linked')
  ok('bare basename excluded from derivation')
}
// 6. idempotency: a second run creates ZERO new edges
{
  const before = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  const r2 = await backfillLinkage()
  const after = get<{ c: number }>(`SELECT count(*) c FROM edges`)!.c
  assert.equal(after, before, 're-run creates no new edges')
  assert.equal(r2.edgesCreated, 0, 'second run reports 0 edges created')
  ok('idempotent: re-run is a no-op')
}
// 7. counts reported
{
  assert.ok(r1.scanned >= 2, `scanned the memories (got ${r1.scanned})`)
  assert.ok(r1.edgesCreated >= 1, `created at least the m1 derived edge (got ${r1.edgesCreated})`)
  assert.ok(r1.removed >= 2, `removed dangling edge + orphan stub (got ${r1.removed})`)
  ok('reports scanned / edges-created / removed counts')
}

console.log(`\nOK linkage-backfill.test.ts — ${passed} assertions passed`)
