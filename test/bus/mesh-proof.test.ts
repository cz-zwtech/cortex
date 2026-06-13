#!/usr/bin/env tsx
/**
 * mesh mutual-auth — the HMAC-SHA256 proof primitive (slice #4A). The fleet token is
 * the HMAC KEY, never in the output, so a proof rides the wire without leaking the
 * token (THE invariant of the bearer-purge). verifyMac is constant-time + fail-closed.
 *
 * Pure unit — no DB, no server. Mirrors test/bus/identity.test.ts.
 */
import assert from 'node:assert/strict'
import { signMac, verifyMac } from '../../server/bus/meshProof.ts'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const TOKEN = 'fleet-secret-abc123'
const CTX = 'POST|/api/mesh/gossip|deadbeef|nonce-A|1750000000'

// 1. deterministic + the token NEVER appears in the mac (the leak invariant).
{
  const mac = signMac(TOKEN, CTX)
  assert.equal(mac, signMac(TOKEN, CTX), 'signMac is deterministic for the same (token, context)')
  assert.ok(/^[0-9a-f]{64}$/.test(mac), 'mac is 64-char lowercase hex (HMAC-SHA256)')
  assert.ok(!mac.includes(TOKEN), 'the token NEVER appears in the mac — it is the HMAC key, not the payload')
  ok('signMac: deterministic, hex, token-free')
}

// 2. verifyMac accepts a valid proof; rejects tamper / wrong token / malformed / empty.
{
  const mac = signMac(TOKEN, CTX)
  assert.equal(verifyMac(TOKEN, CTX, mac), true, 'valid proof verifies')
  assert.equal(verifyMac(TOKEN, CTX + 'x', mac), false, 'tampered context rejected')
  assert.equal(verifyMac('wrong-token', CTX, mac), false, 'wrong token rejected')
  assert.equal(verifyMac(TOKEN, CTX, mac.slice(0, -1)), false, 'truncated mac rejected (length guard, no throw)')
  assert.equal(verifyMac(TOKEN, CTX, mac.toUpperCase()), false, 'case-mutated mac rejected')
  assert.equal(verifyMac(TOKEN, CTX, ''), false, 'empty mac rejected')
  assert.equal(verifyMac('', CTX, mac), false, 'empty token rejected (fail-closed)')
  ok('verifyMac: accepts valid, rejects tamper/wrong-token/malformed/empty')
}

// 3. ROLE-BINDING (anti-reflection): dialer & peer proofs over the SAME nonces DIFFER,
//    so a peer's proof can't be replayed as the dialer's.
{
  const ctxDialer = 'nonce-A||nonce-B||dialer'
  const ctxPeer = 'nonce-A||nonce-B||peer'
  assert.notEqual(
    signMac(TOKEN, ctxDialer),
    signMac(TOKEN, ctxPeer),
    'role-bound proofs differ (dialer vs peer)',
  )
  assert.equal(
    verifyMac(TOKEN, ctxDialer, signMac(TOKEN, ctxPeer)),
    false,
    "peer's proof does NOT verify as the dialer's (anti-reflection)",
  )
  ok('role-binding: dialer/peer proofs differ — reflection blocked')
}

console.log(`\nOK mesh-proof.test.ts — ${passed} cases passed`)
