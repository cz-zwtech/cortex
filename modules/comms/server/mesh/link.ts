/**
 * One link: a single open WebSocket between two nodes, whichever side dialed.
 *
 * Frames are JSON text:
 *   hello    { node, addresses, intent, roles }  sent on open and whenever it changes
 *   have     { origins: [{ origin, maxSeq }] }    what this side holds, sent once the link is ready
 *   records  { records: MeshRecord[] }           records the other side lacks
 *   route    RouteFrame                           a routed message or ack (router.ts)
 *
 * A link is ready when both ends are validated (a role announced, or relay or
 * gateway intent declared). Until then nothing but hellos cross. Once ready,
 * each side streams whatever the other lacks, tracked per origin from the
 * other's `have` and from every record either side has sent; that is the
 * whole sync, so a reconnect after any outage is the same exchange.
 */
import type WebSocket from 'ws'

import { isRecord, sendableTo, type MeshLog, type MeshRecord } from './log.js'
import { isValidated, type Intent } from './nodes.js'
import { isRouteFrame, type RouteFrame } from './router.js'

export type Hello = { node: string; addresses: string[]; intent: Intent; roles: string[] }
type Frame =
  | ({ t: 'hello'; v: 1 } & Hello)
  | { t: 'have'; origins: { origin: string; maxSeq: number }[] }
  | { t: 'records'; records: MeshRecord[] }
  | RouteFrame

const BATCH = 500

const isHello = (f: Record<string, unknown>): boolean =>
  typeof f.node === 'string' && f.node.length > 0 &&
  Array.isArray(f.addresses) && f.addresses.every((a) => typeof a === 'string') &&
  (f.intent === 'node' || f.intent === 'relay' || f.intent === 'gateway') &&
  Array.isArray(f.roles) && f.roles.every((r) => typeof r === 'string')

export type LinkEvents = {
  self: () => Hello
  onHello: (link: Link) => void
  onRecords: (link: Link, adopted: number) => void
  onRoute: (link: Link, frame: RouteFrame) => void
  onClose: (link: Link) => void
}

export class Link {
  peer?: Hello
  lastPongAt = Date.now()
  openedAt = Date.now()
  #peerHas = new Map<string, number>()
  #haveSent = false
  #haveReceived = false
  #closed = false

  constructor(
    readonly ws: WebSocket,
    readonly direction: 'out' | 'in',
    private log: MeshLog,
    private ev: LinkEvents,
    readonly url?: string,
  ) {
    ws.on('message', (data) => this.#receive(String(data)))
    ws.on('pong', () => (this.lastPongAt = Date.now()))
    ws.on('close', () => this.#close())
    ws.on('error', () => this.#close())
    this.sendHello()
  }

  get node(): string | undefined {
    return this.peer?.node
  }

  get ready(): boolean {
    const me = this.ev.self()
    return !this.#closed && !!this.peer && isValidated(me.intent, me.roles) && isValidated(this.peer.intent, this.peer.roles)
  }

  get live(): boolean {
    return !this.#closed && this.ws.readyState === this.ws.OPEN
  }

  sendHello(): void {
    this.#send({ t: 'hello', v: 1, ...this.ev.self() })
    this.#maybeHave()
  }

  /** Send everything the other side lacks. Cheap when it lacks nothing. */
  flush(): void {
    if (!this.ready || !this.#haveReceived) return
    for (const { origin, maxSeq } of this.log.origins()) {
      let since = this.#peerHas.get(origin) ?? 0
      while (since < maxSeq) {
        const batch = this.log.since(origin, since, BATCH)
        if (!batch.length) break
        // A kind kept from this peer's intent is skipped, and the cursor still passes it.
        const allowed = batch.filter((r) => sendableTo(r.kind, this.peer?.intent))
        if (allowed.length) this.#send({ t: 'records', records: allowed })
        since = batch[batch.length - 1]!.seq
        this.#peerHas.set(origin, since)
      }
    }
  }

  /** Send a routed frame; false unless the link is ready. */
  sendRoute(frame: RouteFrame): boolean {
    if (!this.ready || !this.live) return false
    this.#send(frame)
    return true
  }

  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason)
    } catch {
      /* already gone */
    }
    this.#close()
  }

  #send(f: Frame): void {
    if (this.live) this.ws.send(JSON.stringify(f))
  }

  #maybeHave(): void {
    if (this.ready && !this.#haveSent) {
      this.#haveSent = true
      this.#send({ t: 'have', origins: this.log.origins() })
    }
  }

  #receive(text: string): void {
    // Frames already buffered when the link closed are dropped: at shutdown the log behind them is closed too.
    if (this.#closed) return
    let f: Record<string, unknown>
    try {
      f = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (f.t === 'hello') {
      if (!isHello(f)) return this.close(4002, 'bad hello')
      const { node, addresses, intent, roles } = f as unknown as Hello
      this.peer = { node, addresses, intent, roles }
      this.ev.onHello(this)
      if (this.#closed) return
      this.#maybeHave()
      this.flush()
      return
    }
    if (!this.ready) return // nothing but hellos crosses until both ends are validated
    if (f.t === 'have' && Array.isArray(f.origins)) {
      for (const o of f.origins as { origin: unknown; maxSeq: unknown }[]) {
        if (typeof o.origin === 'string' && Number.isInteger(o.maxSeq)) this.#peerHas.set(o.origin, o.maxSeq as number)
      }
      this.#haveReceived = true
      this.flush()
      return
    }
    if (f.t === 'route') {
      if (!isRouteFrame(f)) return this.close(4004, 'bad route frame')
      this.ev.onRoute(this, f)
      return
    }
    if (f.t === 'records' && Array.isArray(f.records)) {
      const records = f.records as unknown[]
      if (!records.every(isRecord)) return this.close(4003, 'bad records')
      for (const r of records) this.#peerHas.set(r.origin, Math.max(this.#peerHas.get(r.origin) ?? 0, r.seq))
      // Nor is such a kind kept here if a peer sends it anyway.
      const intent = this.ev.self().intent
      this.ev.onRecords(this, this.log.adopt(records.filter((r) => sendableTo(r.kind, intent))))
    }
  }

  #close(): void {
    if (this.#closed) return
    this.#closed = true
    this.ev.onClose(this)
  }
}
