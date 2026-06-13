/**
 * Code-graph symbols inside the singular Cortex graph.
 *
 * The codegraph package (`/personal/codegraph`) extracts Symbol nodes +
 * CALLS/IMPORTS/EXTENDS/IMPLEMENTS/REFERENCES edges from source and emits a
 * JSON snapshot. This module is the SQLite half of the CodeGraphStore seam: it
 * folds that snapshot into the SAME graph DB as Entry (memory) nodes —
 * principle #1, singular mind. Symbols carry the forgetting-lifecycle fields
 * (stickiness/lastSeen/groundTruthValid) verbatim — principle #2 — so a later
 * forget sweep can act on them. The community toggle (principle #3) lives
 * upstream in the codegraph package; here we are one concrete store
 * implementation behind the same node/edge shape.
 *
 * Edge kinds map 1:1 to the codegraph `EdgeKind` union. All symbol edges are
 * FROM Symbol TO Symbol; they live in the SAME `edges` table as Entry edges,
 * discriminated by the `rel` column. Symbol ids are fully qualified
 * (`machine@branch::naturalId`) and Entry ids are not, so they never collide.
 *
 * SQLite migration: the old "NEVER call these helpers outside withGraphWriteLock"
 * rule is gone — better-sqlite3 statements are synchronous and cannot
 * interleave. Multi-statement mutations are wrapped in `transaction()` for
 * atomicity. Reads issue plain `all()`/`get()` with bound params (never string
 * interpolation).
 */
import { all, get, run, transaction, getDb } from './db.js'
import { rowToSymbol, rowToGraphHead, type SymbolRow, type GraphHeadRow } from './_rows.js'

export type { SymbolRow, GraphHeadRow }

// Edge kinds the codegraph emits. Kept as a const list so the snapshot's
// freeform `kind` string maps to a real `rel` value; anything else is ignored.
export const SYMBOL_EDGE_TABLES = [
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'REFERENCES',
] as const
export type SymbolEdgeKind = (typeof SYMBOL_EDGE_TABLES)[number]

const EDGE_TABLE_SET = new Set<string>(SYMBOL_EDGE_TABLES)

// Build a parameterised `IN (?,?,…)` placeholder list for a list of values.
const inClause = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

// Fully-qualified Symbol id: `${machine}@${branch}::${naturalId}` where
// naturalId is the extractor's `repo:file#name`. Machine + branch live in the
// PK so a swarm branch, the user's branch, and a peer machine's view coexist
// without collision. Split on the FIRST '::' so a naturalId containing '::'
// (rare, but legal in a path) round-trips.
export function qualifyId(machine: string, branch: string, naturalId: string): string {
  return `${machine}@${branch}::${naturalId}`
}

export function parseQualifiedId(
  id: string,
): { machine: string; branch: string; naturalId: string } | null {
  const sep = id.indexOf('::')
  if (sep < 0) return null
  const head = id.slice(0, sep)
  const naturalId = id.slice(sep + 2)
  const at = head.indexOf('@')
  if (at < 0) return null
  return { machine: head.slice(0, at), branch: head.slice(at + 1), naturalId }
}

// ── snapshot shape (mirror of codegraph/src/types.ts) ───────────────────────

export interface SnapshotLifecycle {
  base?: number
  stickiness?: number
  lastSeen?: number
  pinned?: boolean
  groundTruthValid?: boolean
}

export interface SnapshotSymbol {
  id: string
  name: string
  symbolKind: string
  repo: string
  file: string
  lang?: string
  line?: number
  signature?: string
  lifecycle?: SnapshotLifecycle
}

export interface SnapshotEdge {
  src: string
  dst: string
  kind: string
}

export interface CodeGraphSnapshot {
  symbols: SnapshotSymbol[]
  edges: SnapshotEdge[]
}

// ── schema ───────────────────────────────────────────────────────────────────

/**
 * Idempotent symbol-schema setup. Under SQLite the whole graph schema (symbols
 * + the unified `edges` table + graph_heads) is created once by `initSchema`
 * (db.ts → schema.sql) on every boot, so there is nothing per-call to do here.
 * Retained as a no-op so the ~dozen `await ensureSymbolSchema(conn)` call sites
 * (read + write paths, migration 0007) keep compiling unchanged; opening the DB
 * via getDb() guarantees the schema exists.
 *
 * The `conn` parameter is accepted (and ignored) for signature compatibility
 * with the old connection-taking form.
 */
export async function ensureSymbolSchema(_conn?: unknown): Promise<void> {
  // schema.sql already created `symbols`, `edges`, `graph_heads`. Touch the DB
  // so a never-opened handle is initialised.
  getDb()
}

export interface RebuildResult {
  migrated: number
  edges: number
  skipped: boolean
}

/**
 * The v2 PK migration is obsolete under SQLite: the qualified-id schema is the
 * only schema, applied once from schema.sql, and the one-time import
 * lands symbols already qualified. There is no old-PK table to rebuild. Kept as
 * a signature-compatible no-op so migration 0013 / the dry-run CLI still link;
 * always reports `skipped: true`.
 */
export async function rebuildSymbolTableV2(
  _conn: unknown,
  _opts: { machine: string; defaultBranch: string },
): Promise<RebuildResult> {
  await ensureSymbolSchema()
  return { migrated: 0, edges: 0, skipped: true }
}

// ── reconciler ───────────────────────────────────────────────────────────────

export interface UpsertSymbolsResult {
  symbols: number
  edges: number
  invalidated: number
  repos: string[]
}

/**
 * Fold a codegraph snapshot into the graph. Delta-aware:
 *   - existing Symbol nodes preserve their earned lifecycle (stickiness,
 *     base, lastSeen, pinned) — only structural fields + groundTruthValid
 *     are refreshed, matching JsonSnapshotStore.upsert.
 *   - new symbols land with the snapshot's lifecycle (or defaults).
 *   - edges originating from any symbol in the snapshot are replaced
 *     wholesale (idempotent upsert of the re-extracted source's outgoing
 *     edges).
 *
 * When `reExtractedRepos` is given, any symbol previously known in one of
 * those repos but absent from this snapshot is marked groundTruthValid=false
 * — the provable-staleness signal. The node and its edges are NOT deleted;
 * a later forget sweep archives below-threshold nodes while edges stay as
 * history.
 */
export interface UpsertOpts {
  reExtractedRepos?: string[]
  originMachine?: string
  machine?: string
  repoRoot?: string
  branch?: string
  commitSha?: string
  dirty?: boolean
  dirtyFiles?: string
  baseBranch?: string
}

/** Public entry. */
export async function upsertSymbols(
  snapshot: CodeGraphSnapshot,
  opts: UpsertOpts = {},
): Promise<UpsertSymbolsResult> {
  return __upsertSymbolsOn(getDb(), snapshot, opts)
}

