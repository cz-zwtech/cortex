/**
 * Test helper: complete the DIALER side of the mesh in-band mutual-auth handshake
 * (slice #4C) over a raw `ws` socket, resolving once authed. Production dialing goes
 * through a Link that runs this automatically; tests that open a bare WebSocket to
 * `acceptPeer` must drive it themselves so the server-side Link promotes to live and
 * exchanges real frames. Attaches its OWN message listener (coexists with the test's
 * frame collector) and no-ops once authed; the token must match the server's.
 */
import type { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import { MeshHandshake, type HsFrame } from '../../server/bus/meshHandshake.js'

export function dialerHandshake(ws: WebSocket, token: string, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const hs = new MeshHandshake('dialer', token, randomBytes(16).toString('hex'))
    const timer = setTimeout(() => reject(new Error('dialer handshake timeout')), timeoutMs)
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
        reject(new Error('dialer handshake failed'))
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
    const first = hs.open()
    if (first) ws.send(JSON.stringify(first))
  })
}
