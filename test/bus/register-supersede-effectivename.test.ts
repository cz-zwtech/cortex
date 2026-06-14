#!/usr/bin/env tsx
/**
 * #86 register supersede on the EFFECTIVE (post-floor) name + same-machine scope.
 *
 * (1) FLOORED-SUPERSEDE: a post-compact no-title re-register floors to its real
 *     name; the supersede scan must run on that effective name so it signs off a
 *     stale live twin under the real name. The old scan ran on the PRE-floor bare
 *     id and missed it -> two live rows under the real name.
 * (2) CROSS-MACHINE COEXIST: localTranscriptIds() is local-only, so a register on
 *     machine A must NOT sign off a machine-B live session sharing name+cwd.
 * (3) NON-FLOORED normal supersede UNCHANGED (regression guard).
 *
 * Spawns its own throwaway server (temp port + temp SQLite), mirroring
 * register-name-floor.test.ts. hasTranscript is false for these synthetic ids
 * (no real transcript); the phantom-guard itself is unit-tested in
 * supersede-scan.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-supersede-'))
const PORT = 3093
const BASE = `http://127.0.0.1:${PORT}/api/bus`
const ts = Date.now()

let server: ChildProcess | null = null
const cleanup = () => {
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
const peers = async (): Promise<any[]> => {
  const r = await fetch(`${BASE}/peers`)
  if (!r.ok) throw new Error(`/peers -> ${r.status}`)
  return ((await r.json()) as { peers: any[] }).peers
}
const activeUnder = async (name: string): Promise<any[]> =>
  (await peers()).filter((p) => p.friendlyName === name && p.status !== 'signed_off')
const statusOf = async (id: string): Promise<string | undefined> =>
  (await peers()).find((p) => p.sessionId === id)?.status
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
      CKN_FORBID_DEFAULT_DB: '1',
    },
    stdio: 'ignore',
    detached: true,
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
  throw new Error('supersede test server never came up on :' + PORT)
}

async function main() {
  await startServer()

  // ── 1. FLOORED-SUPERSEDE (the #86 core; RED on the old bare-id scan) ──────────
  const N = `sup-name-${ts}`
  const CWD = `/tmp/sup-${ts}`
  const D = `sup-D-${ts}`
  const B = `sup-B-${ts}`
  // D named N; then B named N supersedes D (explicit-name path — works today).
  await post('/register', { sessionId: D, title: N, cwd: CWD, machine: 'm1' })
  await post('/register', { sessionId: B, title: N, cwd: CWD, machine: 'm1' })
  assert.equal(await statusOf(D), 'signed_off', 'setup: explicit-name B supersedes D')
  assert.equal((await activeUnder(N)).length, 1, 'setup: exactly one live row under N (B)')
  // D resumes post-compact with EMPTY title -> floors to N -> must supersede the
  // stale live twin B. Old scan ran on D's bare id and missed it -> two live rows.
  await post('/register', { sessionId: D, title: '', cwd: CWD, machine: 'm1' })
  const liveN = await activeUnder(N)
  assert.equal(liveN.length, 1, 'floored re-register supersedes the stale twin -> exactly ONE live row under N')
  assert.equal(liveN[0].sessionId, D, 'the resumed (floored) session is the survivor')
  assert.equal(await statusOf(B), 'signed_off', 'the stale twin B is signed off by the floored effective-name scan')

  // ── 2. CROSS-MACHINE COEXIST (the peer-race fix) ─────────────────────────────
  const M = `sup-xm-${ts}`
  const CWD2 = `/tmp/sup-xm-${ts}`
  const A2 = `sup-A2-${ts}`
  const B2 = `sup-B2-${ts}`
  await post('/register', { sessionId: A2, title: M, cwd: CWD2, machine: 'm2' })
  await post('/register', { sessionId: B2, title: M, cwd: CWD2, machine: 'm1' })
  const liveM = await activeUnder(M)
  assert.equal(liveM.length, 2, 'a different-machine session sharing name+cwd is NOT signed off (coexist)')
  assert.equal(await statusOf(A2), 'live', 'the remote-machine session stays live')

  // ── 3. NON-FLOORED normal supersede UNCHANGED (regression guard) ─────────────
  const K = `sup-k-${ts}`
  const CWD3 = `/tmp/sup-k-${ts}`
  const E = `sup-E-${ts}`
  const F = `sup-F-${ts}`
  await post('/register', { sessionId: E, title: K, cwd: CWD3, machine: 'm1' })
  await post('/register', { sessionId: F, title: K, cwd: CWD3, machine: 'm1' })
  const liveK = await activeUnder(K)
  assert.equal(liveK.length, 1, 'same-machine explicit-name supersede still collapses to one live row')
  assert.equal(liveK[0].sessionId, F, 'the newer same-machine session wins the name')
  assert.equal(await statusOf(E), 'signed_off', 'the prior same-name session is signed off (unchanged)')

  console.log('register-supersede-effectivename.test.ts: floored-supersede + cross-machine-coexist + non-floored-unchanged all passed')
}

main().then(cleanup).catch((err) => {
  cleanup()
  console.error(err)
  process.exit(1)
})