/**
 * Connection-taking core (test seam). Provenance-aware: every symbol id is
 * qualified `${machine}@${branch}::${naturalId}`; staleness + centrality are
 * scoped to the (repo, branch, machine) being re-extracted so re-extracting one
 * branch never invalidates another. Writes a GraphHead freshness row.
 *
 * The whole fold runs in ONE transaction (atomic + fast). The `_conn` parameter
 * is accepted for signature compatibility; all writes go through the module
 * helpers against the singleton DB.
 */
export async function __upsertSymbolsOn(
  _conn: unknown,
  snapshot: CodeGraphSnapshot,
  opts: UpsertOpts = {},
): Promise<UpsertSymbolsResult> {
  await ensureSymbolSchema()

  const now = Date.now()
  const { getMachineId } = await import('../privateMind.js')
  const machine = opts.machine ?? opts.originMachine ?? getMachineId()
  const branch = opts.branch ?? ''
  const commitSha = opts.commitSha ?? ''
  const dirty = opts.dirty === true
  const repoRoot = opts.repoRoot ?? ''
  const symbols = Array.isArray(snapshot.symbols) ? snapshot.symbols : []
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : []

  // Map natural id → qualified id for THIS (machine, branch).
  const qid = (naturalId: string) => qualifyId(machine, branch, naturalId)

  // Preserve earned lifecycle on existing nodes (by qualified id).
  const existingLifecycle = new Map<
    string,
    { base: number; stickiness: number; lastSeen: number; pinned: boolean }
  >()
  const priorRows = all<{
    id: string
    base: number | null
    stickiness: number | null
    lastSeen: number | null
    pinned: number | null
  }>(
    `SELECT id, base, stickiness, lastSeen, pinned FROM symbols WHERE machine = ? AND branch = ?`,
    machine,
    branch,
  )
  for (const row of priorRows) {
    existingLifecycle.set(String(row.id), {
      base: Number(row.base ?? 1),
      stickiness: Number(row.stickiness ?? 0),
      lastSeen: Number(row.lastSeen ?? 0),
      pinned: row.pinned === 1 || (row.pinned as unknown) === true,
    })
  }

  const seen = new Set<string>() // qualified ids in this snapshot
  let symbolCount = 0
  let edgeCount = 0
  let invalidated = 0
  const upsertRepos = [...new Set(symbols.map((s) => s.repo).filter(Boolean))]

  // Per-repo base branch for the GraphHead row. Honor the caller's explicit value
  // (the ingest path passes it from git provenance); otherwise resolve the repo's
  // recorded base (avoids clobbering a `develop`-based repo to `main`), then floor
  // at `main`. Resolved BEFORE the (sync) transaction since it reads the DB.
  const baseBranchByRepo = new Map<string, string>()
  for (const repo of upsertRepos) {
    baseBranchByRepo.set(
      repo,
      opts.baseBranch ?? (await defaultBaseBranch(repo, machine)),
    )
  }

  // Reusable prepared statements (compiled once per upsert).
  const db = getDb()
  const delEdges = db.prepare(`DELETE FROM edges WHERE src = ? OR dst = ?`)
  const delSym = db.prepare(`DELETE FROM symbols WHERE id = ?`)
  const insSym = db.prepare(
    `INSERT INTO symbols (
      id, name, symbolKind, repo, file, lang, line, signature,
      base, stickiness, centrality, lastSeen, pinned, groundTruthValid,
      syncedAt, machine, root, branch, commitSha, dirty, extractedAt, naturalId
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const insEdge = db.prepare(`INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)`)
  const markStale = db.prepare(`UPDATE symbols SET groundTruthValid = 0 WHERE id = ?`)

  transaction(() => {
    for (const sym of symbols) {
      if (!sym?.id) continue
      const naturalId = sym.id
      const id = qid(naturalId)
      seen.add(id)
      const prior = existingLifecycle.get(id)
      const lc = sym.lifecycle ?? {}
      const base = prior ? prior.base : Number(lc.base ?? 1)
      const stickiness = prior ? prior.stickiness : Number(lc.stickiness ?? 0)
      const lastSeen = prior ? prior.lastSeen : Number(lc.lastSeen ?? now)
      const pinned = prior ? prior.pinned : lc.pinned === true

      // DETACH DELETE → delete incident edges + the node, then recreate.
      delEdges.run(id, id)
      delSym.run(id)
      insSym.run(
        id,
        String(sym.name ?? ''),
        String(sym.symbolKind ?? ''),
        String(sym.repo ?? ''),
        String(sym.file ?? ''),
        String(sym.lang ?? ''),
        Number.isFinite(sym.line) ? Math.floor(sym.line as number) : 0,
        String(sym.signature ?? ''),
        base,
        stickiness,
        0, // centrality (recomputed below)
        lastSeen,
        pinned ? 1 : 0,
        1, // groundTruthValid
        now,
        machine,
        repoRoot,
        branch,
        commitSha,
        dirty ? 1 : 0,
        now,
        naturalId,
      )
      symbolCount++
    }

    // Edges — qualify both endpoints to this (machine, branch).
    const presentNatural = new Set(symbols.map((s) => s.id))
    for (const e of edges) {
      if (!e?.src || !e?.dst) continue
      const rel = String(e.kind).toUpperCase()
      if (!EDGE_TABLE_SET.has(rel)) continue
      if (!presentNatural.has(e.src)) continue
      // Only create the edge when both endpoints exist (an edge whose endpoint
      // is missing is silently skipped). dst may be outside the
      // snapshot, so check the store for it.
      const dstId = qid(e.dst)
      const dstExists =
        presentNatural.has(e.dst) ||
        get<{ id: string }>(`SELECT id FROM symbols WHERE id = ?`, dstId) != null
      if (!dstExists) continue
      insEdge.run(qid(e.src), dstId, rel)
      edgeCount++
    }

    // Scoped staleness: only within THIS (repo, branch, machine).
    for (const repo of opts.reExtractedRepos ?? []) {
      const rows = all<{ id: string }>(
        `SELECT id FROM symbols WHERE repo = ? AND branch = ? AND machine = ? AND groundTruthValid <> 0`,
        repo,
        branch,
        machine,
      )
      for (const row of rows) {
        if (seen.has(String(row.id))) continue
        markStale.run(String(row.id))
        invalidated++
      }
    }

    // Scoped centrality (in-transaction; pure sync writes).
    recomputeCentralitySync({ branch, machine })

    // GraphHead freshness row per (repo, branch, machine).
    for (const repo of upsertRepos) {
      writeGraphHeadSync({
        repo,
        branch,
        machine,
        commitSha,
        dirty,
        dirtyFiles: opts.dirtyFiles ?? '',
        baseBranch: baseBranchByRepo.get(repo) ?? 'main',
        extractedAt: now,
      })
    }
  })

  return { symbols: symbolCount, edges: edgeCount, invalidated, repos: upsertRepos }
}

/**
 * Set each symbol's `centrality` to its incoming-edge count and raise
 * `stickiness` to the centrality-derived floor (never lowers it — earned
 * reinforcement wins). Pinned nodes are left alone. Scoped to (branch, machine)
 * so re-extracting one branch never reweights another.
 *
 * Synchronous core (runs inside the upsert transaction). The stickiness floor
 * is `MAX(stickiness, floor)` so it can only rise.
 */
function recomputeCentralitySync(scope: { branch: string; machine: string }): void {
  // In-degree per target symbol, over symbol edge kinds, within the scope.
  // Target side (b) carries the scope filter — filtered on b.branch/b.machine.
  const rows = all<{ id: string; c: number }>(
    `SELECT e.dst AS id, COUNT(*) AS c
       FROM edges e
       JOIN symbols b ON b.id = e.dst
      WHERE e.rel IN (${inClause(SYMBOL_EDGE_TABLES.length)})
        AND b.branch = ? AND b.machine = ?
      GROUP BY e.dst`,
    ...SYMBOL_EDGE_TABLES,
    scope.branch,
    scope.machine,
  )
  const setCentrality = getDb().prepare(`UPDATE symbols SET centrality = ? WHERE id = ?`)
  const raiseStickiness = getDb().prepare(
    `UPDATE symbols SET stickiness = ? WHERE id = ? AND pinned = 0 AND stickiness < ?`,
  )
  for (const row of rows) {
    const deg = Number(row.c ?? 0)
    const floor = deg <= 0 ? 0 : Math.min(1, deg / (deg + 1))
    setCentrality.run(deg, String(row.id))
    if (floor > 0) raiseStickiness.run(floor, String(row.id), floor)
  }
}

// ── GraphHead freshness ────────────────────────────────────────────────────

const graphHeadId = (repo: string, branch: string, machine: string) =>
  `${repo}@${branch}@${machine}`

// Cap stored dirtyFiles so a whole-tree-churn porcelain (huge refactor / fresh
// clone with line-ending changes) can't write a multi-MB string into the graph.
const MAX_DIRTY_FILES = 4000

/** Synchronous upsert of the GraphHead freshness row (delete + insert). */
function writeGraphHeadSync(h: GraphHeadRow): void {
  const id = graphHeadId(h.repo, h.branch, h.machine)
  const dirtyFiles =
    h.dirtyFiles.length > MAX_DIRTY_FILES
      ? h.dirtyFiles.slice(0, MAX_DIRTY_FILES) + '\n…(truncated)'
      : h.dirtyFiles
  run(`DELETE FROM graph_heads WHERE id = ?`, id)
  run(
    `INSERT INTO graph_heads (id, repo, branch, machine, commitSha, dirty, dirtyFiles, baseBranch, extractedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    h.repo,
    h.branch,
    h.machine,
    h.commitSha,
    h.dirty === true ? 1 : 0,
    dirtyFiles,
    h.baseBranch,
    Math.floor(h.extractedAt),
  )
}

