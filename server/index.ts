import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import os from 'node:os'
import { filesRouter } from './routes/files.js'
import { projectsRouter } from './routes/projects.js'
import { shellRouter } from './routes/shell.js'
import { obsidianRouter } from './routes/obsidian.js'
import { graphRouter } from './routes/graph.js'
import { sessionsRouter } from './routes/sessions.js'
import { recallRouter } from './routes/recall.js'
import { capabilityRouter } from './routes/capability.js'
import { sharedRouter } from './routes/shared.js'
import { observationsRouter } from './routes/observations.js'
import { deriveRouter } from './routes/derive.js'
import { mindRouter } from './routes/mind.js'
import { busRouter } from './routes/bus.js'
import { machinesRouter } from './routes/machines.js'
import { profileRouter } from './routes/profile.js'
import { refreshAwareCache } from './awareCache.js'
import { refreshCodegraphCache } from './codegraphCache.js'
import { warmEmbeddings } from './embeddings.js'
import { setupPty } from './pty.js'
import { setupWatcher } from './watcher.js'
import { ensureStopHook } from './hookRegistrar.js'
import { runMigrations } from './migrations.js'
import { portAlreadyOwned, listenErrorAction } from './singleInstanceGuard.js'
import { meshRouter } from './routes/mesh.js'
import { meshUpgradeAuthorized } from './bus/meshAuth.js'
import { stopMeshGossip } from './bus/meshGossip.js'
import { acceptPeer, stopWsMesh } from './bus/meshWs.js'
import { stopDiscovery } from './bus/meshDiscovery.js'
import { startMembership, stopMembership } from './bus/meshMembership.js'
import { startMeshBind, stopMeshBind } from './bus/meshBind.js'
import { reapOrphanedWatchers } from './bus/reapOrphanedWatchers.js'
import { reapPhantomPresences } from './bus/reapPhantomPresences.js'
import { pruneStaleSessions } from './bus/pruneStaleSessions.js'
import { pruneBusMessages } from './bus/retention.js'
import { startDiskGuard } from './diskGuard.js'

// ── crash-resilience guards ──────────────────────────────────────────────────
// Never let a stray promise rejection / uncaught throw silently kill the shared
// server (e.g. a fire-and-forget mesh dial on a junk peer url). The dev box has no
// supervisor, so a degraded-but-up server beats a silently-dead one. LOUD on
// purpose: these are the captured errors a crash RCA needs — before this, a crash
// went to stderr of a detached process and vanished ("crashed, no error captured").
// LIMITATION: this canNOT catch a native SIGSEGV (signal 11) — segfaults in native
// deps (onnxruntime/better-sqlite3/node-pty/tree-sitter) terminate the process below
// the JS layer and are tracked as a separate FR (+ a supervisor → principled
// log+EXIT for uncaughtException, which is log+continue here as a pragmatic stopgap).
process.on('unhandledRejection', (reason) => {
  console.error(
    '[ckn] !! UNHANDLED REJECTION (logged, continuing):',
    reason instanceof Error ? reason.stack || reason.message : reason,
  )
})
process.on('uncaughtException', (err) => {
  console.error(
    '[ckn] !! UNCAUGHT EXCEPTION (logged, continuing — state may be degraded):',
    err?.stack || err?.message || err,
  )
})

const app = express()
const server = createServer(app)
// Two noServer WebSocketServers share the one HTTP listener. `/ws` carries
// PTY/file events (setupPty/setupWatcher); `/api/mesh/ws` carries the mesh
// transport. We route the raw `upgrade` event by url so both coexist on 3001.
const wss = new WebSocketServer({ noServer: true })
const wssMesh = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/ws') {
    // PTY/files: hand off to the existing wss; setupPty/setupWatcher listen on
    // its 'connection' event, so emitting it preserves their behavior verbatim.
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    return
  }
  if (pathname === '/api/mesh/ws') {
    if (!meshUpgradeAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wssMesh.handleUpgrade(req, socket, head, (ws) => acceptPeer(ws))
    return
  }
  socket.destroy()
})

app.use(cors())
// Capture the raw body so the mesh per-request HMAC (meshAuthMiddleware) hashes
// exactly the bytes the dialer signed — re-stringifying req.body would risk a
// key-order/whitespace mismatch. Harmless for non-mesh routes (just stashes a ref).
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      ;(req as unknown as { rawBody?: Buffer }).rawBody = buf
    },
  }),
)

// Health / home dir
app.get('/api/home', (_req, res) => {
  res.json({ home: os.homedir() })
})

