#!/usr/bin/env tsx
/**
 * s2a #31 — HTTP surface for /cortex-threads + /cortex-continue.
 *
 * GET  /api/graph/threads  — list open threads annotated with the asking
 *                            session's claim state (resumable=1 → only the
 *                            resume candidates: open AND not held by a live peer).
 * POST /api/graph/threads/:id/claim — claim a thread for a session (the write
 *                            that /cortex-continue performs; server is the single
 *                            writer, so the CLI routes through here).
 *
 * Server computes `now` (never trusts the client clock). Mounts graphRouter on a
 * throwaway express app against a temp DB — mirrors recall-for-file-route.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import express from 'express'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-threads-route-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { graphRouter } = await import('../../server/routes/graph.js')
getDb()

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const session = (id: string, lastSeen: number) =>
  run(`INSERT INTO session_meta (id, last_seen, status) VALUES (?, ?, '')`, id, lastSeen)
const thread = (id: string, machine: string, status: string, updatedAt: number) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, machine)
     VALUES (?, ?, 'thread', ?, ?, 'src', 'thread:p', ?, ?, ?)`,
    id, `n-${id}`, `summary ${id}`,
    JSON.stringify({ status, next_step: `do ${id}`, links: ['m-detail'] }),
    updatedAt, updatedAt, machine,
  )

session('me', NOW - 60_000) // live
session('peer', NOW - 60_000) // live
thread('t-free', 'box-A', 'open', NOW - 2 * DAY)
thread('t-peer', 'box-A', 'in-progress', NOW - 1 * DAY)
thread('t-done', 'box-A', 'done', NOW)
run(`INSERT INTO entries (id,name,kind,content,source,scope,updatedAt,syncedAt) VALUES ('m-mem','M','memory','','src','memory:auto',?,?)`, NOW, NOW)
run(`INSERT INTO thread_claims (thread_id, session_id, claimed_at, released_at) VALUES ('t-peer','peer',?,0)`, NOW)

const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = app.listen(0)
await new Promise<void>((r) => server.once('listening', () => r()))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}/api/graph`

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. GET threads (resumable) — open + not held by a live peer
{
  const res = await fetch(`${base}/threads?session=me&owner=box-A&resumable=1`)
  assert.equal(res.status, 200, 'status 200')
  const body = (await res.json()) as { threads: { id: string; claimState: string }[] }
  const ids = new Set(body.threads.map((t) => t.id))
  assert.ok(ids.has('t-free'), 'free open thread is a resume candidate')
  assert.ok(!ids.has('t-peer'), 'thread a live peer holds is withheld')
  assert.ok(!ids.has('t-done'), 'done thread is not a candidate')
  assert.ok(!ids.has('m-mem'), 'a memory is never a thread')
  ok('GET resumable threads filters to open + not-claimed-other')
}

// ── 2. GET threads (no resumable) — all open threads with claim annotation
{
  const res = await fetch(`${base}/threads?session=me&owner=box-A`)
  const body = (await res.json()) as { threads: { id: string; claimState: string }[] }
  const byId = new Map(body.threads.map((t) => [t.id, t.claimState]))
  assert.equal(byId.get('t-free'), 'pending', 't-free pending')
  assert.equal(byId.get('t-peer'), 'claimed-other', 't-peer held by a live peer')
  assert.ok(!byId.has('t-done'), 'done excluded from the open listing')
  ok('GET threads annotates claim state for all open threads')
}

// ── 3. POST claim — claims for me; reflected as claimed-mine
{
  const res = await fetch(`${base}/threads/t-free/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal(res.status, 200, 'claim 200')
  const body = (await res.json()) as { thread: { id: string; state: { nextStep: string } }; claimState: string }
  assert.equal(body.claimState, 'claimed-mine', 'claim reflected as mine')
  assert.equal(body.thread.state.nextStep, 'do t-free', 'claim returns the thread detail (next_step)')
  // a DIFFERENT session now sees it as claimed-other
  const peerView = await (await fetch(`${base}/threads?session=peer&owner=box-A`)).json()
  const m = new Map((peerView.threads as any[]).map((t) => [t.id, t.claimState]))
  assert.equal(m.get('t-free'), 'claimed-other', 'peer sees my fresh claim as claimed-other')
  ok('POST claim claims the thread + returns detail')
}

// ── 4. POST claim on a non-thread id → 404
{
  const res = await fetch(`${base}/threads/m-mem/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal(res.status, 404, 'claiming a non-thread → 404')
  ok('POST claim on a non-thread id is a 404')
}

// ── 5. POST claim resolves a BARE slug (the /cortex-continue passthrough) — a
//      thread with a thread:<slug> id is claimable by just <slug>.
{
  run(
    `INSERT INTO entries (id, name, kind, content, source, scope, updatedAt, syncedAt, machine)
     VALUES ('thread:resume-x', 'Resume X', 'thread', '{"status":"open","next_step":"go"}', 'src', 'thread:p', ?, ?, 'box-A')`,
    NOW, NOW,
  )
  const res = await fetch(`${base}/threads/resume-x/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal(res.status, 200, 'bare slug claim 200')
  const body = (await res.json()) as { thread: { id: string }; claimState: string }
  assert.equal(body.thread.id, 'thread:resume-x', 'bare slug resolved to the full thread id')
  assert.equal(body.claimState, 'claimed-mine', 'claimed under the resolved id')
  ok('POST claim resolves a bare slug to thread:<slug>')
}

// ── 6. POST release — graceful hand-off: a live session frees its claim so a
//      peer can resume immediately (s2b). Resolves a bare slug like claim does.
{
  // t-free was claimed by 'me' in test 3. Releasing it returns it to pending.
  const res = await fetch(`${base}/threads/t-free/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal((await res.json()).claimState, 'claimed-mine', 'precondition: t-free claimed-mine')

  const rel = await fetch(`${base}/threads/t-free/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal(rel.status, 200, 'release 200')
  const body = (await rel.json()) as { thread: { id: string }; claimState: string }
  assert.equal(body.thread.id, 't-free', 'release returns the thread')
  assert.equal(body.claimState, 'pending', 'released claim returns to pending (resumable by a peer)')

  // a fresh peer now sees it as a resume candidate again
  const peer = await (await fetch(`${base}/threads?session=peer2&owner=box-A&resumable=1`)).json()
  assert.ok((peer.threads as any[]).some((t) => t.id === 't-free'), 'released thread is resumable again')
  ok('POST release frees the claim (graceful hand-off → pending)')
}

// ── 7. release a non-thread / unknown ref → 404
{
  const res = await fetch(`${base}/threads/nope/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'me' }),
  })
  assert.equal(res.status, 404, 'release of an unknown ref → 404')
  ok('POST release on an unknown ref is a 404')
}

server.close()
console.log(`\nOK threads-route.test.ts — ${passed} assertions passed`)
