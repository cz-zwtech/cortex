/**
 * Test helper: complete the PEER side of the mesh in-band mutual-auth handshake
 * (slice #4C) over a raw `ws` socket — the mirror of `_dialer-handshake.ts`. A
 * loopback ws server that stands in for a REMOTE peer (one that production
 * `connectPeer` dials INTO, rather than one wrapped via `acceptPeer`) must answer
 * the dialer's hs1 with hs2 and accept hs3 before it honors any bus frame. Resolves
 * once authed; attaches its OWN message listener (coexists with the test's own
 * handlers) and no-ops once authed/failed, so post-auth frames (e.g. hello) flow to
 * the test's listeners. The token must match the dialer's.
 */
import type { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import { MeshHandshake, type HsFrame } from '../../server/bus/meshHandshake.js'

export function peerHandshake(ws: WebSocket, token: string, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const hs = new MeshHandshake('peer', token, randomBytes(16).toString('hex'))
    const timer = setTimeout(() => reject(new Error('peer handshake timeout')), timeoutMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    const onMsg = (data: unknown) => {
      if (hs.authed || hs.failed) return
      let frame: HsFrame
      try {
        frame = JSON.parse(String(data)) as HsFrame
      } catch {
        return
      }
      const step = hs.onFrame(frame)
      if (step.send) ws.send(JSON.stringify(step.send))
      if (step.fail) {
        clearTimeout(timer)
        reject(new Error('peer handshake failed'))
        return
      }
      if (step.authed) {
        clearTimeout(timer)
        resolve()
      }
    }
    ws.on('message', onMsg)
    ws.once('close', () => {
      if (!hs.authed) {
        clearTimeout(timer)
        reject(new Error('socket closed during handshake'))
      }
    })
    // Peer role does not initiate (hs.open() === null); it waits for the dialer's hs1.
  })
}
