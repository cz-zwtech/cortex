#!/usr/bin/env tsx
/** A `feedback` memory with top-level `engagement: true` syncs with engagement=1; untagged → 0. */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-eng-home-'))
const dbdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-eng-db-'))
const memDir = path.join(home, '.claude', 'memory'); fs.mkdirSync(memDir, { recursive: true })
fs.writeFileSync(path.join(memDir, 'response-brevity.md'),
  '---\nname: response-brevity\ndescription: Concise, no sycophancy; brief-first; options with pros/cons\ntype: feedback\nengagement: true\n---\nbody\n')
fs.writeFileSync(path.join(memDir, 'some-note.md'),
  '---\nname: some-note\ndescription: just a note\ntype: feedback\n---\nbody\n')
const PORT = 3096; const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1', CKN_HOME: home,
  CKN_SERVER_URL: BASE,
  CKN_GRAPH_DB_PATH: path.join(dbdir, 'graph.sqlite'),
  CKN_PRIVATE_MIND: 'off', CKN_EMBEDDINGS: 'off', CKN_MESH_PEERS: '', CKN_MESH_TOKEN: '' }
const cleanup = () => { try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch {}
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dbdir, { recursive: true, force: true }) }

async function start() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], { cwd: repoRoot, env, stdio: 'ignore', detached: true })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/home`)).ok) return } catch {} await sleep(150) }
  throw new Error('server never came up')
}
const runSync = () => new Promise<void>((res, rej) => {
  const cp = spawn('node_modules/.bin/tsx', ['bin/ckn-sync.ts'], { cwd: repoRoot, env, stdio: 'ignore' })
  cp.on('close', (c) => (c === 0 ? res() : rej(new Error('sync exit ' + c))))
})

let passed = 0; const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }
try {
  await start(); await runSync()
  const all = await fetch(`${BASE}/api/graph/search?q=response-brevity`).then((r) => r.json())
  assert.ok(all.entries?.length, 'tagged memory synced')
  // engagement endpoint (built in Task 3) is the cleanest read; here assert via it once it exists.
  const eng = await fetch(`${BASE}/api/profile/engagement`).then((r) => r.json())
  const names = (eng.directives ?? []).map((d: any) => d.name)
  assert.deepEqual(names, ['response-brevity'], 'only the engagement-tagged feedback is returned')
  ok('engagement flag persisted + served')
  console.log(`\n${passed} assertions passed.`); cleanup(); process.exit(0)
} catch (e) { console.error(e); cleanup(); process.exit(1) }
