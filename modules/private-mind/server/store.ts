/**
 * Private mind's own records, in its data dir:
 * - writers: the roles held by the member that wrote in each session, taken as
 *   close to capture as possible and never revised, so a later role change
 *   cannot turn a role's private memory into a shareable one;
 * - pointers: working memories other machines hold, known only by a line
 *   (design 5.2), for the remote-pointer seed;
 * - released: own records an operator released after they were held.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS writers (
  session TEXT PRIMARY KEY,
  roles TEXT,                -- JSON array once resolved
  state TEXT NOT NULL,       -- 'resolved' | 'unbound' (never bound to a member: no roles) | 'pending' | 'unresolvable'
  first_seen INTEGER NOT NULL,
  resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS pointers (
  memory TEXT PRIMARY KEY,   -- '<machine>:<seq>'
  slug TEXT, summary TEXT NOT NULL, owner_node TEXT NOT NULL, owner_session TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kept (            -- journal hashes of own memories kept home: no deletion of them may name them
  hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS held (            -- what the last bundle built here held back, and why: for status
  record TEXT PRIMARY KEY, code TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL, slug TEXT);
CREATE TABLE IF NOT EXISTS released (
  machine TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (machine, seq));
`

/** A writer still unknown this long after it was first seen is given up on: its records stay held, and the stream moves on. */
export const UNRESOLVED_GRACE_MS = 24 * 3_600_000

export type Writer = { state: 'resolved'; roles: string[]; unbound?: boolean } | { state: 'pending' } | { state: 'unresolvable' }
export type Pointer = { memory: string; slug?: string; summary: string; owner: { node: string; session?: string } }

export class MindStore {
  readonly db: Database.Database
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = new Database(path.join(dataDir, 'mind.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    const cols = new Set((this.db.prepare('PRAGMA table_info(held)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('slug')) this.db.exec('ALTER TABLE held ADD COLUMN slug TEXT')
  }

  writer(session: string): Writer | undefined {
    const r = this.db.prepare('SELECT roles, state FROM writers WHERE session = ?').get(session) as { roles: string | null; state: string } | undefined
    if (!r) return undefined
    if (r.state === 'resolved') return { state: 'resolved', roles: JSON.parse(r.roles ?? '[]') as string[] }
    if (r.state === 'unbound') return { state: 'resolved', roles: [], unbound: true }
    return { state: r.state as 'pending' | 'unresolvable' }
  }

  /** First resolution wins: a session's writer roles are never revised. */
  resolve(session: string, roles: string[], at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO writers (session, roles, state, first_seen, resolved_at) VALUES (?, ?, 'resolved', ?, ?)
         ON CONFLICT(session) DO UPDATE SET roles = excluded.roles, state = 'resolved', resolved_at = excluded.resolved_at WHERE writers.state != 'resolved'`,
      )
      .run(session, JSON.stringify([...roles].sort()), at, at)
  }

  /** A session never bound to any member: its writer holds no role. Final, like a resolution. */
  unbound(session: string, at = Date.now()): void {
    this.db
      .prepare("INSERT INTO writers (session, roles, state, first_seen, resolved_at) VALUES (?, '[]', 'unbound', ?, ?) ON CONFLICT(session) DO UPDATE SET state = 'unbound', roles = '[]', resolved_at = excluded.resolved_at WHERE writers.state IN ('pending', 'unresolvable')")
      .run(session, at, at)
  }

  /** Not resolvable now: pending, until the grace runs out. */
  unresolved(session: string, at = Date.now()): Writer {
    this.db.prepare("INSERT OR IGNORE INTO writers (session, state, first_seen) VALUES (?, 'pending', ?)").run(session, at)
    this.db.prepare("UPDATE writers SET state = 'unresolvable' WHERE session = ? AND state = 'pending' AND first_seen < ?").run(session, at - UNRESOLVED_GRACE_MS)
    return this.writer(session)!
  }

  heldWriters(): { session: string; state: string; first_seen: number }[] {
    return this.db.prepare("SELECT session, state, first_seen FROM writers WHERE state IN ('pending', 'unresolvable') ORDER BY first_seen").all() as never
  }

  putPointers(ps: Pointer[], at = Date.now()): number {
    const put = this.db.prepare(
      'INSERT INTO pointers (memory, slug, summary, owner_node, owner_session, at) VALUES (?,?,?,?,?,?) ON CONFLICT(memory) DO UPDATE SET slug = excluded.slug, summary = excluded.summary, at = excluded.at',
    )
    let n = 0
    this.db.transaction(() => {
      for (const p of ps) n += put.run(p.memory, p.slug ?? null, p.summary, p.owner.node, p.owner.session ?? null, at).changes
    })()
    return n
  }

  pointers(): Pointer[] {
    return (this.db.prepare('SELECT * FROM pointers ORDER BY memory').all() as Record<string, string | null>[]).map((r) => ({
      memory: r.memory!,
      ...(r.slug ? { slug: r.slug } : {}),
      summary: r.summary!,
      owner: { node: r.owner_node!, ...(r.owner_session ? { session: r.owner_session } : {}) },
    }))
  }

  /** Own records the last bundle held back (records from others are their origin's to list). */
  setHeld(held: { record: string; code: string; why: string; slug?: string }[], at = Date.now()): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO held (record, code, why, at, slug) VALUES (?,?,?,?,?)')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM held').run()
      for (const h of held) put.run(h.record, h.code, h.why, at, h.slug ?? null)
    })()
  }

  held(): { record: string; code: string; slug: string | null }[] {
    return this.db.prepare('SELECT record, code, slug FROM held ORDER BY code, record').all() as never
  }

  heldByCode(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT code, COUNT(*) n FROM held GROUP BY code').all() as { code: string; n: number }[]) out[r.code] = r.n
    return out
  }

  keep(hashes: string[]): void {
    const put = this.db.prepare('INSERT OR IGNORE INTO kept (hash) VALUES (?)')
    this.db.transaction(() => hashes.forEach((h) => put.run(h)))()
  }

  keptHashes(): Set<string> {
    return new Set((this.db.prepare('SELECT hash FROM kept').all() as { hash: string }[]).map((r) => r.hash))
  }

  release(machine: string, seq: number, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO released (machine, seq, at) VALUES (?,?,?)').run(machine, seq, at)
  }

  isReleased(machine: string, seq: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM released WHERE machine = ? AND seq = ?').get(machine, seq)
  }

  close(): void {
    this.db.close()
  }
}
