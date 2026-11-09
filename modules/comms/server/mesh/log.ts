/**
 * The mesh message bus: one append-only record log per machine.
 *
 * Every Cortex process on a machine opens the same SQLite file (WAL), so
 * sessions on one machine talk through it directly, with no daemon involved.
 * The daemon only replicates it to and from peers.
 *
 * Replication rests on two rules:
 *   - a machine appends only records of its OWN origin, numbered 1, 2, 3...;
 *     records from elsewhere are adopted with their origin and seq unchanged,
 *     so (origin, seq) is a record's identity on every machine and nothing
 *     can echo back as new;
 *   - a puller keeps a cursor per (peer, origin) and asks only for later seqs,
 *     so catch-up after any outage is the same pull as normal operation.
 *
 * Seqs are never reused. Records do leave the log (beats are superseded, a
 * routed message goes once it is read), and its seq lives on as the message id
 * in the outbox and at the destination; a reused seq there is a new message
 * that both sides treat as one already finished. So a high-water mark per
 * origin, which only goes up, numbers every append.
 *
 * Beats are ephemeral: only the latest per (origin, address, key) is kept.
 * Purge empties a payload and keeps the row, so seqs stay contiguous.
 *
 * Two planes share the log (mesh design, 4.2). REPLICATED kinds (node
 * announcements, purges, offline notices) flood to every node. Everything
 * else, comms above all, is LOCAL: it never leaves this machine by
 * replication, and arrives from elsewhere only by routed delivery, which
 * the daemon appends here itself. A peer can therefore never write into a
 * local mailbox by replication.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type MeshRecord = {
  origin: string
  seq: number
  kind: string
  address: string
  key: string
  payload: string
  stamp: number
  purged: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  origin  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  address TEXT NOT NULL,
  key     TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  stamp   INTEGER NOT NULL,
  purged  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (origin, seq)
);
CREATE INDEX IF NOT EXISTS idx_records_address ON records(address);
CREATE TABLE IF NOT EXISTS purged (
  origin TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  PRIMARY KEY (origin, seq)
);
CREATE TABLE IF NOT EXISTS forgotten (
  origin TEXT PRIMARY KEY,
  before INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seqs (
  origin TEXT PRIMARY KEY,
  seq    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  peer   TEXT NOT NULL,
  origin TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  PRIMARY KEY (peer, origin)
);
`

/**
 * Which record kinds flood beyond this machine, and how. Every other kind stays
 * on its machine. A replicated kind is kept from gateway peers unless its
 * policy says otherwise: a kind added without thought for the gateway fails
 * closed, home only (private mind, D15). `external` is a gateway's word on an
 * external domain it serves.
 */
export type KindPolicy = {
  /** Only the latest record per (origin, address, key) is kept. */
  ephemeral?: boolean
  /** Peer intents this kind is never sent to. Defaults to ['gateway']. */
  never?: string[]
}

export const FORGET_ADDRESS = 'mesh:forget'
const KINDS = new Map<string, Required<KindPolicy>>()

export const registerKind = (kind: string, policy: KindPolicy = {}): void => {
  KINDS.set(kind, { ephemeral: policy.ephemeral ?? false, never: policy.never ?? ['gateway'] })
}

for (const k of ['announce', 'offline', 'external']) registerKind(k, { ephemeral: true, never: [] })
for (const k of ['purge', 'forget']) registerKind(k, { never: [] })
// `memory` (V1's memory sync) is retired: private mind syncs memory through comms
// bundles, never by flooding. Unregistered, it is neither sent nor kept on receipt.
const BUILT_IN = new Set([...KINDS.keys(), 'memory'])

/** Kinds declared in module manifests (`meshKinds`). A built-in kind is never redefined. Returns what was refused. */
export const registerDeclaredKinds = (declared: { module: string; kinds: Record<string, KindPolicy> }[]): string[] => {
  const refused: string[] = []
  for (const d of declared)
    for (const [kind, policy] of Object.entries(d.kinds)) {
      if (BUILT_IN.has(kind)) refused.push(`${d.module}: ${kind} is a built-in mesh kind`)
      else registerKind(kind, policy)
    }
  return refused
}

export const isReplicated = (kind: string) => KINDS.has(kind)
export const replicatedKinds = (): string[] => [...KINDS.keys()]
/** Whether a record of this kind may be sent to a peer of this intent. */
export const sendableTo = (kind: string, intent: string | undefined): boolean => {
  const p = KINDS.get(kind)
  return !!p && !p.never.includes(intent ?? '')
}

const inReplicated = () => `kind IN (${replicatedKinds().map((k) => `'${k.replace(/'/g, "''")}'`).join(',')})`

/** Kinds where only the latest record per (origin, address, key) is kept. `beat` is local but ephemeral too. */
const isEphemeral = (kind: string) => kind === 'beat' || !!KINDS.get(kind)?.ephemeral

