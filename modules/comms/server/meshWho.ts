/**
 * Every role on the mesh, with where it lives and who in it is live:
 * `cortex-role who --mesh [--live] [--json]`.
 *
 * `who` alone lists this node's members. A service that routes to owners
 * anywhere (notify) needs the roles of every node it can reach, and for a
 * fan-out only those with someone around to read it. This node's roles come
 * from its own registry; other nodes' from their latest announcements, which
 * carry each member's liveness.
 */
import type { AnnouncedRole } from './mesh/nodes.js'
import type { MeshView } from './mesh/view.js'

export type MeshRole = {
  role: string
  node: string
  alias?: string
  /** How to send to it from here: alias:role, or node:role when the node has no alias. */
  address: string
  /** This node, or a node with a route now. */
  reachable: boolean
  members: { name: string; live: boolean }[]
}

export const meshRoles = (view: Pick<MeshView, 'self' | 'nodes'>, local: AnnouncedRole[], opts: { live?: boolean } = {}): MeshRole[] => {
  const rows: MeshRole[] = []
  const add = (node: string, alias: string | undefined, reachable: boolean, roles: AnnouncedRole[]) => {
    for (const r of roles) {
      rows.push({
        role: r.role,
        node,
        ...(alias ? { alias } : {}),
        address: `${alias ?? node}:${r.role}`,
        reachable,
        members: r.members.map((m) => ({ name: m.name, live: m.live === true })),
      })
    }
  }
  add(view.self.node, view.self.alias, true, local)
  for (const n of view.nodes) if (!n.expired) add(n.node, n.alias, n.reachable, n.roles)
  const out = opts.live ? rows.filter((r) => r.reachable && r.members.some((m) => m.live)) : rows
  return out.sort((a, b) => a.role.localeCompare(b.role) || a.address.localeCompare(b.address))
}

export const meshRoleLine = (r: MeshRole): string => {
  const live = r.members.filter((m) => m.live).length
  return `${r.address.padEnd(28)} ${r.reachable ? 'reachable  ' : 'unreachable'} ${live}/${r.members.length} live  ${r.members.map((m) => m.name).join(', ')}`
}
