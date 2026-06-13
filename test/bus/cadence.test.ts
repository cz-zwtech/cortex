#!/usr/bin/env tsx
/**
 * cadence_s liveness-heartbeat field on session presence — against a throwaway
 * server (mesh off, temp DB). Proves the generic primitive:
 *   1. POST /api/bus/touch {sessionId, cadenceS:30} records cadence_s + bumps last_seen.
 *   2. GET /api/bus/peers exposes cadenceS on the peer + a fresh lastSeen.
 *   3. A subsequent touch WITHOUT cadenceS must NOT reset cadence_s to 0 (the
 *      per-prompt pause-context touch sends no cadence — it must not clobber it).
 */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-cadence-'))
const PORT = 3097
const BASE = `http://127.0.0.1:${PORT}/api/bus`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => { try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch {}
  fs.rmSync(dir, { recursive: true, force: true }) }

async function start() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: { ...process.env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: path.join(dir, 'graph.sqlite'),
      CKN_PRIVATE_MIND: 'off', CKN_EMBEDDINGS: 'off', CKN_MESH_PEERS: '', CKN_MESH_TOKEN: '' },
    stdio: 'ignore', detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server never came up')
}

const post = (p: string, b: any) => fetch(`${BASE}${p}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
const peer = async (id: string) => {
  const { peers } = await fetch(`${BASE}/peers`).then((r) => r.json()) as { peers: any[] }
  return peers.find((p) => p.sessionId === id)
}

try {
  await start()

  // 1. touch with a cadence → cadenceS recorded, lastSeen fresh.
  const before = Date.now()
  await post('/touch', { sessionId: 's1', cadenceS: 30 })
  const p1 = await peer('s1')
  assert.ok(p1, 'peer s1 exists after touch')
  assert.equal(p1.cadenceS, 30, 'touch records cadenceS=30 on the peer')
  assert.ok(p1.lastSeen >= before - 1000, 'lastSeen is recent (within the last few seconds)')

  // 2. a later touch WITHOUT cadenceS must NOT reset cadence_s to 0.
  await post('/touch', { sessionId: 's1' })
  const p2 = await peer('s1')
  assert.equal(p2.cadenceS, 30, 'a touch without cadenceS preserves the existing cadence_s (no clobber)')

  // 3. a never-touched-with-cadence session has cadenceS 0 (the generic default).
  await post('/touch', { sessionId: 's2' })
  const p3 = await peer('s2')
  assert.equal(p3.cadenceS, 0, 'no bounded heartbeat → cadenceS defaults to 0')

  console.log('cadence.test.ts: all assertions passed'); cleanup(); process.exit(0)
} catch (e) { console.error(e); cleanup(); process.exit(1) }
