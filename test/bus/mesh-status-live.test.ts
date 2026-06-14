#!/usr/bin/env tsx
/**
 * /api/bus/mesh-status must report a derived `live` — the mesh actually has >=1 OPEN ws
 * link — distinct from `enabled` (mesh armed by config). Consumers were reading `enabled`
 * and treating an armed-but-unconnected mesh as connected.
 *   - meshLive() pure: true iff some link is connected (OPEN); false on empty or all-dialed.
 *   - route wiring: mesh-status returns a boolean `live`; false when there are no links.
 * Mirrors mesh-status-hint.test.ts: mounts the real busRouter and drives it with fetch.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-status-live-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
delete process.env.CKN_MESH_BIND
delete process.env.CKN_MESH_PEERS
delete process.env.CKN_MESH_SELF

const { busRouter, meshLive } = await import('../../server/routes/bus.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── meshLive() pure ──────────────────────────────────────────────────────────
assert.equal(meshLive([]), false)
ok('meshLive([]) → false (no links)')
assert.equal(meshLive([{ connected: false }, { connected: false }]), false)
ok('meshLive(all dialed, none open) → false')
assert.equal(meshLive([{ connected: false }, { connected: true }]), true)
ok('meshLive(>=1 open) → true')

// ── route wiring ─────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())
app.use('/api/bus', busRouter)
const server = http.createServer(app)
const cleanup = () => {
  try {
    server.close()
  } catch {
    /* noop */
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
const base: string = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`)
  })
})

try {
  const r = await fetch(`${base}/api/bus/mesh-status`)
  assert.equal(r.status, 200, 'mesh-status 200')
  const s = (await r.json()) as { live?: unknown }
  assert.equal(typeof s.live, 'boolean', 'response has a boolean `live`')
  assert.equal(s.live, false, 'no ws links → live false')
  ok('mesh-status returns derived live (boolean, false with no links)')
  console.log(`\n${passed} assertions passed.`)
} finally {
  cleanup()
}
process.exit(0)
