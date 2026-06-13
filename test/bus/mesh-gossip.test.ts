#!/usr/bin/env tsx
/**
 * T7 unit test: the periodic mesh gossip loop.
 *
 * Stubs `global.fetch` for `/api/mesh/gossip` and `/api/mesh/since` (no real
 * network) and points the graph at a fresh temp SQLite (catch-up ingests rows
 * into the local store + advances the per-peer cursor there). Same
 * env-before-import + temp-DB convention as test/graph/bus.test.ts. Standalone
 * tsx + node:assert/strict (no vitest).
 *
 * Proves:
 *   - a tick POSTs /gossip to every seeded peer with our node id, marks the peer
 *     reachable, and merges its replied presence into the gossiped view
 *   - an unreachable→reachable TRANSITION triggers catch-up: GET /since drains
 *     the peer's originated messages (paged until short), each is ingested into
 *     the local store, and the per-peer cursor advances to the max seq seen
 *   - a steady-state tick (already reachable) does NOT re-run catch-up
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  signResponse,
  SIG_NONCE_HEADER,
  SIG_TS_HEADER,
  SIG_HEADER,
  RESP_SIG_HEADER,
} from '../../server/bus/meshProof.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-gossip-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = 'http://node-b:3002'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
process.env.CKN_MESH_GOSSIP_MS = '20000'
process.env.CKN_MESH_ZOMBIE_MS = '600000'
delete process.env.CKN_MESH_SELF

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

const B = 'http://node-b:3002'
const NB = 'node-b-id'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

// The fleet token the test peer also holds — used only to forge the MUTUAL
// proof-back the stub must return. It is NEVER expected on an outbound header.
const TOKEN = 'fleet-secret'

let calls: Captured[] = []

/** A remote-originated presence the peer reports in its gossip reply. */
function remotePresence(sessionId: string): any {
  return {
    sessionId,
    friendlyName: sessionId,
    cwd: '/repo',
    machine: 'host-b',
    title: sessionId,
    startedAt: 1,
    lastSeen: Date.now(),
    rawStatus: 'live',
    supersedes: '',
    metaId: `meta_${sessionId}`,
    nameHistory: [],
  }
}

/**
 * A fully-stamped wire message as /since returns it (a BusMessageRow carrying
 * origin_node/mesh_seq). originNode is the PEER's node id — we must NOT re-stamp
 * it on ingest.
 */
function sinceMsg(seq: number): any {
  return {
    id: `msg-${seq}`,
    fromSession: 'sess-remote',
    fromName: 'Remote',
    to: 'sess-local',
    kind: 'msg',
    ref: '',
    body: `catch-up ${seq}`,
    createdAt: 1000 + seq,
    deliveredTo: [],
    ackedBy: [],
    status: 'open',
    origTo: '',
    originNode: NB,
    meshSeq: seq,
  }
}

/** What the stub should hand back for the next /since call (drives paging). */
let sincePages: any[][] = []

