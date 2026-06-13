#!/usr/bin/env tsx
/**
 * FR-7 I5 — `/api/bus/mesh-status` surfaces the direct-link hint. Mounts the real
 * busRouter and drives it with fetch, so the plumbing (meshBindConfig + meshState
 * capability → meshDirectLinkHint → response.hints) is exercised end-to-end. The
 * hint's content rules are unit-tested in mesh-hints.test.ts; this proves the wiring:
 *   - loopback-only (no CKN_MESH_BIND) + an unreachable peer → hints non-empty
 *   - a published CKN_MESH_BIND → no hint (the node is inbound-reachable)
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-status-hint-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
delete process.env.CKN_MESH_BIND
delete process.env.CKN_MESH_PEERS
delete process.env.CKN_MESH_SELF

const { busRouter } = await import('../../server/routes/bus.js')
const { _resetMeshState, getMeshState } = await import('../../server/bus/meshState.js')

const app = express()
app.use(express.json())
app.use('/api/bus', busRouter)
const server = http.createServer(app)
const cleanup = () => {
  try { server.close() } catch { /* noop */ }
  fs.rmSync(dir, { recursive: true, force: true })
}
const listen = (): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`)
    })
  })

async function main() {
  const base = await listen()

  // seed a peer a probe classified unreachable, on a loopback-only node (no CKN_MESH_BIND).
  _resetMeshState(['http://peer-down:3002'])
  getMeshState().setCapability('http://peer-down:3002', 'unreachable', 1)

  const r1 = await fetch(`${base}/api/bus/mesh-status`)
  assert.equal(r1.status, 200, 'mesh-status is 200')
  const s1 = (await r1.json()) as { hints?: string[] }
  assert.ok(Array.isArray(s1.hints) && s1.hints.length >= 1, 'loopback-only + unreachable peer → a hint')
  assert.match(s1.hints![0]!, /mirrored networking/i, 'hint names the WSL mirrored-networking fix')

  // opt into a published bind → the node is inbound-reachable → no hint.
  process.env.CKN_MESH_BIND = '0.0.0.0:3010'
  const r2 = await fetch(`${base}/api/bus/mesh-status`)
  const s2 = (await r2.json()) as { hints?: string[] }
  assert.deepEqual(s2.hints, [], 'a published CKN_MESH_BIND suppresses the hint')
  delete process.env.CKN_MESH_BIND

  console.log('mesh-status-hint OK')
}

main().then(
  () => { cleanup(); process.exit(0) },
  (err) => { cleanup(); console.error(err); process.exit(1) },
)