// Feature routers
app.use('/api/files', filesRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/shell', shellRouter)
app.use('/api/obsidian', obsidianRouter)
app.use('/api/graph', graphRouter)
app.use('/api/sessions', sessionsRouter)
app.use('/api/recall', recallRouter)
app.use('/api/capability', capabilityRouter)
app.use('/api/shared', sharedRouter)
app.use('/api/observations', observationsRouter)
app.use('/api/derive', deriveRouter)
app.use('/api/mind', mindRouter)
app.use('/api/bus', busRouter)
app.use('/api/machines', machinesRouter)
app.use('/api/mesh', meshRouter)
app.use('/api/profile', profileRouter)

// WebSocket: PTY (terminal) + file-change events
setupPty(wss)
setupWatcher(wss)

const PORT = Number(process.env.CKN_PORT ?? '3001')
// Bind: 127.0.0.1 by default (dev workstation, single user). Set
// CKN_BIND=0.0.0.0 to expose on the LAN — required for the worker-mode
// deployment where a separate dev box reaches the worker over a VLAN.
// No auth on top — the user's stated stance is "locked-down VLAN, no
// public access." Don't expose to the public internet without putting
// auth in front first.
const BIND = process.env.CKN_BIND ?? '127.0.0.1'

// Single-instance guard (bus-wedge hardening). A second server-stack launch on an
// already-owned port used to dogpile :3001 and contend the graph lock — a wedged
// server is a wedged bus. Exit cleanly BEFORE migrations/graph-lock so a loser never
// touches the graph. See server/singleInstanceGuard.ts.
const alreadyRunningMsg = `[ckn] :${PORT} already in use — another cortex is running. Exiting (single-instance guard).`
if (await portAlreadyOwned(PORT)) {
  console.log(alreadyRunningMsg)
  process.exit(0)
}
// Race backstop: if the port was free at probe time but got bound in the TOCTOU
// window, server.listen emits EADDRINUSE — exit cleanly rather than wedge. Any other
// listen error is a genuine failure and must surface.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (listenErrorAction(e.code) === 'exit') {
    console.log(alreadyRunningMsg)
    process.exit(0)
  }
  throw e
})
server.listen(PORT, BIND, async () => {
  const displayHost = BIND === '0.0.0.0' ? 'all interfaces' : BIND
  console.log(`[ckn] server ready on http://${BIND}:${PORT} (${displayHost})`)
  // Register Stop hook on first start (additive, no-op if already registered)
  try {
    await ensureStopHook()
  } catch (e: any) {
    console.warn('[ckn] could not register Stop hook:', e.message)
  }
  // Run any pending data migrations (e.g. back-fill .md files for
  // legacy in-DB-only nodes). Idempotent — recorded in
  // ~/.config/ckn/migrations.json once each migration completes.
  //
  // Migrations is the first real DB writer at startup. If the graph DB
  // can't acquire the file lock here, the server would otherwise continue
  // running with a wedged connection (port 3001 listening, every read
  // returning 500). getConnection now retries 5x with backoff and
  // throws a fatal lock-error message if it still fails; we exit on
  // that fatal so the operator sees the real cause.
  try {
    await runMigrations()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('Could not set lock on file') || msg.includes('FATAL')) {
      console.error('[ckn] graph DB lock unavailable — exiting. Restart after stopping the other ckn process.')
      process.exit(1)
    }
    console.warn('[ckn] migrations failed:', msg)
  }
  // Build the aware cache so the PreToolUse hook can short-circuit on
  // tools the graph has nothing to say about. Cheap — runs once at boot
  // and is refreshed by the watcher on graph:sync.
  void refreshAwareCache().catch((e) => {
    console.warn('[ckn] could not build aware cache:', e?.message ?? e)
  })
  void refreshCodegraphCache().catch((e) => {
    console.warn('[ckn] codegraph cache refresh failed at boot:', (e as Error)?.message ?? e)
  })

  // Warm the embedding model in its worker thread so the first /api/recall
  // doesn't pay the ~800 ms cold-load. Fire-and-forget; off when embeddings
  // are disabled. Inference runs entirely off the event loop (embeddingWorker).
  warmEmbeddings()

  // Reap orphaned `ckn-bus watch` processes left by dead sessions (watchers
  // SIGKILLed/crashed without signing off). Conservative: only signed_off +
  // >60min-stale sessions; never a live/idle/resuming one. Best-effort + Linux
  // /proc-only; wrapped so it can never block startup.
  try {
    reapOrphanedWatchers()
  } catch {
    /* never block startup */
  }

  // Prune stale presence ROWS the watcher reaper can't (it only kills processes).
  // Removes only genuinely-dead rows (signed_off >24h, or any status >30d) so the
  // peer list stays meaningful. Reversible: a real --resume re-touches the session
  // back. Best-effort; wrapped so it can never block startup.
  try {
    pruneStaleSessions()
  } catch {
    /* never block startup */
  }

  // Retire bootstrap PHANTOM presence rows — same-machine sessions with a blank
  // presence but NO `<id>.jsonl` transcript (a continue/compact bootstrap mints
  // these and the agent's watcher can arm under them, splitting presence). Past a
  // fresh-session grace window only; mesh-remote rows are spared. Keeps
  // bus_messages. Best-effort; wrapped so it can never block startup.
  try {
    reapPhantomPresences()
  } catch {
    /* never block startup */
  }

  // Disk-free-space guard — the preventive for the SIGBUS/disk-full crash vector
  // (2026-06 corrected RCA: the ~daily node crashes were mmap faults from C:
  // filling with WSL dumps + swap.vhdx, not a code defect). Periodic statfs on the
  // WSL disk + /mnt/c; logs LOUD (cooldown-gated) when low. Off via CKN_DISK_GUARD=off.
  try {
    startDiskGuard()
  } catch {
    /* never block startup */
  }

  // Bus housekeeping (stage 3A): expire old ack/done confirmations so bus_messages
  // stays bounded + the inbox stays a working surface. At boot + hourly. Content
  // kinds (msg/reply) are never pruned. Best-effort; never blocks startup.
  try {
    const n = pruneBusMessages()
    if (n > 0) console.log(`[ckn bus] pruned ${n} expired ack/done message(s) at boot`)
    setInterval(() => {
      try {
        pruneBusMessages()
      } catch {
        /* best-effort */
      }
    }, 60 * 60 * 1000).unref()
  } catch {
    /* never block startup */
  }

  // Cross-machine mesh tier — FR-7 D1: a membership controller owns this now (a
  // CONTINUOUS reachability logic test, not a boot-once env gate). It acquires the
  // token (env, or a runtime bao-run fetch — D2), brings the WS tier up (dial +
  // probe-tested discovery + persisted-peer seed + federated broker) when a token
  // is available, and degrades to local-only otherwise — all without a restart, so
  // a node booted off-VPN joins the moment OpenBao + peers become reachable. The
  // /api/mesh/ws accept route is always mounted (above) and authorizes once a token
  // exists. A standalone node (no peers, no token source) never starts the tier.
  startMembership()

  // FR-7 I4 — opt-in published mesh-accept bind. Default OFF (no CKN_MESH_BIND ⇒
  // no-op). When set, opens a SEPARATE listener serving ONLY the bearer-gated
  // /api/mesh/ws — the graph/bus/API/UI stay on the loopback listener above. Detached
  // (never blocks startup); a bind error degrades to "not published", not a crash.
  void startMeshBind()

  // Detached startup tasks, run STRICTLY SEQUENTIALLY in one IIFE so they never
  // race each other on the graph write lock — a concurrent boot-seed once wedged
  // startup. Order: (1) private-mind sync (when enabled), then (2) the
  // onboarding seed (when CKN_SEED_ONBOARDING=1). By the time (2) runs, (1) has
  // fully awaited, so the seed writes against an idle server (the proven-safe
  // case). Detached so neither blocks the server from serving.
  void (async () => {
    // (1) Private-mind startup sync — only when enabled (clone + remote, not
    // CKN_PRIVATE_MIND=off). Pull-only on boot by default — a restart reconciles
    // + adopts remote but does NOT push local commits (a reboot must not be
    // enough to publish). Set CKN_MIND_PUSH_ON_BOOT=1 to push on boot; explicit
    // syncs (/api/mind/sync, ckn-mind-sync) always push. mindSync (git+fs,
    // timeout-bounded) runs OUTSIDE the write lock; only the graph re-index locks.
    try {
      const { mindStatus, mindSync, detectDuplicates, changedLocalPaths } = await import('./privateMind.js')
      const status = await mindStatus()
      if (status.enabled) {
        const { withGraphWriteLock } = await import('./graph/db.js')
        const { syncMemories, memoryHome } = await import('./graph/sync.js')
        const pushOnBoot = process.env.CKN_MIND_PUSH_ON_BOOT === '1'
        const report = await mindSync({ push: pushOnBoot })
        if (report.enabled) {
          await withGraphWriteLock('mind-reindex-startup', () => syncMemories(memoryHome()))
          report.duplicates = await detectDuplicates(changedLocalPaths(report))
        }
        const n = report.adopted.length + report.pushedFiles.length + report.conflicts.length
        console.log(
          `[ckn] private-mind startup sync (${pushOnBoot ? 'push' : 'pull-only'}): ` +
            `${report.adopted.length} adopted, ${report.pushedFiles.length} staged, ` +
            `${report.conflicts.length} conflicts, ${report.tombstoned.length} tombstoned` +
            (n === 0 ? ' (already in sync)' : ''),
        )
        if (report.errors.length) console.warn('[ckn] private-mind sync errors:', report.errors)
      }
    } catch (e: any) {
      console.warn('[ckn] private-mind startup sync skipped:', e?.message ?? e)
    }

    // (1b) One-time node-alias seed + anchor pin (idempotent, best-effort).
    try {
      const { seedNodeAliases } = await import('./bus/seedNodeAliases.js')
      seedNodeAliases()
    } catch (e: any) {
      console.warn('[ckn] node-alias seed skipped:', e?.message ?? e)
    }

    // (2) First-boot onboarding seed — opt-in via CKN_SEED_ONBOARDING=1. Writes
    // the bundled corpus into the local graph under `shared:cortex` so a fresh
    // install can lean on Cortex recall for setup with no team mind. Runs AFTER
    // (1) above (sequential — no lock race) and once-per-machine via a marker
    // (the upsert is idempotent regardless; re-seed with `ckn-seed-onboarding --local`).
    if (process.env.CKN_SEED_ONBOARDING === '1') {
      try {
        const fs = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const marker = pathMod.join(os.homedir(), '.config', 'ckn', 'onboarding-seeded.json')
        let already = false
        try {
          await fs.access(marker)
          already = true
        } catch {
          /* not seeded yet */
        }
        if (!already) {
          const { withGraphWriteLock } = await import('./graph/db.js')
          const { seedOnboardingLocal } = await import('./onboarding/seed.js')
          const result = await withGraphWriteLock('seed-onboarding-boot', () => seedOnboardingLocal())
          await fs.mkdir(pathMod.dirname(marker), { recursive: true })
          await fs.writeFile(marker, JSON.stringify({ seeded: result.seeded, at: Date.now() }, null, 2))
          console.log(`[ckn] onboarding seeded: ${result.seeded} memories under ${result.scope}`)
        }
      } catch (e: any) {
        console.warn('[ckn] onboarding seed skipped:', e?.message ?? e)
      }
    }
  })()
})

