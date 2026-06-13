#!/usr/bin/env tsx
/**
 * s2a slice 1 — the `thread` kind read layer (Item-2 resume surface data layer).
 *
 * A thread is a graph entry with kind='thread'. owner_machine maps to the
 * existing `machine` column; the structured state (status/next_step/links/
 * repo/branch/pushed) lives in `content` as JSON. The resume surface needs to
 * list threads filtered by owner machine + status, CWD-INDEPENDENT (open
 * threads follow you across projects, unlike cwd-scoped recall).
 *
 * Temp-DB pattern mirrors test/graph/recall-for-file.test.ts: set
 * CKN_GRAPH_DB_PATH + CKN_EMBEDDINGS=off + HOME before importing db.js.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-threads-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { listThreads, getThread } = await import('../../server/graph/threads.js')

getDb()

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

const threadEntry = (
  id: string,
  machine: string,
  scope: string,
  status: string,
  nextStep: string,
  updatedAt: number,
  extra: { links?: string[]; repo?: string; branch?: string; pushed?: boolean } = {},
) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, machine)
     VALUES (?, ?, 'thread', ?, ?, 'src', ?, ?, ?, ?)`,
    id,
    `name-${id}`,
    `summary of ${id}`,
    JSON.stringify({
      status,
      next_step: nextStep,
      links: extra.links ?? [],
      repo: extra.repo,
      branch: extra.branch,
      pushed: extra.pushed,
    }),
    scope,
    updatedAt,
    updatedAt,
    machine,
  )

const memEntry = (id: string, machine: string) =>
  run(
    `INSERT INTO entries (id, name, kind, description, content, source, scope, updatedAt, syncedAt, machine)
     VALUES (?, ?, 'memory', '', '', 'src', 'memory:auto', ?, ?, ?)`,
    id,
    `name-${id}`,
    NOW,
    NOW,
    machine,
  )

// box-A threads under two different project scopes (cwd-independence) + one done.
threadEntry('t-open', 'box-A', 'thread:proj1', 'open', 'wire up the route', NOW - 1 * DAY)
threadEntry('t-prog', 'box-A', 'thread:proj2', 'in-progress', 'review CI', NOW, {
  links: ['m-foo'],
  repo: 'cortex',
  branch: 'feat/x',
  pushed: false,
})
threadEntry('t-done', 'box-A', 'thread:proj1', 'done', 'shipped', NOW - 2 * DAY)
// a different machine's thread + a non-thread memory (must never surface as threads)
threadEntry('t-otherbox', 'box-B', 'thread:proj1', 'open', 'their work', NOW - 1 * DAY)
memEntry('m-mem', 'box-A')

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

// ── 1. list by owner machine — cwd-independent, threads only
{
  const hits = listThreads({ ownerMachine: 'box-A' })
  const ids = new Set(hits.map((t) => t.id))
  assert.ok(ids.has('t-open') && ids.has('t-prog') && ids.has('t-done'), 'all box-A threads (any scope) surface')
  assert.ok(!ids.has('t-otherbox'), 'a different machine thread is excluded')
  assert.ok(!ids.has('m-mem'), 'a non-thread memory is never a thread')
  ok('list by owner machine is cwd-independent + thread-only')
}

// ── 2. status filter (the resume surface drops done)
{
  const hits = listThreads({ ownerMachine: 'box-A', statuses: ['open', 'in-progress', 'pending', 'blocked'] })
  const ids = new Set(hits.map((t) => t.id))
  assert.ok(ids.has('t-open') && ids.has('t-prog'), 'open + in-progress kept')
  assert.ok(!ids.has('t-done'), 'done excluded by status filter')
  ok('status filter excludes done')
}

// ── 3. no machine filter → all threads regardless of owner
{
  const hits = listThreads({})
  const ids = new Set(hits.map((t) => t.id))
  assert.ok(ids.has('t-otherbox'), 'cross-machine thread present when unfiltered')
  assert.ok(!ids.has('m-mem'), 'still thread-only')
  ok('no owner filter returns all machines threads')
}

// ── 4. sorted most-recent first
{
  const hits = listThreads({ ownerMachine: 'box-A' })
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].updatedAt >= hits[i].updatedAt, 'sorted by updatedAt desc')
  }
  assert.equal(hits[0].id, 't-prog', 'most recent thread first')
  ok('sorted most-recent first')
}

// ── 5. getThread parses the structured state
{
  const t = getThread('t-prog')
  assert.ok(t, 'thread found')
  assert.equal(t!.ownerMachine, 'box-A', 'owner machine from machine column')
  assert.equal(t!.description, 'summary of t-prog', 'description is the one-line summary')
  assert.equal(t!.state.status, 'in-progress', 'status parsed')
  assert.equal(t!.state.nextStep, 'review CI', 'next_step parsed')
  assert.deepEqual(t!.state.links, ['m-foo'], 'links parsed')
  assert.equal(t!.state.repo, 'cortex', 'repo parsed')
  assert.equal(t!.state.branch, 'feat/x', 'branch parsed')
  assert.equal(t!.state.pushed, false, 'pushed parsed')
  ok('getThread parses structured state')
}

// ── 6. getThread is thread-only + safe on miss
{
  assert.equal(getThread('m-mem'), null, 'a memory id is not a thread')
  assert.equal(getThread('does-not-exist'), null, 'missing id → null')
  ok('getThread is thread-only and null-safe')
}

console.log(`\nOK threads.test.ts — ${passed} assertions passed`)
