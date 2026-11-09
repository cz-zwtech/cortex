/**
 * The sync itself (design 5.5, 5.6): comms over the home mesh, every message
 * home-only, so nothing of the mind is ever routed through a gateway.
 *
 * A round, on a node that is not central:
 *  1. pick the source: central when it is reachable; otherwise the reachable
 *     home node built on the newest central commit, and mark this node degraded;
 *  2. push what the source lacks (from its gossiped vectors) as `mind.sync.push`;
 *  3. ask for what this node lacks with `mind.sync.request`; the source answers
 *     `mind.sync.bundle`.
 * Central answers requests and takes pushes, acknowledging with `mind.sync.ack`.
 * Bundles travel as NDJSON files in parts; every part is applied on its own and
 * applying is idempotent, so a cut transfer is simply finished by the next round.
 * When central is back after a degraded spell, the next round is with central
 * and clears the flag: the vectors make that round the full reconcile.
 */
import fs from 'node:fs'
import path from 'node:path'

import { fromNdjson, toNdjson, type Line } from './bundle.js'
import { short, type Vector } from './commits.js'
import type { MindConfig } from './config.js'
import { gossip, loadState, record, saveState, type MindState } from './state.js'
import type { MindStore } from './store.js'
import { makeBundle, takeBundle, type Ports } from './sync.js'

export const MIND_ROLE = 'mind'
export const PART_LINES = 5_000

export type Msg =
  | { t: 'mind.sync.request'; have: { vv: Vector; bvv: Vector }; commits: string[] }
  | { t: 'mind.sync.bundle'; reply: string; part: number; parts: number; commit?: string; base?: string; central: boolean }
  | { t: 'mind.sync.push'; round: string; part: number; parts: number; commit?: string; base?: string }
  | { t: 'mind.sync.ack'; round: string; part: number; commit?: string }

export type InboxItem = { id: string; from: string; body: string; node?: string; files?: { name: string; path?: string }[] }
/** How often a one-shot looks at its mailbox while it waits for answers. */
export const DRAIN_POLL_MS = 1_000
/** How often a one-shot asks again when no home node with a mind is reachable yet. */
export const SOURCE_RETRY_MS = 5_000

export type MindState_ = { node: string; vv: Vector; bvv: Vector; commits: string[]; base?: string; role: string[]; degraded: boolean; at: number }

export type CommsPort = {
  send: (from: string, to: string, body: string, opts: { files?: string[]; homeOnly: true; queueAnyway?: boolean }) => Promise<{ ok: boolean; outcome?: string }>
  inbox: (member: string) => Promise<InboxItem[]>
  markSeen: (member: string, ids: string[]) => void
  /** Home nodes with a `mind` role and a route to them that passes no gateway, by node id. */
  mindNodes: () => string[]
}

export type ServiceOpts = {
  self: string
  cfg: MindConfig
  dataDir: string
  store: MindStore
  ports: Ports
  comms: CommsPort
  /** Every node's latest gossiped mind-state. */
  peers: () => MindState_[]
  publish: () => void
  log: (m: string) => void
  now?: () => number
  /** Lines per bundle part (tests make it small). */
  partLines?: number
}

