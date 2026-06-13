// test/bus/machines-route.test.ts
import { describe, it, expect } from '../_tinytest.js'
import { assembleMachines } from '../../server/routes/machines.js'

const NOW = 1_000_000_000_000
const ago = (ms: number) => NOW - ms

describe('assembleMachines (route join, pure)', () => {
  it('joins counts by canonical id, folds aliases, drops ghosts', () => {
    const out = assembleMachines({
      self: 'ZW-new',
      now: NOW,
      aliasOf: (x) => (x === 'ZW-old' ? 'ZW-new' : x),
      peers: [
        { machine: 'ZW-new', lastSeen: ago(60_000), rawStatus: 'live' },
      ],
      meshPeers: [{ nodeId: 'LAP-1', lastActivityAt: ago(2 * 3_600_000) }],
      mem: { 'ZW-new': 2000, 'ZW-old': 50, 'wsl-dev-test': 1 }, // wsl-dev-test = ghost (no presence)
      sym: { 'ZW-new': 3000, 'ZW-old': 0 },
      hostnameOf: (id) => id.replace(/-[0-9a-z]{8}$/, ''),
    })
    const byId = Object.fromEntries(out.machines.map((m) => [m.canonicalId, m]))
    expect(byId['ZW-new'].memoryCount).toBe(2050)  // 2000 + folded 50
    expect(byId['ZW-new'].symbolCount).toBe(3000)
    expect(byId['ZW-new'].isSelf).toBe(true)
    expect(byId['LAP-1'].status).toBe('dormant')
    expect(byId['wsl-dev-test']).toBeUndefined()    // no-ghost regression
    expect(byId['ZW-old']).toBeUndefined()          // folded, not a node
  })
})
