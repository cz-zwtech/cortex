#!/usr/bin/env tsx
/**
 * Stale-session-row prune, against a throwaway server (mesh off, temp DB).
 *
 * Seeds presence rows at varied ages/status (register via the API, then back-date
 * `last_seen` + set `status` directly in the temp DB), calls POST
 * /api/bus/prune-sessions, then GET /api/bus/peers and asserts ONLY rows past the
 * 90d hard cap are GONE while live/idle/recent AND signed_off ANCHORS under the cap
 * SURVIVE (anchor model — a retained signed_off row lets a resume UPDATE-rebind).
 * Also asserts a pruned session's `entries` stub-node + incident edge are cleaned.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-stale-prune-'))
const DB_PATH = path.join(dir, 'graph.sqlite')
const PORT = 3092
const BASE = `http://127.0.0.1:${PORT}/api/bus`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => {
  try {
    if (server?.pid) process.kill(-server.pid, 'SIGKILL')
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

async function start() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CKN_PORT: String(PORT),
      CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: DB_PATH,
      CKN_PRIVATE_MIND: 'off',
      CKN_EMBEDDINGS: 'off',
      CKN_MESH_PEERS: '',
      CKN_MESH_TOKEN: '',
    },
    stdio: 'ignore',
    detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok) return
    } catch {}
    await sleep(150)
  }
  throw new Error('server never came up')
}

const post = (p: string, b: any) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json())

const peerIds = async (): Promise<Set<string>> => {
  const { peers } = await fetch(`${BASE}/peers`).then((r) => r.json())
  return new Set(peers.map((p: any) => p.sessionId))
}

try {
  await start()

  // Register five sessions via the API (creates session_meta rows, status 'live').
  const ids = {
    live: 'sp-live',
    idle: 'sp-idle',
    recent: 'sp-recent',
    signedOld: 'sp-signed-25h',
    abandoned: 'sp-abandoned-100d',
  }
  for (const id of Object.values(ids)) {
    await post('/register', { sessionId: id, cwd: `/tmp/${id}`, machine: 'm1' })
  }
  // Sign the soon-to-be-old one off (so it goes via the signed_off+24h branch).
  await post('/signoff', { sessionId: ids.signedOld })

  // Back-date last_seen + force status directly in the temp DB. The server holds
  // the file under WAL, so a second handle can write while it's up (single
  // writer at a time; the server is idle here). We close immediately after.
  const now = Date.now()
  const db = new Database(DB_PATH)
  try {
    const setSeen = db.prepare('UPDATE session_meta SET last_seen = ? WHERE id = ?')
    const setStatus = db.prepare('UPDATE session_meta SET status = ?, last_seen = ? WHERE id = ?')
    setSeen.run(now - 1 * MIN, ids.live) // live → keep
    setSeen.run(now - 30 * MIN, ids.idle) // idle → keep
    setSeen.run(now - 2 * HOUR, ids.recent) // stale but <90d, never signed off → keep
    setStatus.run('signed_off', now - 25 * HOUR, ids.signedOld) // signed_off but <90d → ANCHOR, keep
    setSeen.run(now - 100 * DAY, ids.abandoned) // any status >90d → prune

    // Give the abandoned session an entries stub-node + an incident edge, to prove
    // the prune removes graph residue (no orphan node/edge lingers).
    db.prepare(
      `INSERT INTO entries (id, name, kind, scope) VALUES (?, ?, 'session', ?)`,
    ).run(ids.abandoned, ids.abandoned, `session:${ids.abandoned}`)
    db.prepare(
      `INSERT INTO edges (src, dst, rel) VALUES ('some-pattern', ?, 'OCCURRED_IN')`,
    ).run(ids.abandoned)
  } finally {
    db.close()
  }

  // All five present before the prune.
  let present = await peerIds()
  for (const id of Object.values(ids)) {
    assert.ok(present.has(id), `${id} present before prune`)
  }

  // Prune.
  const { pruned } = await post('/prune-sessions', {})
  assert.equal(
    pruned,
    1,
    'prunes exactly the 1 row past the 90d cap; signed_off anchors under the cap are retained',
  )

  // Over-cap row gone; live/idle/recent AND the signed_off anchor survive.
  present = await peerIds()
  assert.ok(present.has(ids.signedOld), 'signed_off anchor under 90d SURVIVES (retained for resume rebind)')
  assert.ok(!present.has(ids.abandoned), 'any-status >90d row is GONE')
  assert.ok(present.has(ids.live), 'live row SURVIVES')
  assert.ok(present.has(ids.idle), 'idle row SURVIVES')
  assert.ok(present.has(ids.recent), 'stale-but-recent (never signed off, under 90d) row SURVIVES')

  // The abandoned session's graph residue is cleaned (no orphan node/edge).
  const verify = new Database(DB_PATH, { readonly: true })
  try {
    const ent = verify.prepare('SELECT COUNT(*) AS c FROM entries WHERE id = ?').get(ids.abandoned) as {
      c: number
    }
    const edge = verify
      .prepare('SELECT COUNT(*) AS c FROM edges WHERE src = ? OR dst = ?')
      .get(ids.abandoned, ids.abandoned) as { c: number }
    const meta = verify.prepare('SELECT COUNT(*) AS c FROM session_meta WHERE id = ?').get(
      ids.abandoned,
    ) as { c: number }
    assert.equal(ent.c, 0, 'pruned session entries stub-node removed')
    assert.equal(edge.c, 0, 'pruned session incident edge removed')
    assert.equal(meta.c, 0, 'pruned session_meta row removed')
  } finally {
    verify.close()
  }

  // Idempotent: a second prune removes nothing.
  const { pruned: again } = await post('/prune-sessions', {})
  assert.equal(again, 0, 'a second prune removes nothing (idempotent)')

  console.log('stale-prune.test.ts: passed')
  cleanup()
  process.exit(0)
} catch (e) {
  console.error(e)
  cleanup()
  process.exit(1)
}
