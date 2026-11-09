/**
 * The mesh daemon: holds one open link per known node and streams the record
 * log across them. No polling between machines.
 *
 *   GET  /health     { node, startedAt }
 *   GET  /origins    [{ origin, maxSeq }]   (diagnostics)
 *   WS   /mesh       a link (see link.ts)
 *
 * Whichever side can reach the other dials, and the open socket carries both
 * directions, so a node behind NAT (the hub under WSL, a travelling laptop) takes
 * part with outbound connections only. If both sides dial, the link dialed by
 * the lower node id is kept and the other closed, so each pair has one link.
 *
 * Records relay transitively: what arrives on one link is offered to every
 * other link, minus what that side already holds, so nothing echoes. Sessions
 * on this machine append to the same SQLite log directly; the daemon notices
 * through SQLite's data_version and streams the new records out.
 *
 * Each node floods an announcement of itself (addresses, intent, direct
 * links, roles with members' capabilities and focus) as an `announce` record,
 * latest-only per node. That is the gossip: every node learns every other
 * node through whatever links exist, and dials the ones it can reach. When D
 * cannot reach A but A can reach D, A learns D's addresses from D's
 * announcement (relayed by B) and dials it.
 *
 * Link state goes to status.json, which the status line and `cortex-mesh
 * status` read, so neither needs to call the daemon.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

import { Link, type Hello } from './link.js'
import { MeshLog } from './log.js'
import { isPrivateAddress } from './net.js'
import { isValidated, NodeTable, type AnnouncedRole, type Announcement, type Intent, type Source } from './nodes.js'
import { readPeers } from './peers.js'
import { Router, type Accept, type DeliverFiles, type OutboxRow, type RouteFrame } from './router.js'
import { announceable, computeRoutes, isDrop, type Route } from './routing.js'
import { isExpired, limitFor, OFFLINE_ADDRESS, readOfflinePolicy, type OfflineNotice, type OfflinePolicy } from './offline.js'

export const DEFAULT_PORT = 3021
export const LIVE_MS = 10_000
const HEARTBEAT_MS = 10_000
const DEAD_MS = 30_000
const WATCH_MS = 200
const STATUS_MS = 2_000
const DIAL_MIN_MS = 1_000
const DIAL_MAX_MS = 60_000
// A node we only heard about may never be reachable from here (it sits behind
// NAT, or in a VLAN we cannot enter), so it is retried far less eagerly.
const DIAL_MAX_GOSSIP_MS = 5 * 60_000
export const ANNOUNCE_ADDRESS = 'mesh:announce'

export type LinkStatus = {
  node?: string
  url?: string
  direction: 'out' | 'in'
  live: boolean
  ready: boolean
  intent?: Intent
  roles?: string[]
  source?: Source
  since: number
}
export type Status = {
  node: string
  pid: number
  port: number
  startedAt: number
  updatedAt: number
  running: boolean
  intent: Intent
  alias: string
  roles: string[]
  links: LinkStatus[]
  /** Configured peers with no live link, and why the last dial failed: a dead end is never silent. */
  dials: { url: string; lastError?: string; nextAttemptAt?: number }[]
  nodes: {
    node: string
    alias?: string
    source: Source
    intent: Intent
    roles: string[]
    validated: boolean
    linked: boolean
    links: string[]
    /** Unreachable nodes have no route; their roles are unavailable. */
    route?: { nextHop: string; hops: number; path: string[] }
    /** Hops on a path that passes no gateway; absent when there is none (home-only traffic cannot reach it). */
    homeHops?: number
    /** Unreachable since then (its last route from here, or when first heard of). */
    offlineSince?: number
    /** Offline past its limit: nothing is held or accepted for it until it is back. */
    expired?: boolean
  }[]
}

export const statusFile = (dir: string) => path.join(dir, 'status.json')
export const pidFile = (dir: string) => path.join(dir, 'daemon.pid')

