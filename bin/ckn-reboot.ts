#!/usr/bin/env tsx
/**
 * ckn-reboot — coordinated restart of the SHARED Cortex dev server (:3001).
 *
 * Multiple interactive Claude sessions share one Cortex server on this machine,
 * so a unilateral restart yanks the graph + session bus out from under peers.
 * This tool runs the agreed protocol:
 *   1. ANNOUNCE the reboot on the session bus (broadcast).
 *   2. WAIT for live peers to ACK (bounded by CKN_REBOOT_GRACE_MS, default 20s).
 *   3. REBOOT — kill the single listener by PID, start ONE non-watch instance.
 *   4. REPORT back up on the bus.
 *
 * The server is started NON-WATCH (`npm run server` = `tsx server/index.ts`):
 * `tsx watch` does not reload on /mnt (WSL inotify) and respawns its child on
 * crash, which previously piled up 9 instances contending for the graph writer.
 *
 * Usage: ckn-reboot [--reason "text"] [--grace <ms>] [--yes]
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { SERVER_URL, isServerUp } from './_graph-guard.js'

const execFileP = promisify(execFile)
const arg = (f: string): string | undefined => {
  const i = process.argv.indexOf(f)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const GRACE_MS = Number(arg('--grace') ?? process.env.CKN_REBOOT_GRACE_MS ?? '20000')
const REASON = arg('--reason') ?? 'maintenance'
const LOG = path.join(os.homedir(), '.local', 'state', 'ckn', 'server.log')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const mySession = (): string => process.env.CLAUDE_CODE_SESSION_ID ?? `reboot-${process.pid}`
const post = (p: string, body: unknown) =>
  fetch(`${SERVER_URL}/api/bus${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)
const get = async (p: string): Promise<any> => {
  try {
    const r = await fetch(`${SERVER_URL}/api/bus${p}`)
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

const announce = async (sid: string): Promise<{ id: string; livePeers: number } | null> => {
  const peersResp = await get('/peers')
  const peers: any[] = peersResp?.peers ?? []
  const me = peers.find((p) => p.sessionId === sid)
  const fromName = me?.friendlyName ?? sid.slice(0, 8)
  const livePeers = peers.filter((p) => p.sessionId !== sid && p.status === 'live').length
  const sent = await post('/send', {
    fromSession: sid,
    fromName,
    to: '*',
    body: `⚠ Rebooting the shared Cortex server (:3001) now — reason: ${REASON}. Pause graph writes; the bus will be briefly down. Reply/ack to confirm; I'll report when it's back up.`,
  })
  if (!sent) return null
  const { id } = (await (sent as Response).json().catch(() => ({}))) as { id?: string }
  return { id: id ?? '', livePeers }
}

const waitForAcks = async (sid: string, announceId: string, livePeers: number): Promise<number> => {
  if (livePeers === 0) {
    console.log('[ckn-reboot] no live peers — proceeding immediately.')
    return 0
  }
  console.log(`[ckn-reboot] waiting up to ${GRACE_MS}ms for ${livePeers} live peer(s) to ack…`)
  const ackers = new Set<string>()
  const deadline = Date.now() + GRACE_MS
  while (Date.now() < deadline && ackers.size < livePeers) {
    const inbox = await get(`/inbox?session=${encodeURIComponent(sid)}&undeliveredOnly=1`)
    for (const m of inbox?.messages ?? []) {
      if (m.ref === announceId || m.kind === 'ack' || m.kind === 'reply') ackers.add(m.fromSession)
    }
    if (ackers.size > 0) await post('/delivered', { sessionId: sid, ids: (inbox?.messages ?? []).map((m: any) => m.id) })
    if (ackers.size >= livePeers) break
    await sleep(1000)
  }
  console.log(`[ckn-reboot] ${ackers.size}/${livePeers} peer(s) acked${ackers.size < livePeers ? ' (grace elapsed; proceeding)' : ''}.`)
  return ackers.size
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killListener = async (): Promise<void> => {
  // Kill ONLY the process LISTENING on 3001 (not transient client connections).
  let pids: number[] = []
  try {
    const { stdout } = await execFileP('lsof', ['-ti:3001', '-sTCP:LISTEN'])
    pids = stdout.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0)
  } catch {
    /* nothing listening */
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  // Wait for the LISTENER PID(s) to actually exit — not merely the port to free.
  // On /mnt a server can sit in uninterruptible (D) state holding the graph
  // writer until kernel I/O completes; starting a fresh instance before the
  // predecessor is truly dead is what caused the contention + pile-up. Escalate to
  // SIGKILL midway, and only return once every PID is gone.
  for (let i = 0; i < 80; i++) {
    const stillAlive = pids.filter(pidAlive)
    if (stillAlive.length === 0) return
    if (i === 24) {
      // ~12s of graceful SIGTERM elapsed — escalate to SIGKILL. This MUST be
      // longer than the server's graceful-shutdown hard-timeout (6s in
      // server/index.ts) so a clean shutdown (drain → CHECKPOINT → close →
      // exit 0) always finishes first; SIGKILLing mid-close would abort the
      // graph DB's I/O and re-create the do_exit/D-state wedge this path avoids.
      for (const pid of stillAlive) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    await sleep(500)
  }
  console.warn('[ckn-reboot] WARNING: listener PID(s) still present after wait — proceeding may contend for the graph writer.')
}

