/**
 * Focused unit test for the §3.8 "easy batch" SQLite ports:
 *   derive.ts (coverage join + deriveObservations guard)
 *   contradictions.ts (findContradictions)
 *   patterns.ts (upsertPattern transaction + searchPatterns/searchSharedKnowledge LIKE)
 *   vaultImport.ts (importVaultPaths INSERT OR REPLACE + edge clear)
 *   routes/observations.ts (observation_meta join read)
 *
 * Run: CKN_EMBEDDINGS=off npx tsx test/graph/easy-batch.test.ts
 * Uses a temp DB via CKN_GRAPH_DB_PATH (set before importing db.ts).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.CKN_EMBEDDINGS = 'off' // skip model load; exercise non-embedding paths
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-easybatch-'))
process.env.CKN_GRAPH_DB_PATH = path.join(tmpDir, 't.sqlite')

const { run, all, get, getDb } = await import('../../server/graph/db.js')
const { findContradictions } = await import('../../server/graph/contradictions.js')
const { upsertPattern, searchPatterns, searchSharedKnowledge } = await import(
  '../../server/graph/patterns.js'
)
const { importVaultPaths } = await import('../../server/graph/vaultImport.js')
const { deriveObservations } = await import('../../server/graph/derive.js')

// Force schema init.
getDb()

let passed = 0
const ok = (label: string) => {
  passed++
  console.log(`  ok ${label}`)
}

// ── helpers ──────────────────────────────────────────────────────────────────
const insertEntry = (o: Record<string, any>) =>
  run(
    `INSERT OR REPLACE INTO entries ` +
      `(id, name, kind, description, content, source, scope, updatedAt, syncedAt, outcome) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.id,
    o.name ?? '',
    o.kind ?? 'memory',
    o.description ?? '',
    o.content ?? '',
    o.source ?? '',
    o.scope ?? 'user',
    o.updatedAt ?? 0,
    o.syncedAt ?? 0,
    o.outcome ?? '',
  )

// ── 1. findContradictions ──────────────────────────────────────────────────────
{
  // new memory: outcome 'failure', mentions file 'a.ts' and tool 'Bash'
  // old memory M1: outcome 'success', mentions file 'a.ts'  → contradicts (opposite + shared file)
  // old memory M2: outcome 'success', mentions tool 'Bash'  → contradicts (shared tool)
  // old memory M3: outcome 'success', mentions file 'z.ts'  → no shared context, NOT a contradiction
  // old memory M4: outcome 'failure' (same outcome)          → NOT a contradiction
  insertEntry({ id: 'm1', kind: 'memory', outcome: 'success' })
  insertEntry({ id: 'm2', kind: 'memory', outcome: 'success' })
  insertEntry({ id: 'm3', kind: 'memory', outcome: 'success' })
  insertEntry({ id: 'm4', kind: 'memory', outcome: 'failure' })
  insertEntry({ id: 'file:a', kind: 'file', name: 'a.ts' })
  insertEntry({ id: 'file:z', kind: 'file', name: 'z.ts' })
  insertEntry({ id: 'tool:bash', kind: 'tool', name: 'Bash' })
  run(`INSERT INTO edges (src, dst, rel) VALUES ('m1', 'file:a', 'MENTIONS_FILE')`)
  run(`INSERT INTO edges (src, dst, rel) VALUES ('m2', 'tool:bash', 'MENTIONS_TOOL')`)
  run(`INSERT INTO edges (src, dst, rel) VALUES ('m3', 'file:z', 'MENTIONS_FILE')`)

  const hits = await findContradictions({
    similarIds: ['m1', 'm2', 'm3', 'm4'],
    outcome: 'failure',
    mentionsFiles: ['a.ts'],
    mentionsTools: ['Bash'],
  })
  assert.deepEqual([...hits].sort(), ['m1', 'm2'], 'contradictions = m1,m2')
  ok('findContradictions: opposite-outcome + shared file/tool')

  // outcome with no clean opposite → [] before any DB work
  const none = await findContradictions({
    similarIds: ['m1'],
    outcome: 'unknown',
    mentionsFiles: ['a.ts'],
    mentionsTools: [],
  })
  assert.deepEqual(none, [], 'no-opposite outcome short-circuits')
  ok('findContradictions: no-opposite outcome → []')

  // empty similar list → []
  assert.deepEqual(
    await findContradictions({ similarIds: [], outcome: 'failure', mentionsFiles: [], mentionsTools: [] }),
    [],
  )
  ok('findContradictions: empty input → []')
}

// ── 2. upsertPattern (transaction: entry + pattern_meta + concept + LINKS_TO edge) ──
{
  const cand = {
    id: 'pattern:/tmp/proj/sess1/tu_fail',
    projectDir: '/tmp/proj',
    sessionId: 'sess1',
    tool: 'Bash',
    failToolUseId: 'tu_fail',
    successToolUseId: 'tu_ok',
    failArgs: 'sleep 5',
    successArgs: 'sleep 5 &',
    errorMessage: 'sleep blocked by approval',
    failTimestamp: '2026-06-02T10:00:00.000Z',
    successTimestamp: '2026-06-02T10:01:00.000Z',
  }
  const isNew = await upsertPattern(cand)
  assert.equal(isNew, true, 'first upsert is new')
  ok('upsertPattern: first insert returns true')

  const stableId = `-tmp-proj/pattern-${(await import('../../server/graph/patterns.js')).patternFingerprint(cand)}`
  const entryRow = get<any>(`SELECT id, kind, scope, outcome, authorship FROM entries WHERE id = ?`, stableId)
  assert.ok(entryRow, 'pattern entry row exists')
  assert.equal(entryRow.kind, 'pattern')
  assert.equal(entryRow.scope, 'pattern:auto')
  assert.equal(entryRow.outcome, 'success')
  assert.equal(entryRow.authorship, 'auto-extracted')
  ok('upsertPattern: entry row has pattern shape')

  const metaRow = get<any>(`SELECT tool, fingerprint FROM pattern_meta WHERE id = ?`, stableId)
  assert.ok(metaRow, 'pattern_meta row exists')
  assert.equal(metaRow.tool, 'Bash')
  ok('upsertPattern: pattern_meta specialization written')

  const conceptRow = get<any>(`SELECT id, kind FROM entries WHERE id = 'concept:bash'`)
  assert.ok(conceptRow, 'tool concept stub exists')
  assert.equal(conceptRow.kind, 'concept')
  ok('upsertPattern: tool concept stub created')

  const edgeRow = get<any>(
    `SELECT label FROM edges WHERE src = ? AND dst = 'concept:bash' AND rel = 'LINKS_TO'`,
    stableId,
  )
  assert.ok(edgeRow, 'LINKS_TO edge exists')
  assert.equal(edgeRow.label, 'tool')
  ok('upsertPattern: LINKS_TO {label:tool} edge created')

  // Same fingerprint again from a different session → deduped (false), no dup entry.
  const dup = await upsertPattern({ ...cand, sessionId: 'sess2', failToolUseId: 'tu_fail2' })
  assert.equal(dup, false, 'duplicate fingerprint → false')
  const cnt = get<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE kind = 'pattern'`)
  assert.equal(cnt!.n, 1, 'still one pattern entry')
  ok('upsertPattern: fingerprint dedup blocks duplicate')

  // searchPatterns keyword path: 'Bash' substring on name (LIKE-faithful).
  const found = await searchPatterns('Bash', 5)
  assert.ok(found.length >= 1, 'searchPatterns finds the Bash pattern')
  assert.equal(found[0]!.source, 'pattern')
  ok('upsertPattern + searchPatterns: keyword LIKE match')

  // searchPatterns with a tool that doesn't appear in any name → empty.
  const miss = await searchPatterns('NonexistentToolXYZ', 5)
  assert.deepEqual(miss, [], 'no keyword + no semantic (off) → []')
  ok('searchPatterns: no match → []')
}

// ── 3. searchSharedKnowledge (scope LIKE shared:% + name/desc/content CONTAINS) ──
{
  insertEntry({
    id: 'shared:team:ssh-note',
    kind: 'memory',
    name: 'SSH via Bash',
    description: 'how Corey uses Bash for SSH',
    content: 'always SSH the -claude host',
    scope: 'shared:team',
    syncedAt: 100,
  })
  insertEntry({
    id: 'shared:team:unrelated',
    kind: 'memory',
    name: 'Postgres tuning',
    description: 'vacuum settings',
    content: 'autovacuum',
    scope: 'shared:team',
    syncedAt: 200,
  })
  // A non-shared entry mentioning Bash must NOT surface.
  insertEntry({ id: 'user:bash-local', kind: 'memory', name: 'Bash local', scope: 'user' })

  const shared = await searchSharedKnowledge('Bash', 5)
  assert.equal(shared.length, 1, 'one shared hit for Bash')
  assert.equal(shared[0]!.id, 'shared:team:ssh-note')
  assert.equal(shared[0]!.source, 'shared')
  ok('searchSharedKnowledge: shared scope + CONTAINS match, excludes user scope')

  // LIKE metacharacter safety: a literal '%' search must not wildcard-match all.
  const pctMiss = await searchSharedKnowledge('%', 5)
  assert.deepEqual(pctMiss, [], "literal '%' is escaped, not a wildcard")
  ok('searchSharedKnowledge: LIKE metacharacters escaped')
}

// ── 4. importVaultPaths (INSERT OR REPLACE per file + edge clear) ──────────────
{
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-vault-'))
  const noteA = path.join(vaultDir, 'philosophy', 'principle.md')
  fs.mkdirSync(path.dirname(noteA), { recursive: true })
  fs.writeFileSync(noteA, '---\ntitle: A Principle\ndescription: a desc\n---\nbody text\n')
  const noteB = path.join(vaultDir, 'plain.md')
  fs.writeFileSync(noteB, 'no frontmatter here\n')
  fs.writeFileSync(path.join(vaultDir, 'MEMORY.md'), 'skip me\n') // excluded by collectFiles

  const res = await importVaultPaths('MyVault', [vaultDir])
  assert.equal(res.imported, 2, 'imported 2 markdown files (MEMORY.md excluded)')
  assert.equal(res.errors.length, 0, 'no errors')
  ok('importVaultPaths: imported count + MEMORY.md exclusion')

  // scope lowercased to vault:myvault; id = vault:myvault:<filename>
  const principle = get<any>(`SELECT id, name, kind, scope, description FROM entries WHERE id = 'vault:myvault:principle'`)
  assert.ok(principle, 'principle entry exists')
  assert.equal(principle.scope, 'vault:myvault', 'scope lowercased')
  assert.equal(principle.name, 'A Principle', 'title → name')
  assert.equal(principle.kind, 'decision', '/philosophy/ folder → decision kind')
  ok('importVaultPaths: frontmatter shape + folder kind inference + lowercased scope')

  const plain = get<any>(`SELECT id, name, kind FROM entries WHERE id = 'vault:myvault:plain'`)
  assert.ok(plain, 'plain entry exists')
  assert.equal(plain.name, 'plain', 'no-frontmatter → filename as name')
  ok('importVaultPaths: plain markdown falls back to filename')

  // Re-import clears stale incident edges (DETACH-DELETE semantics).
  run(`INSERT INTO edges (src, dst, rel) VALUES ('vault:myvault:principle', 'vault:myvault:plain', 'LINKS_TO')`)
  const before = get<{ n: number }>(`SELECT COUNT(*) AS n FROM edges WHERE src = 'vault:myvault:principle'`)
  assert.equal(before!.n, 1, 'stale edge present before re-import')
  const res2 = await importVaultPaths('MyVault', [noteA])
  assert.equal(res2.imported, 1)
  const after = get<{ n: number }>(`SELECT COUNT(*) AS n FROM edges WHERE src = 'vault:myvault:principle'`)
  assert.equal(after!.n, 0, 're-import cleared incident edges (DETACH DELETE)')
  // INSERT OR REPLACE → still exactly one row, not a duplicate.
  const dupCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE id = 'vault:myvault:principle'`)
  assert.equal(dupCount!.n, 1, 'INSERT OR REPLACE keeps a single row')
  ok('importVaultPaths: re-import is idempotent + clears stale edges')

  fs.rmSync(vaultDir, { recursive: true, force: true })
}

// ── 5. deriveObservations: embeddings-off guard + coverage join SQL ────────────
{
  await assert.rejects(
    () => deriveObservations({}),
    /embeddings are off/,
    'deriveObservations throws when embeddings off',
  )
  ok('deriveObservations: embeddings-off guard throws')

  // Exercise the coverage join the way deriveObservations does: an observation
  // entry with DERIVED_FROM edges marks its sources as covered.
  insertEntry({ id: 'observation:user/o1', kind: 'observation', scope: 'user' })
  run(`INSERT INTO observation_meta (id, trend, evidence_count, first_observed, last_observed, observer, pinned) VALUES ('observation:user/o1','stable',2,1,2,'self',0)`)
  run(`INSERT INTO edges (src, dst, rel) VALUES ('observation:user/o1','m1','DERIVED_FROM')`)
  run(`INSERT INTO edges (src, dst, rel) VALUES ('observation:user/o1','m2','DERIVED_FROM')`)
  const cov = all<{ oid: string; mid: string }>(
    `SELECT ed.src AS oid, ed.dst AS mid FROM edges ed ` +
      `JOIN entries o ON o.id = ed.src ` +
      `WHERE ed.rel = 'DERIVED_FROM' AND o.kind = 'observation'`,
  )
  assert.deepEqual(cov.map((r) => r.mid).sort(), ['m1', 'm2'], 'coverage join returns the two sources')
  ok('deriveObservations: DERIVED_FROM coverage join shape')
}

// ── 6. observations route read shape (entries × observation_meta join) ─────────
{
  // Replicate the route's join + mapper path directly (the router handler is
  // thin glue over this SQL + rowToObservation).
  const { rowToObservation } = await import('../../server/graph/_rows.js')
  const rows = all<Record<string, any>>(
    `SELECT e.id AS id, e.name AS name, e.description AS description, ` +
      `       e.scope AS scope, e.updatedAt AS updatedAt, ` +
      `       o.trend AS trend, o.evidence_count AS evidence_count, ` +
      `       o.first_observed AS first_observed, o.last_observed AS last_observed, ` +
      `       o.observer AS observer, o.pinned AS pinned ` +
      `FROM entries e JOIN observation_meta o ON e.id = o.id ` +
      `WHERE e.kind = 'observation'`,
  )
  assert.equal(rows.length, 1, 'one observation joined')
  const dto = rowToObservation(rows[0]!)
  assert.equal(dto.id, 'observation:user/o1')
  assert.equal(dto.trend, 'stable')
  assert.equal(dto.evidence_count, 2)
  assert.equal(dto.observer, 'self')
  assert.equal(dto.pinned, false, 'pinned 0 → false (toBool coercion)')
  ok('observations route: join + rowToObservation shape')
}

console.log(`\n${passed} assertions passed.`)
fs.rmSync(tmpDir, { recursive: true, force: true })