const writeStatus = (dir: string, s: Status) => {
  const tmp = `${statusFile(dir)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s))
  fs.renameSync(tmp, statusFile(dir))
}

/** This machine's reachable addresses: every private IPv4 it has, at the mesh port. */
export const ownAddresses = (port: number): string[] =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address))
    .map((i) => `http://${i.address}:${port}`)

export const wsUrl = (url: string) => `${url.replace(/^http/, 'ws')}/mesh`

export type ServeOpts = {
  host?: string
  /** false: open no port; this node only dials out (its peers), and advertises no address. Default true. */
  listen?: boolean
  /** The roles this node has, with members; a node with none (and no relay intent) stays unvalidated. */
  roles?: () => AnnouncedRole[]
  /**
   * Roles are re-read whenever a session appends, and also this often: a
   * member's liveness lapses with time alone, with nothing appended to notice.
   */
  rolesRecheckMs?: number
  intent?: Intent
  /** Advertised addresses; defaults to this machine's private IPv4s. */
  addresses?: string[]
  /** A short human name for this node; defaults to the hostname. */
  alias?: string
  /** Routed delivery: may a message be stored in this mailbox here? Default: refuse all. */
  accept?: Accept
  /** Routed delivery: tell the sender of a message that could not be delivered. */
  notifySender?: (row: OutboxRow, envelope: string, reason: string) => void
  /** The offline lifetime; read from CKN_MESH_OFFLINE_DAYS and offline.json when absent. */
  offline?: OfflinePolicy
  /** File transfer: the secret gate for a received file, and the message that announces delivered files. Absent: files refused. */
  files?: { scan: (file: string, address: string) => string | undefined; deliver: DeliverFiles }
}

export const defaultAlias = () => os.hostname().split('.')[0]!.toLowerCase()

export const serve = async (
  dir: string,
  node: string,
  port: number,
  opts: ServeOpts = {},
): Promise<{ close: () => Promise<void>; links: () => Link[]; routes: () => Map<string, Route>; router: Router }> => {
  const host = opts.host ?? '0.0.0.0'
  const log = new MeshLog(dir, node)
  log.rejoin()
  const nodes = new NodeTable(log.db)
  const startedAt = Date.now()
  const intent = opts.intent ?? 'node'
  const alias = opts.alias ?? defaultAlias()
  const rolesOf = opts.roles ?? (() => [])
  let announcedRoles = rolesOf()
  // Bound to loopback (a service node), nothing elsewhere can dial it: it dials out, and advertises nothing.
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  const listening = opts.listen !== false
  let me: Hello = { node, addresses: opts.addresses ?? (loopback || !listening ? [] : ownAddresses(port)), intent, roles: announcedRoles.map((r) => r.role) }
  const ownAddr = new Set(me.addresses)
  const links = new Set<Link>()
  let stopped = false

  const flushAll = (except?: Link) => {
    for (const l of links) if (l !== except) l.flush()
  }

  // ── announcements ────────────────────────────────────────────────────────
  const drops = new Map<string, number[]>() // node -> when its links dropped, for flap damping
  const readyNodes = () => [...new Set([...links].filter((l) => l.live && l.ready && l.node).map((l) => l.node!))].sort()
  let lastAnnounced = ''
  const announce = () => {
    if (log.hasLeft()) return
    const now = Date.now()
    const a: Announcement = {
      v: 1,
      node,
      alias,
      addresses: me.addresses,
      intent,
      links: readyNodes().filter((n) => {
        const l = [...links].find((x) => x.live && x.ready && x.node === n)!
        return announceable(drops.get(n) ?? [], l.openedAt, now)
      }),
      roles: announcedRoles,
    }
    const body = JSON.stringify(a)
    if (body === lastAnnounced) return
    lastAnnounced = body
    log.append('announce', ANNOUNCE_ADDRESS, body, node)
    flushAll()
  }
  const takeAnnouncements = () => {
    for (const r of log.read(ANNOUNCE_ADDRESS)) {
      if (r.origin === node) continue
      try {
        const a = JSON.parse(r.payload) as Announcement
        if (a.node === r.origin) nodes.announced(a)
      } catch {
        /* a malformed announcement teaches nothing */
      }
    }
  }
  // A forgotten node leaves the table unless it is linked now or announced itself since: then it came back.
  const dropForgotten = () => {
    for (const f of log.forgotten()) {
      const row = nodes.get(f.node)
      if (!row || log.announcedSince(f.node, f.before) || [...links].some((l) => l.live && l.node === f.node)) continue
      nodes.remove(f.node)
      router.expire(f.node, `node ${row.alias ?? f.node} was forgotten: it is gone from the mesh`)
    }
  }

  const events = {
    self: () => me,
    onHello: (link: Link) => {
      const peer = link.peer!
      if (peer.node === node) return link.close(4001, 'self')
      // Configured only when our human gave this address; a link we dialed from
      // gossip is gossiped, and one that called in is accepted.
      const configured = link.direction === 'out' && !!link.url && readPeers(dir).includes(link.url)
      nodes.seen(peer, configured ? 'configured' : link.direction === 'out' ? 'gossiped' : 'accepted', configured ? link.url : undefined)
      // One link per pair: keep the one dialed by the lower node id.
      for (const other of links) {
        if (other === link || other.node !== peer.node || !other.live) continue
        const dialer = (l: Link) => (l.direction === 'out' ? node : peer.node)
        const keepNew = dialer(link) === [node, peer.node].sort()[0]
        ;(keepNew ? other : link).close(4000, 'duplicate')
        if (!keepNew) return
      }
    },
    onRecords: (link: Link, adopted: number) => {
      if (adopted) {
        flushAll(link)
        takeAnnouncements()
        dropForgotten()
      }
      if (link.node) nodes.touch(link.node)
    },
    onRoute: (_link: Link, frame: RouteFrame) => {
      router.receive(frame)
    },
    onClose: (link: Link) => {
      links.delete(link)
      // A drop is losing the node, not losing one of two links to it: the
      // duplicate the tie-break closes leaves the other one live. A closed link
      // is never `ready`, so ask whether it carried a validated peer.
      const peer = link.peer
      const stillLinked = [...links].some((l) => l.live && l.node === peer?.node)
      if (peer && !stillLinked && !stopped) dropForgotten()
      if (peer && !stopped) router.linkLost()
      if (peer && isDrop(isValidated(peer.intent, peer.roles), stillLinked) && !stopped) {
        drops.set(peer.node, [...(drops.get(peer.node) ?? []), Date.now()].slice(-10))
      }
    },
  }

  const attach = (ws: WebSocket, direction: 'out' | 'in', url?: string) => {
    // A dial that completes after shutdown, or a call that lands during it, gets no link.
    if (stopped) {
      ws.close(1001, 'shutdown')
      return undefined
    }
    const link = new Link(ws, direction, log, events, url)
    links.add(link)
    return link
  }

  const server = http.createServer((req, res) => {
    if (!isPrivateAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/health') return send({ node, startedAt })
    if (url.pathname === '/origins') return send(log.origins())
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    if (!isPrivateAddress(req.socket.remoteAddress) || new URL(req.url ?? '/', 'http://x').pathname !== '/mesh') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, 'in'))
  })
  if (listening)
    await new Promise<void>((ok, fail) => {
      server.once('error', fail)
      server.listen(port, host, ok)
    })

  // Dial every configured address, and every known address of every other
  // validated node, that has no live link. Unreachable ones (behind NAT, or in
  // a VLAN we cannot enter) fail and back off; the other side dials us instead.
  const backoff = new Map<string, { next: number; wait: number }>()
  const dialErrors = new Map<string, string>()
  const dialing = new Set<string>()
  const configuredUrls = new Set<string>()
  const dialTargets = (): string[] => {
    const linked = new Set([...links].filter((l) => l.live && l.node).map((l) => l.node!))
    const out: string[] = []
    configuredUrls.clear()
    for (const url of readPeers(dir)) {
      configuredUrls.add(url)
      const known = nodes.byConfigured(url)
      if (known && linked.has(known.node)) continue
      out.push(url)
    }
    for (const n of nodes.list()) {
      if (n.node === node || linked.has(n.node) || !n.validated) continue
      out.push(...n.addresses)
    }
    return [...new Set(out)].filter((a) => !ownAddr.has(a))
  }
  const dial = (url: string) => {
    const b = backoff.get(url)
    if (dialing.has(url) || (b && Date.now() < b.next)) return
    dialing.add(url)
    const ws = new WebSocket(wsUrl(url), { handshakeTimeout: 5_000 })
    const fail = (err?: unknown) => {
      if (!dialing.delete(url)) return
      dialErrors.set(url, err instanceof Error ? err.message : err ? String(err) : 'connection failed')
      const wait = Math.min((b?.wait ?? DIAL_MIN_MS / 2) * 2, configuredUrls.has(url) ? DIAL_MAX_MS : DIAL_MAX_GOSSIP_MS)
      backoff.set(url, { next: Date.now() + wait, wait })
      ws.terminate()
    }
    ws.once('open', () => {
      dialing.delete(url)
      backoff.delete(url)
      dialErrors.delete(url)
      attach(ws, 'out', url)
    })
    ws.once('error', fail)
    ws.once('unexpected-response', (_req, res) => fail(`unexpected HTTP ${res.statusCode}`))
  }

  let dataVersion = log.db.pragma('data_version', { simple: true }) as number
  const recheckMs = opts.rolesRecheckMs ?? 30_000
  let rolesAt = Date.now()
  const tick = setInterval(() => {
    if (stopped) return
    // Another process (a session) appended: stream it out, and re-announce if our roles changed.
    const v = log.db.pragma('data_version', { simple: true }) as number
    const appended = v !== dataVersion
    if (appended || Date.now() - rolesAt >= recheckMs) {
      dataVersion = v
      rolesAt = Date.now()
      const roles = rolesOf()
      if (JSON.stringify(roles) !== JSON.stringify(announcedRoles)) {
        announcedRoles = roles
        const names = roles.map((r) => r.role)
        if (JSON.stringify(names) !== JSON.stringify(me.roles)) {
          me = { ...me, roles: names }
          for (const l of links) l.sendHello()
        }
      }
      if (appended) {
        flushAll()
        takeAnnouncements()
        dropForgotten()
      }
    }
    if (isValidated(intent, me.roles)) announce()
    pumpRoutes()
    for (const url of dialTargets()) dial(url)
  }, WATCH_MS)

  const heartbeat = setInterval(() => {
    for (const l of links) {
      if (Date.now() - l.lastPongAt > DEAD_MS) {
        l.ws.terminate()
        continue
      }
      try {
        l.ws.ping()
      } catch {
        /* closing */
      }
    }
  }, HEARTBEAT_MS)

  const routes = () => {
    const announced = new Map(nodes.list().map((n) => [n.node, n.links]))
    return computeRoutes(node, readyNodes(), announced)
  }
  // Home-only traffic never passes through a gateway, and a gateway forwards none of it.
  const homeRoutes = () => {
    if (intent === 'gateway') return new Map<string, Route>()
    const all = nodes.list()
    const gateways = new Set(all.filter((n) => n.intent === 'gateway').map((n) => n.node))
    return computeRoutes(node, readyNodes(), new Map(all.map((n) => [n.node, n.links])), gateways)
  }

  const router = new Router(
    log,
    node,
    (to, frame) => [...links].find((l) => l.live && l.ready && l.node === to)?.sendRoute(frame) ?? false,
    (to, home) => (home ? homeRoutes() : routes()).get(to)?.nextHop,
    opts.accept ?? (() => ({ ok: false, reason: 'this node takes no routed messages' })),
    opts.notifySender ?? (() => {}),
    opts.files && {
      root: path.join(dir, 'files'),
      scan: opts.files.scan,
      deliver: opts.files.deliver,
      keepReadMs: () => (opts.offline ?? readOfflinePolicy(dir)).defaultMs,
    },
  )
  dropForgotten()
  let reachable = new Set<string>()
  const expired = new Set<string>()
  const ownNotices = () => {
    const out = new Map<string, OfflineNotice>()
    for (const r of log.read(OFFLINE_ADDRESS)) {
      if (r.origin !== node) continue
      try {
        out.set(r.key, JSON.parse(r.payload) as OfflineNotice)
      } catch {
        /* ignore */
      }
    }
    return out
  }
  const pumpRoutes = () => {
    const now = Date.now()
    const current = new Set(routes().keys())
    for (const n of current) if (!reachable.has(n)) router.routeUp(n)
    reachable = current
    nodes.reachable(current, now)

    // The offline lifetime: past its limit, a node's held messages go and every node is told.
    const policy = opts.offline ?? readOfflinePolicy(dir)
    const notices = ownNotices()
    for (const n of nodes.list()) {
      if (n.node === node || n.intent !== 'node') continue
      const since = n.lastReachable || n.firstSeen
      const isOut = isExpired(n.lastReachable, n.firstSeen, limitFor(policy, n.node, n.alias), current.has(n.node), now)
      const flagged = notices.get(n.node)?.since != null
      if (isOut) {
        expired.add(n.node)
        const days = Math.round((now - since) / 86_400_000)
        router.expire(n.node, `node ${n.alias ?? n.node} has been offline since ${new Date(since).toISOString()} (${days} day${days === 1 ? '' : 's'}), past its limit`)
        if (!flagged) log.append('offline', OFFLINE_ADDRESS, JSON.stringify({ node: n.node, since } satisfies OfflineNotice), n.node)
      } else {
        expired.delete(n.node)
        if (flagged && current.has(n.node)) log.append('offline', OFFLINE_ADDRESS, JSON.stringify({ node: n.node, since: null } satisfies OfflineNotice), n.node)
      }
    }
    router.pump(now)
  }

  const status = (): Status => ({
    node,
    pid: process.pid,
    port,
    startedAt,
    updatedAt: Date.now(),
    running: true,
    intent,
    alias,
    roles: me.roles,
    links: [...links].map((l) => ({
      node: l.node,
      url: l.url,
      direction: l.direction,
      live: l.live,
      ready: l.ready,
      intent: l.peer?.intent,
      roles: l.peer?.roles,
      source: l.node ? nodes.get(l.node)?.source : undefined,
      since: l.openedAt,
    })),
    dials: readPeers(dir)
      .filter((url) => !(() => {
        const known = nodes.byConfigured(url)
        return known && [...links].some((l) => l.live && l.node === known.node)
      })())
      .map((url) => ({
        url,
        ...(dialErrors.has(url) ? { lastError: dialErrors.get(url) } : {}),
        ...(backoff.has(url) ? { nextAttemptAt: backoff.get(url)!.next } : {}),
      })),
    nodes: (() => {
      const linked = new Set(readyNodes())
      const r = routes()
      const home = homeRoutes()
      return nodes.list().map((n) => {
        const route = r.get(n.node)
        return {
          node: n.node,
          ...(n.alias ? { alias: n.alias } : {}),
          source: n.source,
          intent: n.intent,
          roles: n.roles,
          validated: n.validated,
          linked: linked.has(n.node),
          links: n.links,
          ...(route ? { route: { nextHop: route.nextHop, hops: route.hops, path: route.path } } : { offlineSince: n.lastReachable || n.firstSeen }),
          ...(home.has(n.node) ? { homeHops: home.get(n.node)!.hops } : {}),
          ...(expired.has(n.node) ? { expired: true } : {}),
        }
      })
    })(),
  })
  fs.writeFileSync(pidFile(dir), String(process.pid))
  writeStatus(dir, status())
  const statusTimer = setInterval(() => writeStatus(dir, status()), STATUS_MS)

  return {
    links: () => [...links],
    routes,
    router,
    close: async () => {
      stopped = true
      clearInterval(tick)
      clearInterval(heartbeat)
      clearInterval(statusTimer)
      for (const l of links) l.close(1001, 'shutdown')
      wss.close()
      if (listening) await new Promise<void>((r) => server.close(() => r()))
      writeStatus(dir, { ...status(), running: false, links: [] })
      fs.rmSync(pidFile(dir), { force: true })
      log.close()
    },
  }
}
