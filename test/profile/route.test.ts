#!/usr/bin/env tsx
/** /api/profile observe + read, against a throwaway server (mesh off, temp DB). */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-profile-route-'))
const PORT = 3098
const BASE = `http://127.0.0.1:${PORT}/api/profile`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => { try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch {}
  fs.rmSync(dir, { recursive: true, force: true }) }

async function start() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: { ...process.env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: path.join(dir, 'graph.sqlite'),
      CKN_PRIVATE_MIND: 'off', CKN_EMBEDDINGS: 'off', CKN_MESH_PEERS: '', CKN_MESH_TOKEN: '' },
    stdio: 'ignore', detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server never came up')
}

try {
  await start()
  const post = (b: any) => fetch(`${BASE}/observe`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
  // observe two distinct sessions of the same facet
  await post({ sessionId: 's1', candidates: [{ dimension: 'communication', facet_key: 'verbosity',
    stance: 'terse', statement: 'Prefers terse', valence: 'trait', classification: 'perception' }] })
  await post({ sessionId: 's2', candidates: [{ dimension: 'communication', facet_key: 'verbosity',
    stance: 'terse', statement: 'Prefers terse', valence: 'trait', classification: 'perception' }] })
  const got = await fetch(BASE).then((r) => r.json())
  assert.ok(got.facets.some((f: any) => f.stance === 'terse' && f.evidence_count === 2),
    'GET /api/profile returns the merged facet (2 sessions)')
  // override classification is NOT ingested as perception
  await post({ sessionId: 's3', candidates: [{ dimension: 'communication', facet_key: 'tone',
    stance: 'formal', statement: 'asked to be formal now', valence: 'neutral', classification: 'override' }] })
  const got2 = await fetch(BASE).then((r) => r.json())
  assert.ok(!got2.facets.some((f: any) => f.facet_key === 'tone'),
    'override candidate is not stored as a perception facet')
  await fetch(`${BASE}/narrative`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Corey values terse, high-signal exchanges.' }) })
  const withNarr = await fetch(BASE).then((r) => r.json())
  assert.equal(withNarr.narrative, 'Corey values terse, high-signal exchanges.', 'narrative round-trips')
  console.log('route.test.ts: passed'); cleanup(); process.exit(0)
} catch (e) { console.error(e); cleanup(); process.exit(1) }
