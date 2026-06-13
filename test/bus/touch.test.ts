#!/usr/bin/env tsx
/**
 * Self-healing-heartbeat (touch) test. Spawns its OWN throwaway server on a temp
 * port + temp SQLite (NOT :3001 — that polluted the real ~/.config/ckn/graph.sqlite
 * with machine='m1' rows). Mirrors the isolation pattern in integration.test.ts.
 * Covers the two behaviors that distinguish touch from register/heartbeat:
 *   1. touch REVIVES a signed_off session (resume / failed-SessionStart case)
 *      while PRESERVING its friendly name (a /rename'd identity must survive).
 *   2. touch CREATES a presence for a never-registered session id.
 * ISOLATION: run-unique ids/names; asserts only on the rows it owns.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-touch-'))
const PORT = 3096
const BASE = `http://127.0.0.1:${PORT}/api/bus`
const ts = Date.now()
const NAMED = `touch-named-${ts}`
const NAME = `touch-friendly-${ts}`
const FRESH = `touch-fresh-${ts}`

let server: ChildProcess | null = null

const cleanup = () => {
  // Kill the whole process GROUP: tsx spawns a child node process, so killing the
  // tsx wrapper alone leaks the actual server (grandchild keeps the port).
  try {
    if (server?.pid) process.kill(-server.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

const post = async (p: string, body: any) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}
const peer = async (id: string) => {
  const r = await fetch(`${BASE}/peers`)
  if (!r.ok) throw new Error(`/peers -> ${r.status}`)
  const { peers } = (await r.json()) as { peers: any[] }
  return peers.find((p) => p.sessionId === id)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function startServer() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CKN_PORT: String(PORT),
      CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: path.join(dir, 'graph.sqlite'),
      CKN_PRIVATE_MIND: 'off',
      CKN_EMBEDDINGS: 'off',
      CKN_MESH_PEERS: '',
      CKN_MESH_TOKEN: '',
      // Defense-in-depth: if this server ever accidentally resolves the real DB path,
      // it will throw rather than silently polluting production.
      CKN_FORBID_DEFAULT_DB: '1',
    },
    stdio: 'ignore',
    detached: true, // own process group so cleanup kills the whole tree
  })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/home`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error('touch test server never came up on :' + PORT)
}

async function main() {
  await startServer()

  // 1. register a NAMED session, sign it off, then touch it.
  await post('/register', { sessionId: NAMED, title: NAME, cwd: `/tmp/touch-${ts}`, machine: 'm1' })
  await post('/signoff', { sessionId: NAMED })
  let p = await peer(NAMED)
  assert.equal(p.status, 'signed_off', 'session is signed_off before touch')

  await post('/touch', { sessionId: NAMED, cwd: `/tmp/touch-${ts}`, machine: 'm1' })
  p = await peer(NAMED)
  assert.equal(p.status, 'live', 'touch revives a signed_off session')
  assert.equal(p.friendlyName, NAME, 'touch preserves the /rename friendly name (no clobber)')

  // 2. touch a never-registered id → created live, name = short id prefix.
  assert.equal(await peer(FRESH), undefined, 'fresh id absent before touch')
  await post('/touch', { sessionId: FRESH, cwd: `/tmp/fresh-${ts}`, machine: 'm1' })
  p = await peer(FRESH)
  assert.ok(p, 'touch creates a presence for an unseen session')
  assert.equal(p.status, 'live', 'created presence is live')
  assert.equal(p.friendlyName, FRESH.slice(0, 8), 'created presence uses short-id name')

  // cleanup: sign off the sessions this run registered (keep /api/machines clean).
  for (const s of [NAMED, FRESH]) await post('/signoff', { sessionId: s })

  console.log('touch.test.ts: all assertions passed')
}

main().then(cleanup).catch((err) => { cleanup(); console.error(err); process.exit(1) })
