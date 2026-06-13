#!/usr/bin/env tsx
/**
 * s1 integration: the /api/graph/recall/for-file route writes a SURFACED_IN edge
 * for each recalled memory when given a sessionId. DETERMINISTIC — recallForFile is
 * edge-based (MENTIONS_FILE), no embeddings — so this proves the foundational wiring
 * (recall call → graph surfacing edge) that the unit + boot-smoke tests don't cover.
 *
 * Spawns a throwaway server on a temp port + temp SQLite (mirrors touch.test.ts).
 * Seeds the graph by DIRECT better-sqlite3 BEFORE the server boots, then asserts via
 * a read-only connection AFTER the route's synchronous write commits.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-s1-route-'))
const DB = path.join(dir, 'graph.sqlite')
const PORT = 3098
const ts = Date.now()
const MEM = `mem:s1route-${ts}`
const SESS = `sess-s1route-${ts}`
const FILE = 'server/graph/surfacings.ts'
const fileId = `file:${FILE.replace(/\//g, '_')}`

let server: ChildProcess | null = null
const cleanup = () => {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── seed BEFORE boot: a memory + a file stub + a MENTIONS_FILE edge ───────────
{
  const schema = fs.readFileSync(path.join(repoRoot, 'server/graph/schema.sql'), 'utf8')
  const seed = new Database(DB)
  seed.exec(schema)
  const ins = `INSERT INTO entries
    (id, name, kind, description, content, source, scope, updatedAt, syncedAt, authorship,
     outcome, outcome_text, agent_id, session_id, pinned, engagement, machine, content_hash)
    VALUES (?, ?, ?, ?, ?, '', 'user', 0, 0, 'human', '', '', '', '', 0, 0, '', '')`
  seed.prepare(ins).run(MEM, MEM, 'memory', 'a memory about the surfacings module', 'body mentions the file')
  seed.prepare(ins).run(fileId, FILE, 'file', '', '')
  seed
    .prepare(`INSERT INTO edges (src, dst, rel, provenance) VALUES (?, ?, 'MENTIONS_FILE', 'frontmatter')`)
    .run(MEM, fileId)
  seed.close()
}

async function startServer() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CKN_PORT: String(PORT),
      CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: DB,
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
    } catch { /* not up yet */ }
    await sleep(150)
  }
  throw new Error('s1-route test server never came up on :' + PORT)
}

const forFile = (body: any) =>
  fetch(`http://127.0.0.1:${PORT}/api/graph/recall/for-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const surfRows = () => {
  const ro = new Database(DB, { readonly: true })
  const row = ro
    .prepare(`SELECT weight, notedAt FROM edges WHERE src=? AND dst=? AND rel='SURFACED_IN'`)
    .get(MEM, SESS) as { weight: number; notedAt: number } | undefined
  const total = (ro.prepare(`SELECT count(*) c FROM edges WHERE rel='SURFACED_IN'`).get() as { c: number }).c
  const sess = ro.prepare(`SELECT kind FROM entries WHERE id=?`).get(SESS) as { kind: string } | undefined
  ro.close()
  return { row, total, sess }
}

async function main() {
  await startServer()

  // 1. for-file recall WITH a sessionId → recalls the memory + writes SURFACED_IN.
  const r = await forFile({ file: FILE, sessionId: SESS, limit: 5 })
  assert.ok(r.ok, `/recall/for-file -> ${r.status}`)
  const { hits } = (await r.json()) as { hits: { id: string }[] }
  assert.ok(hits.some((h) => h.id === MEM), 'recallForFile returned the memory that MENTIONS_FILE the target')

  await sleep(150) // let the route's synchronous write settle into WAL
  {
    const { row, total, sess } = surfRows()
    assert.ok(row, 'route wrote a SURFACED_IN edge for the recalled memory')
    assert.equal(row!.weight, 1, 'surface count = 1')
    assert.ok(row!.notedAt > 0, 'notedAt set')
    assert.equal(sess?.kind, 'session', 'the route ensured the session stub')
    assert.equal(total, 1, 'exactly one surfacing edge so far')
  }

  // 2. a repeat (same memory+session) increments the count, no new row.
  await forFile({ file: FILE, sessionId: SESS, limit: 5 })
  await sleep(150)
  {
    const { row, total } = surfRows()
    assert.equal(row!.weight, 2, 'repeat recall increments the surface count')
    assert.equal(total, 1, 'still one edge (upsert, not a new row)')
  }

  // 3. a recall WITHOUT a sessionId still 200s but records NO surfacing.
  const r3 = await forFile({ file: FILE, limit: 5 })
  assert.ok(r3.ok, 'for-file without sessionId still returns 200')
  await sleep(150)
  assert.equal(surfRows().total, 1, 'no sessionId → no surfacing recorded (graceful no-op)')

  console.log('surfacings-route.test.ts: all assertions passed')
}

main().then(cleanup).catch((err) => { cleanup(); console.error(err); process.exit(1) })
