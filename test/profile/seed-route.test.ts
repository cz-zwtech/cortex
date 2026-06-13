#!/usr/bin/env tsx
/** POST /api/profile/seed: declared onboarding seeds, invalid-dimension skip, non-array → 400.
 * Mirrors route.test.ts — a throwaway server (mesh off, temp DB) hit over fetch. The same
 * temp DB file is opened read-side in this process (WAL allows cross-process reads) to assert
 * the stored facet count + provenance via the graph functions directly. */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-profile-seed-route-'))
const dbPath = path.join(dir, 'graph.sqlite')
const PORT = 3099
const BASE = `http://127.0.0.1:${PORT}/api/profile`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => { try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch {}
  fs.rmSync(dir, { recursive: true, force: true }) }

// Read-side: this process opens the same WAL DB the server writes to.
process.env.CKN_EMBEDDINGS = 'off'
process.env.CKN_GRAPH_DB_PATH = dbPath
const { profileFacetCount, getFacet, facetId } = await import('../../server/graph/profile.js')

async function start() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: { ...process.env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: dbPath,
      CKN_PRIVATE_MIND: 'off', CKN_EMBEDDINGS: 'off', CKN_MESH_PEERS: '', CKN_MESH_TOKEN: '' },
    stdio: 'ignore', detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server never came up')
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
const seed = (b: any) => fetch(`${BASE}/seed`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })

const validFacet = {
  dimension: 'communication', facet_key: 'answer-length', stance: 'brief-first',
  statement: 'Prefers brief answers first, expanded on request', valence: 'like',
}

try {
  await start()

  // 1. One valid candidate → { seeded: 1 }; stored as a 'declared' facet.
  const r1 = await seed({ candidates: [validFacet] })
  assert.equal(r1.status, 200, 'valid seed → 200')
  assert.deepEqual(await r1.json(), { seeded: 1 }, 'responds { seeded: 1 }')
  assert.equal(profileFacetCount(), 1, 'one facet on record after seeding')
  const f = getFacet(facetId(validFacet as any))!
  assert.ok(f, 'seeded facet is retrievable')
  assert.equal(f.source, 'declared', 'seeded facet is provenance-labeled declared')
  ok('POST /seed with one valid candidate seeds a declared facet')

  // 2. Invalid dimension is skipped → { seeded: 0 }, nothing new on record.
  const r2 = await seed({ candidates: [{ ...validFacet, dimension: 'not-a-dimension', facet_key: 'x', stance: 'y' }] })
  assert.equal(r2.status, 200, 'invalid-dimension request still 200')
  assert.deepEqual(await r2.json(), { seeded: 0 }, 'invalid candidate skipped → seeded 0')
  assert.equal(profileFacetCount(), 1, 'no new facet recorded for an invalid candidate')
  ok('POST /seed skips a candidate with an invalid dimension')

  // 3. Non-array candidates → 400.
  const r3 = await seed({ candidates: 'nope' })
  assert.equal(r3.status, 400, 'non-array candidates → 400')
  ok('POST /seed rejects non-array candidates with 400')

  console.log(`\n${passed} assertions passed.`)
  cleanup(); process.exit(0)
} catch (e) {
  console.error('\nFAIL:', e instanceof Error ? e.message : e)
  cleanup(); process.exit(1)
}