/** Upsert the GraphHead freshness row. Signature-compatible (conn ignored). */
export async function writeGraphHead(_conn: unknown, h: GraphHeadRow): Promise<void> {
  await ensureSymbolSchema()
  writeGraphHeadSync(h)
}

const HEAD_COLS =
  `repo, branch, machine, commitSha, dirty, dirtyFiles, baseBranch, extractedAt`

/** Read the single GraphHead matching (repo,branch,machine), or null. */
export async function __readGraphHeadOn(
  _conn: unknown,
  key: { repo: string; branch: string; machine: string },
): Promise<GraphHeadRow | null> {
  await ensureSymbolSchema()
  const id = graphHeadId(key.repo, key.branch, key.machine)
  const row = get<Record<string, any>>(
    `SELECT ${HEAD_COLS} FROM graph_heads WHERE id = ?`,
    id,
  )
  return row ? rowToGraphHead(row) : null
}

/** Public head reader — filter rows by any subset of repo/branch/machine. */
export async function readGraphHeads(
  filter: { repo?: string; branch?: string; machine?: string } = {},
): Promise<GraphHeadRow[]> {
  await ensureSymbolSchema()
  const conds: string[] = []
  const params: string[] = []
  if (filter.repo) {
    conds.push(`repo = ?`)
    params.push(filter.repo)
  }
  if (filter.branch) {
    conds.push(`branch = ?`)
    params.push(filter.branch)
  }
  if (filter.machine) {
    conds.push(`machine = ?`)
    params.push(filter.machine)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = all<Record<string, any>>(`SELECT ${HEAD_COLS} FROM graph_heads ${where}`, ...params)
  return rows.map(rowToGraphHead)
}

/**
 * The base branch to assume for a repo when the caller didn't pass one. Resolves
 * **data-first** from the `GraphHead.baseBranch` recorded at ingest (the repo's
 * real default, e.g. `develop` for a swarm repo) — taking the most-recently
 * extracted non-empty value across the repo's heads — then falls back to `'main'`.
 *
 * This replaces the hardcoded `'main'` defaults that made a repo whose base is
 * `develop` blast/render empty. It's pure-read (no git): the git-default branch
 * was already resolved (via `inferBaseBranch`) at ingest time and persisted on
 * the GraphHead, so we honor that recorded value here rather than re-shelling git
 * (the server has no repo root). Scope to `machine` when given so a peer's head
 * doesn't override the local view.
 */
export async function defaultBaseBranch(repo: string, machine?: string): Promise<string> {
  if (!repo) return 'main'
  const heads = await readGraphHeads(machine ? { repo, machine } : { repo })
  let best = ''
  let bestAt = -1
  for (const h of heads) {
    if (!h.baseBranch) continue
    if (h.extractedAt > bestAt) {
      best = h.baseBranch
      bestAt = h.extractedAt
    }
  }
  return best || 'main'
}

/**
 * The branch to DISPLAY for a repo's whole-graph view (the Code-view subgraph).
 * Picks the branch that actually HOLDS symbols — the richest snapshot (most
 * symbols), tie-broken by most-recent extraction.
 *
 * Deliberately distinct from `defaultBaseBranch`: that returns the *base* a
 * branch was cut from (for blast overlays), but symbols are stored under the
 * branch they were extracted ON. A repo whose work lives on `master`/`develop`
 * (and was never snapshotted on the base) would render an EMPTY graph if we
 * filtered on the base — even though the symbols pane (which lists across all
 * branches) still shows rows. That mismatch is the "symbols in the pane, no
 * visual" bug. Falls back to `defaultBaseBranch` only when the repo has no rows.
 */
export async function displaySymbolBranch(repo: string, machine?: string): Promise<string> {
  if (!repo) return 'main'
  await ensureSymbolSchema()
  const conds = ['repo = ?']
  const params: any[] = [repo]
  if (machine) {
    conds.push('machine = ?')
    params.push(machine)
  }
  const rows = all<{ branch: string; c: number }>(
    `SELECT branch, COUNT(*) AS c FROM symbols WHERE ${conds.join(' AND ')} GROUP BY branch`,
    ...params,
  )
  if (rows.length === 0) return await defaultBaseBranch(repo, machine)
  // A user-pinned default wins — but only if it still has symbols, so a stale
  // pin (its branch later forgotten/renamed) never re-creates the empty-graph
  // bug; we fall through to the heuristic instead.
  const pinned = getRepoDefaultBranch(repo)
  if (pinned !== null && rows.some((r) => r.branch === pinned && r.c > 0)) return pinned
  const heads = await readGraphHeads(machine ? { repo, machine } : { repo })
  const recency = new Map<string, number>()
  for (const h of heads) recency.set(h.branch, Math.max(recency.get(h.branch) ?? -1, h.extractedAt))
  rows.sort((a, b) => b.c - a.c || (recency.get(b.branch) ?? -1) - (recency.get(a.branch) ?? -1))
  return String(rows[0]!.branch ?? '')
}

/** The branch a user has pinned as the Code-view default for `repo`, or null. */
export function getRepoDefaultBranch(repo: string): string | null {
  if (!repo) return null
  const row = get<{ default_branch: string }>(
    'SELECT default_branch FROM codegraph_prefs WHERE repo = ?',
    repo,
  )
  return row ? String(row.default_branch) : null
}

/**
 * Pin (or, with a falsy branch, clear) the Code-view default display branch for
 * `repo`. Upsert keyed by repo. `now` is the caller's timestamp (ms).
 */
export function setRepoDefaultBranch(repo: string, branch: string | null, now: number): void {
  if (!repo) return
  if (!branch) {
    run('DELETE FROM codegraph_prefs WHERE repo = ?', repo)
    return
  }
  run(
    `INSERT INTO codegraph_prefs (repo, default_branch, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET default_branch = excluded.default_branch, updated_at = excluded.updated_at`,
    repo,
    branch,
    now,
  )
}

export interface SymbolView {
  repo: string
  branch: string
  machine: string
  symbols: number
  lastSyncedAt: number
  commitSha: string
  dirty: boolean
}

/**
 * Distinct (repo, branch, machine) coordinates present in the Symbol table,
 * with a symbol count + the matching GraphHead freshness (commitSha/dirty/
 * extractedAt). The discovery driver for "review another view".
 */
export async function listSymbolViews(): Promise<SymbolView[]> {
  await ensureSymbolSchema()
  const rows = all<{ repo: string; branch: string; machine: string; c: number }>(
    `SELECT repo, branch, machine, COUNT(*) AS c FROM symbols
      GROUP BY repo, branch, machine
      ORDER BY repo ASC, branch ASC, machine ASC`,
  )
  const heads = await readGraphHeads()
  const headIndex = new Map(heads.map((h) => [graphHeadId(h.repo, h.branch, h.machine), h]))
  return rows.map((r) => {
    const repo = String(r.repo ?? '')
    const branch = String(r.branch ?? '')
    const machine = String(r.machine ?? '')
    const head = headIndex.get(graphHeadId(repo, branch, machine))
    return {
      repo,
      branch,
      machine,
      symbols: Number(r.c ?? 0),
      lastSyncedAt: head?.extractedAt ?? 0,
      commitSha: head?.commitSha ?? '',
      dirty: head?.dirty ?? false,
    }
  })
}

// ── queries (read-only) ───────────────────────────────────────────────────────

const SYMBOL_COLS =
  `id, name, symbolKind, repo, file, lang, line, signature, base, stickiness, ` +
  `centrality, lastSeen, pinned, groundTruthValid, machine, root`

export async function listSymbols(
  opts: { repo?: string; limit?: number; machine?: string; branch?: string } = {},
): Promise<SymbolRow[]> {
  await ensureSymbolSchema()
  const limit = Math.min(opts.limit ?? 2000, 10000)
  const conditions: string[] = []
  const params: any[] = []
  if (opts.repo) {
    conditions.push(`repo = ?`)
    params.push(opts.repo)
  }
  if (opts.machine) {
    conditions.push(`machine = ?`)
    params.push(opts.machine)
  }
  if (opts.branch !== undefined) {
    conditions.push(`branch = ?`)
    params.push(opts.branch)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = all<Record<string, any>>(
    `SELECT ${SYMBOL_COLS} FROM symbols ${where}
      ORDER BY centrality DESC, name ASC LIMIT ?`,
    ...params,
    limit,
  )
  return rows.map(rowToSymbol)
}

export async function getSymbol(id: string): Promise<SymbolRow | null> {
  await ensureSymbolSchema()
  const row = get<Record<string, any>>(`SELECT ${SYMBOL_COLS} FROM symbols WHERE id = ?`, id)
  return row ? rowToSymbol(row) : null
}

export interface SymbolNeighborhood {
  symbol: SymbolRow | null
  dependents: SymbolRow[]
  dependencies: SymbolRow[]
}

/**
 * Blast-radius query — the load-bearing one. `dependents` are symbols with an
 * edge INTO `id` (who calls/imports/extends this); `dependencies` are symbols
 * `id` points at. `edgeKinds` filters which edge tables to traverse; default
 * is all of them.
 */
export async function symbolNeighborhood(
  id: string,
  edgeKinds?: SymbolEdgeKind[],
): Promise<SymbolNeighborhood> {
  await ensureSymbolSchema()
  const rels = (edgeKinds && edgeKinds.length ? edgeKinds : SYMBOL_EDGE_TABLES).filter((t) =>
    EDGE_TABLE_SET.has(t),
  )
  const symbol = await getSymbol(id)
  if (rels.length === 0) return { symbol, dependents: [], dependencies: [] }

  const relPlaceholders = inClause(rels.length)

  // Dependents: symbols with an edge INTO id → join symbols on edge.src.
  const dependentRows = all<Record<string, any>>(
    `SELECT ${SYMBOL_COLS.split(', ').map((c) => `s.${c}`).join(', ')}
       FROM edges e
       JOIN symbols s ON s.id = e.src
      WHERE e.dst = ? AND e.rel IN (${relPlaceholders})`,
    id,
    ...rels,
  )
  // Dependencies: symbols id points at → join symbols on edge.dst.
  const dependencyRows = all<Record<string, any>>(
    `SELECT ${SYMBOL_COLS.split(', ').map((c) => `s.${c}`).join(', ')}
       FROM edges e
       JOIN symbols s ON s.id = e.dst
      WHERE e.src = ? AND e.rel IN (${relPlaceholders})`,
    id,
    ...rels,
  )

  const dedup = (rows: Record<string, any>[]): SymbolRow[] => {
    const seen = new Map<string, SymbolRow>()
    for (const row of rows) {
      const n = rowToSymbol(row)
      if (!seen.has(n.id)) seen.set(n.id, n)
    }
    return [...seen.values()]
  }

  return { symbol, dependents: dedup(dependentRows), dependencies: dedup(dependencyRows) }
}

export interface SymbolGraphNode {
  id: string
  name: string
  kind: string
  scope: string
}

export interface SymbolGraphEdge {
  from: string
  to: string
  label: string
}

/**
 * The full symbol graph as `{ nodes, edges }` shaped for the D3 GraphCanvas —
 * every Symbol node plus every Symbol→Symbol edge. Nodes are tagged
 * `kind: 'symbol'` so the memory-graph view treats them as a single cluster;
 * `scope` mirrors the source repo. Edge `label` is the edge-kind (CALLS,
 * IMPORTS, …). Read-only.
 */
export async function listSymbolGraph(
  opts: { repo?: string; machine?: string; branch?: string } = {},
): Promise<{ nodes: SymbolGraphNode[]; edges: SymbolGraphEdge[] }> {
  await ensureSymbolSchema()
  const conditions: string[] = []
  const params: any[] = []
  if (opts.repo) {
    conditions.push(`repo = ?`)
    params.push(opts.repo)
  }
  if (opts.machine) {
    conditions.push(`machine = ?`)
    params.push(opts.machine)
  }
  // Default-branch-only unless an explicit branch is asked for — otherwise the
  // canvas overlays every branch's view of every symbol. Resolve the repo's real
  // base from GraphHead (a `develop`-based repo rendered empty under the old hard
  // `'main'` default); fall back to `'main'` when no repo scope is given.
  const branch = opts.branch ?? (opts.repo ? await defaultBaseBranch(opts.repo, opts.machine) : 'main')
  conditions.push(`branch = ?`)
  params.push(branch)
  const where = `WHERE ${conditions.join(' AND ')}`
  const nodeRows = all<{ id: string; name: string; repo: string }>(
    `SELECT id, name, repo FROM symbols ${where}`,
    ...params,
  )
  const nodes: SymbolGraphNode[] = nodeRows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? r.id),
    kind: 'symbol',
    scope: String(r.repo ?? ''),
  }))
  const present = new Set(nodes.map((n) => n.id))
  const edges: SymbolGraphEdge[] = []
  const edgeRows = all<{ from: string; to: string; rel: string }>(
    `SELECT src AS "from", dst AS "to", rel FROM edges WHERE rel IN (${inClause(SYMBOL_EDGE_TABLES.length)})`,
    ...SYMBOL_EDGE_TABLES,
  )
  for (const row of edgeRows) {
    const from = String(row.from)
    const to = String(row.to)
    if (!present.has(from) || !present.has(to)) continue
    edges.push({ from, to, label: String(row.rel) })
  }
  return { nodes, edges }
}