function installFetchStub() {
  global.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    // MUTUAL proof-back (slice #4B): a real peer signs HMAC(token, reqNonce|resp)
    // over OUR request nonce; call() rejects any response that doesn't carry it. A
    // Headers-like `get()` returns the forged-but-valid proof for RESP_SIG_HEADER.
    const reqNonce = headers[SIG_NONCE_HEADER] ?? ''
    const respHeaders = {
      get: (n: string) => (n === RESP_SIG_HEADER ? signResponse(TOKEN, reqNonce) : null),
    }
    if (url.includes('/api/mesh/gossip')) {
      // Peer answers with its node id + one live session.
      return {
        ok: true,
        status: 200,
        headers: respHeaders,
        json: async () => ({ node: NB, sessions: [remotePresence('remote-1')] }),
      } as any
    }
    if (url.includes('/api/mesh/since')) {
      const page = sincePages.shift() ?? []
      return { ok: true, status: 200, headers: respHeaders, json: async () => ({ messages: page }) } as any
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as any
}

async function main() {
  installFetchStub()

  const { _resetMeshState, getMeshState } = await import('../../server/bus/meshState.js')
  const { _gossipOnce, catchUpFrom } = await import('../../server/bus/meshGossip.js')
  const { getCursor, getMessageById } = await import('../../server/graph/bus.js')

  _resetMeshState([B])

  // ── tick 1: unreachable→reachable. Gossips, merges presence, runs catch-up ──
  // One page below the 500 page-size → drains in a single /since round.
  sincePages = [[sinceMsg(1), sinceMsg(2), sinceMsg(3)]]
  await _gossipOnce()

  const gossipCalls = calls.filter((c) => c.url.endsWith('/api/mesh/gossip'))
  assert.equal(gossipCalls.length, 1, 'gossips the one seeded peer')
  assert.equal(gossipCalls[0]!.method, 'POST', 'gossip is a POST')
  // slice #4B HARD CUTOVER: the gossip carries a per-request HMAC PROOF, never the
  // fleet bearer — the token never goes on the wire (gate test 5, gossip path).
  const gh = gossipCalls[0]!.headers
  assert.ok(gh[SIG_NONCE_HEADER] && gh[SIG_TS_HEADER] && gh[SIG_HEADER], 'gossip carries the nonce/ts/sig proof')
  assert.equal(gh['Authorization'], undefined, 'NO Authorization/bearer header on the gossip')
  assert.ok(!JSON.stringify(gh).includes(TOKEN), 'the fleet token never appears in the gossip headers')
  assert.ok(typeof gossipCalls[0]!.body.node === 'string' && gossipCalls[0]!.body.node.length > 0, 'sends our node id')
  assert.ok(Array.isArray(gossipCalls[0]!.body.sessions), 'sends our local presences (possibly empty)')

  // Peer is now reachable + its session merged into the gossiped view.
  const mesh = getMeshState()
  assert.deepEqual(mesh.broadcastTargets(), [B], 'a successful gossip marks the peer reachable')
  const view = mesh.gossipedPeers(Date.now())
  assert.deepEqual(view.map((p) => p.sessionId), ['remote-1'], 'merges the peer-reported presence')

  // Catch-up fired on the transition: /since drained, messages ingested, cursor bumped.
  const sinceCalls = calls.filter((c) => c.url.includes('/api/mesh/since'))
  assert.equal(sinceCalls.length, 1, 'a single short page drains catch-up in one /since call')
  assert.equal(sinceCalls[0]!.method, 'GET', '/since is a GET')
  assert.match(sinceCalls[0]!.url, /after=0/, 'first catch-up reads from cursor 0')
  assert.equal(getCursor(NB), 3, 'cursor advances to the max mesh_seq ingested')
  for (const seq of [1, 2, 3]) {
    const row = getMessageById(`msg-${seq}`)
    assert.ok(row, `msg-${seq} ingested into the local store`)
    assert.equal(row!.originNode, NB, 'ingest preserves the PEER origin_node (not re-stamped)')
    assert.equal(row!.meshSeq, seq, 'ingest preserves the peer mesh_seq')
  }

  // ── tick 2: steady-state (already reachable) → NO catch-up re-run ───────────
  calls = []
  sincePages = [] // any /since call here would be a bug
  await _gossipOnce()
  assert.equal(calls.filter((c) => c.url.endsWith('/api/mesh/gossip')).length, 1, 'still gossips each tick')
  assert.equal(
    calls.filter((c) => c.url.includes('/api/mesh/since')).length,
    0,
    'no catch-up on a non-transition tick (avoids double-replay)',
  )
  assert.equal(getCursor(NB), 3, 'cursor unchanged when no new messages')

  // ── recovery transition re-fires catch-up from the advanced cursor ─────────
  mesh.markUnreachable(B, Date.now())
  assert.deepEqual(mesh.broadcastTargets(), [], 'peer dropped after going unreachable')
  calls = []
  // Paged drain: a full 500-row page would continue, but a final short page ends it.
  sincePages = [[sinceMsg(4)]]
  await _gossipOnce()
  const recoverySince = calls.filter((c) => c.url.includes('/api/mesh/since'))
  assert.equal(recoverySince.length, 1, 'recovery transition re-runs catch-up')
  assert.match(recoverySince[0]!.url, /after=3/, 'catch-up resumes from the advanced cursor')
  assert.equal(getCursor(NB), 4, 'cursor advances past the recovery page')
  assert.ok(getMessageById('msg-4'), 'the recovery message ingested')

  // ── catchUpFrom paging: two full-ish pages then a short page drains ─────────
  // (direct call — exercises the multi-page loop the gossip path delegates to.)
  calls = []
  const peerNodeP = 'peer-paged'
  // Page sizes < 500 normally drain immediately; to prove the loop continues we
  // make the first page report exactly 500 rows so the loop must fetch again.
  const bigPage = Array.from({ length: 500 }, (_, i) => sinceMsg(100 + i))
  sincePages = [bigPage, [sinceMsg(700)]]
  await catchUpFrom(B, peerNodeP)
  assert.equal(
    calls.filter((c) => c.url.includes('/api/mesh/since')).length,
    2,
    'a full page forces a second /since fetch; the short page drains',
  )
  assert.equal(getCursor(peerNodeP), 700, 'cursor reaches the last page max seq')

  console.log('mesh-gossip OK')
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
