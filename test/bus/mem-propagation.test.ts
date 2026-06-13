#!/usr/bin/env tsx
/**
 * M4 two-node LIVE memory propagation + reconnect-backfill GATE.
 *
 * Boots TWO throwaway Cortex servers as child processes (NOT the shared :3001
 * dev server — mirrors test/bus/integration.test.ts's spawn+isolate convention),
 * mesh ON with a shared CKN_MESH_TOKEN. Node A dials node B (CKN_MESH_PEERS=B);
 * B is accept-only. Each node gets its OWN temp graph DB, temp CKN_HOME (the
 * memory tree the sync route scans + the apply path writes into), temp
 * CKN_CONFIG_DIR (hermetic against a real mesh.json — see meshIdentity.ts), and
 * a distinct CKN_NODE_ID (the override is REQUIRED to run two nodes on one host).
 * Embeddings + private-mind OFF.
 *
 * Proves (the M4 acceptance gate):
 *   1. LIVE propagation: a memory .md written into A's home + synced
 *      (POST A/api/graph/sync → recordLocalMemory emits a `mem` frame) appears,
 *      within the gossip interval, as the SAME .md on B's disk AND as a
 *      searchable graph entry on B (full content, not just a pointer).
 *   2. RECONNECT-BACKFILL: bounce B; write a SECOND memory on A during the gap
 *      (B link dead, so the live flood reaches no one); restart B reusing its
 *      SAME DB + home. On reconnect the hello→membacklog replay
 *      (memoriesOriginatedSince) delivers the missed memory — proving lossless
 *      offline catch-up, not just live-forward.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ts = Date.now()
const PORT_A = 3094
const PORT_B = 3095
const URL_A = `http://127.0.0.1:${PORT_A}`
const URL_B = `http://127.0.0.1:${PORT_B}`
const TOKEN = `fleet-secret-${ts}`

// Per-node isolation roots (graph DB, CKN_HOME memory tree, hermetic config dir).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mem-prop-'))
const dbA = path.join(root, 'a', 'graph.sqlite')
const dbB = path.join(root, 'b', 'graph.sqlite')
const homeA = path.join(root, 'a', 'home')
const homeB = path.join(root, 'b', 'home')
const cfgA = path.join(root, 'a', 'config')
const cfgB = path.join(root, 'b', 'config')
for (const d of [path.dirname(dbA), path.dirname(dbB), homeA, homeB, cfgA, cfgB]) {
  fs.mkdirSync(d, { recursive: true })
}

let serverA: ChildProcess | null = null
let serverB: ChildProcess | null = null

const killGroup = (proc: ChildProcess | null) => {
  // tsx spawns a child node process; killing the wrapper alone leaks the server
  // (the grandchild keeps the port). Each is `detached` (own group leader) — kill
  // the negative pid to take the whole tree.
  try {
    if (proc?.pid) process.kill(-proc.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
const cleanup = () => {
  killGroup(serverA)
  killGroup(serverB)
  fs.rmSync(root, { recursive: true, force: true })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(pred: () => Promise<boolean> | boolean, timeoutMs = 8000, stepMs = 150): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await pred()) return true
    } catch {
      /* not ready */
    }
    await sleep(stepMs)
  }
  return false
}

/** Spawn one node. `peers` empty ⇒ accept-only (node B); set ⇒ dialer (node A). */
function spawnNode(opts: {
  port: number
  db: string
  home: string
  config: string
  nodeId: string
  self: string
  peers: string
}): ChildProcess {
  return spawn('node_modules/.bin/tsx', ['server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CKN_PORT: String(opts.port),
      CKN_BIND: '127.0.0.1',
      CKN_GRAPH_DB_PATH: opts.db,
      CKN_HOME: opts.home,
      CKN_CONFIG_DIR: opts.config,
      CKN_NODE_ID: opts.nodeId,
      CKN_MESH_SELF: opts.self,
      CKN_MESH_PEERS: opts.peers,
      CKN_MESH_TOKEN: TOKEN,
      // Fast reconnect-backfill: short gossip + reconnect so the hello→membacklog
      // catch-up fires within the test window after B comes back.
      CKN_MESH_GOSSIP_MS: '1000',
      CKN_PRIVATE_MIND: 'off',
      CKN_EMBEDDINGS: 'off',
    },
    stdio: 'ignore',
    detached: true,
  })
}

