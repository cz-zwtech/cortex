#!/usr/bin/env tsx
/**
 * ckn-observe-facets CLI (Path B capture): pipe facet JSON on stdin → the CLI
 * POSTs to /api/profile/observe → the facets appear in /api/profile. Also
 * verifies `override` candidates are dropped (not perceptions) and that a
 * missing session id is an error. Runs against a throwaway server + temp DB,
 * mesh + embeddings off (mirrors route.test.ts).
 */
import assert from 'node:assert/strict'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(repoRoot, 'node_modules/.bin/tsx')
const SCRIPT = path.join(repoRoot, 'bin/ckn-observe-facets.ts')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-observe-cli-'))
const PORT = 3097
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch { /* already gone */ }
  fs.rmSync(dir, { recursive: true, force: true })
}

async function start(): Promise<void> {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: path.join(dir, 'graph.sqlite'),
      CKN_PRIVATE_MIND: 'off', CKN_EMBEDDINGS: 'off', CKN_MESH_PEERS: '', CKN_MESH_TOKEN: '',
    },
    stdio: 'ignore', detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/home`)).ok) return } catch { /* not up yet */ }
    await sleep(150)
  }
  throw new Error('server never came up')
}

const runCli = (
  input: string,
  args: string[] = ['--session', 'cli-test-sess'],
  cwd: string = repoRoot,
): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    const cp = spawn(TSX, [SCRIPT, ...args], {
      cwd,
      // Blank CLAUDE_CODE_SESSION_ID so resolution is driven only by --session / cwd.
      env: { ...process.env, CKN_SERVER_URL: BASE, CLAUDE_CODE_SESSION_ID: '' },
    })
    let out = '', err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.stdin.on('error', () => { /* child may exit before reading stdin (EPIPE) */ })
    cp.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    cp.stdin.write(input); cp.stdin.end()
  })

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

try {
  await start()

  // 1. Two valid perceptions in distinct dimensions → both observed + visible.
  const facetJson = JSON.stringify({
    facets: [
      { dimension: 'communication', facet_key: 'verbosity', stance: 'terse',
        statement: 'Prefers terse answers with options', valence: 'trait', classification: 'perception' },
      { dimension: 'work-cadence', facet_key: 'pace', stance: 'momentum-over-ceremony',
        statement: 'Pushes momentum over process ceremony', valence: 'trait', classification: 'perception' },
    ],
  })
  const r1 = await runCli(facetJson)
  assert.equal(r1.code, 0, `CLI exits 0 (out=${r1.out} err=${r1.err})`)
  assert.match(r1.out, /observed 2 facet/, 'reports 2 observed')
  ok('pipes facet JSON on stdin → observes 2 facets')

  const profile = await fetch(`${BASE}/api/profile`).then((r) => r.json())
  assert.equal(profile.facets.length, 2, 'both facets present in /api/profile')
  assert.deepEqual(
    profile.facets.map((f: any) => f.dimension).sort(),
    ['communication', 'work-cadence'],
    'correct dimensions landed',
  )
  ok('observed facets appear in /api/profile')

  // 2. Fenced JSON + an override candidate: parser strips the fence, server
  //    drops the override (not a perception) → facet count unchanged.
  const fenced = '```json\n' + JSON.stringify({
    facets: [
      { dimension: 'communication', facet_key: 'tone', stance: 'lightweight',
        statement: 'keep it light right now', valence: 'neutral', classification: 'override' },
    ],
  }) + '\n```'
  const r2 = await runCli(fenced)
  assert.equal(r2.code, 0, `CLI exits 0 on override-only input (err=${r2.err})`)
  const profile2 = await fetch(`${BASE}/api/profile`).then((r) => r.json())
  assert.equal(profile2.facets.length, 2, 'override not added as a facet')
  ok('fenced JSON parsed + override classification dropped server-side')

  // 3. No session id resolvable (run from a transcript-less cwd, env blanked,
  //    no --session) → exit 2.
  const r3 = await runCli(facetJson, [], dir)
  assert.equal(r3.code, 2, `missing session id is a usage error (out=${r3.out} err=${r3.err})`)
  assert.match(r3.err, /session id/i, 'explains the missing session id')
  ok('errors cleanly when no session id is resolvable')

  console.log(`\n${passed} assertions passed.`)
  cleanup()
  process.exit(0)
} catch (e) {
  console.error(e)
  cleanup()
  process.exit(1)
}
