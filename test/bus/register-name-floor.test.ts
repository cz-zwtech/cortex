#!/usr/bin/env tsx
/**
 * register name-FLOOR test — the #47 "name survives /compact" pin.
 *
 * ROOT CAUSE: a post-compact SessionStart fires ckn-context → /register. When the
 * incoming title is empty (readCurrentTopic missed it — cwd-encoding skew, sid/timing,
 * whatever the upstream reason), registerSession recomputed friendly_name via
 * resolveFriendlyName → sid.slice(0,8) and the exists-branch UPDATE UNCONDITIONALLY
 * overwrote the stored name, DOWNGRADING a /rename'd "cortex-dev" to its bare id.
 * touchSession was already non-clobbering; register was not — that asymmetry was the bug.
 *
 * FLOOR: a no-title re-register must NEVER downgrade an existing non-bare name. An
 * EXPLICIT title still wins (rename + bare→named upgrade unaffected) — only the
 * empty-input DOWNGRADE is blocked.
 *
 * Spawns its OWN throwaway server on a temp port + temp SQLite (NOT :3001), mirroring
 * touch.test.ts. Run-unique ids/names; asserts only on the rows it owns.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-namefloor-'))
const PORT = 3097
const BASE = `http://127.0.0.1:${PORT}/api/bus`
const ts = Date.now()
const NAMED = `namefloor-named-${ts}`
const NAME = `namefloor-friendly-${ts}`
const NAME2 = `namefloor-renamed-${ts}`
const BARE = `namefloor-bare-${ts}`
const NAME3 = `namefloor-upgraded-${ts}`
const CWD = `/tmp/namefloor-${ts}`

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
  throw new Error('name-floor test server never came up on :' + PORT)
}

async function main() {
  await startServer()

  // ── matrix A — no-title re-register PRESERVES name AND title ──────────────────
  // (Fable cond 1: floor title too; cond 4: "no-title register preserves name+title".)
  await post('/register', { sessionId: NAMED, title: NAME, cwd: CWD, machine: 'm1' })
  let p = await peer(NAMED)
  assert.equal(p.friendlyName, NAME, 'first register sets the explicit name')
  assert.equal(p.title, NAME, 'first register sets the title')

  // The EXACT post-compact body ckn-context.ts:65 sends: {sessionId, title:'', cwd, machine}
  // — empty title, NO autoName key (PM cross-check (i): assert the real resume payload).
  await post('/register', { sessionId: NAMED, title: '', cwd: CWD, machine: 'm1' })
  p = await peer(NAMED)
  assert.equal(p.friendlyName, NAME, 'no-title re-register PRESERVES the friendly name (no bare-id downgrade) — the #47 fix')
  assert.equal(p.title, NAME, 'no-title re-register PRESERVES the title too (row stays internally consistent)')
  // Symptom-pin (PM/Fable optional hardening): the floor never WRITES the bare id, so it
  // never folds into name_history — directly refutes the observed nameHistory=[bare-id].
  assert.ok(
    !p.nameHistory.includes(NAMED.slice(0, 8)),
    'post-floor name_history carries NO bare-id entry (the rebind symptom is gone at the source)',
  )

  // ── matrix B — an EXPLICIT title still overwrites (floor must not freeze) ──────
  // (Fable cond 2 + cond 4 "explicit-title register overwrites".)
  await post('/register', { sessionId: NAMED, title: NAME2, cwd: CWD, machine: 'm1' })
  p = await peer(NAMED)
  assert.equal(p.friendlyName, NAME2, 'an explicit title still renames')
  assert.equal(p.title, NAME2, 'an explicit title updates the stored title')

  // ── matrix C — rename-then-compact survives ───────────────────────────────────
  // (Fable cond 4 "rename-then-compact survives": the renamed name persists across a
  // subsequent no-title resume.)
  await post('/register', { sessionId: NAMED, title: '', cwd: CWD, machine: 'm1' })
  p = await peer(NAMED)
  assert.equal(p.friendlyName, NAME2, 'a renamed session survives a later compact resume')
  assert.equal(p.title, NAME2, 'the renamed title survives the compact resume')
  // The pre-rename name stays in history (alias routing) but the bare id never does.
  assert.ok(!p.nameHistory.includes(NAMED.slice(0, 8)), 'rename-then-compact: name_history still carries no bare-id entry')

  // ── matrix D — born-bare unaffected, then bare→named UPGRADE ───────────────────
  // (Fable cond 4 "born-bare session unaffected": floor is exists-branch only — a
  // first-ever no-title register still gets the bare-id fallback; a later explicit
  // title upgrades it. The floor blocks DOWNGRADE, never UPGRADE.)
  await post('/register', { sessionId: BARE, title: '', cwd: CWD, machine: 'm1' })
  p = await peer(BARE)
  assert.equal(p.friendlyName, BARE.slice(0, 8), 'born-bare: first no-title register falls back to the short-id name')

  await post('/register', { sessionId: BARE, title: NAME3, cwd: CWD, machine: 'm1' })
  p = await peer(BARE)
  assert.equal(p.friendlyName, NAME3, 'bare→named upgrade: a later explicit title names a bare session')
  assert.equal(p.title, NAME3, 'bare→named upgrade sets the title')

  // cleanup: sign off the sessions this run registered.
  for (const s of [NAMED, BARE]) await post('/signoff', { sessionId: s })

  console.log('register-name-floor.test.ts: all 4 compact-sim matrix cases passed')
}

main().then(cleanup).catch((err) => { cleanup(); console.error(err); process.exit(1) })
