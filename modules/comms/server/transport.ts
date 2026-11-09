import { recordBus } from './dialogue.js'
import { decode, encode } from './envelope.js'
import type { Envelope, Posted } from './types.js'
import type { MeshLog } from './mesh/log.js'
import { ACKS_ADDRESS, OUTBOX_ADDRESS, type RouteOut } from './mesh/router.js'
import { moveIntoInbox, snapshot } from './mesh/files.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * How envelopes move between machines.
 *
 * The comms module owns everything about roles; the transport only stores and
 * replicates. Today that is the V1 bus, which already replicates every message
 * to every mesh peer regardless of its address, so it is a ready-made durable
 * log for us with no V1 change. When the mesh moves into V2 this interface is
 * the only thing that changes. (Build plan, option C.)
 */
/** `home`: route only through home nodes, never a gateway (private mind, D15). */
export type RouteOpts = { home?: boolean }

export interface Transport {
  /** Store an envelope at `address`. Returns the transport's message id. */
  post(address: string, env: Envelope, opts?: { ephemeral?: boolean }): Promise<string>
  /** Every envelope ever stored at `address`, in no particular order. */
  read(address: string): Promise<Posted[]>
  /** Send to a mailbox on another node (routed). Only transports that route have it. */
  postTo?(node: string, address: string, env: Envelope, opts?: RouteOpts): Promise<string>
  /** Send files (and folders) to a mailbox on another node: snapshot here, routed in chunks. */
  postFilesTo?(node: string, address: string, env: Envelope, sources: string[], opts?: RouteOpts): Promise<string>
  /** Put files (and folders) straight into a mailbox's inbox on this node. */
  saveFiles?(address: string, sources: string[]): Promise<NonNullable<Envelope['files']>>
  /** Messages shown to a session: routed ones are acknowledged READ to their origins. */
  shown?(ids: string[]): Promise<void>
  /**
   * Claim a work message atomically, where every member of the role shares one
   * store: the first claim committed wins, with no clocks and no waiting.
   * Transports without it fall back to the posted-stamp rule and settle window.
   */
  claimAtomic?(address: string, msgId: string, claim: Envelope, started: Envelope): Promise<{ won: boolean; owner: string }>
}

/** Wire addresses. Prefixed so no V1 session alias can ever collide with them. */
export const ADDR = {
  registry: 'cortex-comms:registry',
  beat: 'cortex-comms:beat',
  role: (role: string) => `cortex-comms:role:${role}`,
  member: (member: string) => `cortex-comms:member:${member}`,
} as const

/** Envelopes larger than this are refused at send, loudly, rather than truncated in transit. */
export const MAX_ENVELOPE_BYTES = 32_000

const memberOf = (from: string) => (from.includes('/') ? from.split('/')[1]! : from)

/**
 * In-memory transport. One instance shared by several Comms objects behaves
 * like a mesh whose replication is instant. Tests simulate a network split by
 * giving each side its own instance and merging them afterwards (`absorb`).
 */
export class MemoryTransport implements Transport {
  private store = new Map<string, Posted[]>()
  private seq = 0

  async post(address: string, env: Envelope): Promise<string> {
    const id = `t_${String(++this.seq).padStart(6, '0')}`
    const list = this.store.get(address) ?? []
    list.push({ ...env, id })
    this.store.set(address, list)
    return id
  }

  async read(address: string): Promise<Posted[]> {
    return [...(this.store.get(address) ?? [])]
  }

  /** Heal a split: copy every envelope the other side has that this side lacks. */
  absorb(other: MemoryTransport): void {
    for (const [addr, list] of other.store) {
      const mine = this.store.get(addr) ?? []
      const ids = new Set(mine.map((p) => p.id))
      for (const p of list) if (!ids.has(p.id)) mine.push(p)
      this.store.set(addr, mine)
    }
  }

  /** Mint ids in a namespace so two split sides never collide. */
  static withPrefix(prefix: string): MemoryTransport {
    const t = new MemoryTransport()
    const post = t.post.bind(t)
    t.post = async (address, env) => {
      const id = await post(address, env)
      const list = t.store.get(address)!
      const renamed = `${prefix}${id}`
      list[list.length - 1] = { ...list[list.length - 1]!, id: renamed }
      return renamed
    }
    return t
  }
}

/**
 * The mesh message bus as a transport: the V2 replacement for the V1 bus.
 *
 * Posts append to this machine's mesh log, and reads see this machine's own
 * records: sessions on one machine share the log file. Comms records never
 * replicate; a message for another node is routed there by the mesh daemon
 * and appended to that node's log on arrival. Beats are ephemeral: only the
 * latest per member is kept.
 */
export class MeshTransport implements Transport {
  constructor(private log: MeshLog) {}

