#!/usr/bin/env tsx
/**
 * ABOUT tier-1 slice 3: POST /api/graph/recall/for-file.
 *
 * Thin HTTP wrapper over recallForFile. Mounts graphRouter on a throwaway
 * express app (no full server boot) against a temp DB. Contract: {repo, file}
 * in, {hits} out; a missing/blank file yields {hits: []} (never an error — the
 * PreToolUse hook must stay quiet, not fail the edit).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import express from 'express'

process.env.CKN_EMBEDDINGS = 'off'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-forfile-route-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.HOME = dir

const { getDb, run } = await import('../../server/graph/db.js')
const { graphRouter } = await import('../../server/routes/graph.js')
getDb()

const NOW = Date.now()
const fileEntryId = (p: string): string => `file:${p.replace(/\//g, '_').replace(/\\/g, '_')}`
const STORED = '/home/claude/cortex/bin/ckn-sync.ts' // absolute, cross-machine

run(
  `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,pinned)
   VALUES (?,?,?,?,?,?,?,?,?,0)`,
  'm1', 'name-m1', 'memory', 'desc-m1', 'x'.repeat(80), 'src', 'memory:auto', NOW, NOW,
)
run(
  `INSERT INTO entries (id,name,kind,description,content,source,scope,updatedAt,syncedAt,pinned)
   VALUES (?,?, 'file','','','','file',?,?,0)`,
  fileEntryId(STORED), STORED, NOW, NOW,
)
run(`INSERT INTO edges (src,dst,rel) VALUES (?,?,'MENTIONS_FILE')`, 'm1', fileEntryId(STORED))

const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = app.listen(0)
await new Promise<void>((r) => server.once('listening', () => r()))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const post = (body: unknown) =>
  fetch(`${base}/api/graph/recall/for-file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// 1. a repo-relative target surfaces the absolute-stored memory
{
  const res = await post({ repo: 'cortex', file: 'bin/ckn-sync.ts' })
  assert.equal(res.status, 200, 'status 200')
  const body = (await res.json()) as { hits?: { id: string }[] }
  assert.ok(Array.isArray(body.hits), 'hits is an array')
  assert.ok(body.hits!.some((h) => h.id === 'm1'), 'matching memory returned')
  ok('POST returns the file-knowledge hit for a repo-relative target')
}

// 2. blank/missing file → 200 {hits: []} (quiet, never an error)
{
  const res = await post({ repo: 'cortex' })
  assert.equal(res.status, 200, 'status 200 even with no file')
  const body = (await res.json()) as { hits?: unknown[] }
  assert.deepEqual(body.hits, [], 'missing file → empty hits')
  ok('missing file yields empty hits, not an error')
}

server.close()
console.log(`\nOK recall-for-file-route.test.ts — ${passed} assertions passed`)
