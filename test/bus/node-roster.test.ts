// test/bus/node-roster.test.ts
import { describe, it, expect } from '../_tinytest.js'
import { buildNodeRoster, RETIRE_MS } from '../../server/bus/nodeRoster.js'

const NOW = 1_000_000_000_000
const ago = (ms: number) => NOW - ms
const id = (x: string) => (x === 'ZW-old' ? 'ZW-new' : x) // alias fold: ZW-old → ZW-new

describe('buildNodeRoster', () => {
  it('classifies the liveness ladder and folds aliases', () => {
    const r = buildNodeRoster({
      self: 'SELF-1',
      now: NOW,
      aliasOf: id,
      // sessions: { machine, lastSeen }
      sessions: [
        { machine: 'SELF-1', lastSeen: ago(60_000) },        // live
        { machine: 'ZW-new', lastSeen: ago(30 * 60_000) },   // idle
        { machine: 'ZW-old', lastSeen: ago(90 * 60_000) },   // folds into ZW-new (idle wins via max)
      ],
      // meshPeers: { nodeId, lastActivityAt }
      meshPeers: [
        { nodeId: 'LAP-1', lastActivityAt: ago(3 * 3_600_000) },   // dormant (3h)
        { nodeId: 'GONE-1', lastActivityAt: ago(48 * 3_600_000) }, // retired (>24h)
      ],
    })
    const byId = Object.fromEntries(r.living.map((n) => [n.canonicalId, n]))
    expect(byId['SELF-1'].status).toBe('live')
    expect(byId['SELF-1'].isSelf).toBe(true)
    expect(byId['ZW-new'].status).toBe('idle')         // max(idle, older) = idle
    expect(byId['LAP-1'].status).toBe('dormant')
    expect(byId['GONE-1']).toBeUndefined()             // retired → excluded
    expect(r.retiredCount).toBe(1)
    expect(r.living.find((n) => n.canonicalId === 'ZW-old')).toBeUndefined() // folded, not separate
  })

  it('self is always present and never retired, even with no recent contact', () => {
    const r = buildNodeRoster({ self: 'SELF-1', now: NOW, aliasOf: (x) => x, sessions: [], meshPeers: [] })
    expect(r.living.find((n) => n.canonicalId === 'SELF-1')?.isSelf).toBe(true)
  })

  it('RETIRE_MS defaults to 24h', () => {
    expect(RETIRE_MS()).toBe(24 * 60 * 60 * 1000)
  })

  it('RETIRE_MS is env-overridable via CKN_NODE_RETIRE_TTL_MS', () => {
    process.env.CKN_NODE_RETIRE_TTL_MS = '5000'
    expect(RETIRE_MS()).toBe(5000)
    delete process.env.CKN_NODE_RETIRE_TTL_MS
  })
})