  #encode(env: Envelope): string {
    const body = encode(env)
    if (Buffer.byteLength(body, 'utf-8') > MAX_ENVELOPE_BYTES) {
      throw new Error(`message too large (${Buffer.byteLength(body)} bytes, limit ${MAX_ENVELOPE_BYTES})`)
    }
    return body
  }

  async post(address: string, env: Envelope, opts: { ephemeral?: boolean } = {}): Promise<string> {
    const body = this.#encode(env)
    const r = this.log.append(opts.ephemeral ? 'beat' : 'comms', address, body, opts.ephemeral ? memberOf(env.from) : '', env.stamp)
    if (!opts.ephemeral) {
      const ref = `${r.origin}.${r.seq}`
      recordBus('send', env, memberOf(env.from), ref)
      // Delivered right here: the receiving side's dialogue is recorded now too.
      if (address.startsWith(ADDR.member(''))) recordBus('receive', env, address.slice(ADDR.member('').length), ref)
      else if (address.startsWith(ADDR.role(''))) recordBus('receive', env, `role:${address.slice(ADDR.role('').length)}`, ref)
    }
    return `${r.origin}.${r.seq}`
  }

  /** Queue for the mesh daemon, which routes it to `node` and holds it until READ. */
  async postTo(node: string, address: string, env: Envelope, opts: RouteOpts = {}): Promise<string> {
    const out: RouteOut = { to: node, address, body: this.#encode(env), ...(opts.home ? { home: true } : {}) }
    const r = this.log.append('route-out', OUTBOX_ADDRESS, JSON.stringify(out), '', env.stamp)
    recordBus('send', env, memberOf(env.from), `${r.origin}.${r.seq}`)
    return `${r.origin}.${r.seq}`
  }

  /**
   * Members of a node's role are sessions on this node, sharing this log
   * ("the only conflict is same machine members"). So a claim is one
   * IMMEDIATE transaction: if nobody has claimed or started the message, write
   * this member's claim and started together; otherwise report who has it.
   */
  async claimAtomic(address: string, msgId: string, claim: Envelope, started: Envelope): Promise<{ won: boolean; owner: string }> {
    const claimBody = this.#encode(claim)
    const startedBody = this.#encode(started)
    return this.log.db
      .transaction(() => {
        for (const r of this.log.read(address)) {
          if (r.origin !== this.log.origin) continue
          const p = decode(`${r.origin}.${r.seq}`, r.payload)
          if (p && (p.type === 'claim' || p.type === 'started') && p.ref === msgId) return { won: memberOf(p.from) === memberOf(claim.from), owner: memberOf(p.from) }
        }
        this.log.append('comms', address, claimBody, '', claim.stamp)
        this.log.append('comms', address, startedBody, '', started.stamp)
        return { won: true, owner: memberOf(claim.from) }
      })
      .immediate()
  }

  async postFilesTo(node: string, address: string, env: Envelope, sources: string[], opts: RouteOpts = {}): Promise<string> {
    const dir = path.join(this.log.dir, 'files', 'out', crypto.randomUUID())
    let entries
    try {
      entries = snapshot(sources, dir)
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
    const body = this.#encode({ ...env, files: entries.map((e) => ({ name: e.name, size: e.size, sha256: e.sha256 })) })
    const out: RouteOut = { to: node, address, body, files: { dir, entries }, ...(opts.home ? { home: true } : {}) }
    const r = this.log.append('route-out', OUTBOX_ADDRESS, JSON.stringify(out), '', env.stamp)
    recordBus('send', env, memberOf(env.from), `${r.origin}.${r.seq}`)
    return `${r.origin}.${r.seq}`
  }

  async saveFiles(address: string, sources: string[]): Promise<NonNullable<Envelope['files']>> {
    const staging = path.join(this.log.dir, 'files', 'local', crypto.randomUUID())
    try {
      const entries = snapshot(sources, staging)
      return moveIntoInbox(path.join(this.log.dir, 'files'), address, entries.map((entry) => ({ entry, part: path.join(staging, entry.name) })))
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  async shown(ids: string[]): Promise<void> {
    const local = ids.filter((id) => this.#remoteOf(id))
    if (local.length) this.log.append('route-ack', ACKS_ADDRESS, JSON.stringify({ local }))
  }

  /** Where a routed message came from, as the daemon recorded on delivery. */
  #remoteOf(localId: string): { node: string; id: string } | undefined {
    try {
      const row = this.log.db.prepare('SELECT origin, id FROM routed_in WHERE local_id = ?').get(localId) as { origin: string; id: string } | undefined
      return row && { node: row.origin, id: row.id }
    } catch {
      return undefined // no daemon has run here yet, so nothing was routed in
    }
  }

  async read(address: string): Promise<Posted[]> {
    const out: Posted[] = []
    for (const r of this.log.read(address)) {
      // Comms records are local: written here by a session, or appended here by
      // the daemon on routed delivery. One of another origin is a leftover of
      // the replicated mesh and is never this node's.
      if (r.origin !== this.log.origin) continue
      const id = `${r.origin}.${r.seq}`
      const p = decode(id, r.payload)
      if (!p) continue
      const remote = r.kind === 'comms' ? this.#remoteOf(id) : undefined
      out.push(remote ? { ...p, remote } : p)
    }
    return out
  }
}
