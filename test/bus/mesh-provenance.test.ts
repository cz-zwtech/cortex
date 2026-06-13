#!/usr/bin/env tsx
/**
 * FR — verifiable mesh-node message provenance (Part 1): the trust root for m2m
 * node-trust. A receiver must distinguish a message that genuinely arrived from an
 * AUTHENTICATED mesh node (meshVerified:true) from a locally-injected/claimed one
 * (meshVerified:false). meshVerified is SERVER-ASSERTED at the authed boundary and
 * can NEVER be set by the local/API path — THAT is what defeats a forged `from`.
 *
 * Semantics (per-node, receiver-asserted):
 *   - true  iff the row entered THIS node's store via ingestMeshMessage (whose only
 *            callers are the handshake-authed WS Link + the proof-gated mesh routes).
 *   - false for everything created locally (sendMessage / the local /api/bus send).
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckn-provenance-'))
process.env.CKN_GRAPH_DB_PATH = path.join(dir, 'graph.sqlite')

const { sendMessage, ingestMeshMessage, getMessageById, inbox } = await import(
  '../../server/graph/bus.js'
)

const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

async function main() {
  // ── local send → meshVerified:false, even when it spoofs a fleet-ish `from` ──
  const local = await sendMessage({
    fromSession: 'rogue',
    fromName: 'zw1-IMPERSONATOR',
    to: 'someone',
    kind: 'msg',
    body: 'trust me, I am zw1',
  })
  const localRow = getMessageById(local.id)
  assert.ok(localRow, 'local message stored')
  assert.equal(
    localRow!.meshVerified,
    false,
    'a locally-created message is NEVER meshVerified — a forged `from` cannot self-certify',
  )
  ok('local/API send → meshVerified:false regardless of claimed from')

  // ── ingest at the authed-WS boundary → meshVerified:true + originNode preserved ──
  ingestMeshMessage(
    {
      id: 'm_from_zw1',
      fromSession: 's-zw1',
      fromName: 'zw1-session',
      to: '*',
      kind: 'msg',
      ref: '',
      body: 'hello fleet',
      createdAt: 1,
      deliveredTo: [],
      ackedBy: [],
      status: 'open',
      origTo: '',
      originNode: 'node-b-901329ee',
      meshSeq: 5,
    },
    'node-b-901329ee',
  )
  const meshRow = getMessageById('m_from_zw1')
  assert.ok(meshRow, 'mesh message stored')
  assert.equal(
    meshRow!.meshVerified,
    true,
    'a message ingested at the authed-WS boundary IS meshVerified',
  )
  assert.equal(
    meshRow!.originNode,
    'node-b-901329ee',
    'originNode preserved (transitive-trust, model a)',
  )
  ok('authed-WS ingest → meshVerified:true + originNode preserved')

  // ── idempotent re-ingest (catch-up replay) keeps meshVerified:true ──
  ingestMeshMessage(
    {
      id: 'm_from_zw1',
      fromSession: 's-zw1',
      fromName: 'zw1-session',
      to: '*',
      kind: 'msg',
      ref: '',
      body: 'hello fleet',
      createdAt: 1,
      deliveredTo: ['x'],
      ackedBy: [],
      status: 'open',
      origTo: '',
      originNode: 'node-b-901329ee',
      meshSeq: 5,
    },
    'node-b-901329ee',
  )
  assert.equal(getMessageById('m_from_zw1')!.meshVerified, true, 're-ingest stays verified')
  ok('idempotent re-ingest preserves meshVerified')

  // ── monotonic upgrade: a row that pre-existed UNVERIFIED (0) is upgraded to
  //    verified when it later arrives via the authed ingest boundary (re-ingest /
  //    relay-ordering / pre-roll legacy row). Once verified, never downgrades. ──
  const pre = await sendMessage({
    id: 'm_preexist',
    fromSession: 'zwd-sess',
    fromName: 'zwd',
    to: '*',
    kind: 'msg',
    body: 'relayed later',
  })
  assert.equal(getMessageById(pre.id)!.meshVerified, false, 'starts unverified (local insert)')
  ingestMeshMessage(
    {
      id: 'm_preexist',
      fromSession: 'zwd-sess',
      fromName: 'zwd',
      to: '*',
      kind: 'msg',
      ref: '',
      body: 'relayed later',
      createdAt: 1,
      deliveredTo: [],
      ackedBy: [],
      status: 'open',
      origTo: '',
      originNode: 'node-a-c5e3af1c',
      meshSeq: 9,
    },
    'node-b-901329ee',
  )
  assert.equal(
    getMessageById('m_preexist')!.meshVerified,
    true,
    'authed re-ingest UPGRADES an existing unverified row to verified (monotonic)',
  )
  ok('authed re-ingest monotonically upgrades meshVerified 0→1 (relay/ordering-safe)')

  // ── inbox delivery surfaces the flag so a receiver / Part-2 directive can gate ──
  const box = await inbox('reader-session', {})
  const seen = box.find((m) => m.id === 'm_from_zw1')
  assert.ok(seen, 'wildcard mesh message is in the inbox')
  assert.equal(seen!.meshVerified, true, 'inbox delivery carries meshVerified')
  assert.equal(seen!.originNode, 'node-b-901329ee', 'inbox delivery carries originNode')
  ok('inbox delivery surfaces meshVerified + originNode')

  console.log(`\n${passed} assertions passed.`)
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  },
  (e) => {
    cleanup()
    console.error(e)
    process.exit(1)
  },
)
