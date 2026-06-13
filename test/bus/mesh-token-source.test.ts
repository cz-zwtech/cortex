#!/usr/bin/env tsx
/**
 * FR-7 D2 — runtime mesh-token acquisition. env CKN_MESH_TOKEN always wins; when
 * absent, the token is fetched at runtime via CKN_MESH_TOKEN_CMD and cached so the
 * whole tier (meshToken()) activates without a restart. Fetch failure → stay
 * fail-closed (caller retries). Runner is injected so this is deterministic/offline.
 */
import assert from 'node:assert/strict'

const { meshToken, clearRuntimeMeshToken } = await import('../../server/bus/meshAuth.js')
const { acquireMeshToken, _setRunner } = await import('../../server/bus/meshTokenSource.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}
const reset = () => {
  delete process.env.CKN_MESH_TOKEN
  delete process.env.CKN_MESH_TOKEN_CMD
  clearRuntimeMeshToken()
}

async function main() {
  // ── env token wins; no fetch attempted ──
  {
    reset()
    process.env.CKN_MESH_TOKEN = 'env-tok'
    let ran = false
    _setRunner(async () => {
      ran = true
      return 'should-not-be-used'
    })
    assert.equal(await acquireMeshToken(), true, 'env token ⇒ available')
    assert.equal(meshToken(), 'env-tok', 'meshToken returns the env token')
    assert.equal(ran, false, 'no runtime fetch when env token present')
    ok('env CKN_MESH_TOKEN wins, no fetch')
  }

  // ── no env, fetch via cmd succeeds ⇒ cached + meshToken returns it ──
  {
    reset()
    process.env.CKN_MESH_TOKEN_CMD = 'bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN'
    _setRunner(async () => 'cafebabe')
    assert.equal(await acquireMeshToken(), true, 'fetch succeeds ⇒ available')
    assert.equal(meshToken(), 'cafebabe', 'fetched token is cached + surfaced')
    ok('runtime fetch caches the token (whole tier activates)')
  }

  // ── env precedence even after a runtime cache exists ──
  {
    // (cache still holds 'cafebabe' from above)
    process.env.CKN_MESH_TOKEN = 'env-override'
    assert.equal(meshToken(), 'env-override', 'env beats the runtime cache')
    ok('env token takes precedence over a cached runtime token')
  }

  // ── no env + no cmd ⇒ false, stays fail-closed ──
  {
    reset()
    assert.equal(await acquireMeshToken(), false, 'no source ⇒ not available')
    assert.equal(meshToken(), '', 'meshToken stays empty (fail-closed)')
    ok('no token source ⇒ fail-closed')
  }

  // ── no env + cmd fails/empties ⇒ false, fail-closed (caller retries) ──
  {
    reset()
    process.env.CKN_MESH_TOKEN_CMD = 'bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN'
    _setRunner(async () => '') // OpenBao unreachable / empty output
    assert.equal(await acquireMeshToken(), false, 'fetch failure ⇒ not available')
    assert.equal(meshToken(), '', 'no token cached on failure')
    ok('fetch failure stays fail-closed (controller retries)')
  }

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
