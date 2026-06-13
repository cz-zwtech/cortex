#!/usr/bin/env tsx
/**
 * T6 unit test: the proof-gated `/api/mesh/*` ingress (server/routes/mesh.ts).
 * Mounts the real meshRouter on a tiny Express app over node:http and drives it
 * with fetch, so the auth middleware, body parsing, and JSON contract are all
 * exercised end-to-end (no handler mocking).
 *
 * Slice #4 HARD CUTOVER: the token is NEVER transmitted. Each request carries a
 * per-request HMAC PROOF (meshHeaders → nonce/ts/sig over METHOD|originalUrl|
 * sha256(body)|nonce|ts); the middleware recomputes + constant-time verifies and
 * signs a MUTUAL proof-back over our nonce. The app captures the raw body (as the
 * real server does via express.json's `verify`) so the body hash checks the exact
 * bytes. Env is set BEFORE the dynamic imports (repo convention): a fresh temp
 * graph DB, a peer list, and the fleet token (the HMAC key, never on the wire).
 *
 * Proves:
 *   - 401 with no proof, and with a forged signature
 *   - POST /ingest persists the wire message to the local store + proof-backs us
 *   - POST /gossip echoes OUR node id + live local presences
 *   - GET  /since returns only locally-originated rows past the cursor, in order
 *   - GATE 5: the fleet token never appears in any outbound header
 *   - GATE 6: a sig is bound to the EXACT body — a mutated body is rejected
 *   - GATE 8: a sig is bound to the query (originalUrl) — a mutated query is rejected
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'
import {
  verifyResponse,
  SIG_NONCE_HEADER,
  SIG_TS_HEADER,
  SIG_HEADER,
  RESP_SIG_HEADER,
} from '../../server/bus/meshProof.js'
import { _resetNonceCache } from '../../server/bus/meshNonceCache.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-mesh-routes-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')
process.env.CKN_MESH_PEERS = 'http://peer-a:3002'
process.env.CKN_MESH_TOKEN = 'fleet-secret-token'
process.env.CKN_MESH_GOSSIP_MS = '20000'
delete process.env.CKN_MESH_SELF

const { meshRouter } = await import('../../server/routes/mesh.js')
const { meshHeaders } = await import('../../server/bus/meshAuth.js')
const { sendMessage, registerSession } = await import('../../server/graph/bus.js')
const { nodeId } = await import('../../server/bus/meshIdentity.js')
const { getDb } = await import('../../server/graph/db.js')

const TOKEN = 'fleet-secret-token'

const app = express()
// Capture the raw body exactly as the production server does, so the auth
// middleware can hash the bytes the client actually signed.
app.use(express.json({ verify: (req, _res, buf) => ((req as unknown as { rawBody?: Buffer }).rawBody = buf) }))
app.use('/api/mesh', meshRouter)

const server = http.createServer(app)
const cleanup = () => {
  try {
    server.close()
  } catch {
    /* noop */
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

function listen(): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

/**
 * Sign a request the way a real peer does — via the production `meshHeaders`
 * builder. `pathWithQuery` MUST equal what the server sees as `req.originalUrl`
 * (the query is part of the signature). Returns the headers + the request nonce so
 * the caller can verify the peer's mutual proof-back. Every call mints a fresh
 * nonce, so distinct requests never trip the replay cache.
 */
function signedReq(method: 'GET' | 'POST', pathWithQuery: string, bodyStr = '') {
  const headers = meshHeaders(method, pathWithQuery, bodyStr) as unknown as Record<string, string>
  return { headers, nonce: headers[SIG_NONCE_HEADER]! }
}

function wireMsg(over: Record<string, any> = {}) {
  return {
    id: 'rm_ingest_1',
    fromSession: 'sess-remote',
    fromName: 'Remote',
    to: 'Local',
    kind: 'msg',
    ref: '',
    body: 'replicated over the mesh',
    createdAt: Date.now(),
    deliveredTo: [] as string[],
    ackedBy: [] as string[],
    status: 'open',
    origTo: '',
    originNode: 'peer-a-node',
    meshSeq: 3,
    ...over,
  }
}

