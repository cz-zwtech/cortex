/**
 * The external side: one TLS link per peer gateway, on the forwarded port
 * (28417). Mutual TLS 1.3 with ed25519 keys; each side checks the other's key
 * against the pin in its config, so a peer is identified by its key and never
 * by anything it says. A WebSocket rides the TLS link and carries JSON frames
 * both ways, so whichever side can dial does.
 *
 * Built to live with IPS on (trust doc, IPS response): one long-lived link per
 * peer, dialled with backoff and jitter, nothing else on this port. The
 * gateway watches itself too: new connections are rate-limited per source,
 * and a source that keeps failing the handshake is banned for a while.
 */
import crypto from 'node:crypto'
import https from 'node:https'
import type net from 'node:net'
import tls from 'node:tls'
import WebSocket, { WebSocketServer } from 'ws'

import type { GatewayConfig } from './config.js'
import { pinOf, type DomainKey } from './keys.js'

export type Frame = { t: string } & Record<string, unknown>
export type ExternalEvents = {
  onLink: (domain: string) => void
  onFrame: (domain: string, frame: Frame) => void
  onDrop: (domain: string) => void
  /** Every refusal on this port: kept for the audit log. */
  onRefused: (source: string, why: string) => void
}

const PATH = '/gate'
const DIAL_MIN_MS = 1_000
const DIAL_MAX_MS = 5 * 60_000
const PING_MS = 30_000
const DEAD_MS = 90_000

/** The key a certificate holds, and its pin. */
const certKey = (raw: Buffer | undefined): { key: crypto.KeyObject; pin: string } | undefined => {
  try {
    if (!raw) return undefined
    const key = new crypto.X509Certificate(raw).publicKey
    return { key, pin: pinOf(key) }
  } catch {
    return undefined
  }
}

type Link = { ws: WebSocket; domain: string; direction: 'in' | 'out'; lastPong: number; key: crypto.KeyObject }

export class ExternalLinks {
  #links = new Map<string, Link>()
  #server?: https.Server
  #wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  #timers: NodeJS.Timeout[] = []
  #backoff = new Map<string, { next: number; wait: number }>()
  #dialing = new Set<string>()
  #newConns = new Map<string, number[]>()
  #failures = new Map<string, number[]>()
  #banned = new Map<string, number>()
  #stopped = false
  port = 0

  constructor(
    private cfg: () => GatewayConfig,
    private key: DomainKey,
    private ev: ExternalEvents,
  ) {}

