/**
 * Mesh WS in-band mutual-auth handshake (FR slice #4C) — a PURE step machine, no I/O.
 * The fleet token NEVER appears in a frame: both sides prove possession by HMAC over
 * the two exchanged nonces, ROLE-BOUND (`…||dialer` vs `…||peer`) so a peer's proof
 * can't be reflected back as the dialer's. The Link (meshWs) wires send()/close() to
 * the steps and only forwards bus activity once `authed`.
 *
 * Wire sequence (auth moves in-band, AFTER an unprivileged WS open):
 *   dialer --hs1{nonceA}-->                 peer
 *   dialer <--hs2{nonceB, proof=peer}--     peer
 *   dialer --hs3{proof=dialer}-->           peer
 * The dialer authes once it verifies the peer's hs2 (the peer proved it holds the
 * token); the peer authes once it verifies the dialer's hs3. Either bad/absent proof,
 * a malformed/out-of-order frame, or an empty token ends the handshake (fail-closed).
 */
import { signMac, verifyMac, MAC_VERSION } from './meshProof.js'

export type HsRole = 'dialer' | 'peer'

export interface HsFrame {
  t: 'hs1' | 'hs2' | 'hs3'
  nonce?: string
  proof?: string
}

/** A step result: an optional frame to send, and at most one terminal transition. */
export interface HsStep {
  send?: HsFrame
  authed?: boolean
  fail?: boolean
}

/** Context binds BOTH nonces (dialer's then peer's) + the prover's role. Identical on
 *  both sides for the same proof; differs by role so proofs are not interchangeable. */
function ctx(nonceDialer: string, noncePeer: string, role: HsRole): string {
  return `${MAC_VERSION}||${nonceDialer}||${noncePeer}||${role}`
}

export class MeshHandshake {
  readonly role: HsRole
  authed = false
  failed = false
  private readonly token: string
  private readonly nonceSelf: string
  private noncePeer = ''

  constructor(role: HsRole, token: string, nonceSelf: string) {
    this.role = role
    this.token = token
    this.nonceSelf = nonceSelf
  }

  /** Frame to send immediately on link-open: the dialer opens with hs1; the peer
   *  sends nothing and waits for it. */
  open(): HsFrame | null {
    return this.role === 'dialer' ? { t: 'hs1', nonce: this.nonceSelf } : null
  }

  private fail(): HsStep {
    this.failed = true
    return { fail: true }
  }

  /** Drive one received handshake frame. Fail-closed on anything unexpected. */
  onFrame(frame: HsFrame): HsStep {
    if (this.authed || this.failed) return {}
    if (!this.token || !frame || typeof frame.t !== 'string') return this.fail()

    if (this.role === 'dialer') {
      // nonceSelf = nonceA. Expect hs2 carrying the peer's nonceB + peer-role proof.
      if (frame.t !== 'hs2' || !frame.nonce || !frame.proof) return this.fail()
      this.noncePeer = frame.nonce // nonceB
      if (!verifyMac(this.token, ctx(this.nonceSelf, this.noncePeer, 'peer'), frame.proof)) return this.fail()
      this.authed = true // the peer proved possession of the fleet token
      return {
        send: { t: 'hs3', proof: signMac(this.token, ctx(this.nonceSelf, this.noncePeer, 'dialer')) },
        authed: true,
      }
    }

    // peer: nonceSelf = nonceB. First hs1 (nonceA) → reply hs2; then hs3 → verify.
    if (frame.t === 'hs1') {
      if (!frame.nonce) return this.fail()
      this.noncePeer = frame.nonce // nonceA
      return {
        send: { t: 'hs2', nonce: this.nonceSelf, proof: signMac(this.token, ctx(this.noncePeer, this.nonceSelf, 'peer')) },
      }
    }
    if (frame.t === 'hs3') {
      if (!frame.proof || !this.noncePeer) return this.fail()
      if (!verifyMac(this.token, ctx(this.noncePeer, this.nonceSelf, 'dialer'), frame.proof)) return this.fail()
      this.authed = true // the dialer proved possession of the fleet token
      return { authed: true }
    }
    return this.fail()
  }
}
