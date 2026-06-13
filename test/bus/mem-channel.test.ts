#!/usr/bin/env tsx
/**
 * WS-level test for the M4 mem tier over a live `ws` loopback (server/bus/meshWs.ts),
 * the mirror of test/bus/ws-channel.test.ts for the `msg` tier. Same temp-DB +
 * dynamic-import pattern: point db.ts at a fresh SQLite file and memMesh's
 * memoryHome() at a fresh CKN_HOME BEFORE importing the modules under test. The
 * db.ts singleton is process-wide, so both "ends" of the loopback share one store
 * — fine here: the assertions are about the WIRE (frame dispatch + echo-guard +
 * backfill durability + crash-resilience), not two independent stores.
 *
 * Proves the paths the Task-6 2-node gate would otherwise be the only cover for —
 * including the two regressions this file was written to lock down:
 *   1. inbound `mem` frame ingests + APPLIES (the .md is written, entry indexed).
 *   2. echo-guard: a mem event tagged with a link's peerNode is NOT forwarded back
 *      to that peer; one tagged with a DIFFERENT peer IS (flood-forward, no loop).
 *   3. `hello` (with memCursors) → the link replies with a `membacklog` of
 *      `memoriesOriginatedSince` (everything we originated past the mem cursor).
 *   4. inbound `membacklog` advances the per-peer mem cursor to the max seq — and
 *      ONLY AFTER the memory is durably applied (the .md exists), out-of-order safe.
 *   5. CRASH-RESILIENCE: a `mem` frame whose ingest REJECTS (write fails) does not
 *      crash the process (the `.catch` guard) and a `membacklog` whose first ingest
 *      rejects does NOT advance the cursor past the unapplied seq (durability gate).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { dialerHandshake } from './_dialer-handshake.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mem-channel-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_TOKEN = 'mem-channel-token' // Link now authenticates in-band (slice #4C)
process.env.CKN_EMBEDDINGS = 'off'
process.env.CKN_NODE_ID = 'node-self'
// memoryHome() = CKN_HOME || os.homedir(); isolate the .md writes under the temp dir.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mem-home-'))
process.env.CKN_HOME = fakeHome
// Deterministic, long gossip interval so the per-link timer doesn't fire mid-test.
process.env.CKN_MESH_GOSSIP_MS = '600000'

const { all, getDb } = await import('../../server/graph/db.js')
getDb()
const { nodeId } = await import('../../server/bus/meshIdentity.js')
const { _resetMeshState } = await import('../../server/bus/meshState.js')
const { recordLocalMemory, onBusMemory, emitBusMemory, getMemCursor } = await import(
  '../../server/graph/memMesh.js'
)
const { acceptPeer, stopWsMesh, wsPeerCount } = await import('../../server/bus/meshWs.js')

const cleanup = () => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(fakeHome, { recursive: true, force: true })
}

const REMOTE = 'peer-node-remote'
const OTHER = 'peer-node-other'

function collectFrames(ws: WebSocket): any[] {
  const out: any[] = []
  ws.on('message', (d) => {
    try {
      out.push(JSON.parse(String(d)))
    } catch {
      /* ignore */
    }
  })
  return out
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await wait(10)
  }
}

const memMd = (id: string, body: string, machine = 'mach-remote') =>
  `---\nid: ${id}\nname: ${id}\ntype: decision\nmachine: ${machine}\n---\n${body}`

/** A wire MeshMemory the peer sends us. */
function wireMem(over: Partial<any> & { id: string; repoPath: string; content: string }): any {
  return {
    scope: 'user',
    contentHash: '',
    machine: 'mach-remote',
    originNode: REMOTE,
    memSeq: 1,
    deletedAt: 0,
    ...over,
  }
}

