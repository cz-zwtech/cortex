#!/usr/bin/env tsx
/**
 * Unit test for server/bus/meshAuth.ts — the fleet mutual-auth gate (slice #4B).
 * The token is NEVER transmitted: a dialer signs the request shape (meshHeaders),
 * the middleware recomputes + constant-time verifies (verifyRequest) and proves
 * BACK over the request nonce (mutual). Exercises: valid proof passes + sets the
 * proof-back header; 401 on tampered sig / wrong body / missing headers / stale ts /
 * empty server token; meshHeaders is token-free; meshEnabled fail-closed.
 *
 * meshAuth reads env at call time, so we set CKN_MESH_* per case. No graph DB.
 */
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { meshToken, meshEnabled, meshAuthMiddleware, meshHeaders } from '../../server/bus/meshAuth.js'
import {
  signRequest,
  SIG_NONCE_HEADER,
  SIG_TS_HEADER,
  SIG_HEADER,
  RESP_SIG_HEADER,
} from '../../server/bus/meshProof.js'
import { _resetNonceCache } from '../../server/bus/meshNonceCache.js'

const PATH = '/api/mesh/gossip'
const BODY = JSON.stringify({ node: 'zwd', sessions: [] })

function fakeReq(method: string, originalUrl: string, headers: Record<string, string>, rawBody?: Buffer): Request {
  return { method, originalUrl, headers, rawBody } as unknown as Request
}
function fakeRes() {
  const rec: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} }
  const res = {
    status(code: number) {
      rec.status = code
      return res
    },
    json(payload: unknown) {
      rec.body = payload
      return res
    },
    setHeader(k: string, v: string) {
      rec.headers[k] = String(v)
    },
  } as unknown as Response
  return { res, rec }
}
function runMiddleware(method: string, originalUrl: string, headers: Record<string, string>, rawBody?: Buffer) {
  const req = fakeReq(method, originalUrl, headers, rawBody)
  const { res, rec } = fakeRes()
  let nextCalled = false
  meshAuthMiddleware(req, res, () => {
    nextCalled = true
  })
  return { nextCalled, rec }
}

// ── meshToken: reads env, defaults to '' ──────────────────────────────────────
delete process.env.CKN_MESH_TOKEN
assert.equal(meshToken(), '', 'meshToken defaults to empty string when unset')
process.env.CKN_MESH_TOKEN = 'secret-fleet-token'
assert.equal(meshToken(), 'secret-fleet-token', 'meshToken reflects env')

_resetNonceCache()

// ── valid proof passes + sets the mutual proof-back header ────────────────────
{
  const headers = meshHeaders('POST', PATH, BODY)
  const { nextCalled, rec } = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(nextCalled, true, 'a valid per-request proof calls next()')
  assert.equal(rec.status, undefined, 'no status set on pass')
  assert.ok(rec.headers[RESP_SIG_HEADER], 'mutual: the response carries the proof-back header')
}

// ── replay gate: a verbatim re-send of the SAME signed request is rejected ─────
{
  const headers = meshHeaders('POST', PATH, BODY)
  const first = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(first.nextCalled, true, 'first use of a fresh nonce passes')
  const replay = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(replay.nextCalled, false, 'a verbatim replay (same nonce, valid sig) does not call next()')
  assert.equal(replay.rec.status, 401, 'replayed nonce → 401 (authority-replay blocked)')
}

// ── 401 on a tampered signature ───────────────────────────────────────────────
{
  const headers = { ...meshHeaders('POST', PATH, BODY) }
  const sig = headers[SIG_HEADER]!
  headers[SIG_HEADER] = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1) // flip first hex char
  const { nextCalled, rec } = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(nextCalled, false, 'tampered sig does not call next()')
  assert.equal(rec.status, 401, 'tampered sig → 401')
  assert.deepEqual(rec.body, { error: 'mesh auth' }, '401 body shape')
}

// ── 401 when the body does not match the signed bodyHash ──────────────────────
{
  const headers = meshHeaders('POST', PATH, BODY)
  const { nextCalled, rec } = runMiddleware('POST', PATH, headers, Buffer.from(BODY + ' tampered'))
  assert.equal(nextCalled, false, 'a body that does not match the signed bodyHash → 401')
  assert.equal(rec.status, 401)
}

// ── 401 with no proof headers ─────────────────────────────────────────────────
{
  const { nextCalled, rec } = runMiddleware('POST', PATH, {}, Buffer.from(BODY))
  assert.equal(nextCalled, false, 'missing proof headers does not call next()')
  assert.equal(rec.status, 401, 'missing proof → 401')
}

// ── 401 on a stale timestamp (>60s) even with an otherwise-valid sig ──────────
{
  const old = signRequest(meshToken(), 'POST', PATH, BODY, { now: Date.now() - 120_000 })
  const headers = { [SIG_NONCE_HEADER]: old.nonce, [SIG_TS_HEADER]: old.ts, [SIG_HEADER]: old.sig }
  const { nextCalled, rec } = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(nextCalled, false, 'stale ts (>60s) does not call next()')
  assert.equal(rec.status, 401, 'stale ts → 401')
}

// ── 401 when the SERVER token is empty (never authorizes) ─────────────────────
{
  process.env.CKN_MESH_TOKEN = ''
  const headers = { [SIG_NONCE_HEADER]: 'n', [SIG_TS_HEADER]: String(Date.now()), [SIG_HEADER]: 'sig' }
  const { nextCalled, rec } = runMiddleware('POST', PATH, headers, Buffer.from(BODY))
  assert.equal(nextCalled, false, 'empty server token never authorizes')
  assert.equal(rec.status, 401, 'empty server token → 401')
  process.env.CKN_MESH_TOKEN = 'secret-fleet-token'
}

// ── meshHeaders: a token-FREE per-request proof (no Authorization/bearer) ──────
{
  const h = meshHeaders('POST', PATH, BODY)
  assert.ok(h[SIG_NONCE_HEADER] && h[SIG_TS_HEADER] && h[SIG_HEADER], 'meshHeaders carries nonce/ts/sig')
  assert.equal(h['content-type'], 'application/json', 'content-type set')
  assert.equal(h['Authorization'], undefined, 'NO Authorization/bearer header — the token is never sent')
  assert.ok(!JSON.stringify(h).includes('secret-fleet-token'), 'the token never appears in the outbound headers')
}

// ── meshEnabled: fail-closed when peers set but token missing ─────────────────
process.env.CKN_MESH_PEERS = 'http://node-b:3002'
delete process.env.CKN_MESH_TOKEN
assert.equal(meshEnabled(), false, 'fail-closed: peers set, token missing ⇒ disabled')

// ── meshEnabled: ACCEPT-ONLY node — token set, no peers ⇒ ENABLED ──────────────
process.env.CKN_MESH_TOKEN = 'secret-fleet-token'
process.env.CKN_MESH_PEERS = ''
assert.equal(meshEnabled(), true, 'token set, no peers ⇒ enabled (accept-only)')

// ── meshEnabled: on when peers + token both present ────────────────────────────
process.env.CKN_MESH_PEERS = 'http://node-b:3002'
process.env.CKN_MESH_TOKEN = 'secret-fleet-token'
assert.equal(meshEnabled(), true, 'peers + token ⇒ enabled')

console.log('mesh-auth.test.ts: all assertions passed')
