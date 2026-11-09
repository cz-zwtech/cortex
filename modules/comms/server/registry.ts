import { byPostedOrder } from './envelope.js'
import type { Metadata, Posted, Registry, RoleState } from './types.js'

/**
 * Fold registry events into roles and members.
 *
 * Pure, and order-independent given the same SET of events, because it sorts by
 * the agreed posted order first. That is what lets every node build a
 * byte-identical registry without coordinating: they replay the same log in the
 * same order.
 */
export const foldRegistry = (posted: Posted[]): Registry => {
  const roles = new Map<string, RoleState>()
  const members: Registry['members'] = new Map()

  const events = posted.filter((p) => p.type === 'event' && p.event).sort(byPostedOrder)

  for (const p of events) {
    const ev = p.event!
    switch (ev.op) {
      case 'create': {
        const r = roles.get(ev.role)
        if (!r) roles.set(ev.role, { name: ev.role, epoch: 1, deleted: false, members: new Set() })
        else if (r.deleted) {
          // Re-create after delete starts a new epoch, so messages sent into the
          // old mailbox can never surface in the new one.
          r.epoch += 1
          r.deleted = false
          r.members = new Set()
        }
        // Creating a live role is idempotent: two machines creating the same
        // role are creating the same mailbox, by design.
        break
      }
      case 'delete': {
        const r = roles.get(ev.role)
        if (r && !r.deleted) {
          r.deleted = true
          for (const m of r.members) members.get(m)?.roles.delete(ev.role)
          r.members = new Set()
        }
        break
      }
      case 'join': {
        const r = roles.get(ev.role)
        if (!r || r.deleted) break // joining needs a live role; the CLI enforces --create
        const existing = members.get(ev.member)
        if (existing && existing.instance !== ev.instance) {
          // Two sessions minted the same name. The earlier join keeps it; the
          // later one is ignored here and re-mints on its side (identity.ts).
          break
        }
        const m = existing ?? {
          name: ev.member,
          instance: ev.instance,
          meta: {},
          roles: new Set<string>(),
          joinedAt: p.stamp,
        }
        m.meta = { ...m.meta, ...ev.meta }
        m.roles.add(ev.role)
        members.set(ev.member, m)
        r.members.add(ev.member)
        break
      }
      case 'leave': {
        roles.get(ev.role)?.members.delete(ev.member)
        members.get(ev.member)?.roles.delete(ev.role)
        break
      }
      case 'set': {
        const m = members.get(ev.member)
        if (m) m.meta = { ...m.meta, ...ev.meta }
        break
      }
    }
  }
  return { roles, members }
}

/** A role that exists and has not been deleted. */
export const liveRole = (reg: Registry, role: string): RoleState | undefined => {
  const r = reg.roles.get(role)
  return r && !r.deleted ? r : undefined
}

/** Member names that hold `instance`, used to detect a name collision. */
export const ownerInstance = (reg: Registry, member: string): string | undefined =>
  reg.members.get(member)?.instance

/**
 * The next free name in a role: `acme-dev1`, `acme-dev2`, ...
 *
 * Free means unused by ANY member in the registry, not just this role's, because
 * member names are unique fleet-wide.
 */
export const nextMemberName = (reg: Registry, role: string, taken: Iterable<string> = []): string => {
  const used = new Set([...reg.members.keys(), ...taken])
  for (let n = 1; ; n++) {
    const name = `${role}-${n}` // A dash, so role laptop-test2 mints laptop-test2-1, not laptop-test21
    if (!used.has(name)) return name
  }
}

/** Latest beat stamp per member, from beat envelopes. */
export const lastBeats = (posted: Posted[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const p of posted) {
    if (p.type !== 'beat') continue
    const member = p.from.includes('/') ? p.from.split('/')[1]! : p.from
    if ((out.get(member) ?? 0) < p.stamp) out.set(member, p.stamp)
  }
  return out
}

/**
 * Live members of a role. LIVE_MS is a window over the posted beat stamp
 * compared with the READER's clock, so it is the one place skew matters; the
 * window is generous for that reason and only affects delivery reporting and
 * whether a claim may skip the settle wait.
 */
export const liveMembers = (
  reg: Registry,
  role: string,
  beats: Map<string, number>,
  now: number,
  liveMs: number,
): string[] => {
  const r = liveRole(reg, role)
  if (!r) return []
  return [...r.members].filter((m) => now - (beats.get(m) ?? 0) <= liveMs).sort()
}

export const metaOf = (reg: Registry, member: string): Metadata => reg.members.get(member)?.meta ?? {}
