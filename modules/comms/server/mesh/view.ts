/**
 * What comms needs to know about the mesh, read from where the daemon keeps
 * it: who this node is, and every other node with its alias, announced roles
 * and members, and whether it can be reached right now. Sessions read this;
 * they never call the daemon.
 */
import { readStatus } from './control.js'
import { MeshLog } from './log.js'
import { NodeTable, type AnnouncedRole } from './nodes.js'
import { OFFLINE_ADDRESS, type OfflineNotice } from './offline.js'

export type MeshNode = {
  node: string
  alias?: string
  roles: AnnouncedRole[]
  reachable: boolean
  hops?: number
  /** Reachable on a path through home nodes only, never a gateway: what home-only sends need. */
  homeReachable?: boolean
  /** Offline past its limit (here, or as another node announced): nothing is accepted for it. */
  expired?: boolean
  offlineSince?: number
}
/** Work this node sent to another node's mailbox before: what it was about, and when. */
export type PriorWork = { node: string; address: string; subject: string; at: number }
/**
 * An external domain, as the gateway serving it says: the roles its peer
 * announced (what a session here may start a conversation with) and which of
 * them are unavailable now. Reached only through that gateway node.
 */
export type ExternalDomain = {
  domain: string
  gateway: string
  reachable: boolean
  linked: boolean
  roles: string[]
  unavailable: string[]
  /** Open return paths: external `from` may reply to internal `role` until it closes. */
  paths: ReturnPath[]
}
export type ReturnPath = { role: string; from: string }
export type MeshView = { self: { node: string; alias?: string }; nodes: MeshNode[]; history: PriorWork[]; external?: ExternalDomain[] }

/** Where a gateway publishes the external domains it serves (one `external` record per domain). */
export const EXTERNAL_ADDRESS = 'mesh:external'
export type ExternalNotice = { domain: string; linked: boolean; roles: string[]; unavailable: string[]; paths?: ReturnPath[] }

export const meshView = (dir: string, self: string): MeshView => {
  const status = readStatus(dir)
  const routed = new Map((status?.nodes ?? []).map((n) => [n.node, n.route]))
  const homeRouted = new Set((status?.nodes ?? []).filter((n) => n.homeHops !== undefined).map((n) => n.node))
  const expiredHere = new Map((status?.nodes ?? []).filter((n) => n.expired).map((n) => [n.node, n.offlineSince]))
  const log = new MeshLog(dir, self)
  try {
    // Another node's notice counts while we have no route either: it may know longer.
    const announcedOffline = new Map<string, number>()
    for (const r of log.read(OFFLINE_ADDRESS)) {
      try {
        const n = JSON.parse(r.payload) as OfflineNotice
        if (n.since != null) announcedOffline.set(n.node, n.since)
        else announcedOffline.delete(n.node)
      } catch {
        /* ignore */
      }
    }
    const nodes = new NodeTable(log.db)
      .list()
      .filter((n) => n.node !== self && n.intent === 'node')
      .map((n) => {
        const route = routed.get(n.node)
        const since = expiredHere.get(n.node) ?? (route ? undefined : announcedOffline.get(n.node))
        return {
          node: n.node,
          ...(n.alias ? { alias: n.alias } : {}),
          roles: n.members,
          reachable: !!route,
          ...(route ? { hops: route.hops } : {}),
          homeReachable: homeRouted.has(n.node),
          ...(since !== undefined ? { expired: true, offlineSince: since } : {}),
        }
      })
    let history: PriorWork[] = []
    try {
      history = (log.db.prepare("SELECT to_node, address, subject, created FROM outbox WHERE subject != '' ORDER BY created DESC LIMIT 500").all() as {
        to_node: string
        address: string
        subject: string
        created: number
      }[]).map((r) => ({ node: r.to_node, address: r.address, subject: r.subject, at: r.created }))
    } catch {
      /* no daemon has run here yet: no history */
    }
    // Only a node that announced itself a gateway speaks for an external domain.
    const gateways = new Set(new NodeTable(log.db).list().filter((n) => n.intent === 'gateway').map((n) => n.node))
    const external: ExternalDomain[] = []
    for (const r of log.read(EXTERNAL_ADDRESS)) {
      if (!gateways.has(r.origin)) continue
      try {
        const n = JSON.parse(r.payload) as ExternalNotice
        external.push({ domain: n.domain, gateway: r.origin, reachable: r.origin === self || !!routed.get(r.origin), linked: !!n.linked, roles: n.roles ?? [], unavailable: n.unavailable ?? [], paths: n.paths ?? [] })
      } catch {
        /* a malformed notice teaches nothing */
      }
    }
    return { self: { node: self, ...(status?.alias ? { alias: status.alias } : {}) }, nodes, history, external }
  } finally {
    log.close()
  }
}

/** A node named by id or alias. Throws, naming the candidates, when an alias is ambiguous. */
export const findNode = (view: MeshView, name: string): { node: string; self: boolean } | undefined => {
  if (name === view.self.node || name === view.self.alias) return { node: view.self.node, self: true }
  const byId = view.nodes.find((n) => n.node === name)
  if (byId) return { node: byId.node, self: false }
  const byAlias = view.nodes.filter((n) => n.alias === name)
  if (byAlias.length > 1) throw new Error(`"${name}" is the alias of ${byAlias.length} nodes (${byAlias.map((n) => n.node).join(', ')}); use the node id`)
  return byAlias[0] ? { node: byAlias[0].node, self: false } : undefined
}
