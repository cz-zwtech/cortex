#!/usr/bin/env tsx
/**
 * mesh mutual-auth — HTTP nonce-replay cache (slice #4D, Fable+PM-required for v0).
 * Within the SIG_SKEW_MS freshness window a captured, validly-signed state-changing
 * POST would otherwise replay VERBATIM and re-execute (authority replay + double-
 * inject — ingest isn't idempotent). The cache rejects a re-seen nonce until its TTL
 * (= SIG_SKEW_MS) elapses, past which the ts-skew gate already rejects the request.
 */
import assert from 'node:assert/strict'
import { recordNonce, _resetNonceCache } from '../../server/bus/meshNonceCache.ts'
import { SIG_SKEW_MS } from '../../server/bus/meshProof.ts'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}
_resetNonceCache()
const NOW = 1_800_000_000_000

// 1. first sight is fresh; a replay of the SAME nonce within the window is rejected.
{
  assert.equal(recordNonce('nonce-1', NOW), true, 'first sight of a nonce is fresh')
  assert.equal(recordNonce('nonce-1', NOW), false, 'an immediate replay of the same nonce is rejected')
  assert.equal(recordNonce('nonce-1', NOW + 1000), false, 'still rejected later within the freshness window')
  ok('nonce replay within the window is rejected')
}

// 2. distinct nonces are independent.
{
  assert.equal(recordNonce('nonce-2', NOW), true, 'a different nonce is fresh')
  ok('distinct nonces do not collide')
}

// 3. once the TTL elapses the entry is evicted — re-seeing it is harmless (the ts-skew
//    gate already rejects a request that old), so it reads as fresh (bounded memory).
{
  assert.equal(recordNonce('nonce-3', NOW), true, 'first sight')
  assert.equal(recordNonce('nonce-3', NOW + SIG_SKEW_MS + 1), true, 'after TTL the entry has expired → fresh again')
  ok('expired nonce entries are evicted (bounded memory)')
}

console.log(`\nOK mesh-nonce-cache.test.ts — ${passed} cases passed`)