async function waitUp(port: number): Promise<void> {
  const ok = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/home`)
    return r.ok
  }, 20000)
  if (!ok) throw new Error(`node never came up on :${port}`)
}

/** Write a memory .md into a node's user memory tree (CKN_HOME/.claude/memory). */
function writeMemory(home: string, file: string, content: string): void {
  const dir = path.join(home, '.claude', 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), content, 'utf8')
}

async function triggerSync(url: string): Promise<void> {
  const r = await fetch(`${url}/api/graph/sync`, { method: 'POST' })
  if (!r.ok) throw new Error(`${url}/api/graph/sync -> ${r.status} ${await r.text()}`)
}

async function searchFinds(url: string, q: string, id: string): Promise<boolean> {
  const r = await fetch(`${url}/api/graph/search?q=${encodeURIComponent(q)}`)
  if (!r.ok) return false
  const body = (await r.json()) as { entries: Array<{ id: string }> }
  return Array.isArray(body.entries) && body.entries.some((e) => e.id === id)
}

async function main() {
  // ── boot both nodes; A dials B, B accept-only ───────────────────────────────
  serverB = spawnNode({ port: PORT_B, db: dbB, home: homeB, config: cfgB, nodeId: 'node-b', self: URL_B, peers: '' })
  serverA = spawnNode({ port: PORT_A, db: dbA, home: homeA, config: cfgA, nodeId: 'node-a', self: URL_A, peers: URL_B })
  await Promise.all([waitUp(PORT_A), waitUp(PORT_B)])

  // ── 1. LIVE propagation: write+sync on A → appears on B ──────────────────────
  const mem1 = [
    '---',
    'id: mem-prop-1',
    `name: Propagated One ${ts}`,
    'type: decision',
    'machine: mach-a',
    '---',
    `The first decision body, marker prop-one-${ts}.`,
  ].join('\n')
  writeMemory(homeA, 'prop-one.md', mem1)
  await triggerSync(URL_A)

  const bHasFile1 = await until(() => fs.existsSync(path.join(homeB, '.claude', 'memory', 'prop-one.md')))
  assert.ok(bHasFile1, 'B received memory1 .md over the live mesh')
  const writtenOnB = fs.readFileSync(path.join(homeB, '.claude', 'memory', 'prop-one.md'), 'utf8')
  assert.equal(writtenOnB, mem1, 'B holds the FULL .md byte-for-byte (frontmatter + body)')
  assert.ok(writtenOnB.includes('machine: mach-a'), 'machine lineage propagated verbatim')

  const bSearch1 = await until(() => searchFinds(URL_B, `prop-one-${ts}`, 'mem-prop-1'))
  assert.ok(bSearch1, 'B indexed memory1 into its graph (searchable, full content)')

  // ── 2. RECONNECT-BACKFILL: bounce B, write memory2 on A, restart B ───────────
  killGroup(serverB)
  serverB = null
  // Confirm B is actually down before writing the memory it must miss live.
  await until(async () => {
    try {
      await fetch(`${URL_B}/api/home`)
      return false
    } catch {
      return true
    }
  })

  const mem2 = [
    '---',
    'id: mem-prop-2',
    `name: Propagated Two ${ts}`,
    'type: decision',
    'machine: mach-a',
    '---',
    `The second decision body, marker prop-two-${ts}.`,
  ].join('\n')
  writeMemory(homeA, 'prop-two.md', mem2)
  await triggerSync(URL_A) // emits live to nobody — B is down

  // Restart B reusing its SAME db + home (mem cursor + already-applied memory1
  // persist), so the reconnect replays only the missed tail (memory2).
  serverB = spawnNode({ port: PORT_B, db: dbB, home: homeB, config: cfgB, nodeId: 'node-b', self: URL_B, peers: '' })
  await waitUp(PORT_B)

  const bHasFile2 = await until(
    () => fs.existsSync(path.join(homeB, '.claude', 'memory', 'prop-two.md')),
    15000,
  )
  assert.ok(bHasFile2, 'B backfilled memory2 .md on reconnect (hello→membacklog catch-up)')
  const written2 = fs.readFileSync(path.join(homeB, '.claude', 'memory', 'prop-two.md'), 'utf8')
  assert.equal(written2, mem2, 'backfilled memory2 is the full .md byte-for-byte')

  const bSearch2 = await until(() => searchFinds(URL_B, `prop-two-${ts}`, 'mem-prop-2'), 15000)
  assert.ok(bSearch2, 'B indexed the backfilled memory2 into its graph')

  console.log('mem-propagation.test.ts: all assertions passed (live propagation + reconnect-backfill)')
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (err) => {
    cleanup()
    console.error(err)
    process.exit(1)
  },
)