export interface SubgraphModuleNode {
  type: 'module'
  id: string // synthetic: `mod:${repo}:${file}`
  file: string
  symbolCount: number
}
export interface SubgraphSymbolNode {
  type: 'symbol'
  id: string // qualified Symbol id (`machine@branch::naturalId`)
  name: string
  symbolKind: string
  file: string
  line: number
  centrality: number
  groundTruthValid: boolean
}
export type SubgraphNode = SubgraphModuleNode | SubgraphSymbolNode
export interface SubgraphEdge {
  from: string
  to: string
  kind: SymbolEdgeKind
  weight?: number // only set in module-aggregated edges
}
export interface SymbolSubgraph {
  repo: string
  branch: string
  mode: 'modules' | 'symbols' | 'all'
  truncated: boolean
  totalSymbols: number
  nodes: SubgraphNode[]
  edges: SubgraphEdge[]
}

const moduleNodeId = (repo: string, file: string) => `mod:${repo}:${file}`

/**
 * Capped, branch-scoped subgraph for the Code-view empty-state visualization.
 *
 * - `mode='symbols'` (default): top-`topN` symbols by centrality become symbol
 *   nodes; every file that lost its symbols to the cap gets a module node (so
 *   files with no top-N symbol still show). Edges whose endpoint isn't a drawn
 *   symbol re-point to that endpoint's module node; duplicates are folded.
 * - `mode='modules'`: only module nodes; cross-file edges aggregate file→file
 *   with a `weight` (dominant rel kind wins the `kind`).
 * - `mode='all'`: every symbol node, no module nodes, no cap (caller must opt in;
 *   the UI warns above a threshold).
 *
 * Node ids and edge endpoints are the STORED (qualified) symbol ids — the same
 * ids `listSymbols`/`listSymbolGraph` return and the Code-view selection flow
 * keys off — so click-to-select round-trips without re-qualification.
 *
 * Branch resolution: an explicit branch wins; otherwise `defaultBaseBranch`
 * resolves the repo's real base from GraphHead (fixing the latent hard-coded
 * 'main' that rendered develop-based repos empty). Read-only; bounds the wire
 * payload server-side — no whole-graph transfer.
 */
