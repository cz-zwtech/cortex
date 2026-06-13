#!/usr/bin/env tsx
/**
 * s2a slice 2 — claim-on-presence for `thread` nodes.
 *
 * A CLAIM links a thread to the SESSION working it (distinct from owner_machine,
 * which is the MACHINE that owns the work). A claim is ACTIVE only while its
 * session is present on the bus (presenceStatus live|idle); it LAPSES to pending
 * when the session goes stale or signs off — so `/cortex-threads` shows it as
 * available again. Lineage is preserved (append-only claimed_at/released_at).
 *
 * Temp-DB pattern mirrors test/graph/threads.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-claim-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { claimThread, releaseThread, threadClaimState } = await import('../../server/graph/threads.js')
const { LIVE_MS, STALE_MS } = await import('../../server/bus/identity.js')

getDb()

const NOW = 1_700_000_000_000
const session = (id: string, lastSeen: number, status = '') =>
  run(`INSERT INTO session_meta (id, last_seen, status) VALUES (?, ?, ?)`, id, lastSeen, status)
const thread = (id: string) =>
  run(
    `INSERT INTO entries (id, name, kind, content, source, scope, updatedAt, syncedAt)
     VALUES (?, ?, 'thread', '{}', 'src', 'thread:p', ?, ?)`,
    id,
    `n-${id}`,
    NOW,
    NOW,
  )

thread('t1')
session('live-sess', NOW - 60_000) // 1 min ago → live
session('idle-sess', NOW - (LIVE_MS + 60_000)) // > LIVE_MS, < STALE_MS → idle (still present)
session('stale-sess', NOW - (STALE_MS + 60_000)) // > STALE_MS → stale
session('off-sess', NOW, 'signed_off') // explicit signoff overrides age

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. unclaimed → pending
{
  assert.equal(threadClaimState('t1', 'me', NOW), 'pending', 'unclaimed thread is pending')
  ok('unclaimed thread is pending')
}

// ── 2. live claimer → claimed-other / claimed-mine
{
  claimThread('t1', 'live-sess', NOW)
  assert.equal(threadClaimState('t1', 'me', NOW), 'claimed-other', 'live claimer != me → claimed-other')
  assert.equal(threadClaimState('t1', 'live-sess', NOW), 'claimed-mine', 'live claimer == me → claimed-mine')
  ok('live claim → claimed-other / claimed-mine')
}

// ── 3. release → back to pending (lineage row remains, released_at set)
{
  releaseThread('t1', 'live-sess', NOW)
  assert.equal(threadClaimState('t1', 'me', NOW), 'pending', 'released → pending')
  ok('released claim returns to pending')
}

// ── 4. idle (still present) session holds the claim
{
  claimThread('t1', 'idle-sess', NOW)
  assert.equal(threadClaimState('t1', 'me', NOW), 'claimed-other', 'idle claimer still present → held')
  releaseThread('t1', 'idle-sess', NOW)
  ok('idle (present) session holds the claim')
}

// ── 5. stale claimer → claim LAPSES to pending
{
  claimThread('t1', 'stale-sess', NOW)
  assert.equal(threadClaimState('t1', 'me', NOW), 'pending', 'stale claimer → lapsed → pending')
  releaseThread('t1', 'stale-sess', NOW)
  ok('stale claim lapses to pending')
}

// ── 6. signed_off claimer → lapses
{
  claimThread('t1', 'off-sess', NOW)
  assert.equal(threadClaimState('t1', 'me', NOW), 'pending', 'signed_off claimer → lapsed')
  ok('signed_off claim lapses to pending')
}

console.log(`\nOK thread-claim.test.ts — ${passed} assertions passed`)
