#!/usr/bin/env tsx
/**
 * Crash-hardening: classifyAndMaybeDial must be GENUINELY non-throwing. It is called
 * fire-and-forget (`void classifyAndMaybeDial(url)` in meshWs.learnAddresses) for every
 * gossiped peer url, so if it rejects — e.g. connectPeer throws on a malformed/junk url
 * — that becomes an unhandledRejection which (Node 20 default) crashes the whole server.
 * The probe is already safe; this pins that connectPeer (and persistence) throwing is
 * swallowed too, so a single bad peer can never take the process down.
 */
import assert from 'node:assert/strict'

process.env.CKN_MESH_PEERS = 'http://seed:3002'
process.env.CKN_MESH_TOKEN = 'fleet-secret'
delete process.env.CKN_MESH_SELF

const { classifyAndMaybeDial, _setWebSocketImpl, _setConnectPeer } = await import(
  '../../server/bus/meshDiscovery.js'
)
const { _resetMeshState } = await import('../../server/bus/meshState.js')

// A WS stub that opens (probe → reachable → connectPeer is invoked).
class OpenWs {
  private handlers: Record<string, Array<(...a: any[]) => void>> = {}
  constructor() {
    setTimeout(() => {
      for (const cb of this.handlers['open'] ?? []) cb()
    }, 0)
  }
  on(ev: string, cb: (...a: any[]) => void) {
    ;(this.handlers[ev] ??= []).push(cb)
  }
  close() {}
}

async function main() {
  const REACH = 'http://reach:3010'
  const ms = _resetMeshState([REACH])
  _setWebSocketImpl(OpenWs as any)
  // connectPeer throws — simulating a malformed url / dial failure on a junk peer.
  _setConnectPeer(() => {
    throw new Error('connect blew up on a junk peer')
  })

  // Must RESOLVE (not reject) despite connectPeer throwing — else it's an
  // unhandledRejection that crashes the server.
  await assert.doesNotReject(
    () => classifyAndMaybeDial(REACH, 1_000),
    'classifyAndMaybeDial swallows a throwing connectPeer (no unhandledRejection)',
  )
  // The probe verdict still landed even though the dial threw.
  const p = ms.allPeers().find((x) => x.url === REACH)!
  assert.equal(p.capability, 'reachable', 'capability still recorded reachable despite the dial throw')

  _setWebSocketImpl(null)
  _setConnectPeer(null)
  console.log('discovery-nonthrow OK')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
