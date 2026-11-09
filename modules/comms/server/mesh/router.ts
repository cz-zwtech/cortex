/**
 * Routed delivery (mesh design section 9, Q2 and Q3; build plan P4).
 *
 * Comms messages for another node never replicate. A session writes a
 * `route-out` record in its own log; the daemon sends it toward the
 * destination hop by hop along the current route; the destination appends it
 * to its own log, where its sessions read it as any local message.
 *
 *   DELIVERED  the destination stored it. The origin stops resending.
 *   READ       a session there has been shown it. Only now does the origin
 *              drop its copy ("an ack of read is the action for
 *              origination to delete").
 *
 * The origin holds every message until READ. A relay that cannot forward
 * says `broken` back to the origin, which resends once a route exists again;
 * resends are dropped at the destination by (origin, id). Relays never store.
 * Every frame carries a hop count (limit 8) and each node drops a frame it has
 * already forwarded, so a route that is briefly inconsistent cannot loop.
 *
 * Lost acks heal: the origin periodically asks the destination about a
 * message that is delivered but not yet read, and the destination answers
 * from what it recorded.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import type Database from 'better-sqlite3'

import { fileMaxBytes, Inbound, moveIntoInbox, Outbound, safeName, type ChunkFrame, type FileEntry, type SavedFile } from './files.js'
import type { MeshLog } from './log.js'

export const OUTBOX_ADDRESS = 'mesh:outbox'
export const ACKS_ADDRESS = 'mesh:acks'
export const MAX_HOPS = 8
const RESEND_MS = 30_000
const QUERY_MS = 10 * 60_000
const SEEN_MS = 10 * 60_000

export type RouteKind =
  | 'msg' | 'delivered' | 'read' | 'broken' | 'refused' | 'query'
  | 'file-offer' | 'file-need' | 'chunk' | 'file-progress' // file transfer (files.ts)
export type RouteFrame = {
  t: 'route'
  kind: RouteKind
  /** The origin's id for the message this frame is about. */
  id: string
  from: string
  to: string
  hops: number
  /** msg and file-offer: the destination mailbox and the encoded envelope. */
  address?: string
  body?: string
  reason?: string
  /** file-offer: the files; file-need: chunks held per file; chunk; file-progress. */
  entries?: FileEntry[]
  need?: number[]
  entry?: number
  n?: number
  data?: string
  sha256?: string
  upto?: number
  /**
   * This transmission, minted by the node that first sends the frame. Relays
   * drop a frame they have already forwarded by it, which stops loops; a
   * retransmission after a loss carries a new one and passes.
   */
  tx?: string
  /** Home only: routed on paths that avoid every gateway, and never forwarded by one. */
  home?: 1
}

const KINDS = ['msg', 'delivered', 'read', 'broken', 'refused', 'query', 'file-offer', 'file-need', 'chunk', 'file-progress']
const int = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0)
const isEntry = (e: unknown): e is FileEntry => {
  const x = e as Record<string, unknown>
  return !!x && typeof x.name === 'string' && safeName(x.name) && int(x.size) && typeof x.sha256 === 'string' && Number.isInteger(x.chunks) && (x.chunks as number) > 0
}

export const isRouteFrame = (f: Record<string, unknown>): f is RouteFrame =>
  f.t === 'route' &&
  KINDS.includes(f.kind as string) &&
  typeof f.id === 'string' && typeof f.from === 'string' && typeof f.to === 'string' &&
  Number.isInteger(f.hops) &&
  (f.address === undefined || typeof f.address === 'string') &&
  (f.body === undefined || typeof f.body === 'string') &&
  (f.entries === undefined || (Array.isArray(f.entries) && f.entries.every(isEntry))) &&
  (f.need === undefined || (Array.isArray(f.need) && f.need.every((x) => Number.isInteger(x) && x >= 0))) &&
  int(f.entry) && int(f.n) && int(f.upto) &&
  (f.data === undefined || typeof f.data === 'string') &&
  (f.sha256 === undefined || typeof f.sha256 === 'string') &&
  (f.tx === undefined || typeof f.tx === 'string') &&
  (f.home === undefined || f.home === 1)

