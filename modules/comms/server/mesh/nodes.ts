/**
 * The node table: every node this machine knows, keyed by node id, never by
 * address: "nodes need an ID and details of its connection, so when the
 * connection details move, it is still seen as the node the other node knew."
 *
 *   source     how we learned of it: configured (our human gave its address),
 *              accepted (it connected in, not configured) or gossiped (a peer
 *              told us; P2). The strongest source seen is kept.
 *   intent     what it declared in its handshake: node, relay or gateway.
 *   validated  it has announced at least one role, or declared relay/gateway
 *              intent. Only validated nodes exchange records (Q5:
 *              "An empty mesh node with no role is suspect").
 *   links      the nodes it is directly linked to, from its announcement
 *   members    per role, its members with their capabilities and focus
 *
 * Lives in mesh.sqlite beside the record log.
 */
import type Database from 'better-sqlite3'

export type Source = 'configured' | 'accepted' | 'gossiped'
export type Intent = 'node' | 'relay' | 'gateway'

/** `live`: the member beat within its node's live window (a prompt, or a watcher running). Absent means not live. */
export type AnnouncedMember = { name: string; capabilities?: string; focus?: string; live?: true }
export type AnnouncedRole = { role: string; members: AnnouncedMember[] }

/** What every node floods about itself; the latest one per node is kept. */
export type Announcement = {
  v: 1
  node: string
  /** A short human name (home, hub, laptop); addresses may use it in place of the id. */
  alias?: string
  addresses: string[]
  intent: Intent
  links: string[]
  roles: AnnouncedRole[]
}

export type NodeRow = {
  node: string
  addresses: string[]
  configured: string[] // the configured URLs that turned out to be this node
  source: Source
  intent: Intent
  roles: string[]
  validated: boolean
  firstSeen: number
  lastSeen: number
  links: string[]
  members: AnnouncedRole[]
  alias?: string
  /** The last time this node had a route from here; 0 if it never has. */
  lastReachable: number
}

const RANK: Record<Source, number> = { gossiped: 0, accepted: 1, configured: 2 }

export const isValidated = (intent: Intent, roles: string[]): boolean => intent !== 'node' || roles.length > 0

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  node       TEXT PRIMARY KEY,
  addresses  TEXT NOT NULL DEFAULT '[]',
  configured TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL,
  intent     TEXT NOT NULL DEFAULT 'node',
  roles      TEXT NOT NULL DEFAULT '[]',
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  links      TEXT NOT NULL DEFAULT '[]',
  members    TEXT NOT NULL DEFAULT '[]',
  alias      TEXT,
  last_reachable INTEGER NOT NULL DEFAULT 0
);
`

type Raw = {
  node: string
  addresses: string
  configured: string
  source: Source
  intent: Intent
  roles: string
  first_seen: number
  last_seen: number
  links: string
  members: string
  alias: string | null
  last_reachable: number
}

const fromRaw = (r: Raw): NodeRow => {
  const roles = JSON.parse(r.roles) as string[]
  return {
    node: r.node,
    addresses: JSON.parse(r.addresses) as string[],
    configured: JSON.parse(r.configured) as string[],
    source: r.source,
    intent: r.intent,
    roles,
    validated: isValidated(r.intent, roles),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    links: JSON.parse(r.links) as string[],
    members: JSON.parse(r.members) as AnnouncedRole[],
    ...(r.alias ? { alias: r.alias } : {}),
    lastReachable: r.last_reachable,
  }
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]

export class NodeTable {
  constructor(private db: Database.Database) {
    db.exec(SCHEMA)
    const cols = new Set((db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('links')) db.exec("ALTER TABLE nodes ADD COLUMN links TEXT NOT NULL DEFAULT '[]'")
    if (!cols.has('members')) db.exec("ALTER TABLE nodes ADD COLUMN members TEXT NOT NULL DEFAULT '[]'")
    if (!cols.has('alias')) db.exec('ALTER TABLE nodes ADD COLUMN alias TEXT')
    if (!cols.has('last_reachable')) db.exec('ALTER TABLE nodes ADD COLUMN last_reachable INTEGER NOT NULL DEFAULT 0')
  }

  get(node: string): NodeRow | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE node = ?').get(node) as Raw | undefined
    return r && fromRaw(r)
  }

  list(): NodeRow[] {
    return (this.db.prepare('SELECT * FROM nodes ORDER BY node').all() as Raw[]).map(fromRaw)
  }

  /** The node a configured URL turned out to be, if any handshake told us. */
  byConfigured(url: string): NodeRow | undefined {
    return this.list().find((n) => n.configured.includes(url))
  }

  /**
   * Record a handshake. A known node at a new address stays the same row: its
   * addresses grow, and its source only ever strengthens.
   */
  seen(h: { node: string; addresses: string[]; intent: Intent; roles: string[] }, source: Source, configuredUrl?: string, now = Date.now()): NodeRow {
    const prev = this.get(h.node)
    const row: NodeRow = {
      node: h.node,
      addresses: union(h.addresses, prev?.addresses ?? []),
      configured: configuredUrl ? union([configuredUrl], prev?.configured ?? []) : (prev?.configured ?? []),
      source: prev && RANK[prev.source] > RANK[source] ? prev.source : source,
      intent: h.intent,
      roles: h.roles,
      validated: isValidated(h.intent, h.roles),
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      links: prev?.links ?? [],
      members: prev?.members ?? [],
      lastReachable: prev?.lastReachable ?? 0,
    }
    this.db
      .prepare(
        `INSERT INTO nodes (node, addresses, configured, source, intent, roles, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(node) DO UPDATE SET addresses = excluded.addresses, configured = excluded.configured, source = excluded.source,
           intent = excluded.intent, roles = excluded.roles, last_seen = excluded.last_seen`,
      )
      .run(row.node, JSON.stringify(row.addresses), JSON.stringify(row.configured), row.source, row.intent, JSON.stringify(row.roles), row.firstSeen, row.lastSeen)
    return row
  }

  /**
   * Take in a node's announcement, flooded through the mesh. A node we only
   * know this way is `gossiped`; one we have linked to keeps its stronger
   * source. lastSeen is left alone: an announcement is hearsay, not contact.
   */
  announced(a: Announcement, now = Date.now()): void {
    const prev = this.get(a.node)
    const roles = a.roles.map((r) => r.role)
    this.db
      .prepare(
        `INSERT INTO nodes (node, addresses, configured, source, intent, roles, first_seen, last_seen, links, members, alias) VALUES (?,?,'[]','gossiped',?,?,?,0,?,?,?)
         ON CONFLICT(node) DO UPDATE SET addresses = excluded.addresses, intent = excluded.intent, roles = excluded.roles,
           links = excluded.links, members = excluded.members, alias = excluded.alias`,
      )
      .run(
        a.node,
        JSON.stringify(union(a.addresses, prev?.addresses ?? [])),
        a.intent,
        JSON.stringify(roles),
        prev?.firstSeen ?? now,
        JSON.stringify(a.links),
        JSON.stringify(a.roles),
        a.alias ?? null,
      )
  }

  /** These nodes have a route from here right now. */
  reachable(nodes: Iterable<string>, now = Date.now()): void {
    const st = this.db.prepare('UPDATE nodes SET last_reachable = ? WHERE node = ?')
    for (const n of nodes) st.run(now, n)
  }

  remove(node: string): boolean {
    return this.db.prepare('DELETE FROM nodes WHERE node = ?').run(node).changes > 0
  }

  touch(node: string, now = Date.now()): void {
    this.db.prepare('UPDATE nodes SET last_seen = ? WHERE node = ?').run(now, node)
  }
}