export const memberFor = (node: string) => `mind-${node.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 60)
const address = (node: string) => `${node}:${MIND_ROLE}`

export class MindService {
  readonly member: string
  constructor(private o: ServiceOpts) {
    this.member = memberFor(o.self)
  }

  get #isCentral() {
    return this.o.cfg.central === this.o.self
  }
  #now() {
    return (this.o.now ?? Date.now)()
  }
  #state(): MindState {
    return loadState(this.o.dataDir)
  }

  /** Write a bundle's lines as part files and send each, home-only. */
  async #sendParts(to: string, lines: Line[], head: (part: number, parts: number) => Msg): Promise<boolean> {
    const dir = path.join(this.o.dataDir, 'out')
    fs.mkdirSync(dir, { recursive: true })
    const per = this.o.partLines ?? PART_LINES
    const parts = Math.max(1, Math.ceil(lines.length / per))
    let ok = true
    for (let i = 0; i < parts; i++) {
      const file = path.join(dir, `${this.#now().toString(36)}-${i + 1}of${parts}.ndjson`)
      fs.writeFileSync(file, toNdjson(lines.slice(i * per, (i + 1) * per)))
      const r = await this.o.comms.send(this.member, address(to), JSON.stringify(head(i + 1, parts)), { files: [file], homeOnly: true })
      fs.rmSync(file, { force: true }) // the transport has its own snapshot
      if (!r.ok) {
        ok = false
        this.o.log(`private mind: part ${i + 1}/${parts} to ${to} not sent: ${r.outcome ?? 'refused'}`)
      }
    }
    return ok
  }

  /** The node to sync with now, and whether that makes this node degraded. Undefined: nobody reachable. */
  source(): { node: string; degraded: boolean } | undefined {
    const reachable = new Set(this.o.comms.mindNodes())
    const central = this.o.cfg.central
    if (central && central !== this.o.self && reachable.has(central)) return { node: central, degraded: false }
    const lineage = this.#state().central
    const rank = (p: MindState_) => {
      const i = p.base ? lineage.indexOf(p.base) : -1
      return [i < 0 ? Infinity : i, -Object.values(p.vv).reduce((a, n) => a + n, 0)] as const
    }
    const candidates = this.o.peers().filter((p) => p.node !== this.o.self && p.node !== central && reachable.has(p.node))
    candidates.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])
    return candidates[0] ? { node: candidates[0].node, degraded: true } : undefined
  }

  /** One round: push what the source lacks, ask for what this node lacks. */
  async round(): Promise<{ with?: string; degraded: boolean; pushed: number; held: number; refused?: string }> {
    if (!this.o.cfg.enabled) return { degraded: false, pushed: 0, held: 0 }
    if (this.#isCentral) return { degraded: false, pushed: 0, held: 0 } // central serves; it does not pull
    this.refused = this.#idReused()
    if (this.refused) {
      this.o.log(`private mind: ${this.refused}`)
      return { degraded: this.#state().degraded, pushed: 0, held: 0, refused: this.refused }
    }
    const src = this.source()
    if (!src) {
      this.o.log('private mind: no home node with a mind is reachable; capture goes on, sync waits')
      return { degraded: this.#state().degraded, pushed: 0, held: 0 }
    }
    const theirs = this.o.peers().find((p) => p.node === src.node)
    const b = await makeBundle({ ports: this.o.ports, store: this.o.store, cfg: this.o.cfg, self: this.o.self, since: { vv: theirs?.vv ?? {}, bvv: theirs?.bvv ?? {} }, to: src.node, now: this.#now() })
    const s = this.#state()
    const round = `${this.o.self}-${this.#now().toString(36)}`
    if (b.lines.length) await this.#sendParts(src.node, b.lines, (part, parts) => ({ t: 'mind.sync.push', round, part, parts, ...(s.commits[0] ? { commit: s.commits[0].id } : {}), ...(s.base ? { base: s.base } : {}) }))
    const req: Msg = { t: 'mind.sync.request', have: { vv: this.o.ports.versionVector(), bvv: this.o.ports.blockVector() }, commits: s.commits.map((c) => c.id) }
    await this.o.comms.send(this.member, address(src.node), JSON.stringify(req), { homeOnly: true })
    saveState(this.o.dataDir, { ...this.#state(), degraded: src.degraded })
    // A node that only writes is never sent a bundle back, and those were the only times it gossiped.
    this.o.publish()
    return { with: src.node, degraded: src.degraded, pushed: b.lines.length, held: b.held.length }
  }

  /** Take in what has arrived: requests to answer, bundles and pushes to apply, acks to note. */
  /**
   * One round, then take what comes back until nothing new has arrived for quietMs, or capMs has
   * passed: a node with no long-running host (the hub) syncs this way from its session hooks. Whatever
   * arrives after it returns waits in the mailbox for the next run; parts apply idempotently.
   */
  async syncOnce(o: { quietMs?: number; capMs?: number; sourceWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Awaited<ReturnType<MindService['round']>> & { took: number }> {
    const quietMs = o.quietMs ?? 10_000
    const capMs = o.capMs ?? 180_000
    const sourceWaitMs = o.sourceWaitMs ?? 60_000
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    // The session hook that starts this also starts the mesh daemon: give its links a moment.
    const asked = Date.now()
    let r = await this.round()
    while (!r.with && !r.refused && this.o.cfg.enabled && !this.#isCentral && Date.now() - asked < sourceWaitMs) {
      await sleep(SOURCE_RETRY_MS)
      r = await this.round()
    }
    let took = 0
    if (!r.with) return { ...r, took }
    const start = Date.now()
    let moved = start
    while (Date.now() - start < capMs) {
      await sleep(Math.min(DRAIN_POLL_MS, quietMs))
      const n = await this.drain()
      took += n
      if (n) moved = Date.now()
      else if (Date.now() - moved >= quietMs) break
    }
    return { ...r, took }
  }

  async drain(): Promise<number> {
    const items = await this.o.comms.inbox(this.member)
    for (const it of items) {
      try {
        await this.#handle(it)
      } catch (err) {
        this.o.log(`private mind: message ${it.id} from ${it.from} not handled: ${(err as Error).message}`)
      }
    }
    if (items.length) this.o.comms.markSeen(this.member, items.map((i) => i.id))
    return items.length
  }

  async #handle(it: InboxItem): Promise<void> {
    let m: Msg
    try {
      m = JSON.parse(it.body) as Msg
    } catch {
      return
    }
    const from = it.node
    if (!from || from === this.o.self) return
    const lines = () => {
      const f = it.files?.[0]?.path
      return f && fs.existsSync(f) ? fromNdjson(fs.readFileSync(f, 'utf-8')).lines : []
    }
    if (m.t === 'mind.sync.request') {
      const b = await makeBundle({ ports: this.o.ports, store: this.o.store, cfg: this.o.cfg, self: this.o.self, since: m.have, to: from, now: this.#now() })
      const s = this.#isCentral ? this.#commit() : this.#state()
      await this.#sendParts(from, b.lines, (part, parts) => ({ t: 'mind.sync.bundle', reply: it.id, part, parts, central: this.#isCentral, ...(s.commits[0] ? { commit: s.commits[0].id } : {}), ...(s.base ? { base: s.base } : {}) }))
    } else if (m.t === 'mind.sync.bundle') {
      takeBundle({ ports: this.o.ports, store: this.o.store, lines: lines() })
      const s = this.#state()
      const base = m.central ? m.commit : s.base
      const next = record({ ...s, ...(base ? { base } : {}), ...(m.central && m.commit ? { central: [m.commit, ...s.central.filter((c) => c !== m.commit)].slice(0, 5) } : {}) }, this.#vectors(), false)
      saveState(this.o.dataDir, { ...next, lastSyncAt: this.#now(), degraded: m.central ? false : s.degraded })
      this.o.publish()
      if (m.central && s.degraded) this.o.log('private mind: central is back; reconciled with it, no longer degraded')
    } else if (m.t === 'mind.sync.push') {
      takeBundle({ ports: this.o.ports, store: this.o.store, lines: lines() })
      const s = this.#isCentral ? this.#commit() : this.#state()
      this.o.publish()
      await this.o.comms.send(this.member, address(from), JSON.stringify({ t: 'mind.sync.ack', round: m.round, part: m.part, ...(s.commits[0] ? { commit: s.commits[0].id } : {}) } satisfies Msg), { homeOnly: true })
    } else if (m.t === 'mind.sync.ack') {
      this.o.log(`private mind: ${from} took part ${m.part} of round ${m.round}${m.commit ? ` (at ${short(m.commit)})` : ''}`)
    }
  }

  /**
   * Set when this node must not sync: another node holds more of this id's own records than this
   * journal has. That is a rebuilt or restored box running under an old id, whose new records
   * would reuse seqs the others already hold under different content.
   */
  refused: string | undefined

  #idReused(): string | undefined {
    const own = this.o.ports.versionVector()[this.o.self] ?? 0
    const ahead = this.o.peers().find((p) => p.node !== this.o.self && (p.vv[this.o.self] ?? 0) > own)
    if (!ahead) return undefined
    return `refused: ${ahead.node} holds records of ${this.o.self} up to ${ahead.vv[this.o.self]}, this journal only to ${own}. A rebuilt or restored node takes a new machine id (remove node-id and machine-id from the state dir, then restart) and gets everything back from central under it.`
  }

  #vectors() {
    return { vv: this.o.ports.versionVector(), bvv: this.o.ports.blockVector(), at: this.#now(), node: this.o.self }
  }

  /** Central: a commit for the state it now holds, when its vectors moved. */
  #commit(): MindState {
    const s = this.#state()
    const v = this.#vectors()
    const head = s.commits[0]
    if (head && JSON.stringify(head.vv) === JSON.stringify(v.vv) && JSON.stringify(head.bvv) === JSON.stringify(v.bvv)) return s
    const next = { ...record(s, v, true), lastSyncAt: this.#now() }
    saveState(this.o.dataDir, next)
    return next
  }

  /** This node's gossip record. */
  gossip(): ReturnType<typeof gossip> {
    const roles = [...(this.#isCentral ? ['central'] : []), ...(this.o.cfg.archival === this.o.self ? ['archival'] : [])]
    return gossip(this.#state(), { node: this.o.self, vv: this.o.ports.versionVector(), bvv: this.o.ports.blockVector(), roles, at: this.#now() })
  }
}
