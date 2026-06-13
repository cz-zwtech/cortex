#!/usr/bin/env tsx
/**
 * FR-7 I5 — direct-link diagnostics. A loopback-only node (no published
 * CKN_MESH_BIND) with configured-but-unreachable peers can only relay through a
 * reachable node — for two NAT'd WSL nodes that is a SPOF. `meshDirectLinkHint`
 * decides whether to surface the "enable WSL mirrored networking + CKN_MESH_BIND
 * for a DIRECT link" suggestion. It is pure + advisory (relay stays a valid
 * fallback), so it must NEVER fire when a published bind is already configured.
 */
import assert from 'node:assert/strict'
import { meshDirectLinkHint } from '../../server/bus/meshHints.js'

// ── published bind configured ⇒ never hint (this node is inbound-reachable) ──
assert.equal(
  meshDirectLinkHint({ bindConfigured: true, peers: [{ capability: 'unreachable' }] }),
  null,
  'a node with a published CKN_MESH_BIND is reachable — no direct-link hint even with unreachable peers',
)

// ── loopback-only but no unreachable peer ⇒ nothing to suggest ──
assert.equal(
  meshDirectLinkHint({
    bindConfigured: false,
    peers: [{ capability: 'reachable' }, { capability: 'reception-only' }, { capability: 'unknown' }],
  }),
  null,
  'loopback-only with all peers reachable/reception-only/unprobed → no hint',
)
assert.equal(
  meshDirectLinkHint({ bindConfigured: false, peers: [] }),
  null,
  'loopback-only with no peers at all → no hint',
)

// ── loopback-only + exactly one unreachable peer ⇒ singular hint ──
const one = meshDirectLinkHint({
  bindConfigured: false,
  peers: [{ capability: 'reachable' }, { capability: 'unreachable' }],
})
assert.ok(one, 'loopback-only + an unreachable peer → a hint')
assert.match(one!, /1 configured peer\b/, 'singular "peer" for a single unreachable')
assert.match(one!, /mirrored networking/i, 'hint names WSL mirrored networking (the fix)')
assert.match(one!, /CKN_MESH_BIND/, 'hint names the CKN_MESH_BIND env var')
assert.match(one!, /relay/i, 'hint notes relay stays the fallback')

// ── loopback-only + multiple unreachable peers ⇒ plural + count ──
const many = meshDirectLinkHint({
  bindConfigured: false,
  peers: [{ capability: 'unreachable' }, { capability: 'unreachable' }, { capability: 'reachable' }],
})
assert.ok(many, 'loopback-only + 2 unreachable peers → a hint')
assert.match(many!, /2 configured peers\b/, 'plural "peers" + the count for multiple unreachable')

console.log('mesh-hints OK')
process.exit(0)
