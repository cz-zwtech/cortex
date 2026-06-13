#!/usr/bin/env tsx
/**
 * FR-7 G1 — persisted peer set. The registry seeds from static config ∪ peers
 * learned at last connection, so the mesh re-forms across a restart. Liveness/TTL
 * is by lastGoodAt (last GOOD contact, not probe time) so a dead peer ages out
 * instead of being re-seeded forever. Pure pieces only (fs + the MeshState export).
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const { _resetMeshState } = await import('../../server/bus/meshState.js')
const { loadPersistedPeers, savePersistedPeers, initMeshPeers } = await import(
  '../../server/bus/meshPeerStore.js'
)

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000
const TTL = 7 * DAY
const tmp = path.join(os.tmpdir(), `ckn-peers-test-${process.pid}.json`)
const cleanup = () => fs.rmSync(tmp, { force: true })

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── save → load round-trip, with TTL-prune on load ──
{
  savePersistedPeers(tmp, [
    { url: 'http://a:3001', capability: 'reachable', lastGoodAt: NOW },
    { url: 'http://old:3001', capability: 'unreachable', lastGoodAt: NOW - 8 * DAY },
  ])
  const loaded = loadPersistedPeers(tmp, NOW, TTL)
  assert.deepEqual(loaded.map((p) => p.url), ['http://a:3001'], 'fresh kept, >TTL pruned on load')
  assert.equal(loaded[0]!.capability, 'reachable', 'capability round-trips')
  ok('save→load round-trips and TTL-prunes stale entries')
}

// ── fail-soft: corrupt / missing / non-array → [] (never throws) ──
{
  fs.writeFileSync(tmp, 'not json {')
  assert.deepEqual(loadPersistedPeers(tmp, NOW, TTL), [], 'corrupt JSON → []')
  fs.writeFileSync(tmp, '{"not":"an array"}')
  assert.deepEqual(loadPersistedPeers(tmp, NOW, TTL), [], 'non-array → []')
  cleanup()
  assert.deepEqual(loadPersistedPeers(tmp, NOW, TTL), [], 'missing file → []')
  ok('load is fail-soft on corrupt/non-array/missing')
}

// ── initMeshPeers seeds learned peers into the live registry as candidates ──
{
  const mesh = _resetMeshState([])
  savePersistedPeers(tmp, [{ url: 'http://seed:3001', capability: 'reachable', lastGoodAt: NOW }])
  const seededUrls = initMeshPeers(tmp, NOW, TTL)
  assert.deepEqual(seededUrls, ['http://seed:3001'], 'returns the one seeded url (for the dialer to arm on)')
  assert.ok(mesh.knownAddresses().includes('http://seed:3001'), 'seeded into registry')
  // a fresh-seeded learned peer starts unknown → the discovery sweep will re-probe it
  assert.equal(mesh.allPeers().find((p) => p.url === 'http://seed:3001')!.capability, 'unknown')
  cleanup()
  ok('initMeshPeers seeds persisted peers as discovery candidates')
}

// ── exportPersistable: keep good-within-TTL, drop stale-good and never-good ──
{
  const mesh = _resetMeshState([])
  mesh.markReachable('http://a:3001', 'nodeA', 1, NOW) // good now (gossip+activity)
  mesh.markReachable('http://b:3001', 'nodeB', 1, NOW - 8 * DAY) // good long ago
  mesh.learnAddress('http://c:3001') // never had a good contact
  const out = mesh.exportPersistable(NOW, TTL)
  assert.deepEqual(out.map((p) => p.url), ['http://a:3001'], 'only the recently-good peer persists')
  ok('exportPersistable keeps good-within-TTL, drops stale-good + never-good')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