// CKN_MESH_TOKEN (the fleet bearer gating the mesh tier) lives in OpenBao; the
// `bao-run KEY -- cmd...` wrapper injects it into the child env and execs the
// command. The non-secret mesh config (CKN_MESH_PEERS / CKN_MESH_GOSSIP_MS /
// CKN_MESH_ZOMBIE_MS) rides the ambient env. When bao-run is unavailable (or the
// token is absent) the server still starts — the mesh tier is fail-closed, so it
// stays off and the bus runs local-only.
const onPath = (cmd: string): boolean => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fsSync.accessSync(path.join(dir, cmd), fsSync.constants.X_OK)
      return true
    } catch {
      /* not here */
    }
  }
  return false
}

const startServer = (): void => {
  fsSync.mkdirSync(path.dirname(LOG), { recursive: true })
  const out = fsSync.openSync(LOG, 'a')
  const [cmd, args] = onPath('bao-run')
    ? ['bao-run', ['CKN_MESH_TOKEN', '--', 'npm', 'run', 'server']]
    : ['npm', ['run', 'server']]
  // Lean boot by DEFAULT on the shared dev box: the private-mind re-index walks
  // /mnt (WSL inotify/NTFS) and can block the event loop for minutes on boot,
  // wedging the new instance in D-state and piling up restarts (observed
  // 2026-05-31). So unless the caller has explicitly set these, force them off.
  // A box that WANTS full mode sets CKN_PRIVATE_MIND/CKN_EMBEDDINGS in its env
  // before invoking ckn-reboot, which we respect.
  const leanEnv: Record<string, string> = { ...process.env } as Record<string, string>
  if (leanEnv.CKN_PRIVATE_MIND === undefined) leanEnv.CKN_PRIVATE_MIND = 'off'
  if (leanEnv.CKN_EMBEDDINGS === undefined) leanEnv.CKN_EMBEDDINGS = 'off'
  const child = spawn(cmd as string, args as string[], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    detached: true,
    stdio: ['ignore', out, out],
    env: leanEnv,
  })
  child.unref()
}

const waitReady = async (): Promise<boolean> => {
  for (let i = 0; i < 80; i++) {
    if (await isServerUp()) return true
    await sleep(500)
  }
  return false
}

const main = async () => {
  const sid = mySession()
  const up = await isServerUp()
  if (up) {
    const a = await announce(sid)
    if (a) await waitForAcks(sid, a.id, a.livePeers)
    else console.log('[ckn-reboot] could not announce (bus unreachable) — proceeding.')
  } else {
    console.log('[ckn-reboot] server already down — starting fresh (no announce possible).')
  }
  console.log('[ckn-reboot] stopping listener on :3001…')
  await killListener()
  console.log('[ckn-reboot] starting one non-watch instance…')
  startServer()
  const ready = await waitReady()
  if (!ready) {
    console.error('[ckn-reboot] server did NOT come back up within timeout — check ' + LOG)
    process.exit(1)
  }
  await post('/send', {
    fromSession: sid,
    fromName: sid.slice(0, 8),
    to: '*',
    body: '✅ Cortex server (:3001) is back up.',
  })
  console.log('[ckn-reboot] back up — reported on the bus.')
}

main().catch((e) => {
  console.error('[ckn-reboot] fatal:', e?.message ?? e)
  process.exit(1)
})