export async function listSymbolSubgraph(opts: {
  repo: string
  branch?: string
  machine?: string
  topN?: number
  mode?: 'modules' | 'symbols' | 'all'
}): Promise<SymbolSubgraph> {
  await ensureSymbolSchema()
  const repo = opts.repo
  const machine = opts.machine
  const mode = opts.mode ?? 'symbols'
  const topN = Math.max(0, Math.min(opts.topN ?? 60, 500))
  const branch = opts.branch ?? (await displaySymbolBranch(repo, machine))

  const conds: string[] = ['repo = ?', 'branch = ?']
  const params: any[] = [repo, branch]
  if (machine) {
    conds.push('machine = ?')
    params.push(machine)
  }
  const where = `WHERE ${conds.join(' AND ')}`

  const symRows = all<{
    id: string
    name: string
    symbolKind: string
    file: string
    line: number
    centrality: number
    groundTruthValid: number
  }>(
    `SELECT id, name, symbolKind, file, line, centrality, groundTruthValid
       FROM symbols ${where}
      ORDER BY centrality DESC, name ASC`,
    ...params,
  )
  const totalSymbols = symRows.length

  // File → symbol-count (for module nodes).
  const fileCounts = new Map<string, number>()
  for (const r of symRows) fileCounts.set(r.file, (fileCounts.get(r.file) ?? 0) + 1)

  // All symbol edges among THIS view's symbol ids.
  const idSet = new Set(symRows.map((r) => r.id))
  const idToFile = new Map(symRows.map((r) => [r.id, r.file]))
  const rawEdges = all<{ from: string; to: string; rel: string }>(
    `SELECT src AS "from", dst AS "to", rel FROM edges
      WHERE rel IN (${inClause(SYMBOL_EDGE_TABLES.length)})`,
    ...SYMBOL_EDGE_TABLES,
  ).filter((e) => idSet.has(e.from) && idSet.has(e.to))

  if (mode === 'modules') {
    const nodes: SubgraphNode[] = [...fileCounts.entries()].map(([file, c]) => ({
      type: 'module',
      id: moduleNodeId(repo, file),
      file,
      symbolCount: c,
    }))
    // Aggregate cross-file edges file→file. Key by "fromFile>toFile"; track per-rel counts.
    const agg = new Map<string, { from: string; to: string; rels: Map<string, number> }>()
    for (const e of rawEdges) {
      const ff = idToFile.get(e.from)!
      const tf = idToFile.get(e.to)!
      if (ff === tf) continue
      const key = `${ff}>${tf}`
      const a =
        agg.get(key) ?? { from: moduleNodeId(repo, ff), to: moduleNodeId(repo, tf), rels: new Map() }
      a.rels.set(e.rel, (a.rels.get(e.rel) ?? 0) + 1)
      agg.set(key, a)
    }
    const edges: SubgraphEdge[] = [...agg.values()].map((a) => {
      let dom = 'CALLS'
      let domN = -1
      let weight = 0
      for (const [rel, n] of a.rels) {
        weight += n
        if (n > domN) {
          domN = n
          dom = rel
        }
      }
      return { from: a.from, to: a.to, kind: dom as SymbolEdgeKind, weight }
    })
    return { repo, branch, mode, truncated: false, totalSymbols, nodes, edges }
  }

  // symbols / all mode.
  const limit = mode === 'all' ? symRows.length : topN
  const kept = symRows.slice(0, limit)
  const keptIds = new Set(kept.map((r) => r.id))
  const truncated = mode !== 'all' && symRows.length > limit

  const nodes: SubgraphNode[] = kept.map((r) => ({
    type: 'symbol',
    id: r.id,
    name: r.name,
    symbolKind: r.symbolKind,
    file: r.file,
    line: r.line,
    centrality: r.centrality,
    groundTruthValid: r.groundTruthValid !== 0,
  }))
  // In symbols mode, add module nodes for files that have NO kept symbol, so
  // re-pointed edges land somewhere and lone files still show.
  if (mode === 'symbols') {
    const keptFiles = new Set(kept.map((r) => r.file))
    for (const [file, c] of fileCounts) {
      if (keptFiles.has(file)) continue
      nodes.push({ type: 'module', id: moduleNodeId(repo, file), file, symbolCount: c })
    }
  }

  // Re-point any edge endpoint that isn't a kept symbol to its file's module
  // node (symbols mode only); fold duplicate module↔module edges.
  const resolveEndpoint = (id: string): string => {
    if (keptIds.has(id)) return id
    if (mode === 'all') return id // all mode keeps everything, no module nodes
    return moduleNodeId(repo, idToFile.get(id)!)
  }
  const seenEdge = new Set<string>()
  const edges: SubgraphEdge[] = []
  for (const e of rawEdges) {
    const from = resolveEndpoint(e.from)
    const to = resolveEndpoint(e.to)
    if (from === to) continue
    const k = `${from}>${to}>${e.rel}`
    if (seenEdge.has(k)) continue
    seenEdge.add(k)
    edges.push({ from, to, kind: e.rel as SymbolEdgeKind })
  }
  return { repo, branch, mode, truncated, totalSymbols, nodes, edges }
}

