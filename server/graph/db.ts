import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// ── SQLite (better-sqlite3) graph backend ───────────────────────────────────
//
// The SQLite (better-sqlite3) graph backend. It has no need for two whole
// subsystems that existed ONLY to work around a single-process-single-writer +
// crash-corruption model:
//
//   1. The FIFO async write-serializer (`withGraphWriteLock` / `_writeChain`).
//      better-sqlite3 statements are SYNCHRONOUS — a statement runs to
//      completion before any other JS executes, so two mutations physically
//      cannot interleave on the connection. The lock is no longer needed for
//      correctness; multi-statement atomicity is now handled by callers
//      wrapping their statements in a transaction (see `transaction()`).
//
//   2. The lock-retry loop + the D-state/SIGSEGV shutdown dance
//      (`drainWrites`, `_closing`, `checkpointAndClose` CHECKPOINT-then-close).
//      WAL mode permits N concurrent readers + 1 writer ACROSS processes, with
//      `busy_timeout` absorbing writer contention — so a CLI opening the file
//      while the server runs no longer throws "Could not set lock on file".
//      Shutdown becomes a trivial, synchronous `wal_checkpoint(TRUNCATE)` +
//      `close()`, with no native fsync thread to get parked in uninterruptible
//      sleep at process exit.
//
// Filename: `graph.sqlite` (NOT `graph.db`) so it coexists with the legacy
// graph DB file. Override via CKN_GRAPH_DB_PATH for tests.

export const DB_PATH =
  process.env.CKN_GRAPH_DB_PATH ?? path.join(os.homedir(), '.config', 'ckn', 'graph.sqlite')

let _db: Database.Database | null = null

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

/** Apply the full DDL (all CREATE ... IF NOT EXISTS — idempotent on every boot). */
export function initSchema(db: Database.Database): void {
  ensureBusMeshColumns(db)
  ensureEngagementColumn(db)
  ensureContentHashColumn(db)
  ensureCadenceColumn(db)
  ensureMandateColumns(db)
  ensureProfileSourceColumn(db)
  ensureProvenanceColumn(db)
  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(ddl)
}

/**
 * Additive upgrade for the mandate-in-presence columns on a PRE-existing
 * `session_meta` table (migration 0012). `CREATE TABLE IF NOT EXISTS` can't add
 * columns to a legacy presence table, so this idempotent guard ALTERs them in
 * (all defaulting to '' — a legacy session is NOT in the orchestration pool until
 * it opts in via /available, which is the intended default-out posture). On a
 * fresh DB (no session_meta yet) it's a no-op and the DDL creates the final
 * shape. Mirrors `ensureCadenceColumn`.
 */
/**
 * Additive `provenance` column on a PRE-existing `edges` table (memory→file
 * linkage §2): `frontmatter` | `derived`, NULL = legacy (read as `frontmatter` —
 * every pre-existing memory edge came from frontmatter; session edges never
 * consult it). One additive migration; consumers that don't read it keep working.
 * No-op on a fresh DB (the DDL makes the final shape). Mirrors ensureMandateColumns.
 */
function ensureProvenanceColumn(db: Database.Database): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edges'").get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  if (!cols.has('provenance')) db.exec(`ALTER TABLE edges ADD COLUMN provenance TEXT`)
  // s3: firstAt = first-observed-at for OBSERVATIONAL rels (SURFACED_IN / EDITED_IN),
  // set on INSERT and never bumped by ON CONFLICT (notedAt is last-at and bumps). The
  // acted-on D3 correlation needs first-surfaced-at, not last (a heavily-recalled
  // memory's lastAt drifts past lastEdit → false negatives). Migrated while the live
  // SURFACED_IN corpus is still 0, so firstAt is exact from the first live row.
  if (!cols.has('firstAt')) db.exec(`ALTER TABLE edges ADD COLUMN firstAt INTEGER DEFAULT 0`)
}

