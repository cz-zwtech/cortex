/**
 * Shared graph-access guard for Cortex CLI scripts.
 *
 * The Cortex server (port 3001) owns the single SQLite (better-sqlite3)
 * graph writer. Any CLI that direct-opens the DB while the server is
 * running will contend for the same file. The safe contract for every
 * CLI graph opener:
 *
 *   - Prefer the server HTTP API.
 *   - Direct-open the graph DB ONLY when no server is bound to the port.
 *   - If the server IS up but the API call failed, FAIL LOUD — never
 *     direct-open (it can only contend with the server's writer).
 *
 * This module centralizes the port probe so the rule isn't re-implemented
 * (and re-bugged) per script.
 */
import net from 'node:net'

// Single source of truth for the Cortex server URL across every CLI script.
// Honors CKN_SERVER_URL (same override convention as CKN_PORT/CKN_BIND) so
// all callers resolve the same value rather than diverging per call site.
export const SERVER_URL = process.env.CKN_SERVER_URL ?? 'http://localhost:3001'
export const SERVER_PORT = 3001

/**
 * True when something is listening on the Cortex server port. Used to
 * decide whether a direct graph-DB open is safe (no server bound) or
 * suicidal (server owns the writer). Short timeout — this is a localhost probe.
 */
export const isServerUp = (
  port: number = SERVER_PORT,
  host = '127.0.0.1',
  timeoutMs = 200,
): Promise<boolean> =>
  new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(timeoutMs)
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })

/**
 * Decide whether a direct-DB fallback is allowed right now.
 *
 * Returns:
 *   - 'direct'    — no server bound; safe to open the graph DB directly.
 *   - 'fail-loud' — server is up; direct open would contend with its writer.
 *
 * Honors CKN_FORCE_SERVER=1, which forbids direct fallback even when no
 * server is detected (worker-mode deployments where the server must
 * always be the writer).
 */
export const directFallbackMode = async (): Promise<'direct' | 'fail-loud'> => {
  if (process.env.CKN_FORCE_SERVER === '1') return 'fail-loud'
  return (await isServerUp()) ? 'fail-loud' : 'direct'
}