export async function symbolStats(): Promise<{
  symbols: number
  edges: number
  repos: { repo: string; count: number }[]
}> {
  await ensureSymbolSchema()
  const symbols = Number(
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM symbols`)?.c ?? 0,
  )
  const edges = Number(
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edges WHERE rel IN (${inClause(SYMBOL_EDGE_TABLES.length)})`,
      ...SYMBOL_EDGE_TABLES,
    )?.c ?? 0,
  )
  const repoRows = all<{ repo: string; count: number }>(
    `SELECT repo, COUNT(*) AS count FROM symbols GROUP BY repo ORDER BY count DESC`,
  )
  const repos = repoRows.map((r) => ({ repo: String(r.repo ?? ''), count: Number(r.count ?? 0) }))
  return { symbols, edges, repos }
}

export async function symbolsByMachine(): Promise<Record<string, number>> {
  await ensureSymbolSchema()
  const rows = all<{ machine: string; count: number }>(
    `SELECT machine, COUNT(*) AS count FROM symbols GROUP BY machine`,
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[String(row.machine ?? '')] = Number(row.count ?? 0)
  return out
}

export interface BlastSymbol {
  id: string
  name: string
  symbolKind: string
  file: string
  line: number
  // NOTE: dependents[].id is the dependent's NATURAL id (repo:file#name), NOT a
  // qualified Symbol id — do not re-query it against the qualified-id store.
  dependents: { id: string; name: string; file: string; line: number; edgeKind: string }[]
}

/**
 * Targeted blast-radius for a set of files. Given a repo + file paths (a
 * ticket's `touches:` set), return the symbols DEFINED in those paths plus their
 * **cross-file** dependents (symbols in OTHER files that call/import/extend
 * them) — the "your change has callers in A.ts:L, B.ts:L" signal, server-side
 * filtered so there's no whole-graph transfer. `kinds` narrows the edge tables
 * traversed (default: all). Read-only.
 *
 * Cross-file only by design: same-file callers aren't useful for a "who else
 * depends on this" worker prompt.
 */
/**
 * Two-level ref-chain (the legacy shape). The requested branch first, then its
 * base (so a branch that only touched a callee still finds the base-version
 * caller). Single-element when branch === base or branch is ''. Retained as the
 * pure fallback that `resolveRefChain` reduces to when GraphHead ancestry is
 * missing — and as a standalone export for callers that already know both ends.
 */
export function refChain2(branch: string, baseBranch: string): string[] {
  if (!branch || branch === baseBranch) return [branch]
  return [branch, baseBranch]
}

/**
 * N-level branch ref-chain for nested overlay (epic → feature → main).
 *
 * Walks `GraphHead.baseBranch` ancestry: from `branch`, read its GraphHead's
 * recorded base, then that base's GraphHead's base, and so on until a root (no
 * recorded base, a self-reference, or a branch with no GraphHead) — producing
 * e.g. `['epic/x', 'feature/y', 'main']`. Each branch's own version shadows its
 * ancestors when the chain is iterated first-defining-branch-wins.
 *
 * Data-driven (GraphHead, recorded at ingest), so no git on the server. Cycle-
 * safe (a branch already in the chain stops the walk). When the requested branch
 * has no GraphHead ancestry at all, falls back to the 2-level `[branch, base]`
 * (`refChain2`) using `fallbackBase` (the caller's resolved base) — preserving
 * the legacy behavior for the simple case. The terminal element is always the
 * deepest base reached, so `chain[chain.length - 1]` is the root base for the
 * cross-branch inheritance probe.
 */
export async function resolveRefChain(
  repo: string,
  branch: string,
  machine?: string,
  fallbackBase?: string,
): Promise<string[]> {
  await ensureSymbolSchema()
  const { getMachineId } = await import('../privateMind.js')
  const mach = machine ?? getMachineId()
  const start = branch || (fallbackBase ?? (await defaultBaseBranch(repo, mach)))

  const chain: string[] = []
  const seen = new Set<string>()
  let cur = start
  let startHadHead = false
  // Walk recorded GraphHead.baseBranch ancestry. Cap the depth defensively
  // (cycle set already prevents loops; this bounds a pathological deep tree).
  for (let depth = 0; cur && !seen.has(cur) && depth < 64; depth++) {
    chain.push(cur)
    seen.add(cur)
    const head = await __readGraphHeadOn(getDb(), { repo, branch: cur, machine: mach })
    if (depth === 0) startHadHead = head !== null
    const next = head?.baseBranch ?? ''
    if (!next || next === cur || seen.has(next)) break
    cur = next
  }

  if (chain.length === 0) {
    // Nothing resolvable (no branch, no base) — empty-branch unscoped query.
    return ['']
  }
  // A length-1 chain is ambiguous: either the branch is a true root (its own
  // GraphHead self-bases — keep [root]) OR the branch has NO GraphHead at all
  // (missing ancestry — fall back to the legacy 2-level [branch, base] so the
  // simple case behaves exactly as before).
  if (chain.length === 1 && !startHadHead) {
    const base = fallbackBase ?? (await defaultBaseBranch(repo, mach))
    return refChain2(chain[0]!, base)
  }
  return chain
}

export async function symbolBlastRadius(
  repo: string,
  paths: string[],
  edgeKinds?: SymbolEdgeKind[],
  opts: { machine?: string; branch?: string; baseBranch?: string } = {},
): Promise<{ symbols: BlastSymbol[] }> {
  return __blastRadiusOn(getDb(), { repo, paths, edgeKinds, ...opts })
}

/**
 * Branch-overlay blast core (test seam). Walks the ref chain [branch, base];
 * for each natural key, the FIRST branch in the chain that defines it wins
 * (the branch's own version shadows base). Cross-file dependents are likewise
 * overlay-resolved, so a base-branch caller is inherited into a feature
 * branch's blast. machine defaults to this machine; branch '' means
 * default/unscoped.
 *
 * The `_conn` parameter is accepted for signature compatibility; reads go
 * through the module helpers against the singleton DB.
 */
export async function __blastRadiusOn(
  _conn: unknown,
  args: {
    repo: string
    paths: string[]
    edgeKinds?: SymbolEdgeKind[]
    machine?: string
    branch?: string
    baseBranch?: string
  },
): Promise<{ symbols: BlastSymbol[] }> {
  const { repo, paths } = args
  if (!repo || !paths.length) return { symbols: [] }
  await ensureSymbolSchema()
  const { getMachineId } = await import('../privateMind.js')
  const machine = args.machine ?? getMachineId()
  const baseBranch = args.baseBranch ?? (await defaultBaseBranch(repo, machine))
  const branch = args.branch || baseBranch
  // N-level overlay chain (epic → feature → main) walked from GraphHead
  // ancestry; falls back to the 2-level [branch, base] when ancestry is missing.
  // When the caller passed an explicit baseBranch, honor it as the chain terminus
  // (it short-circuits to refChain2 unless deeper ancestry was recorded).
  const chain = await resolveRefChain(repo, branch, machine, baseBranch)
  // The deepest branch in the chain is the inheritance base: a caller defined
  // only on the root base still points at the root-version callee, so probe that
  // qualified id too (was hardcoded to `baseBranch`; the chain terminus is the
  // N-level generalization and equals baseBranch in the 2-level case).
  const inheritBase = chain[chain.length - 1] ?? baseBranch
  const rels = (args.edgeKinds && args.edgeKinds.length ? args.edgeKinds : SYMBOL_EDGE_TABLES).filter(
    (t) => EDGE_TABLE_SET.has(t),
  )
  const pathPlaceholders = inClause(paths.length)

  // Defined symbols in the touched paths — overlay by naturalId across the chain.
  const byNatural = new Map<string, BlastSymbol>()
  for (const b of chain) {
    const defRows = all<{
      id: string
      nid: string
      name: string
      symbolKind: string
      file: string
      line: number
    }>(
      `SELECT id, naturalId AS nid, name, symbolKind, file, line FROM symbols
        WHERE repo = ? AND file IN (${pathPlaceholders}) AND machine = ? AND branch = ?`,
      repo,
      ...paths,
      machine,
      b,
    )
    for (const r of defRows) {
      const nid = String(r.nid)
      if (byNatural.has(nid)) continue // first branch in chain wins
      byNatural.set(nid, {
        id: String(r.id),
        name: String(r.name ?? ''),
        symbolKind: String(r.symbolKind ?? ''),
        file: String(r.file ?? ''),
        line: Number(r.line ?? 0),
        dependents: [],
      })
    }
  }
  if (byNatural.size === 0) return { symbols: [] }

  // Cross-file dependents — set-based to bound query count to
  // (chain × tables) regardless of how many symbols were defined.
  // Probe BOTH the winning qualified id AND the base-branch qualified id of
  // each natural key, so a base-branch caller (whose edge points at the
  // base-version callee) is inherited into a feature branch's blast.
  const targetToNatural = new Map<string, string>() // qualified target id → owning naturalId
  for (const [nid, target] of byNatural) {
    targetToNatural.set(target.id, nid)
    targetToNatural.set(qualifyId(machine, inheritBase, nid), nid)
  }
  const targetIds = [...targetToNatural.keys()]
  const targetPlaceholders = inClause(targetIds.length)
  const depSeen = new Map<string, Set<string>>() // owning naturalId → seen dependent naturalIds
  for (const nid of byNatural.keys()) depSeen.set(nid, new Set())
  for (const b of chain) {
    for (const t of rels) {
      const rows = all<{
        sid: string
        nid: string
        name: string
        file: string
        line: number
      }>(
        `SELECT s.id AS sid, d.naturalId AS nid, d.name AS name, d.file AS file, d.line AS line
           FROM edges e
           JOIN symbols d ON d.id = e.src
           JOIN symbols s ON s.id = e.dst
          WHERE e.rel = ? AND s.id IN (${targetPlaceholders})
            AND d.machine = ? AND d.branch = ? AND d.file <> s.file`,
        t,
        ...targetIds,
        machine,
        b,
      )
      for (const r of rows) {
        const owningNid = targetToNatural.get(String(r.sid))
        if (!owningNid) continue
        const target = byNatural.get(owningNid)
        if (!target) continue
        const dnid = String(r.nid)
        const seen = depSeen.get(owningNid)!
        if (seen.has(dnid)) continue
        seen.add(dnid)
        target.dependents.push({
          id: dnid,
          name: String(r.name ?? ''),
          file: String(r.file ?? ''),
          line: Number(r.line ?? 0),
          edgeKind: t,
        })
      }
    }
  }
  return { symbols: [...byNatural.values()] }
}

/**
 * Forget an entire repo's symbol subgraph: delete every Symbol node whose
 * `repo` matches plus all incident edges (CALLS/IMPORTS/EXTENDS/IMPLEMENTS/
 * REFERENCES and any Entry→Symbol ABOUT links) so no dangling edges remain.
 * Returns the number of symbol nodes removed.
 *
 * Runs in one transaction: delete the matching symbol nodes and their edges.
 */
export async function forgetRepoSymbols(repo: string): Promise<number> {
  await ensureSymbolSchema()
  const beforeCount = Number(
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM symbols WHERE repo = ?`, repo)?.c ?? 0,
  )
  if (beforeCount === 0) return 0
  transaction(() => {
    // Delete edges incident to any symbol in the repo (both directions), then
    // the symbols themselves. Edges are deleted via a subquery against the
    // doomed symbol ids — covers symbol↔symbol edges and Entry→Symbol ABOUT.
    run(
      `DELETE FROM edges WHERE src IN (SELECT id FROM symbols WHERE repo = ?)
                            OR dst IN (SELECT id FROM symbols WHERE repo = ?)`,
      repo,
      repo,
    )
    run(`DELETE FROM symbols WHERE repo = ?`, repo)
  })
  return beforeCount
}

/**
 * Branch-scoped forget: delete a single (repo, branch[, machine]) symbol
 * snapshot — its symbols, all incident edges, and the matching GraphHead row —
 * leaving the repo's OTHER branches intact. For pruning a stale branch
 * coordinate (e.g. an old `main` snapshot of a repo whose work moved to
 * `master`, or a pre-lineage empty-branch coordinate). Returns symbols removed.
 */
export async function forgetRepoBranchSymbols(
  repo: string,
  branch: string,
  machine?: string,
): Promise<number> {
  await ensureSymbolSchema()
  const conds = ['repo = ?', 'branch = ?']
  const params: any[] = [repo, branch]
  if (machine) {
    conds.push('machine = ?')
    params.push(machine)
  }
  const where = conds.join(' AND ')
  const beforeCount = Number(
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM symbols WHERE ${where}`, ...params)?.c ?? 0,
  )
  if (beforeCount === 0) return 0
  transaction(() => {
    run(
      `DELETE FROM edges WHERE src IN (SELECT id FROM symbols WHERE ${where})
                            OR dst IN (SELECT id FROM symbols WHERE ${where})`,
      ...params,
      ...params,
    )
    run(`DELETE FROM symbols WHERE ${where}`, ...params)
    run(`DELETE FROM graph_heads WHERE ${where}`, ...params)
  })
  return beforeCount
}