function ensureMandateColumns(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(session_meta)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  for (const col of ['availability', 'mandate', 'assigned_by', 'assigned_ref']) {
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE session_meta ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`)
    }
  }
}

/**
 * Additive upgrade for the `source` column on a PRE-existing `profile_facet_meta`
 * table. Distinguishes behaviorally-`observed` facets from user-`declared`
 * onboarding seeds. Legacy rows default to 'observed' (they were all inferred).
 * On a fresh DB it's a no-op and the DDL creates the final shape. Mirrors
 * `ensureCadenceColumn`.
 */
function ensureProfileSourceColumn(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_facet_meta'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(profile_facet_meta)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  if (!cols.has('source')) {
    db.exec("ALTER TABLE profile_facet_meta ADD COLUMN source TEXT NOT NULL DEFAULT 'observed'")
  }
}

/**
 * Additive upgrade for the `content_hash` column on a PRE-existing `entries`
 * table. `CREATE TABLE IF NOT EXISTS entries` is a no-op once the table exists,
 * so it can't add the column to a legacy DB — this idempotent guard ALTERs it
 * in (defaulting to ''). A legacy row keeps '' until its next content-changed
 * upsert, so the first sync after upgrade re-upserts every memory once (''
 * never matches a real sha256), then settles. On a fresh DB (no entries yet)
 * it's a no-op and the DDL creates the final shape. Mirrors
 * `ensureEngagementColumn`.
 */
function ensureContentHashColumn(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  if (!cols.has('content_hash')) {
    db.exec("ALTER TABLE entries ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
  }
}

/**
 * Additive upgrade for the `cadence_s` column on a PRE-existing `session_meta`
 * table. `CREATE TABLE IF NOT EXISTS` can't add a column to a legacy presence
 * table, so this idempotent guard ALTERs it in (defaulting to 0 = no bounded
 * heartbeat). On a fresh DB (no session_meta yet) it's a no-op and the DDL
 * creates the final shape. Mirrors `ensureBusMeshColumns`.
 */
function ensureCadenceColumn(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(session_meta)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  if (!cols.has('cadence_s')) {
    db.exec('ALTER TABLE session_meta ADD COLUMN cadence_s INTEGER NOT NULL DEFAULT 0')
  }
}

/**
 * Additive upgrade for the `engagement` column on a PRE-existing `entries`
 * table. The DDL's `CREATE TABLE IF NOT EXISTS entries` is a no-op once the
 * table exists, so it can't add the column to a legacy DB — this idempotent
 * guard ALTERs it in (defaulting to 0). On a fresh DB (no entries yet) it's a
 * no-op and the DDL creates the final shape. Mirrors `ensureBusMeshColumns`.
 */
function ensureEngagementColumn(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  if (!cols.has('engagement')) {
    db.exec('ALTER TABLE entries ADD COLUMN engagement INTEGER NOT NULL DEFAULT 0')
  }
}

/**
 * Additive upgrade for the mesh-transport columns on a PRE-existing
 * `bus_messages` table. `CREATE TABLE IF NOT EXISTS` is a no-op when the table
 * already exists, so it can't add `origin_node`/`mesh_seq` to a legacy bus —
 * and `CREATE INDEX idx_msg_origin_seq` in the DDL would then throw "no such
 * column". This idempotent guard runs BEFORE the DDL: it ALTERs in the missing
 * columns (defaulting safely), so the subsequent index DDL has its columns. On a
 * fresh DB (no bus_messages yet) it's a no-op and the DDL creates the final shape.
 */
function ensureBusMeshColumns(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bus_messages'")
    .get()
  if (!exists) return
  const cols = new Set(
    (db.prepare('PRAGMA table_info(bus_messages)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  if (!cols.has('origin_node')) {
    db.exec("ALTER TABLE bus_messages ADD COLUMN origin_node TEXT NOT NULL DEFAULT ''")
  }
  if (!cols.has('mesh_seq')) {
    db.exec('ALTER TABLE bus_messages ADD COLUMN mesh_seq INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.has('mesh_verified')) {
    // Provenance trust root: legacy rows default 0 (unverified) — fail-safe.
    db.exec('ALTER TABLE bus_messages ADD COLUMN mesh_verified INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.has('human_provenance')) {
    // humanProvenance (stage 2): legacy rows default 0 (agent/unknown) — fail-safe,
    // so guidance never treats an old message as a human directive.
    db.exec('ALTER TABLE bus_messages ADD COLUMN human_provenance INTEGER NOT NULL DEFAULT 0')
  }
}

// Guard: if CKN_FORBID_DEFAULT_DB is set (test sentinel), refuse to open the real
// default DB so a misconfigured test fails loudly instead of polluting production.
const REAL_DEFAULT_DB = path.join(os.homedir(), '.config', 'ckn', 'graph.sqlite')

/**
 * Open `path` as a fresh SQLite handle with the standard pragmas + schema. Used
 * by `getDb()` for the singleton, and exported as a seam so tooling/tests can
 * open an arbitrary path without touching the module singleton.
 */
export function openDb(dbPath: string): Database.Database {
  if (process.env.CKN_FORBID_DEFAULT_DB && dbPath === REAL_DEFAULT_DB) {
    throw new Error(
      'refusing to open the real graph.sqlite under test — set CKN_GRAPH_DB_PATH to a temp DB',
    )
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')   // concurrent readers + single writer, no lock-retry dance
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = OFF')   // no endpoint FK enforcement (graph edges are unconstrained)
  db.pragma('busy_timeout = 5000')  // replaces the old 5×250ms lock-retry loop
  initSchema(db)
  return db
}

/** Singleton SQLite handle on DB_PATH. Synchronous — no init-promise race. */
export function getDb(): Database.Database {
  if (_db) return _db
  _db = openDb(DB_PATH)
  return _db
}

// ── query helpers ────────────────────────────────────────────────────────────
// Thin prepared-statement wrappers. Use bound params (?) — never string
// interpolation; this is why the old `esc()` escaper is gone.

export function all<T = any>(sql: string, ...params: any[]): T[] {
  return getDb().prepare(sql).all(...params) as T[]
}

export function get<T = any>(sql: string, ...params: any[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, ...params: any[]): Database.RunResult {
  return getDb().prepare(sql).run(...params)
}

/**
 * Run a function inside a single SQLite transaction (atomic multi-statement
 * write). better-sqlite3 transactions are synchronous; `fn` MUST be synchronous
 * (no `await` inside). Replaces the multi-statement-atomicity half of the old
 * write lock. Callers that mutate several rows (sync, symbol upsert, derive,
 * the DETACH-DELETE→delete+delete+insert pattern) should wrap them here.
 */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)()
}

// ── compatibility shims (ported away in later phases) ────────────────────────
// The rest of server/graph/*.ts still calls `await getConnection()` and
// `withGraphWriteLock(...)` against the old async API. These shims keep those
// ~40 call sites COMPILING through the SQLite swap; the query bodies inside
// them are ported in subsequent phases. Do not build new code on these.

/** Async shim: returns the synchronous SQLite handle so `await getConnection()` call sites compile. */
export async function getConnection(): Promise<Database.Database> {
  return getDb()
}

/**
 * Passthrough. The FIFO write-serializer is obsolete: synchronous better-sqlite3
 * statements cannot interleave, so there is nothing to serialize. Multi-statement
 * atomicity is the caller's job now — wrap in `transaction()`. Signature is kept
 * so existing route handlers keep compiling.
 */
export async function withGraphWriteLock<T>(label: string, op: () => Promise<T>): Promise<T> {
  void label
  return op()
}

/** No-op: there are no in-flight async writes to drain (statements are synchronous). */
export async function drainWrites(): Promise<void> {
  return
}

/**
 * Checkpoint + close the singleton, releasing the file lock. Trivial and
 * idempotent — no WSL2 D-state/fsync hazard, which is the entire class of bug
 * this migration eliminates. Optional args are accepted (and ignored) for
 * signature compatibility with the old `checkpointAndClose(conn, db)`; it always
 * operates on the module singleton.
 */
export async function checkpointAndClose(..._args: unknown[]): Promise<void> {
  try {
    _db?.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* best-effort WAL flush — close still releases the lock */
  }
  try {
    _db?.close()
  } catch {
    /* already closed */
  }
  _db = null
}

/** Tear down the singleton. Idempotent; safe in a SIGTERM/SIGINT handler. */
export async function closeGraph(): Promise<void> {
  await checkpointAndClose()
}
