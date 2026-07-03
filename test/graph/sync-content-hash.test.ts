#!/usr/bin/env tsx
/**
 * Regression test for the ckn-sync content-hash change-detection fix.
 *
 * THE BUG: sync decided what to re-upsert purely by file mtime. A body-only
 * edit whose mtime did NOT advance past the stored value (atomic-rename editors
 * that preserve mtime, coarse-granularity filesystems, sub-second re-edits) was
 * silently skipped -> the graph kept the OLD body -> recall served stale content.
 *
 * THE FIX: content hash (sha256 of raw file bytes) is the change signal. A file
 * is re-upserted iff its hash differs from the stored content_hash. mtime is
 * still stored (ordering/display) but is no longer the change signal.
 *
 * Throwaway server + temp CKN_HOME + temp DB (mirrors profile/route.test.ts).
 * ckn-sync runs via bin/ckn-sync.ts pointed at this server (CKN_SERVER_URL);
 * the body is read back via GET /api/graph/node/:id which exposes entry.content.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sync-hash-home-'))
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sync-hash-db-'))
// #108: isolate the config dir too. Without it the spawned server read+wrote the
// REAL ~/.config/ckn (migrations.json + mesh state), so this test's outcome
// depended on the state other tests left behind — an order-dependence in the
// full graph-test sequence.
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-sync-hash-cfg-'))
const PORT = 3093
const SERVER_URL = `http://127.0.0.1:${PORT}`
const memDir = path.join(home, '.claude', 'memory')
const memFile = path.join(memDir, 'hash-fixture.md')
const ENTRY_ID = 'user/hash-fixture'

let server: ChildProcess | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cleanup = () => {
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL') } catch {}
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dbDir, { recursive: true, force: true })
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

// Env shared by the server and every ckn-sync invocation: temp home for the
// memory tree, temp DB, mesh off, embeddings off.
const env = {
  ...process.env,
  CKN_HOME: home,
  CKN_GRAPH_DB_PATH: path.join(dbDir, 'graph.sqlite'),
  CKN_CONFIG_DIR: cfgDir,
  // Sentinel: the spawned server boot must NOT register real hooks (shouldRegisterHooks
  // returns false) and must never fall back to the default DB — keeps the test hermetic
  // and off the real ~/.claude + ~/.config/ckn, which is what made it order-dependent.
  CKN_FORBID_DEFAULT_DB: '1',
  CKN_PRIVATE_MIND: 'off',
  CKN_EMBEDDINGS: 'off',
  CKN_MESH_PEERS: '',
  CKN_MESH_TOKEN: '',
} as NodeJS.ProcessEnv

async function startServer() {
  server = spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: { ...env, CKN_PORT: String(PORT), CKN_BIND: '127.0.0.1' },
    stdio: 'ignore',
    detached: true,
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${SERVER_URL}/api/home`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server never came up')
}

/** Run bin/ckn-sync.ts against the throwaway server; returns the synced count
 * parsed from stdout ("[ckn sync] N entries synced, M skipped"). */
function runSync(): Promise<{ synced: number; skipped: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node_modules/.bin/tsx',
      ['bin/ckn-sync.ts'],
      { cwd: repoRoot, env: { ...env, CKN_SERVER_URL: SERVER_URL }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', reject)
    child.on('close', () => {
      const m = /(\d+)\s+entries synced,\s+(\d+)\s+skipped/.exec(out)
      if (!m) return reject(new Error(`could not parse sync output:\n${out}`))
      resolve({ synced: Number(m[1]), skipped: Number(m[2]), out })
    })
  })
}

const nodeContent = async (id: string): Promise<string | null> => {
  const res = await fetch(`${SERVER_URL}/api/graph/node/${id}`)
  if (!res.ok) return null
  const body = (await res.json()) as { content?: string }
  return body.content ?? null
}

const writeMemory = (body: string) =>
  fs.writeFileSync(
    memFile,
    `---\nname: Hash Fixture\ndescription: a fixture memory\n---\n\n${body}\n`,
    'utf-8',
  )

try {
  fs.mkdirSync(memDir, { recursive: true })
  await startServer()

  // (a) First sync — fresh memory with body BODY-ONE.
  writeMemory('BODY-ONE')
  const first = await runSync()
  assert.ok(first.synced >= 1, `first sync should upsert the new memory (synced=${first.synced})\n${first.out}`)
  assert.ok((await nodeContent(ENTRY_ID))?.includes('BODY-ONE'), 'graph has BODY-ONE after first sync')

  // (b) Body-only edit with PRESERVED mtime — the exact bug condition.
  const st = fs.statSync(memFile)
  writeMemory('BODY-TWO')
  // Reset mtime/atime back to the captured values: simulates an mtime-preserving
  // (atomic-rename) editor. Old mtime-only code would see no advance and skip.
  fs.utimesSync(memFile, st.atime, st.mtime)

  // (c) Second sync MUST re-upsert despite the unchanged mtime, and the graph
  // body MUST now reflect BODY-TWO.
  const second = await runSync()
  assert.ok(
    second.synced >= 1,
    `body-only edit with preserved mtime MUST re-sync (this is the bug) — synced=${second.synced}\n${second.out}`,
  )
  const afterEdit = await nodeContent(ENTRY_ID)
  assert.ok(afterEdit?.includes('BODY-TWO'), `graph must reflect BODY-TWO after edit, got: ${afterEdit}`)
  assert.ok(!afterEdit?.includes('BODY-ONE'), 'stale BODY-ONE must be gone after re-sync')

  // (d) No-op touch — bump mtime FORWARD with identical content. Must NOT
  // re-upsert (hash unchanged), proving we don't waste work on touches.
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(memFile, future, future)
  const third = await runSync()
  assert.equal(
    third.synced,
    0,
    `no-op touch (mtime bumped, content identical) must NOT re-upsert — synced=${third.synced}\n${third.out}`,
  )
  assert.ok((await nodeContent(ENTRY_ID))?.includes('BODY-TWO'), 'content still BODY-TWO after no-op touch')

  console.log('sync-content-hash.test.ts: passed')
  cleanup()
  process.exit(0)
} catch (e) {
  console.error(e)
  cleanup()
  process.exit(1)
}