// ── graceful shutdown ─────────────────────────────────────────────────────────
// CRITICAL: without this, SIGTERM (ckn-reboot, systemd, Ctrl-C, a kill) aborts
// Node while the graph DB may be mid-fsync on graph.db. A native write parked
// in uninterruptible (D) sleep that `do_exit` waits on can hang the process in
// the exit path indefinitely on WSL2 while STILL HOLDING the file lock. The
// successor instance then can't open the DB, and the wedge cascades (the
// recurring D-state incidents). Doing the close deliberately + awaiting it
// (drain writes → CHECKPOINT → close, in `closeGraph`) means no graph DB I/O is
// in flight at exit, so the lock releases cleanly and restart is safe.
let shuttingDown = false
const gracefulShutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[ckn] ${signal} received — shutting down gracefully…`)
  // Hard cap: if the clean path can't finish (e.g. a genuinely wedged native
  // I/O), force exit rather than become a lock-holding zombie. 6s is well under
  // ckn-reboot's SIGKILL escalation, so a clean shutdown always wins the race.
  const hardTimeout = setTimeout(() => {
    console.error('[ckn] graceful shutdown timed out (6s) — forcing exit')
    process.exit(1)
  }, 6000)
  hardTimeout.unref()
  try {
    // 1. Stop accepting new HTTP/WS connections (in-flight requests finish).
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      wss.close()
      wssMesh.close()
    } catch {
      /* ws server already closing */
    }
    // 2a. Stop the membership controller FIRST so a tick can't re-start the tier
    // mid-shutdown (it also tears the tier down), then halt the WS links — before
    // stopping gossip or closing the graph — so no inbound frame ingests against a
    // closing DB and no reconnect timer fires post-shutdown.
    stopMembership()
    stopWsMesh()
    stopMeshBind() // close the published mesh-accept listener (no-op if OFF)
    // 2b. Stop the discovery sweep so no probe-triggered dial races the close.
    stopDiscovery()
    // 2c. Stop the mesh gossip loop so no catch-up write races the graph close.
    stopMeshGossip()
    // 3. Checkpoint + close the SQLite graph — releases the WAL/file handle.
    const { closeGraph } = await import('./graph/db.js')
    await closeGraph()
    clearTimeout(hardTimeout)
    console.log('[ckn] graph closed cleanly — exiting.')
    process.exit(0)
  } catch (e: any) {
    clearTimeout(hardTimeout)
    console.error('[ckn] error during graceful shutdown:', e?.message ?? e)
    process.exit(1)
  }
}
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
