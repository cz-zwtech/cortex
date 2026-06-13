#!/usr/bin/env tsx
/**
 * Fleet roster gossip: canonical-keyed dedup + relay + full-fleet + TTL.
 * Covers the two Machines-page fixes — one row per computer regardless of a
 * custom mesh nodeId (B), and the whole fleet visible from any node via relay (A).
 */
import assert from 'node:assert/strict'

const { _resetMeshState } = await import('../../server/bus/meshState.js')
const { buildNodeRoster } = await import('../../server/bus/nodeRoster.js')

const NOW = 1_000_000_000_000
let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── dedup: same canonical machineId, two different mesh nodeIds → ONE entry ──
{
  const mesh = _resetMeshState([])
  mesh.mergeNodes(
    [
      { nodeId: 'wsl-dev', machineId: 'node-a-c5e3af1c', hostname: 'node-a', lastActivityAt: NOW - 1000 },
      { nodeId: 'node-a-c5e3af1c', machineId: 'node-a-c5e3af1c', hostname: 'node-a', lastActivityAt: NOW },
    ],
    NOW,
  )
  const roster = mesh.nodesForRoster(NOW)
  assert.equal(roster.length, 1, 'same machine folds to one entry')
  assert.equal(roster[0]!.machineId, 'node-a-c5e3af1c')
  assert.equal(roster[0]!.lastActivityAt, NOW, 'keeps the freshest activity')
  ok('canonical machineId folds a custom nodeId to one row')
}

// ── relay: rosterForGossip returns self + everything learned (→ multi-hop) ──
{
  const mesh = _resetMeshState([])
  mesh.mergeNodes([{ nodeId: 'wsl-dev', machineId: 'node-a-c5e3af1c', hostname: 'z', lastActivityAt: NOW }], NOW)
  const out = mesh.rosterForGossip(
    { nodeId: 'zw1', machineId: 'node-b-aaaa1111', hostname: 'zw1', lastActivityAt: NOW },
    NOW,
  )
  assert.deepEqual(
    out.map((n) => n.machineId).sort(),
    ['node-a-c5e3af1c', 'node-b-aaaa1111'],
    'gossip relays self + learned peers',
  )
  ok('rosterForGossip relays the full known set (enables multi-hop)')
}

// ── full-fleet + dedup through the roster builder ──
{
  const mesh = _resetMeshState([])
  // A spoke that learned 3 machines via relay, one advertising a custom nodeId.
  mesh.mergeNodes(
    [
      { nodeId: 'node-a-c5e3af1c', machineId: 'node-a-c5e3af1c', hostname: 'z', lastActivityAt: NOW },
      { nodeId: 'zw1', machineId: 'node-b-aaaa1111', hostname: 'zw1', lastActivityAt: NOW },
      { nodeId: 'node-c', machineId: 'node-c-27f6482c', hostname: 'zw2', lastActivityAt: NOW },
    ],
    NOW,
  )
  const built = buildNodeRoster({
    self: 'node-a-c5e3af1c',
    now: NOW,
    aliasOf: (id) => id,
    sessions: [],
    meshPeers: mesh.nodesForRoster(NOW).map((n) => ({ nodeId: n.machineId, lastActivityAt: n.lastActivityAt })),
  })
  assert.deepEqual(
    built.living.map((n) => n.canonicalId).sort(),
    ['node-a-c5e3af1c', 'node-b-aaaa1111', 'node-c-27f6482c'],
    'whole fleet visible, one row per machine',
  )
  ok('roster builder yields full fleet, deduped by machine')
}

// ── TTL: a machine not re-heard within 24h ages out of the roster ──
{
  const mesh = _resetMeshState([])
  mesh.mergeNodes([{ nodeId: 'old', machineId: 'old-1', hostname: 'old', lastActivityAt: NOW - 25 * 60 * 60 * 1000 }], NOW)
  assert.equal(mesh.nodesForRoster(NOW).length, 0, 'stale node (>24h) aged out')
  ok('TTL drops a departed machine')
}

// ── I8 (G3): the roster carries a dialable url; merge prefers a non-empty one ──
{
  const mesh = _resetMeshState([])
  mesh.mergeNodes(
    [{ nodeId: 'zw1', machineId: 'node-b-aaaa1111', hostname: 'zw1', url: 'http://10.0.0.12:3001', lastActivityAt: NOW }],
    NOW,
  )
  assert.equal(mesh.nodesForRoster(NOW)[0]!.url, 'http://10.0.0.12:3001', 'roster carries the advertised dial url')
  ok('KnownNode round-trips an advertised url through merge')

  // A later relay hop that DROPPED the url must not erase it (prefer non-empty),
  // while still taking the freshest activity.
  mesh.mergeNodes(
    [{ nodeId: 'zw1', machineId: 'node-b-aaaa1111', hostname: 'zw1', url: '', lastActivityAt: NOW + 1000 }],
    NOW + 1000,
  )
  const r2 = mesh.nodesForRoster(NOW + 1000)
  assert.equal(r2[0]!.url, 'http://10.0.0.12:3001', 'a later url-less gossip keeps the known url')
  assert.equal(r2[0]!.lastActivityAt, NOW + 1000, 'still takes the freshest activity')
  ok('merge prefers a non-empty url (relay where a hop dropped it)')
}

// ── rosterForGossip stamps self's own dial url so it propagates multi-hop ──
{
  const mesh = _resetMeshState([])
  const out = mesh.rosterForGossip(
    { nodeId: 'zw1', machineId: 'node-b-aaaa1111', hostname: 'zw1', url: 'http://10.0.0.12:3001', lastActivityAt: NOW },
    NOW,
  )
  const self = out.find((n) => n.machineId === 'node-b-aaaa1111')
  assert.equal(self!.url, 'http://10.0.0.12:3001', 'self advertises its own dial url onward')
  ok('rosterForGossip carries self.url')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
