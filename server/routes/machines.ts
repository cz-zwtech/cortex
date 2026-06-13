import { Router } from 'express'
import * as os from 'node:os'
import { getMachineId, mindStatus } from '../privateMind.js'
import { entriesByMachine } from '../graph/sync.js'
import { symbolsByMachine } from '../graph/symbols.js'
import { getBroker } from '../bus/broker.js'
import { getMeshState } from '../bus/meshState.js'
import { canonicalId } from '../graph/nodeAliases.js'
import { buildNodeRoster, type NodeStatus } from '../bus/nodeRoster.js'

export const machinesRouter = Router()

export interface MachineRow {
  canonicalId: string
  hostname: string
  isSelf: boolean
  status: NodeStatus
  lastContact: number
  sessionCount: number
  memoryCount: number
  symbolCount: number
}

/** Pure assembly: living roster + alias-folded enrichment. Unit-tested. */
export function assembleMachines(input: {
  self: string
  now: number
  aliasOf: (id: string) => string
  peers: { machine: string; lastSeen: number; rawStatus: string }[]
  meshPeers: { nodeId: string; lastActivityAt: number }[]
  mem: Record<string, number>
  sym: Record<string, number>
  hostnameOf: (canonicalId: string) => string
}): { self: string; machines: MachineRow[]; retiredCount: number } {
  const { aliasOf } = input
  const selfCanon = aliasOf(input.self)

  const roster = buildNodeRoster({
    self: input.self,
    now: input.now,
    aliasOf,
    sessions: input.peers.map((p) => ({ machine: p.machine, lastSeen: p.lastSeen })),
    meshPeers: input.meshPeers,
  })

  // Fold raw lineage counts to canonical ids ONCE.
  const foldCounts = (raw: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [id, n] of Object.entries(raw)) {
      if (!id) continue
      const c = aliasOf(id)
      out[c] = (out[c] ?? 0) + (n ?? 0)
    }
    return out
  }
  const mem = foldCounts(input.mem)
  const sym = foldCounts(input.sym)

  // Live/idle session counts per canonical node (presence on that node).
  const sessionCount: Record<string, number> = {}
  for (const p of input.peers) {
    if (p.rawStatus === 'signed_off') continue
    const age = input.now - p.lastSeen
    if (age >= 60 * 60 * 1000) continue // count live + idle sessions only
    const c = aliasOf(p.machine || '')
    if (!c) continue
    sessionCount[c] = (sessionCount[c] ?? 0) + 1
  }

  const machines: MachineRow[] = roster.living.map((n) => ({
    canonicalId: n.canonicalId,
    hostname: n.canonicalId === selfCanon ? os.hostname() : input.hostnameOf(n.canonicalId),
    isSelf: n.isSelf,
    status: n.status,
    lastContact: n.lastContact,
    sessionCount: sessionCount[n.canonicalId] ?? 0,
    memoryCount: mem[n.canonicalId] ?? 0,
    symbolCount: sym[n.canonicalId] ?? 0,
  }))

  return { self: selfCanon, machines, retiredCount: roster.retiredCount }
}

// GET /api/machines — the LIVING mesh: one node per machine + its enrichment.
machinesRouter.get('/', async (_req, res) => {
  try {
    const now = Date.now()
    const [mem, sym, peers, status] = await Promise.all([
      entriesByMachine(),
      symbolsByMachine(),
      getBroker().peers(),
      mindStatus(),
    ])
    // Fleet roster from the gossiped, canonical-keyed node set — full-fleet (it
    // propagates multi-hop via relay) + deduped (one row per machine, a custom
    // mesh nodeId folded to its canonical id). Cross-machine sessions (below)
    // still cover any peer not yet advertising the roster during rollout.
    const meshPeers = getMeshState()
      .nodesForRoster(now)
      .map((n) => ({ nodeId: n.machineId, lastActivityAt: n.lastActivityAt }))

    const out = assembleMachines({
      self: getMachineId(),
      now,
      aliasOf: canonicalId,
      peers: peers.map((p) => ({ machine: p.machine ?? '', lastSeen: p.lastSeen, rawStatus: p.rawStatus })),
      meshPeers,
      mem,
      sym,
      // Canonical ids are `${hostname}-${8hex}` — strip the suffix for the label.
      hostnameOf: (id) => id.replace(/-[0-9a-z]{8}$/i, '') || id,
    })
    res.json({ self: out.self, remote: status.remote, retiredCount: out.retiredCount, machines: out.machines })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
