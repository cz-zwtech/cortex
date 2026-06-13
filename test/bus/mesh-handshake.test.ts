#!/usr/bin/env tsx
/**
 * mesh mutual-auth — WS in-band handshake state machine (slice #4C). Pure: drives the
 * dialer/peer step machines against each other with NO sockets. Pins: happy-path mutual
 * auth, token-never-in-a-frame, a peer/dialer with the wrong token rejected (mutual),
 * role-binding blocks reflection, and malformed/out-of-order frames fail closed.
 */
import assert from 'node:assert/strict'
import { MeshHandshake } from '../../server/bus/meshHandshake.ts'

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const TOKEN = 'fleet-token-9'
const NA = 'nonce-A-aaaa'
const NB = 'nonce-B-bbbb'

// 1. happy path: full mutual auth.
{
  const d = new MeshHandshake('dialer', TOKEN, NA)
  const p = new MeshHandshake('peer', TOKEN, NB)
  const hs1 = d.open()
  assert.deepEqual(hs1, { t: 'hs1', nonce: NA }, 'dialer opens with hs1{nonceA}')
  assert.equal(p.open(), null, 'peer sends nothing on open (it waits for hs1)')
  const r2 = p.onFrame(hs1!) // peer -> hs2
  assert.equal(r2.send?.t, 'hs2', 'peer replies hs2')
  const r3 = d.onFrame(r2.send!) // dialer verifies peer -> hs3 + authed
  assert.equal(r3.send?.t, 'hs3', 'dialer replies hs3')
  assert.equal(r3.authed, true, 'dialer authes after verifying the peer (mutual from the dialer side)')
  const rp = p.onFrame(r3.send!) // peer verifies dialer -> authed
  assert.equal(rp.authed, true, 'peer authes after verifying the dialer')
  assert.equal(d.authed && p.authed, true, 'both sides authed')
  ok('happy path: full mutual handshake')
}

// 2. token NEVER appears in any handshake frame.
{
  const d = new MeshHandshake('dialer', TOKEN, NA)
  const p = new MeshHandshake('peer', TOKEN, NB)
  const frames: unknown[] = []
  const hs1 = d.open()
  frames.push(hs1)
  const r2 = p.onFrame(hs1!)
  frames.push(r2.send)
  const r3 = d.onFrame(r2.send!)
  frames.push(r3.send)
  p.onFrame(r3.send!)
  assert.ok(!JSON.stringify(frames).includes(TOKEN), 'the fleet token never appears in any handshake frame')
  ok('token-never-on-the-wire across all handshake frames')
}

// 3. MUTUAL: a peer with the WRONG token is rejected by the dialer.
{
  const d = new MeshHandshake('dialer', TOKEN, NA)
  const evil = new MeshHandshake('peer', 'WRONG-token', NB)
  const r2 = evil.onFrame(d.open()!)
  const r3 = d.onFrame(r2.send!)
  assert.equal(r3.fail, true, 'dialer rejects a peer that cannot prove the fleet token')
  assert.equal(d.authed, false, 'dialer does not auth a spoofed peer')
  ok('mutual: spoofed peer (wrong token) rejected by dialer')
}

// 3b. MUTUAL the other way: a dialer with the wrong token is rejected by the peer.
{
  const evil = new MeshHandshake('dialer', 'WRONG-token', NA)
  const p = new MeshHandshake('peer', TOKEN, NB)
  const r2 = p.onFrame(evil.open()!)
  const r3 = evil.onFrame(r2.send!)
  const rp = p.onFrame(r3.send!)
  assert.equal(rp.fail, true, 'peer rejects a dialer that cannot prove the fleet token')
  assert.equal(p.authed, false, 'peer does not auth a spoofed dialer')
  ok('mutual: spoofed dialer (wrong token) rejected by peer')
}

// 4. REFLECTION: the peer's hs2 proof replayed as the dialer's hs3 proof fails (role binding).
{
  const d = new MeshHandshake('dialer', TOKEN, NA)
  const p = new MeshHandshake('peer', TOKEN, NB)
  const r2 = p.onFrame(d.open()!) // hs2 carries the peer-role proof
  const reflected = { t: 'hs3' as const, proof: r2.send!.proof }
  const rp = p.onFrame(reflected)
  assert.equal(rp.fail, true, "the peer's own proof cannot be reflected as the dialer's (role binding)")
  ok('reflection blocked: role-bound proofs are not interchangeable')
}

// 5. malformed / out-of-order / empty-token → fail closed.
{
  const p = new MeshHandshake('peer', TOKEN, NB)
  assert.equal(p.onFrame({ t: 'hs3', proof: 'x' }).fail, true, 'peer: hs3 before hs1 fails closed')
  const d = new MeshHandshake('dialer', TOKEN, NA)
  assert.equal(d.onFrame({ t: 'hs2', nonce: NB }).fail, true, 'dialer: hs2 missing proof fails closed')
  const d2 = new MeshHandshake('dialer', '', NA)
  assert.equal(d2.onFrame({ t: 'hs2', nonce: NB, proof: 'x' }).fail, true, 'empty token fails closed')
  ok('malformed/out-of-order/empty-token fail closed')
}

console.log(`\nOK mesh-handshake.test.ts — ${passed} cases passed`)
