/**
 * #116 mesh WS heartbeat — pure decision core.
 *
 * The mesh link transport (meshWs.ts) keeps one WebSocket per peer. A silent
 * TCP/VPN drop does NOT emit 'close' — readyState stays OPEN (so the binary
 * link-aware mesh dot reads green) until OS TCP keepalive notices, which can be
 * hours. This module is the application-level liveness check: ping on an interval
 * and terminate the socket once `tolerance` consecutive pongs are missed, which
 * lets the existing close→reconnect path (dial()'s onDown) re-establish the link
 * and flip the dot within seconds.
 *
 * Per the gate condition: NEVER terminate on a single missed pong — the timeout is
 * a generous multiple of the ping interval (tolerate ~2-3 misses) so a momentarily
 * laggy-but-alive link does not flap. Both the interval and the miss-tolerance are
 * configurable; the heartbeat is on by default for mesh links.
 *
 * Kept pure (no sockets, no timers, no Date.now) so the tick/decision logic is unit
 * testable; the timer + ws wiring live in meshWs.ts.
 */

/** Default ping cadence. 15s keeps detection well under a minute at the default
 *  tolerance while staying cheap on a quiet link. */
const DEFAULT_PING_MS = 15_000
/** Default consecutive-miss tolerance. 3 ⇒ a laggy link gets ~3 intervals of grace
 *  before the socket is force-closed (no single-miss flap). */
const DEFAULT_MISS_TOLERANCE = 3
/** Floor for a positive ping interval: a tiny env misconfig (e.g. CKN_MESH_PING_MS=5)
 *  must not create a ping storm. Applies only to a positive env value — an explicit
 *  opts.intervalMs override (used by tests) is trusted and never clamped. */
const MIN_PING_MS = 1_000

/** Ping interval in ms. Env CKN_MESH_PING_MS overrides; an explicit 0 or negative
 *  value DISABLES the heartbeat (returns 0); a positive value is clamped UP to a 1s
 *  floor so a misconfig can't ping-storm; a non-numeric value falls back to the
 *  default. */
export function meshPingIntervalMs(): number {
  const raw = Number(process.env.CKN_MESH_PING_MS)
  if (Number.isFinite(raw)) {
    if (raw <= 0) return 0
    return Math.max(raw, MIN_PING_MS)
  }
  return DEFAULT_PING_MS
}

/** Consecutive missed-pong tolerance before terminate. Env CKN_MESH_PING_MISS
 *  overrides; values below 1 (or non-numeric) fall back to the default so we can
 *  never be configured to terminate on a single missed pong. */
export function meshPingMissTolerance(): number {
  const raw = Number(process.env.CKN_MESH_PING_MISS)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MISS_TOLERANCE
}

/** Whether the heartbeat runs, given a resolved interval (0 ⇒ off). */
export function heartbeatEnabled(intervalMs: number = meshPingIntervalMs()): boolean {
  return intervalMs > 0
}

export type HeartbeatAction = 'ping' | 'terminate'

/**
 * Decide what one heartbeat tick should do, given the number of pongs missed since
 * the last received pong and the configured tolerance. Pure.
 *   - missed >= tolerance → terminate (the link is presumed dead; count unchanged).
 *   - otherwise          → ping, and report the incremented miss count to carry
 *                          forward. A received pong resets the caller's count to 0,
 *                          so termination only happens after `tolerance` CONSECUTIVE
 *                          unanswered pings.
 */
export function heartbeatTick(
  missed: number,
  tolerance: number,
): { action: HeartbeatAction; missed: number } {
  if (missed >= tolerance) return { action: 'terminate', missed }
  return { action: 'ping', missed: missed + 1 }
}

/** Worst-case age from the last received pong to termination, for diagnostics:
 *  a pong resets the count, then it takes (tolerance + 1) intervals of silence to
 *  terminate. */
export function pongTimeoutMs(intervalMs: number, tolerance: number): number {
  return intervalMs * (tolerance + 1)
}

import { WebSocket } from 'ws'

export interface HeartbeatHandle {
  /** Stop the heartbeat (clear the timer + unbind the pong listener). Idempotent. */
  stop(): void
}

/**
 * Bind a heartbeat to a live WebSocket: ping every `intervalMs`, reset the miss
 * counter on each received pong, and `terminate()` the socket once `tolerance`
 * consecutive pongs are missed. terminate() forcibly closes the socket, which makes
 * the transport's existing 'close' handler fire (teardown + the dialer's reconnect)
 * — so a silent drop flips the link red and re-dials within seconds instead of
 * hanging OPEN until OS keepalive.
 *
 * A live peer's ws auto-responds to our ping with a pong, so on any healthy link the
 * counter resets every interval and the socket is never terminated — only a link
 * that misses `tolerance` pongs in a row (a real silent drop) is torn down. Returns
 * a handle whose stop() must be called on teardown. A no-op handle is returned when
 * the heartbeat is disabled (interval <= 0).
 */
export function attachHeartbeat(
  ws: WebSocket,
  opts?: { intervalMs?: number; tolerance?: number },
): HeartbeatHandle {
  const intervalMs = opts?.intervalMs ?? meshPingIntervalMs()
  const tolerance = opts?.tolerance ?? meshPingMissTolerance()
  if (!heartbeatEnabled(intervalMs)) return { stop() {} }

  let missed = 0
  const onPong = (): void => {
    missed = 0
  }
  ws.on('pong', onPong)

  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return
    const r = heartbeatTick(missed, tolerance)
    missed = r.missed
    if (r.action === 'terminate') {
      ws.terminate()
      return
    }
    try {
      ws.ping()
    } catch {
      // best-effort; a failed ping just counts as a miss on the next tick
    }
  }, intervalMs)
  timer.unref()

  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      ws.off('pong', onPong)
    },
  }
}
