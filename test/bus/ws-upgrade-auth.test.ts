#!/usr/bin/env tsx
/**
 * Unit test for meshUpgradeAuthorized — the gate on the raw `/api/mesh/ws` HTTP
 * upgrade (T3). Slice #4C HARD CUTOVER: the upgrade no longer reads a bearer — the
 * token is NEVER transmitted. The socket opens UNPRIVILEGED (accept-if-a-token-is-
 * configured) and the in-band post-open mutual handshake (meshHandshake.ts) is what
 * actually establishes trust. So this gate only fail-closes when NO token is set
 * (a node with no key can't run the handshake, so refuse the upgrade outright).
 *
 * Proves: no token ⇒ fail-closed regardless of headers; token set ⇒ the upgrade is
 * authorized regardless of (and without reading) any Authorization header — no
 * bearer is consulted, so a stale/absent/bogus one neither helps nor blocks.
 */
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'

const { meshUpgradeAuthorized } = await import('../../server/bus/meshAuth.js')

/** Minimal upgrade-request stand-in. The new gate reads NO header — present one
 * anyway to prove it's ignored. */
function req(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage
}

// Fail-closed: no token configured ⇒ the node can't handshake ⇒ refuse the upgrade,
// even if a (now-ignored) bearer is presented.
delete process.env.CKN_MESH_TOKEN
assert.equal(meshUpgradeAuthorized(req('Bearer anything')), false, 'no token must fail-closed')
assert.equal(meshUpgradeAuthorized(req()), false, 'no token + no header rejected')

// Token set: the upgrade is UNPRIVILEGED — authorized without reading any header.
// (The in-band handshake, not the upgrade, proves token possession.)
process.env.CKN_MESH_TOKEN = 's3cret-fleet-token'
assert.equal(meshUpgradeAuthorized(req()), true, 'token set + no header ⇒ upgrade authorized (auth is in-band)')
assert.equal(meshUpgradeAuthorized(req('')), true, 'an empty Authorization header is ignored, not required')
assert.equal(
  meshUpgradeAuthorized(req('Bearer wrong-token')),
  true,
  'a WRONG bearer no longer blocks the upgrade — no bearer is read; the handshake gates trust',
)
assert.equal(
  meshUpgradeAuthorized(req('Bearer s3cret-fleet-token')),
  true,
  'a matching bearer is neither needed nor consulted — token-set is the only condition',
)

console.log('ws-upgrade-auth.test.ts OK')
