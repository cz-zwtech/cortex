#!/usr/bin/env tsx
/**
 * FR-7 D1 — membership controller decision logic. Membership is a continuous
 * reachability test: not-configured → tier DOWN; configured + token → UP;
 * configured + no token (OpenBao unreachable) → DOWN (retry next tick). Tier
 * actions + the token runner are injected so this asserts the CONTROL LOGIC with
 * no real dialing / broker swap / network.
 */
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'

// Neutralize the real ~/.config/ckn/mesh.json so peerUrls() reflects ONLY the
// CKN_MESH_PEERS env this test sets (otherwise this machine's mesh.json makes
// every node look "configured"). Must be set before the first readMeshConfig().
process.env.CKN_CONFIG_DIR = path.join(os.tmpdir(), `ckn-membership-test-${process.pid}`)

const { clearRuntimeMeshToken } = await import('../../server/bus/meshAuth.js')
const { _setRunner } = await import('../../server/bus/meshTokenSource.js')
const { meshConfigured, membershipTick, _setTierActions } = await import(
  '../../server/bus/meshMembership.js'
)

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}
const reset = () => {
  process.env.CKN_MESH_PEERS = ''
  delete process.env.CKN_MESH_TOKEN
  delete process.env.CKN_MESH_TOKEN_CMD
  clearRuntimeMeshToken()
}

async function main() {
  // ── meshConfigured: peers OR token OR token-cmd; none ⇒ standalone ──
  {
    reset()
    process.env.CKN_MESH_PEERS = 'http://p:3001'
    assert.equal(meshConfigured(), true, 'configured via peers')
    reset()
    process.env.CKN_MESH_TOKEN = 't'
    assert.equal(meshConfigured(), true, 'configured via env token')
    reset()
    process.env.CKN_MESH_TOKEN_CMD = 'bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN'
    assert.equal(meshConfigured(), true, 'configured via token cmd')
    reset()
    assert.equal(meshConfigured(), false, 'no peers + no token source ⇒ standalone')
    ok('meshConfigured reflects peers / token / token-cmd')
  }

  // spies for the tier actions
  let ups = 0
  let downs = 0
  _setTierActions(
    () => {
      ups++
    },
    () => {
      downs++
    },
  )
  const counts = () => {
    const c = { ups, downs }
    ups = 0
    downs = 0
    return c
  }

  // ── configured + token (env) ⇒ tier UP ──
  {
    reset()
    process.env.CKN_MESH_TOKEN = 'env-tok'
    await membershipTick()
    assert.deepEqual(counts(), { ups: 1, downs: 0 }, 'configured + token ⇒ UP')
    ok('tick brings the tier UP when configured + token present')
  }

  // ── not configured ⇒ tier DOWN ──
  {
    reset()
    await membershipTick()
    assert.deepEqual(counts(), { ups: 0, downs: 1 }, 'standalone ⇒ DOWN')
    ok('tick keeps the tier DOWN for a standalone node')
  }

  // ── configured (token-cmd) but the fetch FAILS ⇒ DOWN (retry next tick) ──
  {
    reset()
    process.env.CKN_MESH_TOKEN_CMD = 'bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN'
    _setRunner(async () => '') // OpenBao unreachable
    await membershipTick()
    assert.deepEqual(counts(), { ups: 0, downs: 1 }, 'configured but no token ⇒ DOWN')
    ok('tick stays DOWN (local-only) when the token is unreachable')

    // ── …and once the token becomes fetchable, the next tick comes UP ──
    _setRunner(async () => 'now-reachable')
    await membershipTick()
    assert.deepEqual(counts(), { ups: 1, downs: 0 }, 'token now fetchable ⇒ UP (no restart)')
    ok('tick auto-joins when the token becomes reachable (no restart)')
  }

  _setTierActions(null, null)
  _setRunner(null)
  reset()
  console.log(`\n${passed} assertions passed.`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
