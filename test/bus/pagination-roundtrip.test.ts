#!/usr/bin/env tsx
/**
 * Pagination round-trip (slices 2+3) against a throwaway bus server.
 *
 * Proves the laptop m2m-blocker fix end-to-end on the REAL CLI + server + hook:
 *   - `ckn-bus send` splits a long body into N parts (slice 2);
 *   - the parts land as normal messages carrying [[ckn-page]] headers;
 *   - reassembleList over the stored parts reconstructs the original;
 *   - the REAL ckn-pause-context (the surface the agent reads) renders ONE
 *     reassembled message — no [[ckn-page]] fragments leak through (slice 3).
 *
 * Own server on a temp port + temp DB, mesh OFF — mirrors integration.test.ts.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-bus-paginate-'))
const PORT = 3098
const BASE = `http://127.0.0.1:${PORT}/api/bus`
const ts = Date.now()
const A = `pg-A-${ts}`
const B = `pg-B-${ts}`
const ALPHA = `pgalpha-${ts}`
const BETA = `pgbeta-${ts}`

const { parsePageHeader, reassembleList } = await import('../../bin/_bus-paginate.js')

let server: ChildProcess | null = null
const cleanup = () => {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const post = async (p: string, body: any) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}
const get = async (p: string) => {
  const r = await fetch(`${BASE}${p}`)
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}

const runTsx = (script: string, args: string[], session: string): Promise<{ out: string; code: number }> =>
  new Promise((resolve) => {
    const child = spawn('node_modules/.bin/tsx', [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, CKN_SERVER_URL: `http://127.0.0.1:${PORT}`, CLAUDE_CODE_SESSION_ID: session, CKN_AUTO_SNAPSHOT: 'off' },
    })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ out, code: code ?? 0 }))
    if (script.endsWith('ckn-pause-context.ts')) {
      child.stdin?.write(JSON.stringify({ session_id: session }))
      child.stdin?.end()
    }
  })

async function startServer() {
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
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/home`)).ok) return } catch { /* not up */ }
    await sleep(150)
  }
  throw new Error('paginate test server never came up on :' + PORT)
}

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const LONG = `PAGESTART_${'x'.repeat(3800)}_PAGEEND` // ~3818 chars → multiple parts at the 1500 limit

async function main() {
  await startServer()
  await post('/register', { sessionId: A, title: ALPHA, cwd: `/tmp/pg1-${ts}`, machine: 'mpg' })
  await post('/register', { sessionId: B, title: BETA, cwd: `/tmp/pg2-${ts}`, machine: 'mpg' })

  // ── slice 2: a long `ckn-bus send` splits into N>1 header-tagged parts ──────
  const sent = await runTsx('bin/ckn-bus.ts', ['send', '--to', BETA, '--body', LONG, '--session', A], A)
  assert.equal(sent.code, 0, `ckn-bus send exited 0 (out: ${sent.out.slice(0, 200)})`)

  const inbox = (await get(`/inbox?session=${B}&undeliveredOnly=1`)).messages as Array<{ id: string; body: string }>
  const parts = inbox.filter((m) => parsePageHeader(m.body) !== null)
  assert.ok(parts.length > 1, `long body split into >1 parts (got ${parts.length})`)
  const gids = new Set(parts.map((m) => parsePageHeader(m.body)!.groupId))
  assert.equal(gids.size, 1, 'all parts share one groupId')
  ok(`ckn-bus send split the long body into ${parts.length} parts (shared groupId)`)

  // ── reassembleList over the stored parts reconstructs the original body ─────
  const merged = reassembleList(inbox).find((m) => m.body === LONG)
  assert.ok(merged, 'reassembleList reconstructs the original body from the stored parts')
  assert.equal(merged!.partIds.length, parts.length, 'merged message carries every part id')
  ok('reassembleList reconstructs the original body from the real store')

  // ── slice 4: ckn-bus inbox reassembles parts into the whole message ────────
  // (non-consuming — leaves the parts undelivered for the pause-context check)
  const ib = await runTsx('bin/ckn-bus.ts', ['inbox', '--session', B], B)
  assert.ok(ib.out.includes('PAGESTART_') && ib.out.includes('_PAGEEND'), 'ckn-bus inbox shows the full body')
  assert.ok(!ib.out.includes('[[ckn-page'), 'ckn-bus inbox reassembles (no page-header fragments)')
  ok('ckn-bus inbox reassembles parts into the whole message')

  // ── slice 3: ckn-pause-context renders ONE reassembled message ─────────────
  const pc = await runTsx('bin/ckn-pause-context.ts', [], B)
  assert.ok(pc.out.includes('PAGESTART_') && pc.out.includes('_PAGEEND'), 'pause-context surfaces the full body')
  assert.ok(!pc.out.includes('[[ckn-page'), 'pause-context strips page headers (reassembled, not fragmented)')
  ok('ckn-pause-context reassembles the parts into one full message for the agent')
}

main()
  .then(() => { cleanup(); console.log(`\nOK pagination-roundtrip.test.ts — ${passed} assertions passed`) })
  .catch((e) => { cleanup(); console.error('FAIL:', e?.message ?? e); process.exit(1) })
