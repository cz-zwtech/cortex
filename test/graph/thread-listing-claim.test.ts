#!/usr/bin/env tsx
/**
 * s2a slice 3 — claim-annotated thread listing (the data behind /cortex-threads
 * + /cortex-continue).
 *
 * /cortex-threads shows every open thread with its claim state so you can see
 * what's in flight and who's on what. /cortex-continue resumes one — its
 * candidate set is the OPEN threads NOT held by another live session (pending or
 * already-mine); a thread a present peer is actively working (claimed-other) is
 * NOT offered, so two sessions don't collide on the same resume.
 *
 * Temp-DB pattern mirrors test/graph/thread-claim.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-thread-list-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { claimThread, listThreadsWithClaim, resumableThreads } = await import(
  '../../server/graph/threads.js'
)
const { STALE_MS } = await import('../../server/bus/identity.js')

getDb()

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

const session = (id: string, lastSeen: number, status = '') =>
  run(`INSERT INTO session_meta (id, last_seen, status) VALUES (?, ?, ?)`, id, lastSeen, status)
const thread = (id: string, machine: string, status: string, updatedAt: number) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, machine)
     VALUES (?, ?, 'thread', ?, ?, 'src', 'thread:p', ?, ?, ?)`,
    id,
    `n-${id}`,
    `summary ${id}`,
    JSON.stringify({ status, next_step: `do ${id}` }),
    updatedAt,
    updatedAt,
    machine,
  )

session('me', NOW - 60_000) // live
session('peer-live', NOW - 60_000) // live
session('peer-gone', NOW - (STALE_MS + 60_000)) // stale → claim lapses

thread('t-pending', 'box-A', 'open', NOW - 3 * DAY)
thread('t-mine', 'box-A', 'in-progress', NOW - 1 * DAY)
thread('t-peer', 'box-A', 'open', NOW - 2 * DAY)
thread('t-lapsed', 'box-A', 'blocked', NOW - 4 * DAY)
thread('t-done', 'box-A', 'done', NOW)
thread('t-otherbox', 'box-B', 'open', NOW)

claimThread('t-mine', 'me', NOW)
claimThread('t-peer', 'peer-live', NOW)
claimThread('t-lapsed', 'peer-gone', NOW) // claimer stale → lapses to pending

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. listThreadsWithClaim annotates each thread with my-relative claim state
{
  const byId = new Map(
    listThreadsWithClaim('me', NOW, { ownerMachine: 'box-A' }).map((t) => [t.id, t.claimState]),
  )
  assert.equal(byId.get('t-pending'), 'pending', 'unclaimed → pending')
  assert.equal(byId.get('t-mine'), 'claimed-mine', 'my live claim → claimed-mine')
  assert.equal(byId.get('t-peer'), 'claimed-other', 'peer live claim → claimed-other')
  assert.equal(byId.get('t-lapsed'), 'pending', 'stale claimer → lapsed → pending')
  ok('listThreadsWithClaim annotates claim state per session')
}

// ── 2. resumableThreads = open AND not held by another live session
{
  const ids = new Set(resumableThreads('me', NOW, { ownerMachine: 'box-A' }).map((t) => t.id))
  assert.ok(ids.has('t-pending'), 'pending open thread is resumable')
  assert.ok(ids.has('t-mine'), 'my own claimed thread is resumable')
  assert.ok(ids.has('t-lapsed'), 'a lapsed (stale-claimer) thread is resumable again')
  assert.ok(!ids.has('t-peer'), 'a thread a live peer holds is NOT offered')
  assert.ok(!ids.has('t-done'), 'a done thread is never a resume candidate')
  ok('resumableThreads excludes claimed-other + done')
}

// ── 3. resumableThreads honors the owner-machine filter
{
  const ids = new Set(resumableThreads('me', NOW, { ownerMachine: 'box-A' }).map((t) => t.id))
  assert.ok(!ids.has('t-otherbox'), 'another machine thread excluded by owner filter')
  const all = new Set(resumableThreads('me', NOW).map((t) => t.id))
  assert.ok(all.has('t-otherbox'), 'unfiltered → cross-machine resumable thread present')
  ok('resumableThreads honors ownerMachine filter')
}

console.log(`\nOK thread-listing-claim.test.ts — ${passed} assertions passed`)
