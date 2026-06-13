#!/usr/bin/env tsx
/**
 * mesh mutual-auth — HTTP per-request signing (slice #4B). A dialer signs
 * {method, pathname, bodyHash, nonce, ts} with the fleet token (token NEVER on the
 * wire); the receiver recomputes + constant-time verifies, rejects tamper + ts-skew;
 * and the peer proves BACK over the request nonce (mutual) so a spoofed peer can't pass.
 *
 * Pure unit — no DB/server. now/nonce are injected for determinism.
 */
import assert from 'node:assert/strict'
import {
  signRequest,
  verifyRequest,
  signResponse,
  verifyResponse,
} from '../../server/bus/meshProof.ts'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const TOKEN = 'fleet-xyz'
const NOW = 1_750_000_000_000
const REQ = {
  method: 'POST',
  pathname: '/api/mesh/gossip',
  bodyStr: JSON.stringify({ node: 'zwd', sessions: [] }),
}

// 1. roundtrip + the token is NOT in any sig field (the on-the-wire invariant).
{
  const f = signRequest(TOKEN, REQ.method, REQ.pathname, REQ.bodyStr, { now: NOW })
  assert.ok(f.nonce && f.ts && f.sig, 'signRequest returns nonce/ts/sig')
  assert.ok(
    !`${f.nonce}${f.ts}${f.sig}`.includes(TOKEN),
    'token never appears in the sig fields (on-the-wire invariant)',
  )
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, now: NOW }), true, 'a freshly-signed request verifies')
  ok('http sign/verify roundtrip; token-free fields')
}

// 2. tamper: changing method / pathname / body / nonce / ts / token each invalidates.
{
  const f = signRequest(TOKEN, REQ.method, REQ.pathname, REQ.bodyStr, { now: NOW })
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, method: 'GET', now: NOW }), false, 'tampered method rejected')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, pathname: '/api/mesh/ingest', now: NOW }), false, 'tampered pathname rejected')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, bodyStr: REQ.bodyStr + ' ', now: NOW }), false, 'tampered body rejected')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, nonce: f.nonce + 'x', now: NOW }), false, 'tampered nonce rejected')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, ts: String(Number(f.ts) + 1), now: NOW }), false, 'tampered ts rejected (sig covers ts)')
  assert.equal(verifyRequest('other-token', { ...REQ, ...f, now: NOW }), false, 'wrong token rejected')
  ok('http verify: method/path/body/nonce/ts/token tamper all rejected')
}

// 3. ts-skew: a request outside the ±60s window is rejected even if otherwise valid.
{
  const f = signRequest(TOKEN, REQ.method, REQ.pathname, REQ.bodyStr, { now: NOW })
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, now: NOW + 59_000 }), true, 'within 60s window accepted')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, now: NOW + 61_000 }), false, 'stale >60s rejected')
  assert.equal(verifyRequest(TOKEN, { ...REQ, ...f, now: NOW - 61_000 }), false, 'future >60s rejected')
  ok('http verify: ts-skew >60s rejected (replay window)')
}

// 4. MUTUAL: the peer proves back over the request nonce; a peer w/o the token can't.
{
  const f = signRequest(TOKEN, REQ.method, REQ.pathname, REQ.bodyStr, { now: NOW })
  const respSig = signResponse(TOKEN, f.nonce)
  assert.ok(!respSig.includes(TOKEN), 'response proof is token-free')
  assert.equal(verifyResponse(TOKEN, f.nonce, respSig), true, 'dialer verifies the peer proved back')
  assert.equal(
    verifyResponse(TOKEN, f.nonce, signResponse('spoof-token', f.nonce)),
    false,
    'a peer WITHOUT the token cannot prove back (spoofed peer rejected)',
  )
  assert.equal(verifyResponse(TOKEN, 'other-nonce', respSig), false, 'response proof is bound to THIS request nonce')
  ok('http mutual: peer proves back over the request nonce; spoofed peer rejected')
}

console.log(`\nOK mesh-http-proof.test.ts — ${passed} cases passed`)
