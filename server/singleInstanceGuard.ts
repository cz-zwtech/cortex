/**
 * Single-instance guard for the Cortex server (bus-wedge hardening).
 *
 * Multiple server-stack launches used to dogpile :3001: only one process can bind
 * the port, the losers wedged on EADDRINUSE while contending the graph SQLite lock,
 * and a wedged/contended server = a wedged bus (cross-session comms stuck until a
 * power-cycle). This guard makes a loser exit CLEANLY before it touches the graph:
 *
 *   - portAlreadyOwned() — a pre-listen probe; if something already owns the port,
 *     the caller logs + exit(0) before migrations/graph-lock/listen ever run.
 *   - listenErrorAction() — the race backstop: if the probe raced (free → bound in
 *     the TOCTOU window) and server.listen emits EADDRINUSE, exit clean; any other
 *     listen error is a real failure and must rethrow.
 *
 * Both are pure/thin so they're testable without booting the real server (which
 * would run hookRegistrar and hijack the canonical hooks + home pointer).
 */
import { isServerUp } from '../bin/_graph-guard.js'

/** What a `server.listen` 'error' means. EADDRINUSE = the port is already owned
 *  (a sibling instance) → exit cleanly. Anything else is a genuine failure → rethrow. */
export const listenErrorAction = (code: string | undefined): 'exit' | 'rethrow' =>
  code === 'EADDRINUSE' ? 'exit' : 'rethrow'

/** True when the server port is already owned (so the caller should exit instead of
 *  dogpiling). Reuses the canonical isServerUp TCP probe; always probes loopback —
 *  a 0.0.0.0 listener still answers on 127.0.0.1, so a CKN_BIND override is covered. */
export const portAlreadyOwned = (port: number, timeoutMs = 200): Promise<boolean> =>
  isServerUp(port, '127.0.0.1', timeoutMs)