async function main() {
  _resetMeshState([])

  // A process-level unhandled-rejection sentinel: if the receive path's `.catch`
  // guards regress, an ingest reject becomes an unhandled rejection — we record it
  // and fail the test instead of (as in prod) crashing the whole Cortex process.
  let unhandled: unknown = null
  const onUnhandled = (reason: unknown) => {
    unhandled = reason
  }
  process.on('unhandledRejection', onUnhandled)

  // Seed a memory THIS node originated so the hello→membacklog reply has something
  // to replay. recordLocalMemory stamps origin=nodeId() + a mem_seq.
  const seededId = 'mem-originated-local'
  const r = recordLocalMemory({
    id: seededId,
    repoPath: 'memory/user/originated-local.md',
    scope: 'user',
    content: memMd(seededId, 'originated here', 'mach-self'),
    machine: 'mach-self',
  })
  assert.equal(r.emitted, true, 'seeded local memory emitted')

  // ── Stand up a loopback ws server; each accepted socket becomes a Link. ──────
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  wss.on('connection', (ws) => acceptPeer(ws))
  const port = (wss.address() as AddressInfo).port

  const peer = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/ws`)
  const peerFrames = collectFrames(peer)
  await new Promise<void>((resolve) => peer.on('open', () => resolve()))
  await dialerHandshake(peer, process.env.CKN_MESH_TOKEN!) // authenticate in-band
  await until(() => wsPeerCount() === 1)
  await until(() => peerFrames.some((f) => f.t === 'hello'))

  // ── (3) hello (memCursors) → membacklog replays memoriesOriginatedSince ──────
  peer.send(
    JSON.stringify({ t: 'hello', node: REMOTE, cursors: {}, memCursors: { [nodeId()]: 0 } }),
  )
  await until(() => peerFrames.some((f) => f.t === 'membacklog'))
  const membacklog = peerFrames.find((f) => f.t === 'membacklog')
  assert.ok(Array.isArray(membacklog.mems), 'membacklog carries a mems array')
  assert.ok(
    membacklog.mems.some((m: any) => m.id === seededId),
    'membacklog replays the locally-originated memory',
  )
  // Lineage preserved verbatim on the wire.
  const seededWire = membacklog.mems.find((m: any) => m.id === seededId)
  assert.equal(seededWire.machine, 'mach-self', 'machine lineage rides the membacklog verbatim')

  // ── (1) inbound `mem` frame ingests + APPLIES (.md written, entry indexed). ──
  const ingestEvents: string[] = []
  const unsub = onBusMemory((m: any) => ingestEvents.push(m.id))
  const inboundId = 'mem-inbound-1'
  peer.send(
    JSON.stringify({
      t: 'mem',
      mem: wireMem({
        id: inboundId,
        repoPath: 'memory/user/inbound-1.md',
        content: memMd(inboundId, 'inbound over the wire'),
        memSeq: 7,
      }),
    }),
  )
  await until(() => ingestEvents.includes(inboundId))
  const writtenPath = path.join(fakeHome, '.claude', 'memory', 'inbound-1.md')
  await until(() => fs.existsSync(writtenPath))
  assert.ok(
    fs.readFileSync(writtenPath, 'utf8').includes('inbound over the wire'),
    'inbound mem frame wrote the .md to disk',
  )
  const e = all<any>(`SELECT machine FROM entries WHERE id = ?`, inboundId)[0]
  assert.equal(e?.machine, 'mach-remote', 'inbound mem indexed an entry with lineage preserved')
  // Re-send is idempotent (identical content → no second emit).
  peer.send(
    JSON.stringify({
      t: 'mem',
      mem: wireMem({
        id: inboundId,
        repoPath: 'memory/user/inbound-1.md',
        content: memMd(inboundId, 'inbound over the wire'),
        memSeq: 7,
      }),
    }),
  )
  await wait(50)
  assert.equal(
    ingestEvents.filter((id) => id === inboundId).length,
    1,
    'inbound mem frame ingests exactly once (re-delivery is idempotent)',
  )
  unsub()

  // ── (2) echo-guard: an event tagged with the link's peerNode (REMOTE) is NOT
  // forwarded back; one tagged with a DIFFERENT peer IS (flood-forward, no loop). ─
  // The link learned peerNode=REMOTE from the hello above.
  const beforeEcho = peerFrames.filter((f) => f.t === 'mem').length
  emitBusMemory(wireMem({ id: 'mem-echo', repoPath: 'memory/user/echo.md', content: memMd('mem-echo', 'x') }), REMOTE)
  await wait(50)
  assert.equal(
    peerFrames.filter((f) => f.t === 'mem').length,
    beforeEcho,
    'mem tagged with the link peerNode is NOT echoed back',
  )
  emitBusMemory(
    wireMem({ id: 'mem-from-other', repoPath: 'memory/user/other.md', content: memMd('mem-from-other', 'y'), originNode: OTHER }),
    OTHER,
  )
  await until(() => peerFrames.some((f) => f.t === 'mem' && f.mem?.id === 'mem-from-other'))
  assert.ok(
    peerFrames.some((f) => f.t === 'mem' && f.mem?.id === 'mem-from-other'),
    'mem from a different peer IS forwarded over the link (flood-forward)',
  )

  // ── (4) inbound `membacklog` advances the mem cursor to the max seq, ONLY after
  // each memory is durably applied. Send out-of-order to prove the seq sort. ─────
  peer.send(
    JSON.stringify({
      t: 'membacklog',
      mems: [
        wireMem({ id: 'mem-bl-b', repoPath: 'memory/user/bl-b.md', content: memMd('mem-bl-b', 'b'), memSeq: 42 }),
        wireMem({ id: 'mem-bl-a', repoPath: 'memory/user/bl-a.md', content: memMd('mem-bl-a', 'a'), memSeq: 17 }),
      ],
    }),
  )
  await until(() => getMemCursor(REMOTE) === 42)
  assert.equal(getMemCursor(REMOTE), 42, 'membacklog advanced the per-peer mem cursor to the max seq')
  // Cursor-after-apply: both .md files actually exist by the time the cursor reached 42.
  assert.ok(
    fs.existsSync(path.join(fakeHome, '.claude', 'memory', 'bl-a.md')) &&
      fs.existsSync(path.join(fakeHome, '.claude', 'memory', 'bl-b.md')),
    'membacklog memories are durably applied before the cursor advances',
  )

  // ── (5) CRASH-RESILIENCE: a `mem` frame whose ingest REJECTS does not crash the
  // process, and a `membacklog` whose first (lowest-seq) ingest rejects does NOT
  // advance the cursor past the unapplied seq. We force a write failure by parking
  // a FILE where applyMemory needs to mkdir a directory: a proj-scoped repoPath
  // `memory/proj/<enc>/<file>.md` maps to `<home>/.claude/projects/<enc>/memory/<file>.md`,
  // so writing a FILE at `<home>/.claude/projects/<enc>` makes the recursive mkdir of
  // `<enc>/memory` throw ENOTDIR — fs rejects inside ingestMeshMemory. ────────────
  const blockedEnc = 'blocked-proj'
  const blockerFile = path.join(fakeHome, '.claude', 'projects', blockedEnc)
  fs.mkdirSync(path.dirname(blockerFile), { recursive: true })
  fs.writeFileSync(blockerFile, 'i am a file, not a directory') // collides with the dir applyMemory needs

  const cursorBeforeFail = getMemCursor(REMOTE) // 42
  // Lone `mem` frame that will reject — must NOT produce an unhandled rejection.
  peer.send(
    JSON.stringify({
      t: 'mem',
      mem: wireMem({ id: 'mem-fail', repoPath: `memory/proj/${blockedEnc}/fail.md`, scope: 'project', content: memMd('mem-fail', 'boom'), memSeq: 99 }),
    }),
  )
  // membacklog whose LOWEST-seq item rejects (seq 50, blocked dir) followed by a
  // higher-seq item (seq 60, fine): the durability gate must STOP at the reject,
  // leaving the cursor unchanged (the whole tail replays on the next reconnect).
  peer.send(
    JSON.stringify({
      t: 'membacklog',
      mems: [
        wireMem({ id: 'mem-bl-fail', repoPath: `memory/proj/${blockedEnc}/x.md`, scope: 'project', content: memMd('mem-bl-fail', 'boom2'), memSeq: 50 }),
        wireMem({ id: 'mem-bl-ok', repoPath: 'memory/user/bl-ok.md', content: memMd('mem-bl-ok', 'ok'), memSeq: 60 }),
      ],
    }),
  )
  await wait(150) // give the rejects time to settle
  assert.equal(unhandled, null, 'a rejecting inbound ingest did NOT surface as an unhandled rejection (no crash)')
  assert.equal(
    getMemCursor(REMOTE),
    cursorBeforeFail,
    'membacklog with a failing lowest-seq ingest did NOT advance the cursor past the unapplied seq',
  )

  // ── teardown ────────────────────────────────────────────────────────────────
  process.off('unhandledRejection', onUnhandled)
  peer.close()
  stopWsMesh()
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log('mem-channel OK')
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
