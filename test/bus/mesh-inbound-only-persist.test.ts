#!/usr/bin/env tsx
/**
 * #93 SECONDARY (PM-requested): does a peer learned ONLY via an inbound dial (never
 * gossiped) get persisted as a re-dialable seed at all?
 *
 * A peer's DIALABLE url is learned only via gossip (markReachable stamps lastGossipAt +
 * registers the url). markInbound stamps only `hasInbound` on the ephemeral accept-socket
 * key (an ephemeral remote-port string, NOT a dialable base url), leaving lastGoodAt=0 —
 * so exportPersistable (which keeps only lastGoodAt = max(lastGossipAt,lastActivityAt) > 0)
 * yields NO dialable seed for an inbound-only-never-gossiped peer. By design: re-dial on
 * restart relies on the bidirectional gossip that normal topology runs (CKN_MESH_GOSSIP_MS),
 * so a genuinely-connected peer gets lastGossipAt and IS persisted. The never-gossiped
 * inbound-only peer is the harmless edge (nothing dialable to lose).
 *
 * Proves: inbound-only (markInbound + markInboundNode, no gossip) ⇒ no dialable persisted
 * seed; a gossiped peer (markReachable) ⇒ persisted dialable (the contrast).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-inbound-persist-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = ''
delete process.env.CKN_MESH_SELF

const { getMeshState, _resetMeshState } = await import('../../server/bus/meshState.js')

const NOW = Date.now()
const TTL = 7 * 24 * 60 * 60 * 1000
const isDialable = (u: string) => /^https?:/.test(u)

// ── inbound-only, never gossiped → NO dialable persisted seed ──────────────────
{
  _resetMeshState([])
  const mesh = getMeshState()
  mesh.markInbound('ws:198.51.100.7:54321') // ephemeral accept-socket key (NOT a dialable url)
  mesh.markInboundNode('peer-node-inbound-only')
  const persisted = mesh.exportPersistable(NOW, TTL)
  assert.equal(
    persisted.filter((p) => isDialable(p.url)).length,
    0,
    'a never-gossiped inbound-only peer yields NO dialable persisted seed (re-dial relies on gossip)',
  )
}

// ── contrast: a gossiped/reachable peer IS persisted as a dialable seed ─────────
{
  _resetMeshState([])
  const mesh = getMeshState()
  mesh.markReachable('http://192.0.2.20:3001', 'peer-node-gossiped', 0, NOW) // stamps lastGossipAt
  const persisted = mesh.exportPersistable(NOW, TTL)
  assert.ok(
    persisted.some((p) => p.url === 'http://192.0.2.20:3001'),
    'a gossiped (reachable) peer IS persisted as a dialable seed — the path #93 re-dials on restart',
  )
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('mesh-inbound-only-persist OK — re-dial seed comes from gossip, not inbound-only (#93 secondary)')
