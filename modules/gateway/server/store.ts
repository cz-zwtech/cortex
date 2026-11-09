/**
 * The gateway's own state, in gateway.sqlite beside its config.
 *
 *   outbound   messages from home on their way to a peer gateway
 *   inbound    messages from a peer, handed to home as their origin (the mailbox)
 *   paths      standing return paths: internal role R wrote to external X, so X
 *              may reply to R until R closes it, or it sits unused for the idle limit
 *   peer_roles what each peer exposed to us (what home may start a conversation with)
 *   heard      external roles that wrote to us: home may answer them though they were not announced
 */
import path from 'node:path'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbound (
  xid         TEXT PRIMARY KEY,
  local_id    TEXT NOT NULL,
  origin_node TEXT NOT NULL,
  sender      TEXT NOT NULL,
  peer        TEXT NOT NULL,
  to_role     TEXT NOT NULL,
  frame       TEXT NOT NULL,
  status      TEXT NOT NULL,
  created     INTEGER NOT NULL,
  last_sent   INTEGER NOT NULL DEFAULT 0,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_local ON outbound(local_id);
CREATE TABLE IF NOT EXISTS inbound (
  peer     TEXT NOT NULL,
  xid      TEXT NOT NULL,
  route_id TEXT,
  to_role  TEXT NOT NULL,
  status   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (peer, xid)
);
CREATE TABLE IF NOT EXISTS paths (
  internal_role TEXT NOT NULL,
  ext_domain    TEXT NOT NULL,
  ext_role      TEXT NOT NULL,
  opened_at     INTEGER NOT NULL,
  last_used     INTEGER NOT NULL,
  opened_by     TEXT NOT NULL,
  closed_at     INTEGER,
  closed_why    TEXT,
  PRIMARY KEY (internal_role, ext_domain, ext_role)
);
CREATE TABLE IF NOT EXISTS peer_roles (
  peer        TEXT PRIMARY KEY,
  roles       TEXT NOT NULL,
  unavailable TEXT NOT NULL DEFAULT '[]',
  updated     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS heard (
  peer TEXT NOT NULL,
  role TEXT NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY (peer, role)
);
CREATE TABLE IF NOT EXISTS cursor (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`

export type Outbound = { xid: string; local_id: string; origin_node: string; sender: string; peer: string; to_role: string; frame: string; status: string; created: number; last_sent: number; reason: string | null }
export type PathRow = { internal_role: string; ext_domain: string; ext_role: string; opened_at: number; last_used: number; opened_by: string; closed_at: number | null; closed_why: string | null }

export class GatewayStore {
  readonly db: Database.Database
  constructor(dir: string) {
    this.db = new Database(path.join(dir, 'gateway.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  cursor(name: string): number {
    return (this.db.prepare('SELECT value FROM cursor WHERE name = ?').get(name) as { value: number } | undefined)?.value ?? 0
  }
  setCursor(name: string, value: number): void {
    this.db.prepare('INSERT INTO cursor (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value)
  }

  // ── return paths ──────────────────────────────────────────────────────────
  /** Opened (or refreshed) when R writes to X; a closed one opens again, since R can reopen by writing. */
  openPath(internalRole: string, extDomain: string, extRole: string, by: string, now = Date.now()): 'opened' | 'refreshed' {
    const prior = this.db.prepare('SELECT closed_at FROM paths WHERE internal_role = ? AND ext_domain = ? AND ext_role = ?').get(internalRole, extDomain, extRole) as
      | { closed_at: number | null }
      | undefined
    this.db
      .prepare(
        `INSERT INTO paths (internal_role, ext_domain, ext_role, opened_at, last_used, opened_by) VALUES (?,?,?,?,?,?)
         ON CONFLICT DO UPDATE SET last_used = excluded.last_used,
           opened_at = CASE WHEN paths.closed_at IS NULL THEN paths.opened_at ELSE excluded.opened_at END,
           opened_by = CASE WHEN paths.closed_at IS NULL THEN paths.opened_by ELSE excluded.opened_by END,
           closed_at = NULL, closed_why = NULL`,
      )
      .run(internalRole, extDomain, extRole, now, now, by)
    return prior && prior.closed_at === null ? 'refreshed' : 'opened'
  }
  isOpen(internalRole: string, extDomain: string, extRole: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM paths WHERE internal_role = ? AND ext_domain = ? AND ext_role = ? AND closed_at IS NULL').get(internalRole, extDomain, extRole)
  }
  usePath(internalRole: string, extDomain: string, extRole: string, now = Date.now()): void {
    this.db.prepare('UPDATE paths SET last_used = ? WHERE internal_role = ? AND ext_domain = ? AND ext_role = ? AND closed_at IS NULL').run(now, internalRole, extDomain, extRole)
  }
  closePath(internalRole: string, extDomain: string, extRole: string, why: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE paths SET closed_at = ?, closed_why = ? WHERE internal_role = ? AND ext_domain = ? AND ext_role = ? AND closed_at IS NULL').run(now, why, internalRole, extDomain, extRole).changes > 0
  }
  /** Close every path unused for the idle limit; returns them, each to be audited. */
  closeIdle(idleMs: number, now = Date.now()): PathRow[] {
    const idle = this.db.prepare('SELECT * FROM paths WHERE closed_at IS NULL AND last_used < ?').all(now - idleMs) as PathRow[]
    for (const p of idle) this.closePath(p.internal_role, p.ext_domain, p.ext_role, 'idle', now)
    return idle
  }
  paths(includeClosed = false): PathRow[] {
    return this.db.prepare(`SELECT * FROM paths ${includeClosed ? '' : 'WHERE closed_at IS NULL'} ORDER BY last_used DESC`).all() as PathRow[]
  }

  // ── what peers exposed to us ──────────────────────────────────────────────
  setPeerRoles(peer: string, roles: string[], unavailable: string[], now = Date.now()): void {
    this.db
      .prepare('INSERT INTO peer_roles (peer, roles, unavailable, updated) VALUES (?,?,?,?) ON CONFLICT(peer) DO UPDATE SET roles = excluded.roles, unavailable = excluded.unavailable, updated = excluded.updated')
      .run(peer, JSON.stringify(roles), JSON.stringify(unavailable), now)
  }
  peerRoles(): { peer: string; roles: string[]; unavailable: string[] }[] {
    return (this.db.prepare('SELECT * FROM peer_roles ORDER BY peer').all() as { peer: string; roles: string; unavailable: string }[]).map((r) => ({
      peer: r.peer,
      roles: JSON.parse(r.roles) as string[],
      unavailable: JSON.parse(r.unavailable) as string[],
    }))
  }

  heard(peer: string, role: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO heard (peer, role, last) VALUES (?,?,?) ON CONFLICT DO UPDATE SET last = excluded.last').run(peer, role, now)
  }
  hasHeard(peer: string, role: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM heard WHERE peer = ? AND role = ?').get(peer, role)
  }

  close(): void {
    this.db.close()
  }
}