/** A record from elsewhere, checked field by field before it is adopted. */
export const isRecord = (r: unknown): r is MeshRecord => {
  const x = r as Record<string, unknown>
  return (
    !!x &&
    typeof x.origin === 'string' && x.origin.length > 0 &&
    Number.isInteger(x.seq) && (x.seq as number) > 0 &&
    typeof x.kind === 'string' &&
    typeof x.address === 'string' &&
    typeof x.key === 'string' &&
    typeof x.payload === 'string' &&
    typeof x.stamp === 'number' &&
    (x.purged === 0 || x.purged === 1)
  )
}

export class MeshLog {
  readonly db: Database.Database
  constructor(
    readonly dir: string,
    readonly origin: string,
  ) {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new Database(path.join(dir, 'mesh.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.#seedHighWater()
  }

  /**
   * A log from before the high-water mark may already have given out seqs it
   * no longer holds. Their ids survive in the outbox, so start above both.
   */
  #seedHighWater(): void {
    this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM seqs WHERE origin = ?').get(this.origin)) return
        const { n } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM records WHERE origin = ?').get(this.origin) as { n: number }
        let sent = 0
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get()) {
          const prefix = `${this.origin}.`
          for (const { id } of this.db.prepare('SELECT id FROM outbox WHERE substr(id, 1, ?) = ?').all(prefix.length, prefix) as { id: string }[]) {
            sent = Math.max(sent, Number(id.slice(prefix.length)) || 0)
          }
        }
        this.db.prepare('INSERT INTO seqs (origin, seq) VALUES (?, ?)').run(this.origin, Math.max(n, sent))
      })
      .immediate()
  }

  /** Append a record of this machine's own origin. Safe across processes. */
  append(kind: string, address: string, payload: string, key = '', stamp = Date.now()): MeshRecord {
    return this.db
      .transaction(() => {
        const { n } = this.db
          .prepare('SELECT MAX(COALESCE((SELECT MAX(seq) FROM records WHERE origin = ?), 0), COALESCE((SELECT seq FROM seqs WHERE origin = ?), 0)) n')
          .get(this.origin, this.origin) as { n: number }
        const rec: MeshRecord = { origin: this.origin, seq: n + 1, kind, address, key, payload, stamp, purged: 0 }
        this.#insert(rec)
        this.db.prepare('INSERT INTO seqs (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = excluded.seq').run(this.origin, rec.seq)
        return rec
      })
      .immediate()
  }

  /** Adopt records from elsewhere, idempotently. Returns how many were new. */
  adopt(records: MeshRecord[]): number {
    let added = 0
    this.db.transaction(() => {
      for (const r of records) {
        if (r.origin === this.origin) continue // our own come back via a peer: never re-adopt
        if (!isReplicated(r.kind)) continue // local kinds never arrive by replication
        const n = this.#insert(r)
        added += n
        if (n && r.kind === 'purge') this.#applyPurge(r.payload)
        if (n && r.kind === 'forget') this.#applyForget(r.payload)
      }
    })()
    return added
  }

  #insert(r: MeshRecord): number {
    // A purge can arrive before the record it names (they travel from
    // different origins by different links): the record then lands empty.
    const gone =
      !!this.db.prepare('SELECT 1 FROM purged WHERE origin = ? AND seq = ?').get(r.origin, r.seq) ||
      (r.kind !== 'forget' && !!this.db.prepare('SELECT 1 FROM forgotten WHERE origin = ? AND before >= ?').get(r.origin, r.stamp))
    const changes = this.db
      .prepare('INSERT OR IGNORE INTO records (origin, seq, kind, address, key, payload, stamp, purged) VALUES (?,?,?,?,?,?,?,?)')
      .run(r.origin, r.seq, r.kind, r.address, r.key, gone ? '' : r.payload, r.stamp, gone || r.purged ? 1 : 0).changes
    if (changes && isEphemeral(r.kind)) {
      this.db
        .prepare('DELETE FROM records WHERE origin = ? AND address = ? AND key = ? AND kind = ? AND seq < ?')
        .run(r.origin, r.address, r.key, r.kind, r.seq)
    }
    return changes
  }

  /** Records of a kind, counted by origin: what a purge of a retired kind would select from. */
  countKind(kind: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT origin, COUNT(*) n FROM records WHERE kind = ? GROUP BY origin').all(kind) as { origin: string; n: number }[]) out[r.origin] = r.n
    return out
  }

  /**
   * Delete a RETIRED kind's records, from the origins named and no others. A
   * kind still registered is refused: this is for leftovers no node sends any more.
   */
  purgeKind(kind: string, origins: string[]): number {
    if (isReplicated(kind)) throw new Error(`${kind} is a live mesh kind; only a retired kind's records may be purged`)
    if (!origins.length) return 0
    return this.db.prepare(`DELETE FROM records WHERE kind = ? AND origin IN (${origins.map(() => '?').join(',')})`).run(kind, ...origins).changes
  }

  /** Every record at an address, from every origin. */
  read(address: string): MeshRecord[] {
    return this.db.prepare('SELECT * FROM records WHERE address = ? AND purged = 0 ORDER BY stamp, origin, seq').all(address) as MeshRecord[]
  }

  /** What a peer is sent: one origin's replicated records after a seq. */
  since(origin: string, seq: number, limit = 500): MeshRecord[] {
    return this.db
      .prepare(`SELECT * FROM records WHERE origin = ? AND seq > ? AND ${inReplicated()} ORDER BY seq LIMIT ?`)
      .all(origin, seq, limit) as MeshRecord[]
  }

  /** Origins this log holds replicated records for, with the highest such seq. */
  origins(): { origin: string; maxSeq: number }[] {
    return this.db
      .prepare(`SELECT origin, MAX(seq) maxSeq FROM records WHERE ${inReplicated()} GROUP BY origin`)
      .all() as { origin: string; maxSeq: number }[]
  }

  cursor(peer: string, origin: string): number {
    return (this.db.prepare('SELECT seq FROM cursors WHERE peer = ? AND origin = ?').get(peer, origin) as { seq: number } | undefined)?.seq ?? 0
  }

  setCursor(peer: string, origin: string, seq: number): void {
    this.db.prepare('INSERT INTO cursors (peer, origin, seq) VALUES (?,?,?) ON CONFLICT(peer, origin) DO UPDATE SET seq = excluded.seq').run(peer, origin, seq)
  }

  /**
   * Empty a record's payload; the row stays so seqs stay contiguous. Remembered
   * even when the record has not arrived yet, so it arrives empty.
   */
  purge(origin: string, seq: number): boolean {
    this.db.prepare('INSERT OR IGNORE INTO purged (origin, seq) VALUES (?,?)').run(origin, seq)
    return this.db.prepare("UPDATE records SET payload = '', purged = 1 WHERE origin = ? AND seq = ?").run(origin, seq).changes > 0
  }

  /** Purge a record on this machine and, by replication, on every peer. */
  purgeEverywhere(origin: string, seq: number): void {
    this.append('purge', 'mesh:purge', JSON.stringify({ origin, seq }))
    this.purge(origin, seq)
  }

  #applyPurge(payload: string): void {
    try {
      const { origin, seq } = JSON.parse(payload) as { origin: string; seq: number }
      this.purge(origin, seq)
    } catch {
      /* a malformed purge purges nothing */
    }
  }

  /**
   * A node that is gone for good: everything it said up to `before` is emptied,
   * here and when it arrives later by another link. By stamp, not seq: a node
   * that comes back with a fresh log starts its seqs again, and is heard.
   * Never this node itself: a live node does not forget itself.
   */
  forget(node: string, before: number): boolean {
    if (node === this.origin) return false
    this.db
      .prepare('INSERT INTO forgotten (origin, before) VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET before = MAX(before, excluded.before)')
      .run(node, before)
    // A node's own leave notice is a forget too: it keeps travelling, or nodes past the next hop never hear it.
    this.db.prepare("UPDATE records SET payload = '', purged = 1 WHERE origin = ? AND stamp <= ? AND kind != 'forget'").run(node, before)
    return true
  }

  /** This node is going away for good: every node forgets it once the notice floods. */
  leave(before = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO forgotten (origin, before) VALUES (?,?)').run(this.origin, before)
    this.append('forget', FORGET_ADDRESS, JSON.stringify({ node: this.origin, before }), '', before)
  }

  /** Left, and not started since: a node that left says nothing more about itself. */
  hasLeft(): boolean {
    return !!this.db.prepare('SELECT 1 FROM forgotten WHERE origin = ?').get(this.origin)
  }

  /** Started again after leaving: back in the mesh. */
  rejoin(): void {
    this.db.prepare('DELETE FROM forgotten WHERE origin = ?').run(this.origin)
  }

  /** Forget a node on this machine and, by replication, on every peer. */
  forgetEverywhere(node: string, before = Date.now()): void {
    if (!this.forget(node, before)) return
    this.append('forget', FORGET_ADDRESS, JSON.stringify({ node, before }))
  }

  /** A forgotten node is back: it announced itself after it was forgotten. */
  announcedSince(origin: string, stamp: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM records WHERE origin = ? AND kind = 'announce' AND purged = 0 AND stamp > ?").get(origin, stamp)
  }

  /** Nodes forgotten, with the stamp before which they were. */
  forgotten(): { node: string; before: number }[] {
    return this.db.prepare('SELECT origin node, before FROM forgotten').all() as { node: string; before: number }[]
  }

  #applyForget(payload: string): void {
    try {
      const { node, before } = JSON.parse(payload) as { node: string; before: number }
      if (typeof node === 'string' && typeof before === 'number') this.forget(node, before)
    } catch {
      /* a malformed forget forgets nothing */
    }
  }

  close(): void {
    this.db.close()
  }
}