  /** The peer a key belongs to, by pin. */
  #peerByPin(pin: string | undefined) {
    return pin ? this.cfg().peers.find((p) => p.pin === pin) : undefined
  }

  #fail(source: string | undefined, why: string): void {
    // A source we could not name is reported, never banned: one shared "unknown" would pool every such failure.
    this.ev.onRefused(source ?? 'unknown source', why)
    if (!source) return
    const l = this.cfg().limits
    const now = Date.now()
    const f = [...(this.#failures.get(source) ?? []), now].filter((t) => now - t < 10 * 60_000)
    this.#failures.set(source, f)
    if (f.length >= l.banAfterFailures) {
      this.#banned.set(source, now + l.banMinutes * 60_000)
      this.#failures.delete(source)
      this.ev.onRefused(source, `banned for ${l.banMinutes} min after ${f.length} failures`)
    }
  }

  #isBanned(source: string): boolean {
    const until = this.#banned.get(source)
    if (until && until > Date.now()) return true
    if (until) this.#banned.delete(source)
    return false
  }

  banned(): string[] {
    return [...this.#banned.entries()].filter(([, t]) => t > Date.now()).map(([s]) => s)
  }

  async listen(): Promise<void> {
    const { host, port } = this.cfg().listen
    const server = https.createServer({ key: this.key.key, cert: this.key.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, (_req, res) => {
      res.writeHead(404).end() // nothing but the link is served on this port
    })
    // A peer that resets mid-handshake leaves the TLS socket without an address; the raw socket had it at connect.
    const sources = new WeakMap<net.Socket, string>()
    const sourceOf = (tls: net.Socket) => sources.get((tls as unknown as { _parent?: net.Socket })._parent ?? tls) ?? tls.remoteAddress
    server.on('connection', (socket: net.Socket) => {
      const source = socket.remoteAddress ?? 'unknown'
      if (socket.remoteAddress) sources.set(socket, socket.remoteAddress)
      if (this.#isBanned(source)) return void socket.destroy()
      const now = Date.now()
      const recent = [...(this.#newConns.get(source) ?? []), now].filter((t) => now - t < 60_000)
      this.#newConns.set(source, recent)
      if (recent.length > this.cfg().limits.newPerMinute) {
        this.ev.onRefused(source, 'over the new-connection rate limit')
        socket.destroy()
      }
    })
    server.on('tlsClientError', (_err, socket) => this.#fail(sourceOf(socket), 'TLS handshake failed'))
    server.on('upgrade', (req, socket, head) => {
      const source = sourceOf(req.socket)
      const tls = req.socket as unknown as { getPeerX509Certificate?: () => crypto.X509Certificate | undefined }
      const held = certKey(tls.getPeerX509Certificate?.()?.raw)
      const peer = this.#peerByPin(held?.pin)
      if (!peer || !held) {
        this.#fail(source, held ? `key ${held.pin.slice(0, 12)}... is not a pinned peer` : 'no client certificate')
        return void socket.destroy()
      }
      if (new URL(req.url ?? '/', 'https://x').pathname !== PATH) return void socket.destroy()
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, peer.domain, 'in', held.key))
    })
    await new Promise<void>((ok, fail) => {
      server.once('error', fail)
      server.listen(port, host, () => ok())
    })
    this.port = (server.address() as net.AddressInfo).port
    this.#server = server
    this.#timers.push(setInterval(() => this.#dialAll(), 1_000))
    this.#timers.push(setInterval(() => this.#heartbeat(), PING_MS))
  }

  #attach(ws: WebSocket, domain: string, direction: 'in' | 'out', key: crypto.KeyObject): void {
    // One link per pair: when both sides dial, keep the one dialled by the lower domain.
    const existing = this.#links.get(domain)
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      const keepNew = (direction === 'out' ? this.cfg().domain : domain) < (existing.direction === 'out' ? this.cfg().domain : domain)
      if (!keepNew) return void ws.close(4000, 'duplicate')
      existing.ws.close(4000, 'duplicate')
    }
    const link: Link = { ws, domain, direction, lastPong: Date.now(), key }
    this.#links.set(domain, link)
    ws.on('pong', () => (link.lastPong = Date.now()))
    ws.on('message', (data) => {
      let f: Frame
      try {
        f = JSON.parse(String(data)) as Frame
      } catch {
        return
      }
      if (f && typeof f.t === 'string') this.ev.onFrame(domain, f)
    })
    const drop = () => {
      if (this.#links.get(domain) !== link) return
      this.#links.delete(domain)
      if (!this.#stopped) this.ev.onDrop(domain)
    }
    ws.on('close', drop)
    ws.on('error', drop)
    this.ev.onLink(domain)
  }

  #dialAll(): void {
    if (this.#stopped) return
    for (const peer of this.cfg().peers) {
      if (!peer.address || this.linked(peer.domain) || this.#dialing.has(peer.domain)) continue
      const b = this.#backoff.get(peer.domain)
      if (b && Date.now() < b.next) continue
      this.#dialing.add(peer.domain)
      // tls.connect skips checkServerIdentity for a certificate it did not authorise, which a self-signed one never
      // is, so the listener's key is checked against the pin as soon as TLS is up, before the HTTP upgrade is even
      // sent (21 Oct: a link test showed an imposter at the right address would otherwise be linked).
      let server: ReturnType<typeof certKey>
      const wrong = `${peer.address} does not hold ${peer.domain}'s pinned key`
      const ws = new WebSocket(`wss://${peer.address}${PATH}`, {
        key: this.key.key,
        cert: this.key.cert,
        minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
        // Self-signed, so Node's chain check is off; the key check is ours, on secureConnect.
        rejectUnauthorized: false,
        createConnection: (o: tls.ConnectionOptions) => {
          const sock = tls.connect(o)
          sock.once('secureConnect', () => {
            server = certKey(sock.getPeerX509Certificate()?.raw)
            if (server?.pin !== peer.pin) sock.destroy(new Error(wrong))
          })
          return sock
        },
      } as WebSocket.ClientOptions)
      const fail = (why: string) => {
        if (!this.#dialing.delete(peer.domain)) return
        const wait = Math.min((b?.wait ?? DIAL_MIN_MS / 2) * 2, DIAL_MAX_MS)
        this.#backoff.set(peer.domain, { next: Date.now() + wait + Math.random() * wait * 0.2, wait })
        this.ev.onRefused(peer.address!, `dial ${peer.domain}: ${why}`)
        ws.terminate()
      }
      ws.once('open', () => {
        if (!server || server.pin !== peer.pin) return fail(wrong)
        this.#dialing.delete(peer.domain)
        this.#backoff.delete(peer.domain)
        this.#attach(ws, peer.domain, 'out', server.key)
      })
      ws.once('error', (e) => fail(e.message))
      ws.once('unexpected-response', (_q, res) => fail(`HTTP ${res.statusCode}`))
    }
  }

  #heartbeat(): void {
    for (const l of this.#links.values()) {
      if (Date.now() - l.lastPong > DEAD_MS) {
        l.ws.terminate()
        continue
      }
      try {
        l.ws.ping()
      } catch {
        /* closing */
      }
    }
  }

  /** The public key a linked peer proved it holds: what its signed records are checked against. */
  peerKey(domain: string): crypto.KeyObject | undefined {
    const l = this.#links.get(domain)
    return l && l.ws.readyState === WebSocket.OPEN ? l.key : undefined
  }

  linked(domain: string): boolean {
    return this.#links.get(domain)?.ws.readyState === WebSocket.OPEN
  }

  /** Send a frame to a peer gateway; false when there is no open link. */
  send(domain: string, frame: Frame): boolean {
    const l = this.#links.get(domain)
    if (!l || l.ws.readyState !== WebSocket.OPEN) return false
    l.ws.send(JSON.stringify(frame))
    return true
  }

  async close(): Promise<void> {
    this.#stopped = true
    for (const t of this.#timers) clearInterval(t)
    for (const l of this.#links.values()) l.ws.close(1001, 'shutdown')
    this.#wss.close()
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()))
  }
}
