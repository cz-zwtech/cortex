#!/usr/bin/env tsx
/**
 * #93 — a TOKEN-ONLY node (no static CKN_MESH_PEERS, empty mesh.json) that learned a
 * peer last connection must RE-DIAL it on restart, not boot accept-only. The persist
 * machinery seeds the learned peer into the registry, but the dial-arm GATE in
 * meshMembership.realTierUp() gated startWsInitiator() on STATIC peers only
 * (peerUrls().length > 0) — so a token-only node logged "seeded N" then fell to the
 * accept-only branch and never dialed. The laptop's static .peers masked this.
 *
 * This asserts the GATE + the dial end-to-end: with empty static peers and ONE learned
 * peer in mesh-peers.json, a membership tier-up must actually DIAL that peer (a real
 * loopback ws server receives the connection). Fails on the pre-fix code (accept-only,
 * no dial); passes once the gate counts seeded peers AND startWsInitiator dials them.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-restart-redial-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_CONFIG_DIR = dir // hermetic: no real ~/.config/ckn/mesh.json → peerUrls() reads this empty dir
process.env.CKN_MESH_PEERS = '' // TOKEN-ONLY: no static peers (env empty + empty mesh.json ⇒ peerUrls() = [])
process.env.CKN_MESH_TOKEN = 'fleet-secret' // a token (acquireMeshToken returns true on plain env, no bao-run)
process.env.CKN_MESH_PEERS_FILE = path.join(dir, 'mesh-peers.json') // the learned-peer store
process.env.CKN_MESH_GOSSIP_MS = '600000'
delete process.env.CKN_MESH_SELF

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for the seeded peer to be dialed')
    await wait(20)
  }
}

async function main() {
  // A real loopback ws server stands in for the LEARNED peer; record any inbound dial.
  let dialed = false
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', () => {
    dialed = true
  })
  const port = (wss.address() as AddressInfo).port
  const learnedUrl = `http://127.0.0.1:${port}`

  // Persist the learned peer as if a prior connection had recorded it (the #82 setup:
  // a token-only node that joined via gossip, then restarted).
  fs.writeFileSync(
    process.env.CKN_MESH_PEERS_FILE!,
    JSON.stringify([{ url: learnedUrl, capability: 'reachable', lastGoodAt: Date.now() }]),
  )

  const { peerUrls } = await import('../../server/bus/meshIdentity.js')
  assert.deepEqual(peerUrls(), [], 'precondition: token-only — NO static peers (env + mesh.json both empty)')

  const { membershipTick } = await import('../../server/bus/meshMembership.js')
  const { stopWsMesh } = await import('../../server/bus/meshWs.js')
  const { stopDiscovery } = await import('../../server/bus/meshDiscovery.js')

  // Tier up: configured (token) + token-acquirable (plain env) ⇒ realTierUp runs.
  await membershipTick()

  // The bug: gate sees peerUrls().length===0 → accept-only → never dials. The fix:
  // gate counts the seeded peer + startWsInitiator dials it → the loopback connects.
  await until(() => dialed, 3000)
  assert.ok(dialed, 'a token-only node with a seeded learned peer DIALS it on tier-up (not accept-only)')

  stopDiscovery()
  stopWsMesh()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  console.log('mesh-restart-redial OK — token-only node re-dials its persisted learned peer on restart')
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (err) => {
    cleanup()
    console.error(err)
    process.exit(1)
  },
)