/** The start of a comms message's text, without parsing comms: the envelope is JSON after a prefix. */
const subjectOf = (envelope: string): string => {
  try {
    const body = (JSON.parse(envelope.slice(envelope.indexOf('{'))) as { body?: unknown }).body
    return typeof body === 'string' ? body.slice(0, 200) : ''
  } catch {
    return ''
  }
}

/** What a session writes to send a message (and, with `files`, a snapshot of files) to another node. */
/** `home`: the message and its files may travel only through home nodes, never a gateway. */
export type RouteOut = { to: string; address: string; body: string; files?: { dir: string; entries: FileEntry[] }; home?: boolean }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id           TEXT PRIMARY KEY,
  to_node      TEXT NOT NULL,
  address      TEXT NOT NULL,
  created      INTEGER NOT NULL,
  last_sent    INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  read_at      INTEGER,
  failed       TEXT,
  last_error   TEXT,
  last_query   INTEGER NOT NULL DEFAULT 0,
  subject      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS routed_in (
  origin   TEXT NOT NULL,
  id       TEXT NOT NULL,
  local_id TEXT NOT NULL,
  at       INTEGER NOT NULL,
  read_at  INTEGER,
  files    TEXT,
  PRIMARY KEY (origin, id)
);
CREATE INDEX IF NOT EXISTS idx_routed_in_local ON routed_in(local_id);
`

export type OutboxRow = {
  id: string
  to_node: string
  address: string
  created: number
  last_sent: number
  delivered_at: number | null
  read_at: number | null
  failed: string | null
  last_error: string | null
  last_query: number
  /** The start of the message, kept after its body goes: what that node's role was asked to do. */
  subject: string
  home?: number
}

const migrate = (db: Database.Database) => {
  db.exec(SCHEMA)
  const cols = new Set((db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('subject')) db.exec("ALTER TABLE outbox ADD COLUMN subject TEXT NOT NULL DEFAULT ''")
  if (!cols.has('home')) db.exec('ALTER TABLE outbox ADD COLUMN home INTEGER NOT NULL DEFAULT 0')
  const inCols = new Set((db.prepare('PRAGMA table_info(routed_in)').all() as { name: string }[]).map((c) => c.name))
  if (!inCols.has('files')) db.exec('ALTER TABLE routed_in ADD COLUMN files TEXT')
}

export const openOutbox = (db: Database.Database) => {
  migrate(db)
  return {
    list: (): OutboxRow[] => db.prepare('SELECT * FROM outbox ORDER BY created').all() as OutboxRow[],
  }
}

export type Accept = (address: string, body: string, from: string) => { ok: true } | { ok: false; reason: string }

/** Files arrived, verified and in the inbox: write the message that tells the mailbox, returning its id. */
export type DeliverFiles = (address: string, body: string, saved: SavedFile[]) => string

export type FileOpts = {
  /** Where staging and inboxes live. */
  root: string
  /** The secret gate for a received file bound for `address`: a reason to refuse it, or undefined. */
  scan: (file: string, address: string) => string | undefined
  deliver: DeliverFiles
  /** How long received files are kept after they are read. */
  keepReadMs: () => number
}

export class Router {
  readonly db: Database.Database
  #seen = new Map<string, number>()
  #out = new Outbound()
  #in?: Inbound

  constructor(
    private log: MeshLog,
    private self: string,
    /** Send a frame to a directly linked node. False when there is no live link. */
    private sendTo: (node: string, frame: RouteFrame) => boolean,
    /** The next hop toward a node, if it is reachable; `home` routes avoid every gateway. */
    private nextHop: (node: string, home?: boolean) => string | undefined,
    /** Is this mailbox one a message may be delivered to here? */
    private accept: Accept,
    /** A message this node sent could not be delivered: tell its sender. */
    private notifySender: (row: OutboxRow, envelope: string, reason: string) => void,
    /** File transfer; without it, file offers are refused. */
    private files?: FileOpts,
  ) {
    this.db = log.db
    migrate(this.db)
    if (files) this.#in = new Inbound(files.root)
  }

  // ── origin side ──────────────────────────────────────────────────────────

  /** Pick up new route-out records, send what is due, ask about stale ones. */
  pump(now = Date.now()): void {
    for (const r of this.log.read(OUTBOX_ADDRESS)) {
      if (r.origin !== this.self || r.kind !== 'route-out') continue
      const id = `${r.origin}.${r.seq}`
      let out: RouteOut
      try {
        out = JSON.parse(r.payload) as RouteOut
      } catch {
        continue
      }
      this.db
        .prepare('INSERT OR IGNORE INTO outbox (id, to_node, address, created, subject, home) VALUES (?,?,?,?,?,?)')
        .run(id, out.to, out.address, r.stamp, subjectOf(out.body), out.home ? 1 : 0)
      const home = out.home ? ({ home: 1 } as const) : {}
      const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow
      if (row.created !== r.stamp) {
        // The id already belongs to another message, so both ends would take
        // this one as finished. Say so rather than drop it.
        const reason = `not sent: id ${id} was already used by an earlier message`
        console.error(`mesh: ${reason}`)
        try {
          this.notifySender({ ...row, to_node: out.to, address: out.address, created: r.stamp, subject: subjectOf(out.body) }, out.body, reason)
        } finally {
          this.db.prepare("DELETE FROM records WHERE origin = ? AND seq = ? AND kind = 'route-out'").run(r.origin, r.seq)
        }
        continue
      }
      if (row.failed || row.read_at) continue
      if (!row.delivered_at && out.files) {
        if (this.#out.offerDue(id, out.files.dir, out.files.entries, now)) {
          if (this.#forward({ t: 'route', kind: 'file-offer', id, from: this.self, to: out.to, hops: 0, address: out.address, body: out.body, entries: out.files.entries, ...home })) {
            this.db.prepare('UPDATE outbox SET last_sent = ?, last_error = NULL WHERE id = ?').run(now, id)
          } else {
            this.db.prepare("UPDATE outbox SET last_error = 'no route' WHERE id = ?").run(id)
          }
        }
        continue
      }
      if (!row.delivered_at) {
        if (now - row.last_sent < RESEND_MS) continue
        if (this.#forward({ t: 'route', kind: 'msg', id, from: this.self, to: out.to, hops: 0, address: out.address, body: out.body, ...home })) {
          this.db.prepare('UPDATE outbox SET last_sent = ?, last_error = NULL WHERE id = ?').run(now, id)
        } else {
          this.db.prepare("UPDATE outbox SET last_error = 'no route' WHERE id = ?").run(id)
        }
      } else if (now - Math.max(row.delivered_at, row.last_query) >= QUERY_MS) {
        if (this.#forward({ t: 'route', kind: 'query', id, from: this.self, to: out.to, hops: 0, ...home })) {
          this.db.prepare('UPDATE outbox SET last_query = ? WHERE id = ?').run(now, id)
        }
      }
    }
    this.#sendReadAcks()
    // Messages went first; file chunks fill what is left, a small window each.
    for (const id of this.#out.active()) this.#sendChunks(id)
    this.#forgetReadFiles(now)
  }

  #sendChunks(id: string): void {
    const row = this.db.prepare('SELECT to_node, home FROM outbox WHERE id = ?').get(id) as { to_node: string; home: number } | undefined
    if (!row) return this.#out.done(id)
    for (const c of this.#out.due(id)) this.#forward({ t: 'route', kind: 'chunk', id, from: this.self, to: row.to_node, hops: 0, ...c, ...(row.home ? { home: 1 as const } : {}) })
  }

  /** Received files are kept until read, then for the offline lifetime, then removed. */
  #forgetReadFiles(now: number): void {
    if (!this.files) return
    const old = this.db
      .prepare('SELECT origin, id, files FROM routed_in WHERE files IS NOT NULL AND read_at IS NOT NULL AND read_at < ?')
      .all(now - this.files.keepReadMs()) as { origin: string; id: string; files: string }[]
    for (const r of old) {
      for (const f of JSON.parse(r.files) as SavedFile[]) fs.rmSync(f.path, { force: true })
      this.db.prepare('UPDATE routed_in SET files = NULL WHERE origin = ? AND id = ?').run(r.origin, r.id)
    }
  }

  /**
   * A node passed its offline limit. Undelivered messages for it fail, and
   * their senders are told; delivered-but-unread ones are already there, so
   * the origin just stops holding them.
   */
  expire(node: string, reason: string): number {
    const rows = this.db.prepare('SELECT * FROM outbox WHERE to_node = ? AND failed IS NULL AND read_at IS NULL').all(node) as OutboxRow[]
    for (const r of rows) {
      if (r.delivered_at) {
        this.db.prepare('UPDATE outbox SET failed = ? WHERE id = ?').run(`expired after delivery: ${reason}`, r.id)
        this.#done(r.id)
      } else {
        this.#fail(r.id, reason)
      }
    }
    return rows.length
  }

  /** A link went down: transfers resume (re-offer) at once rather than after a stall. */
  linkLost(): void {
    this.#out.stallAll()
  }

  /** A route reappeared: resend everything undelivered to that node now. */
  routeUp(node: string): void {
    this.db.prepare('UPDATE outbox SET last_sent = 0 WHERE to_node = ? AND delivered_at IS NULL').run(node)
  }

  #done(id: string): void {
    // READ: the origin's copy goes, files included (the outbox row stays as the receipt).
    const [origin, seq] = [id.slice(0, id.lastIndexOf('.')), Number(id.slice(id.lastIndexOf('.') + 1))]
    if (origin !== this.self) return
    this.#out.done(id)
    const rec = this.db.prepare("SELECT payload FROM records WHERE origin = ? AND seq = ? AND kind = 'route-out'").get(origin, seq) as { payload: string } | undefined
    try {
      const dir = rec && (JSON.parse(rec.payload) as RouteOut).files?.dir
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* nothing to remove */
    }
    this.db.prepare("DELETE FROM records WHERE origin = ? AND seq = ? AND kind = 'route-out'").run(origin, seq)
  }

  #fail(id: string, reason: string): void {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined
    if (!row || row.failed) return
    const seq = Number(id.slice(id.lastIndexOf('.') + 1))
    const rec = this.db.prepare('SELECT payload FROM records WHERE origin = ? AND seq = ?').get(this.self, seq) as { payload: string } | undefined
    this.db.prepare('UPDATE outbox SET failed = ? WHERE id = ?').run(reason, id)
    if (rec) {
      try {
        this.notifySender(row, (JSON.parse(rec.payload) as RouteOut).body, reason)
      } catch {
        /* nothing to tell */
      }
    }
    this.#done(id)
  }

  // ── destination side ────────────────────────────────────────────────────

  /**
   * Sessions here were shown routed messages: tell their origins READ. A
   * `route-refuse` (a gateway whose peer refused what it took in) tells the
   * origin it failed, with the reason, so its sender is not told READ.
   */
  #sendReadAcks(): void {
    for (const r of this.log.read(ACKS_ADDRESS)) {
      if (r.origin === this.self && r.kind === 'route-refuse') {
        try {
          const { local, reason } = JSON.parse(r.payload) as { local: string; reason: string }
          const row = this.db.prepare('SELECT * FROM routed_in WHERE local_id = ?').get(local) as { origin: string; id: string } | undefined
          if (row) this.#forward({ t: 'route', kind: 'refused', id: row.id, from: this.self, to: row.origin, hops: 0, reason })
        } catch {
          /* a malformed refusal refuses nothing */
        }
        this.db.prepare('DELETE FROM records WHERE origin = ? AND seq = ?').run(r.origin, r.seq)
        continue
      }
      if (r.origin !== this.self || r.kind !== 'route-ack') continue
      let local: string[]
      try {
        local = (JSON.parse(r.payload) as { local: string[] }).local
      } catch {
        local = []
      }
      for (const l of local) {
        const row = this.db.prepare('SELECT * FROM routed_in WHERE local_id = ?').get(l) as { origin: string; id: string; read_at: number | null } | undefined
        if (!row) continue
        if (!row.read_at) this.db.prepare('UPDATE routed_in SET read_at = ? WHERE origin = ? AND id = ?').run(Date.now(), row.origin, row.id)
        this.#forward({ t: 'route', kind: 'read', id: row.id, from: this.self, to: row.origin, hops: 0 })
      }
      this.db.prepare('DELETE FROM records WHERE origin = ? AND seq = ?').run(r.origin, r.seq)
    }
  }

  #deliver(f: RouteFrame): void {
    const prior = this.db.prepare('SELECT * FROM routed_in WHERE origin = ? AND id = ?').get(f.from, f.id) as { local_id: string; read_at: number | null } | undefined
    if (!prior) {
      const verdict = this.accept(f.address ?? '', f.body ?? '', f.from)
      if (!verdict.ok) {
        this.#forward({ t: 'route', kind: 'refused', id: f.id, from: this.self, to: f.from, hops: 0, reason: verdict.reason })
        return
      }
      const rec = this.log.append('comms', f.address!, f.body!)
      this.db.prepare('INSERT INTO routed_in (origin, id, local_id, at) VALUES (?,?,?,?)').run(f.from, f.id, `${rec.origin}.${rec.seq}`, Date.now())
    }
    this.#forward({ t: 'route', kind: prior?.read_at ? 'read' : 'delivered', id: f.id, from: this.self, to: f.from, hops: 0 })
  }

  // ── every node ──────────────────────────────────────────────────────────

  /** A route frame arrived on a link. */
  receive(f: RouteFrame, now = Date.now()): void {
    if (f.to !== this.self) {
      this.#relay(f, now)
      return
    }
    switch (f.kind) {
      case 'msg':
        return this.#deliver(f)
      case 'query': {
        const row = this.db.prepare('SELECT read_at FROM routed_in WHERE origin = ? AND id = ?').get(f.from, f.id) as { read_at: number | null } | undefined
        if (row) this.#forward({ t: 'route', kind: row.read_at ? 'read' : 'delivered', id: f.id, from: this.self, to: f.from, hops: 0 })
        return
      }
      case 'delivered':
        this.db.prepare('UPDATE outbox SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE id = ?').run(now, f.id)
        this.#out.done(f.id)
        return
      case 'file-offer':
        return this.#fileOffer(f)
      case 'chunk':
        return this.#chunk(f)
      case 'file-need':
        this.#out.need(f.id, f.need ?? [], now)
        return this.#sendChunks(f.id)
      case 'file-progress':
        this.#out.progress(f.id, f.entry ?? 0, f.upto ?? 0, now)
        return this.#sendChunks(f.id)
      case 'read':
        this.db.prepare('UPDATE outbox SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?').run(now, now, f.id)
        this.#done(f.id)
        return
      case 'broken':
        this.db.prepare('UPDATE outbox SET last_error = ? WHERE id = ? AND delivered_at IS NULL').run(`route broken: ${f.reason ?? ''}`, f.id)
        return
      case 'refused':
        this.#fail(f.id, f.reason ?? 'refused')
        return
    }
  }

  // ── files, destination side ─────────────────────────────────────────────

  #fileOffer(f: RouteFrame): void {
    const prior = this.db.prepare('SELECT read_at FROM routed_in WHERE origin = ? AND id = ?').get(f.from, f.id) as { read_at: number | null } | undefined
    if (prior) return void this.#forward({ t: 'route', kind: prior.read_at ? 'read' : 'delivered', id: f.id, from: this.self, to: f.from, hops: 0 })
    const refuse = (reason: string) => void this.#forward({ t: 'route', kind: 'refused', id: f.id, from: this.self, to: f.from, hops: 0, reason })
    if (!this.#in) return refuse('this node takes no files')
    const entries = f.entries ?? []
    if (!entries.length) return refuse('no files in the offer')
    const max = fileMaxBytes()
    const big = entries.find((e) => e.size > max)
    if (big) return refuse(`${big.name} is over the ${Math.round(max / 1048576)} MB limit`)
    const verdict = this.accept(f.address ?? '', f.body ?? '', f.from)
    if (!verdict.ok) return refuse(verdict.reason)
    const need = this.#in.offer(f.from, f.id, entries, f.address!, f.body!)
    this.#forward({ t: 'route', kind: 'file-need', id: f.id, from: this.self, to: f.from, hops: 0, need })
  }

  #chunk(f: RouteFrame): void {
    if (!this.#in || !this.files || f.entry === undefined || f.n === undefined || !f.data || !f.sha256) return
    if (this.db.prepare('SELECT 1 FROM routed_in WHERE origin = ? AND id = ?').get(f.from, f.id)) return // already delivered
    const r = this.#in.chunk(f.from, f.id, { entry: f.entry, n: f.n, data: f.data, sha256: f.sha256 } satisfies ChunkFrame)
    if (!r) return
    this.#forward({ t: 'route', kind: 'file-progress', id: f.id, from: this.self, to: f.from, hops: 0, entry: f.entry, upto: r.upto })
    if (r.complete) this.#finishFiles(f.from, f.id)
  }

  /** Every file verified: the secret gate, then the inbox, then the message that tells the mailbox. */
  #finishFiles(origin: string, id: string): void {
    const staged = this.#in!.staged(origin, id)
    if (!staged) return
    for (const { entry, part } of staged.files) {
      const reason = this.files!.scan(part, staged.staging.address)
      if (reason) {
        this.#in!.drop(origin, id)
        this.#forward({ t: 'route', kind: 'refused', id, from: this.self, to: origin, hops: 0, reason: `${entry.name}: ${reason}` })
        return
      }
    }
    // A delivery that throws refuses this transfer; it must never take the daemon down with it.
    let saved: SavedFile[]
    let localId: string
    try {
      saved = moveIntoInbox(this.files!.root, staged.staging.address, staged.files)
      localId = this.files!.deliver(staged.staging.address, staged.staging.body, saved)
    } catch (err) {
      this.#in!.drop(origin, id)
      this.#forward({ t: 'route', kind: 'refused', id, from: this.self, to: origin, hops: 0, reason: `files not delivered: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    this.db.prepare('INSERT INTO routed_in (origin, id, local_id, at, files) VALUES (?,?,?,?,?)').run(origin, id, localId, Date.now(), JSON.stringify(saved))
    this.#in!.drop(origin, id)
    this.#forward({ t: 'route', kind: 'delivered', id, from: this.self, to: origin, hops: 0 })
  }

  #relay(f: RouteFrame, now: number): void {
    const key = `${f.kind}:${f.from}:${f.id}:${f.entry ?? ''}:${f.n ?? ''}:${f.upto ?? ''}:${f.tx ?? ''}`
    for (const [k, t] of this.#seen) if (now - t > SEEN_MS) this.#seen.delete(k)
    if (this.#seen.has(key) || f.hops + 1 >= MAX_HOPS) return
    this.#seen.set(key, now)
    if (this.#forward({ ...f, hops: f.hops + 1 })) return
    if (f.kind === 'msg') this.#forward({ t: 'route', kind: 'broken', id: f.id, from: this.self, to: f.from, hops: 0, reason: `no route from ${this.self} to ${f.to}` })
  }

  /** Send toward f.to along the current route. False when there is none. */
  #forward(f: RouteFrame): boolean {
    if (f.to === this.self) {
      this.receive(f)
      return true
    }
    const hop = this.nextHop(f.to, f.home === 1)
    if (!hop) return false
    return this.sendTo(hop, f.tx ? f : { ...f, tx: crypto.randomBytes(6).toString('hex') })
  }
}
