import type { Metadata } from './types.js'

export const NAME_RE = /^[a-z][a-z0-9-]{0,47}$/

/** Node ids and aliases: hostnames and machine ids, so wider than role names. */
export const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type Address =
  | { kind: 'role'; role: string; selector?: Metadata; forced?: boolean; node?: string }
  | { kind: 'member'; role: string; member: string; node?: string }

/**
 * Parse an address. With no node it means "this node, or whichever node has
 * it" (see Comms.send); with one it means exactly that node's role:
 *
 *   role  role/member  role[k=v,k2=v2]  role:<name>   (the role, even when a member shares its name)
 *   node:role  node:role/member  node:role:member  node:role[k=v]
 *
 * `node` is a node id or alias. `role` is reserved as a node name.
 *
 * Throws with a message fit to show a person, because an address typo is the
 * single most common way a message used to vanish on the V1 bus.
 */
export const parseAddress = (raw: string): Address => {
  const s = raw.trim()
  const colon = s.split('[')[0]!.indexOf(':') // a selector value may hold a colon
  if (colon > 0 && s.slice(0, colon) !== 'role') {
    const node = s.slice(0, colon)
    if (!NODE_RE.test(node)) throw new Error(`bad node name "${node}" in ${raw}`)
    const rest = s.slice(colon + 1)
    const parts = rest.split(':')
    if (parts.length === 2) {
      assertName(parts[0]!, 'role')
      assertName(parts[1]!, 'member')
      return { kind: 'member', role: parts[0]!, member: parts[1]!, node }
    }
    if (parts.length > 2) throw new Error(`bad address "${raw}": use node:role, node:role/member or node:role:member`)
    return { ...parseLocal(rest, raw), node }
  }
  return parseLocal(s, raw)
}

const parseLocal = (s: string, raw: string): Address => {
  if (s.startsWith('role:')) {
    const role = s.slice(5)
    assertName(role, 'role')
    return { kind: 'role', role, forced: true }
  }
  const sel = s.match(/^([^[\]/]+)\[(.*)\]$/)
  if (sel) {
    const role = sel[1]!
    assertName(role, 'role')
    const selector: Metadata = {}
    for (const pair of sel[2]!.split(',').map((p) => p.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error(`bad selector "${pair}" in ${raw}: expected key=value`)
      selector[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
    if (!Object.keys(selector).length) throw new Error(`empty selector in ${raw}`)
    return { kind: 'role', role, selector }
  }
  const slash = s.split('/')
  if (slash.length === 2) {
    assertName(slash[0]!, 'role')
    assertName(slash[1]!, 'member')
    return { kind: 'member', role: slash[0]!, member: slash[1]! }
  }
  if (slash.length === 1) {
    assertName(s, 'role')
    return { kind: 'role', role: s }
  }
  throw new Error(`bad address "${raw}": use role, role/member, or role[key=value]`)
}

export const assertName = (name: string, what: 'role' | 'member'): void => {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `bad ${what} name "${name}": lowercase letters, digits and hyphens, starting with a letter`,
    )
  }
}

/** True when every selector key matches the member's declared metadata. */
export const matchesSelector = (meta: Metadata, selector: Metadata | undefined): boolean => {
  if (!selector) return true
  return Object.entries(selector).every(([k, v]) => {
    const have = meta[k]
    if (have === undefined) return false
    // Capabilities are a comma list; a selector cap=x matches any one of them.
    return have.split(',').map((x) => x.trim()).includes(v)
  })
}
