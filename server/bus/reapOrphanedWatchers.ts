import { all } from '../graph/db.js'
import { reapDecision, scanWatcherProcs } from '../../bin/_bus-watch.js'

/**
 * Best-effort startup reap of orphaned `ckn-bus watch` processes left by dead
 * sessions (the watcher-teardown gap: a watcher SIGKILLed/crashed without
 * signing off keeps running, piling up node RSS → memory pressure). Conservative
 * (see reapDecision): kills ONLY a watcher whose session is raw `signed_off` AND
 * last_seen older than 60 min. Wrapped so it NEVER blocks server startup; returns
 * the count reaped.
 */
export function reapOrphanedWatchers(now = Date.now()): number {
  let killed = 0
  try {
    const procs = scanWatcherProcs()
    if (!procs.length) return 0
    const sessions = all<{ sessionId: string; rawStatus: string; lastSeen: number }>(
      `SELECT id AS sessionId, status AS rawStatus, last_seen AS lastSeen FROM session_meta`,
    )
    for (const pid of reapDecision(procs, sessions, now)) {
      try {
        process.kill(pid, 'SIGTERM')
        killed++
      } catch {
        /* gone / not ours — skip */
      }
    }
    if (killed) console.log(`[bus] reaped ${killed} orphaned watcher process(es)`)
  } catch {
    /* never block startup */
  }
  return killed
}
