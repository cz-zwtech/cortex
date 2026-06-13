// server/bus/nodeRoster.ts
//
// Pure derivation of the LIVING mesh roster: one entry per physical node
// (canonical id), with a fluid liveness ladder. "If a node isn't talking on the
// mesh, it doesn't exist here" — past the retire TTL it is dropped from `living`.
// No DB/mesh imports: the route feeds it snapshots so it stays unit-testable.

export type NodeStatus = 'live' | 'idle' | 'dormant'

const LIVE_MS = 5 * 60 * 1000
const IDLE_MS = 60 * 60 * 1000

/** Retirement TTL (ms). Default 24h; override with CKN_NODE_RETIRE_TTL_MS. */
export function RETIRE_MS(): number {
  const raw = Number(process.env.CKN_NODE_RETIRE_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000
}

/** Ladder from contact age. Returns null when past the retire TTL (→ excluded). */
function nodeStatus(ageMs: number): NodeStatus | null {
  if (ageMs < LIVE_MS) return 'live'
  if (ageMs < IDLE_MS) return 'idle'
  if (ageMs < RETIRE_MS()) return 'dormant'
  return null
}

export interface RosterSession {
  machine: string
  lastSeen: number
}
export interface RosterMeshPeer {
  nodeId: string
  lastActivityAt: number
}
export interface LivingNode {
  canonicalId: string
  status: NodeStatus
  lastContact: number
  isSelf: boolean
}
export interface NodeRoster {
  living: LivingNode[]
  retiredCount: number
}

export function buildNodeRoster(input: {
  self: string
  now: number
  aliasOf: (id: string) => string
  sessions: RosterSession[]
  meshPeers: RosterMeshPeer[]
}): NodeRoster {
  const { self, now, aliasOf } = input
  // canonical id → max(lastContact)
  const contact = new Map<string, number>()
  const bump = (rawId: string, ts: number) => {
    if (!rawId) return
    const id = aliasOf(rawId)
    contact.set(id, Math.max(contact.get(id) ?? 0, ts || 0))
  }
  for (const s of input.sessions) bump(s.machine, s.lastSeen)
  for (const p of input.meshPeers) bump(p.nodeId, p.lastActivityAt)

  const selfId = aliasOf(self)
  contact.set(selfId, Math.max(contact.get(selfId) ?? 0, now)) // self is always live: the server is up

  const living: LivingNode[] = []
  let retiredCount = 0
  for (const [canonicalId, lastContact] of contact) {
    const status = nodeStatus(now - lastContact)
    if (!status) {
      retiredCount++
      continue
    }
    living.push({ canonicalId, status, lastContact, isSelf: canonicalId === selfId })
  }
  return { living, retiredCount }
}