// ── branch-diff (competing-change prediction) ──────────────────────────────────

/** One side of a branch diff — a symbol identified by its natural id. */
export interface BranchDiffSymbol {
  naturalId: string
  name: string
  symbolKind: string
  file: string
  line: number
}

export interface BranchDiff {
  /** The resolved coordinates the diff was computed against. */
  repo: string
  a: string
  b: string
  base: string
  /** Defined on A, not on B. */
  added: BranchDiffSymbol[]
  /** Defined on B, not on A. */
  removed: BranchDiffSymbol[]
  /** Defined on both, but the fingerprint (signature/line/groundTruth) differs. */
  changed: BranchDiffSymbol[]
  /**
   * Natural ids TOUCHED (added or changed vs the common base) on BOTH A and B —
   * the predicted merge-conflict set, at symbol granularity (catches "both
   * branches edited Foo.bar" before a text-level merge conflict surfaces).
   */
  competing: BranchDiffSymbol[]
}

/** A change-detection fingerprint for a symbol (what "changed" means). */
function symbolFingerprint(s: SymbolRow): string {
  return `${s.signature} ${s.line} ${s.groundTruthValid ? 1 : 0}`
}

function toBranchDiffSymbol(s: SymbolRow): BranchDiffSymbol {
  const parsed = parseQualifiedId(s.id)
  return {
    naturalId: parsed?.naturalId ?? s.id,
    name: s.name,
    symbolKind: s.symbolKind,
    file: s.file,
    line: s.line,
  }
}