async function main() {
  _resetNonceCache()
  const base = await listen()

  // ── auth: 401 with no proof, and with a forged signature ───────────────────
  {
    const noAuth = await fetch(`${base}/api/mesh/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wireMsg()),
    })
    assert.equal(noAuth.status, 401, 'ingest without a proof is 401')
    assert.deepEqual(await noAuth.json(), { error: 'mesh auth' }, '401 body is the mesh-auth error')

    // A structurally-valid proof whose sig is corrupted: first hex char flipped.
    const bodyStr = JSON.stringify(wireMsg())
    const { headers } = signedReq('POST', '/api/mesh/ingest', bodyStr)
    const sig = headers[SIG_HEADER]!
    const forged = { ...headers, [SIG_HEADER]: (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1) }
    const wrong = await fetch(`${base}/api/mesh/ingest`, { method: 'POST', headers: forged, body: bodyStr })
    assert.equal(wrong.status, 401, 'ingest with a forged signature is 401')

    // a rejected proof must NOT have persisted anything.
    assert.ok(
      !getDb().prepare(`SELECT 1 FROM bus_messages WHERE id = 'rm_ingest_1'`).get(),
      'rejected ingest did not touch the store',
    )

    const sinceNoAuth = await fetch(`${base}/api/mesh/since?after=0`)
    assert.equal(sinceNoAuth.status, 401, 'GET /since without a proof is 401 (read surface gated too)')

    // GATE 5: the fleet token NEVER appears in an outbound header.
    assert.ok(!JSON.stringify(headers).includes(TOKEN), 'gate-5: the fleet token never appears in the signed headers')
    assert.equal(headers['Authorization'], undefined, 'gate-5: no Authorization/bearer header at all')
  }

  // ── POST /ingest: persists the wire message + returns a mutual proof-back ───
  {
    const bodyStr = JSON.stringify(wireMsg())
    const { headers, nonce } = signedReq('POST', '/api/mesh/ingest', bodyStr)
    const r = await fetch(`${base}/api/mesh/ingest`, { method: 'POST', headers, body: bodyStr })
    assert.equal(r.status, 200, 'authed ingest is 200')
    assert.deepEqual(await r.json(), { ok: true }, 'ingest acks {ok:true}')
    assert.ok(
      verifyResponse(TOKEN, nonce, r.headers.get(RESP_SIG_HEADER) ?? ''),
      'MUTUAL: the response carries a valid proof-back over OUR nonce',
    )

    const row = getDb()
      .prepare(`SELECT body, origin_node, mesh_seq FROM bus_messages WHERE id = 'rm_ingest_1'`)
      .get() as any
    assert.ok(row, 'ingested message persisted')
    assert.equal(row.body, 'replicated over the mesh', 'body persisted verbatim')
    assert.equal(row.origin_node, 'peer-a-node', 'sender origin_node preserved (not re-stamped)')
    assert.equal(row.mesh_seq, 3, 'sender mesh_seq preserved')

    // a missing id is a 400 (proof valid, payload invalid).
    const badBody = JSON.stringify({ body: 'no id' })
    const bad = await fetch(`${base}/api/mesh/ingest`, {
      method: 'POST',
      headers: signedReq('POST', '/api/mesh/ingest', badBody).headers,
      body: badBody,
    })
    assert.equal(bad.status, 400, 'ingest without an id is 400')
  }

  // ── GATE 6: the signature is bound to the EXACT body bytes ──────────────────
  {
    const goodBody = JSON.stringify(wireMsg({ id: 'rm_body_bind' }))
    const { headers } = signedReq('POST', '/api/mesh/ingest', goodBody)
    // Exact body → 200 (round-trips).
    const ok = await fetch(`${base}/api/mesh/ingest`, { method: 'POST', headers, body: goodBody })
    assert.equal(ok.status, 200, 'gate-6: the exact signed body round-trips (200)')
    // Same proof, byte-different body (a leading space — still valid JSON, so it
    // reaches the auth layer rather than failing JSON parse) → 401 (bodyHash mismatch).
    const tampered = await fetch(`${base}/api/mesh/ingest`, {
      method: 'POST',
      headers: signedReq('POST', '/api/mesh/ingest', goodBody).headers,
      body: ' ' + goodBody,
    })
    assert.equal(tampered.status, 401, 'gate-6: a sig is byte-bound to the body — even a whitespace-different body is rejected')
  }

  // ── POST /gossip: echoes OUR node id + our live local presences ────────────
  {
    // a live local session so our snapshot is non-empty.
    await registerSession({ sessionId: 'sess-local-1', title: 'Local One', cwd: '/repo', machine: 'host-self' })

    const gBody = JSON.stringify({
      node: 'peer-a-node',
      sessions: [
        {
          sessionId: 'sess-peer-x',
          friendlyName: 'PeerX',
          cwd: '/p',
          machine: 'host-peer',
          title: 'PeerX',
          startedAt: 1,
          lastSeen: Date.now(),
          rawStatus: 'live',
          supersedes: '',
          metaId: 'meta_peerx',
          nameHistory: [],
        },
      ],
    })
    const r = await fetch(`${base}/api/mesh/gossip`, {
      method: 'POST',
      headers: signedReq('POST', '/api/mesh/gossip', gBody).headers,
      body: gBody,
    })
    assert.equal(r.status, 200, 'authed gossip is 200')
    const body = (await r.json()) as { node: string; sessions: any[] }
    assert.equal(body.node, nodeId(), 'gossip reply carries OUR node id')
    assert.ok(Array.isArray(body.sessions), 'gossip reply carries a sessions array')
    assert.ok(
      body.sessions.some((s) => s.sessionId === 'sess-local-1'),
      'our live local session is echoed back in the snapshot',
    )

    // the peer's gossiped presence merged into our view.
    const { getMeshState } = await import('../../server/bus/meshState.js')
    assert.ok(
      getMeshState()
        .gossipedPeers(Date.now())
        .some((p) => p.sessionId === 'sess-peer-x'),
      'peer presence merged into the gossiped view',
    )

    // node is required.
    const nnBody = JSON.stringify({ sessions: [] })
    const noNode = await fetch(`${base}/api/mesh/gossip`, {
      method: 'POST',
      headers: signedReq('POST', '/api/mesh/gossip', nnBody).headers,
      body: nnBody,
    })
    assert.equal(noNode.status, 400, 'gossip without a node is 400')
  }

  // ── GET /since: only locally-originated rows past the cursor, in seq order ──
  // GATE 8: the query lives in the signed pathname (== req.originalUrl).
  {
    await sendMessage({ fromSession: 'sess-local-1', fromName: 'L', to: 'Bob', kind: 'msg', body: 's1' })
    await sendMessage({ fromSession: 'sess-local-1', fromName: 'L', to: 'Bob', kind: 'msg', body: 's2' })
    await sendMessage({ fromSession: 'sess-local-1', fromName: 'L', to: 'Bob', kind: 'msg', body: 's3' })

    const { headers, nonce } = signedReq('GET', '/api/mesh/since?after=0')
    const r = await fetch(`${base}/api/mesh/since?after=0`, { headers })
    assert.equal(r.status, 200, 'authed since is 200')
    assert.ok(
      verifyResponse(TOKEN, nonce, r.headers.get(RESP_SIG_HEADER) ?? ''),
      'MUTUAL: /since response proves back over our nonce',
    )
    const { messages } = (await r.json()) as { messages: any[] }

    // remote-origin rm_ingest_1 must be excluded; only our local sends appear.
    assert.ok(
      messages.every((m) => m.originNode === nodeId()),
      '/since returns ONLY locally-originated rows',
    )
    assert.ok(!messages.some((m) => m.id === 'rm_ingest_1'), 'remote-ingested message excluded from /since')
    assert.deepEqual(messages.map((m) => m.body), ['s1', 's2', 's3'], 'rows in mesh_seq ASC order')

    // windowing: after the first row's seq returns only the later two.
    const firstSeq = messages[0]!.meshSeq as number
    const winPath = `/api/mesh/since?after=${firstSeq}`
    const r2 = await fetch(`${base}${winPath}`, { headers: signedReq('GET', winPath).headers })
    const { messages: later } = (await r2.json()) as { messages: any[] }
    assert.deepEqual(later.map((m) => m.body), ['s2', 's3'], 'after=<firstSeq> windows to later rows')

    // GATE 8: a sig minted for ?after=0 does NOT authorize a DIFFERENT query — the
    // query is bound into the signature via originalUrl.
    const { headers: qh } = signedReq('GET', '/api/mesh/since?after=0')
    const qTampered = await fetch(`${base}/api/mesh/since?after=999`, { headers: qh })
    assert.equal(qTampered.status, 401, 'gate-8: a sig bound to ?after=0 is rejected on ?after=999')
  }

  console.log('mesh-routes OK')
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
