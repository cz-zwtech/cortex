#!/usr/bin/env tsx
/**
 * Phase 2/3 gate for the Kuzu → SQLite migration of server/graph/sync.ts.
 *
 * Exercises the ported entry-CRUD + search + graph-projection + edge-materialize
 * + sync-from-disk + prune paths against a temp SQLite DB. Asserts byte-shape
 * fidelity: numeric timestamps, boolean→0/1 coercion via _rows.rowToEntry, the
 * additive updatedAt/syncedAt on getAllForGraph nodes, LIKE-substring search
 * parity, idempotent edge inserts, and the DETACH-DELETE→delete+delete+insert
 * transaction semantics (deleting/re-upserting a node clears its incident edges).
 *
 * Plain tsx + node:assert/strict, mirroring test/graph/sqlite-db.test.ts.
 * Embeddings are forced OFF so the test has no model/worker dependency.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sync-port-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_EMBEDDINGS = 'off' // no embedding model / worker in this test

// Import AFTER setting CKN_GRAPH_DB_PATH so getDb() binds to the temp file.
const { run, get, all, getDb } = await import('../../server/graph/db.js')
const sync = await import('../../server/graph/sync.js')

// ── seed a small graph via raw inserts ────────────────────────────────────────
const now = Date.now()
function insertEntry(o: {
  id: string; name: string; kind?: string; description?: string; content?: string
  source?: string; scope?: string; updatedAt?: number; syncedAt?: number
  machine?: string; pinned?: number
}) {
  run(
    `INSERT INTO entries
       (id, name, kind, description, content, source, scope, updatedAt, syncedAt, machine, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.id, o.name, o.kind ?? 'memory', o.description ?? '', o.content ?? '',
    o.source ?? '', o.scope ?? 'user', o.updatedAt ?? now, o.syncedAt ?? now,
    o.machine ?? 'host1', o.pinned ?? 0,
  )
}

insertEntry({ id: 'mem:alpha', name: 'Alpha Pattern', kind: 'memory',
  description: 'about logging things', content: 'discusses the WidgetFactory',
  scope: 'user', updatedAt: now - 1000, syncedAt: now - 500, machine: 'host1' })
insertEntry({ id: 'mem:beta', name: 'WidgetFactory', kind: 'decision',
  description: 'a beta decision', content: 'the body of beta', scope: 'project:x',
  updatedAt: now - 2000, syncedAt: now - 2000, machine: 'host2' })
insertEntry({ id: 'mem:gamma', name: 'Gamma', kind: 'memory',
  description: '', content: '', scope: 'vault', updatedAt: now, syncedAt: now,
  machine: 'host1' }) // content='' + scope='vault' → pruneStubs target

run(`INSERT INTO edges (src, dst, rel, label) VALUES ('mem:alpha','mem:beta','LINKS_TO','related')`)

// ── searchEntries: LIKE-substring parity (case-insensitive) ───────────────────
{
  const hits = await sync.searchEntries('widgetfactory', 20)
  const ids = hits.map((h: any) => h.id).sort()
  assert.deepEqual(ids, ['mem:alpha', 'mem:beta'],
    'search matches name (beta) AND content substring (alpha) case-insensitively')
  // Projection shape: searchEntries omits content/pinned; updatedAt is numeric.
  const a = hits.find((h: any) => h.id === 'mem:alpha')!
  assert.equal(typeof a.updatedAt, 'number', 'updatedAt projected as number')
  assert.ok(!('content' in a), 'content omitted from search projection')
  assert.ok(!('pinned' in a), 'pinned omitted from search projection')
  assert.equal(a.source, '', 'source projected')
}
// LIKE-metachar safety: '%' in a query must match literally (no wildcard blowup).
{
  insertEntry({ id: 'mem:pct', name: 'fifty% off', content: '', scope: 'user' })
  const pct = await sync.searchEntries('fifty% off', 20)
  assert.deepEqual(pct.map((h: any) => h.id), ['mem:pct'], '% treated as literal in LIKE')
  run(`DELETE FROM entries WHERE id='mem:pct'`)
}

// ── getEntry: row + outbound links + inbound backlinks ────────────────────────
{
  const e = await sync.getEntry('mem:alpha')
  assert.ok(e, 'entry found')
  assert.equal(e!.id, 'mem:alpha')
  assert.equal(typeof e!.updatedAt, 'number', 'updatedAt numeric')
  assert.ok('content' in e!, 'getEntry projects content')
  assert.deepEqual(e!.links, [{ id: 'mem:beta', name: 'WidgetFactory', kind: 'decision', label: 'related' }],
    'outbound LINKS_TO link shape')
  assert.deepEqual(e!.backlinks, [], 'no inbound backlinks for alpha')

  const b = await sync.getEntry('mem:beta')
  assert.deepEqual(b!.backlinks, [{ id: 'mem:alpha', name: 'Alpha Pattern', kind: 'memory', label: 'related' }],
    'inbound backlink shape')

  assert.equal(await sync.getEntry('nope'), null, 'missing id → null')
}

// ── getAllForGraph: nodes carry additive updatedAt+syncedAt; edges {from,to,label} ─
{
  const g = await sync.getAllForGraph()
  const node = g.nodes.find((n: any) => n.id === 'mem:alpha')!
  assert.ok(node, 'alpha in node projection')
  assert.equal(typeof node.updatedAt, 'number', 'node.updatedAt present + numeric (additive §3.6)')
  assert.equal(typeof node.syncedAt, 'number', 'node.syncedAt present + numeric (additive §3.6)')
  assert.equal(node.name, 'Alpha Pattern', 'node.name present')
  assert.equal(node.kind, 'memory', 'node.kind present')
  assert.equal(node.scope, 'user', 'node.scope present')
  assert.deepEqual(g.edges, [{ from: 'mem:alpha', to: 'mem:beta', label: 'related' }],
    'edge shape {from,to,label} for LINKS_TO only')
}

// ── listScopes / listKinds: {scope|kind, count} desc ──────────────────────────
{
  // Seeded scopes: user={alpha}, project:x={beta}, vault={gamma} — one each.
  const scopes = await sync.listScopes()
  const userScope = scopes.find((s: any) => s.scope === 'user')!
  assert.ok(userScope && typeof userScope.count === 'number', 'scope rows have scope+count')
  assert.equal(userScope.count, 1, 'user scope count = 1 (alpha)')
  // counts equal → still sorted, just no strict ordering to assert beyond presence
  assert.equal(scopes.length, 3, 'three distinct scopes')

  const kinds = await sync.listKinds()
  const mem = kinds.find((k: any) => k.kind === 'memory')!
  assert.equal(mem.count, 2, 'memory kind count = 2 (alpha,gamma)')
  // kinds ordered count DESC → memory (2) first
  assert.equal(kinds[0].kind, 'memory', 'kinds ordered count DESC, memory(2) leads')
}

// ── entriesByMachine: Record<machine, count> ──────────────────────────────────
{
  const byMachine = await sync.entriesByMachine()
  assert.equal(byMachine['host1'], 2, 'host1 → alpha+gamma')
  assert.equal(byMachine['host2'], 1, 'host2 → beta')
}

// ── listEntries: filters + sort + numeric coercion ────────────────────────────
{
  const mems = await sync.listEntries('memory')
  assert.deepEqual(mems.map((e: any) => e.id).sort(), ['mem:alpha', 'mem:gamma'], 'kind filter')

  const byScope = await sync.listEntries(undefined, undefined, 100, 'updated', undefined, 'project:x')
  assert.deepEqual(byScope.map((e: any) => e.id), ['mem:beta'], 'scope filter')

  const since = await sync.listEntries(undefined, now - 1500)
  assert.deepEqual(since.map((e: any) => e.id).sort(), ['mem:alpha', 'mem:gamma'], 'since (updatedAt>=) filter')

  const byMachine = await sync.listEntries(undefined, undefined, 100, 'updated', undefined, undefined, 'host2')
  assert.deepEqual(byMachine.map((e: any) => e.id), ['mem:beta'], 'machine filter')

  // sort=updated DESC: gamma(now) > alpha(now-1000) > beta(now-2000)
  const allUpdated = await sync.listEntries()
  assert.deepEqual(allUpdated.map((e: any) => e.id), ['mem:gamma', 'mem:alpha', 'mem:beta'], 'updated DESC order')

  // sort=synced DESC: gamma(now) > alpha(now-500) > beta(now-2000)
  const allSynced = await sync.listEntries(undefined, undefined, 100, 'synced')
  assert.deepEqual(allSynced.map((e: any) => e.id), ['mem:gamma', 'mem:alpha', 'mem:beta'], 'synced DESC order')

  const lim = await sync.listEntries(undefined, undefined, 1)
  assert.equal(lim.length, 1, 'limit honored')

  // syncedSince filter
  const ss = await sync.listEntries(undefined, undefined, 100, 'synced', now - 600)
  assert.deepEqual(ss.map((e: any) => e.id).sort(), ['mem:alpha', 'mem:gamma'], 'syncedSince filter')
}

// ── pruneStubs: scope='vault' AND content='' only ─────────────────────────────
{
  const removed = await sync.pruneStubs()
  assert.equal(removed, 1, 'pruneStubs removed exactly the vault/empty stub (gamma)')
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM entries WHERE id='mem:gamma'`)!.c, 0,
    'gamma gone')
  // alpha/beta (real content) untouched
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM entries`)!.c, 2, 'two real entries remain')
}

// ── ensureEdge idempotency + deleteScope edge cleanup ─────────────────────────
{
  // A second LINKS_TO with same (src,dst,rel) must be ignored (composite PK).
  run(`INSERT OR IGNORE INTO edges (src,dst,rel,label) VALUES ('mem:alpha','mem:beta','LINKS_TO','dup')`)
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM edges`)!.c, 1, 'duplicate edge ignored')

  // deleteScope drops project:x (beta) AND its incident edge (alpha→beta).
  const n = await sync.deleteScope('project:x')
  assert.equal(n, 1, 'deleteScope removed 1 entry (beta)')
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM edges`)!.c, 0,
    'incident edge cleaned up (no dangling edge to deleted beta)')
}

// ── materializeTypedEdges via a real disk sync ────────────────────────────────
// Build a fake $HOME with one memory file that declares typed-edge frontmatter,
// then run syncMemories and assert the stubs + typed edges land.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-home-'))
  const memDir = path.join(home, '.claude', 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, 'lesson.md'),
    `---\nname: SSH lesson\ntype: memory\nmentions_files:\n  - /etc/hosts\nmentions_tools:\n  - Bash\noccurred_in: sess-123\nagent_id: agent-007\n---\nbody about ssh and the WidgetFactory thing\n`,
    'utf8')

  const r = await sync.syncMemories(home)
  assert.ok(r.synced >= 1, `synced at least the lesson (got synced=${r.synced})`)
  assert.deepEqual(r.errors, [], 'no sync errors')

  const lessonId = 'user/lesson'
  // Stubs auto-created
  assert.ok(get(`SELECT id FROM entries WHERE id='file:_etc_hosts'`), 'file stub created')
  assert.ok(get(`SELECT id FROM entries WHERE id='tool:bash'`), 'tool stub (lowercased) created')
  assert.ok(get(`SELECT id FROM entries WHERE id='sess-123'`), 'session stub created')
  assert.ok(get(`SELECT id FROM entries WHERE id='agent:agent-007'`), 'agent stub created')
  // Typed edges land with the right rel discriminator
  const rels = all<{ rel: string; dst: string }>(
    `SELECT rel, dst FROM edges WHERE src=? ORDER BY rel`, lessonId)
  const relSet = new Set(rels.map((x) => x.rel))
  for (const want of ['MENTIONS_FILE', 'MENTIONS_TOOL', 'OCCURRED_IN', 'AUTHORED_BY']) {
    assert.ok(relSet.has(want), `typed edge ${want} created from lesson`)
  }
  assert.equal(rels.find((x) => x.rel === 'MENTIONS_TOOL')!.dst, 'tool:bash', 'MENTIONS_TOOL → tool stub')

  // Re-sync with no file change: delta-skip, no errors, edges still present.
  const r2 = await sync.syncMemories(home)
  assert.deepEqual(r2.errors, [], 'idempotent re-sync no errors')
  assert.ok(get(`SELECT 1 FROM edges WHERE src=? AND rel='MENTIONS_FILE'`, lessonId),
    'typed edge survives a delta-skip re-sync')

  fs.rmSync(home, { recursive: true, force: true })
}

// ── pruneOrphanStubs: single-statement orphan removal ─────────────────────────
{
  // An empty-content stub with NO edge → orphan. One WITH an edge survives.
  run(`INSERT INTO entries (id,name,kind,content,scope,updatedAt,syncedAt) VALUES ('file:orphan','x','file','','file',0,0)`)
  run(`INSERT INTO entries (id,name,kind,content,scope,updatedAt,syncedAt) VALUES ('file:linked','y','file','','file',0,0)`)
  run(`INSERT OR IGNORE INTO edges (src,dst,rel) VALUES ('user/lesson','file:linked','MENTIONS_FILE')`)

  const removed = await sync.pruneOrphanStubs()
  assert.ok(removed >= 1, `removed the unlinked orphan (got ${removed})`)
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM entries WHERE id='file:orphan'`)!.c, 0,
    'orphan stub removed')
  assert.equal(get<{ c: number }>(`SELECT count(*) AS c FROM entries WHERE id='file:linked'`)!.c, 1,
    'edged stub kept')
  // Real content rows are never orphan-pruned even if edgeless.
  assert.ok(get(`SELECT id FROM entries WHERE id='user/lesson'`), 'content-bearing entry never pruned')
}

getDb().close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('sync-port OK')
process.exit(0)