/** Index a branch's symbols by naturalId (qualified-id → naturalId via parse). */
async function symbolsByNaturalId(
  repo: string,
  branch: string,
  machine: string,
): Promise<Map<string, SymbolRow>> {
  const rows = await listSymbols({ repo, branch, machine, limit: 10000 })
  const m = new Map<string, SymbolRow>()
  for (const r of rows) {
    const nid = parseQualifiedId(r.id)?.naturalId ?? r.id
    m.set(nid, r)
  }
  return m
}

/**
 * Compare two branches' symbol sets keyed by naturalId (the SAME symbol across
 * branches), and predict competing changes.
 *
 *   - `added`   : naturalIds on A but not B.
 *   - `removed` : naturalIds on B but not A.
 *   - `changed` : naturalIds on both whose fingerprint (signature/line/
 *                 groundTruth) differs.
 *   - `competing`: naturalIds TOUCHED on BOTH A and B relative to the common
 *                 `base` — i.e. each branch either added the symbol (absent on
 *                 base) or changed it (fingerprint differs from base). The
 *                 predicted merge-conflict set; richer than a text diff.
 *
 * The common base resolves from the explicit `base` option, else
 * `defaultBaseBranch(repo)` (GraphHead ancestry). Read-only.
 */
export async function symbolBranchDiff(
  repo: string,
  a: string,
  b: string,
  opts: { base?: string; machine?: string } = {},
): Promise<BranchDiff> {
  await ensureSymbolSchema()
  const { getMachineId } = await import('../privateMind.js')
  const machine = opts.machine ?? getMachineId()
  const base = opts.base ?? (await defaultBaseBranch(repo, machine))

  const [aMap, bMap, baseMap] = await Promise.all([
    symbolsByNaturalId(repo, a, machine),
    symbolsByNaturalId(repo, b, machine),
    symbolsByNaturalId(repo, base, machine),
  ])

  const added: BranchDiffSymbol[] = []
  const removed: BranchDiffSymbol[] = []
  const changed: BranchDiffSymbol[] = []

  // A vs B (direct two-branch diff).
  for (const [nid, aSym] of aMap) {
    const bSym = bMap.get(nid)
    if (!bSym) {
      added.push(toBranchDiffSymbol(aSym))
    } else if (symbolFingerprint(aSym) !== symbolFingerprint(bSym)) {
      changed.push(toBranchDiffSymbol(aSym))
    }
  }
  for (const [nid, bSym] of bMap) {
    if (!aMap.has(nid)) removed.push(toBranchDiffSymbol(bSym))
  }

  // Competing: touched (added or changed) vs base on BOTH sides.
  const touchedVsBase = (branchMap: Map<string, SymbolRow>): Set<string> => {
    const touched = new Set<string>()
    for (const [nid, sym] of branchMap) {
      const baseSym = baseMap.get(nid)
      if (!baseSym) {
        touched.add(nid) // new vs base (added)
      } else if (symbolFingerprint(sym) !== symbolFingerprint(baseSym)) {
        touched.add(nid) // changed vs base
      }
    }
    return touched
  }
  const aTouched = touchedVsBase(aMap)
  const bTouched = touchedVsBase(bMap)
  const competing: BranchDiffSymbol[] = []
  for (const nid of aTouched) {
    if (!bTouched.has(nid)) continue
    // Prefer A's row for the descriptor; fall back to B's.
    const sym = aMap.get(nid) ?? bMap.get(nid)
    if (sym) competing.push(toBranchDiffSymbol(sym))
  }

  const byNat = (x: BranchDiffSymbol, y: BranchDiffSymbol) =>
    x.naturalId.localeCompare(y.naturalId)
  added.sort(byNat)
  removed.sort(byNat)
  changed.sort(byNat)
  competing.sort(byNat)

  return { repo, a, b, base, added, removed, changed, competing }
}
