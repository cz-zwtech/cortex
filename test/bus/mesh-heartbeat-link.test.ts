/**
 * #116 mesh WS heartbeat — behavioral wiring (real sockets).
 *
 * Proves the gate conditions end-to-end with attachHeartbeat bound to a real ws:
 *   1. NO FLAP: a healthy link whose peer auto-pongs is never terminated, even over
 *      many ping intervals (a momentarily laggy-but-alive link must survive).
 *   2. FLIP-TO-RED-THEN-RECONNECT: on a silent drop (no pong, no close frame — the
 *      socket stays OPEN) the heartbeat terminate()s the socket, which fires the
 *      ws 'close' event — the exact hook the transport uses to teardown + re-dial
 *      (dial()'s onDown → scheduleReconnect). We attach the same close→reconnect
 *      wiring and assert it fires.
 *
 * The silent drop is simulated by pausing the CLIENT's underlying socket: pongs the
 * server sends are never read, so the 'pong' event never fires and the miss counter
 * climbs — while readyState stays OPEN (no close frame), exactly like a vanished VPN
 * link. Only the heartbeat can close it.
 */
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket } from 'ws'
import { attachHeartbeat } from '../../server/bus/meshHeartbeat.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function pollUntil(pred: () => boolean, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (pred()) return true
    await wait(10)
  }
  return pred()
}

const INTERVAL = 30
const TOLERANCE = 2

// Stand up a real WS server on an ephemeral port (auto-pongs while alive).
const wss = new WebSocketServer({ port: 0 })
await new Promise<void>((r) => wss.on('listening', () => r()))
const port = (wss.address() as { port: number }).port

const client = new WebSocket(`ws://127.0.0.1:${port}`)
await new Promise<void>((resolve, reject) => {
  client.on('open', () => resolve())
  client.on('error', reject)
})

// Mirror the transport's real wiring: a close re-dials (dial()'s onDown).
let reconnectCalls = 0
client.on('close', () => {
  reconnectCalls += 1
})

const hb = attachHeartbeat(client, { intervalMs: INTERVAL, tolerance: TOLERANCE })

// ── Phase 1: healthy link must NOT flap across many intervals ───────────────────
await wait(INTERVAL * 7)
assert.equal(client.readyState, WebSocket.OPEN, 'healthy auto-ponging link stays OPEN')
assert.equal(reconnectCalls, 0, 'healthy link is never terminated (no single-miss / laggy flap)')

// ── Phase 2 (MIDDLE case): a recoverable blip must NOT terminate ─────────────────
// Pause the socket briefly — under `tolerance` intervals — so a ping or two go
// unanswered (the miss counter climbs but stays below tolerance), then RESUME. The
// pongs the server already sent are buffered while paused and re-delivered on resume,
// so the onPong listener resets the counter and the laggy-but-alive link survives.
// This proves the no-flap guarantee on a REAL socket: the pure core can only assert
// the arithmetic, but a paused-then-resumed socket re-emitting its buffered pong is
// genuine integration behavior — the whole point of the miss-tolerance.
// @ts-expect-error _socket is the underlying net.Socket on a ws client
client._socket.pause()
// ~1 missed ping; with tolerance 2, terminate needs 3 ticks (>= 2 intervals = 60ms),
// so a 40ms blip can never reach it.
await wait(INTERVAL + 10)
assert.equal(reconnectCalls, 0, 'blip under tolerance is not terminated mid-pause')
assert.equal(client.readyState, WebSocket.OPEN, 'blip: link still OPEN mid-pause')
// @ts-expect-error _socket is the underlying net.Socket on a ws client
client._socket.resume()
await wait(INTERVAL * 5) // resumed link runs healthy again
assert.equal(
  client.readyState,
  WebSocket.OPEN,
  'recovered link stays OPEN after resume (the buffered pong reset the miss counter)',
)
assert.equal(reconnectCalls, 0, 'a laggy-but-alive link never triggered reconnect (no flap)')

// ── Phase 3: permanent silent drop → terminate → close → reconnect ──────────────
// Pause the client socket and never resume: server pongs are no longer read, the
// 'pong' event stops, the miss counter climbs past tolerance, but readyState stays
// OPEN (no close frame) — a true vanished link that only the heartbeat can detect.
// @ts-expect-error _socket is the underlying net.Socket on a ws client
client._socket.pause()

const closedInTime = await pollUntil(() => reconnectCalls >= 1, INTERVAL * (TOLERANCE + 6))
assert.ok(closedInTime, 'silent drop is detected: heartbeat terminate() fires the close→reconnect path')
assert.equal(reconnectCalls, 1, 'reconnect path fired exactly once (flip-to-red-then-reconnect)')
assert.notEqual(client.readyState, WebSocket.OPEN, 'link is no longer OPEN after terminate (dot flips red)')

hb.stop()
try {
  client.terminate()
} catch {
  /* already terminated */
}
await new Promise<void>((r) => wss.close(() => r()))

console.log('mesh-heartbeat behavioral (real sockets): all assertions passed')
process.exit(0)
