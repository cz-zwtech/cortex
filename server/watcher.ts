import { WebSocketServer, WebSocket } from 'ws'
import chokidar, { FSWatcher } from 'chokidar'
import os from 'node:os'
import path from 'node:path'
import {
  readSessionRange,
  sessionMetaFor,
  sessionRefFromPath,
  stateForAge,
  type LiveState,
  type SessionMeta,
  type ParsedLine,
} from './sessions.js'
import { extractPatterns, upsertPattern } from './graph/patterns.js'
import { refreshAwareCache } from './awareCache.js'
import { refreshCodegraphCache } from './codegraphCache.js'
import { noteMemoryChange, isMemoryMdPath } from './graph/turnSync.js'

const home = os.homedir()

// Paths we always watch: global Claude config
const DEFAULT_WATCH = [
  path.join(home, '.claude'),
  path.join(home, '.claude.json'),
]

let watcher: FSWatcher | null = null
const clients = new Set<WebSocket>()

/**
 * Per-session bookkeeping for the liveness state machine. We track the last
 * raw-line offset we've broadcast (so each `session:append` only carries
 * new lines) plus the last broadcast LiveState, so the periodic sweep
 * doesn't re-emit redundant `session:state` events on every tick.
 */
interface SessionTracker {
  projectDir: string
  sessionId: string
  filePath: string
  lastLineSent: number
  lastBroadcastState: LiveState | null
  lastMtimeMs: number
  /**
   * Pattern ids we've already upserted for this session. Cheap set lookup
   * avoids re-running CREATE/DELETE roundtrips against the graph on every append.
   */
  knownPatternIds: Set<string>
  /**
   * Per-tracker mutex for pattern extraction. The watcher fires multiple
   * append events in rapid succession during heavy session activity;
   * without this, two extracts can race on the same JSONL read + graph
   * write. `extractInFlight` is set while a run is active; `extractDirty`
   * flags that another run is needed once the current one finishes.
   */
  extractInFlight: boolean
  extractDirty: boolean
}
const sessionTrackers = new Map<string, SessionTracker>() // key: projectDir/sessionId

const trackerKey = (projectDir: string, sessionId: string) =>
  `${projectDir}/${sessionId}`

function broadcast(event: object) {
  const msg = JSON.stringify(event)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }
}

/**
 * Public broadcast hook for non-watcher modules (e.g. graph routes need to
 * announce that a sync just completed so the Sessions rail can refresh).
 * Re-exported through this module so callers don't need to know about the
 * WS server's lifecycle.
 *
 * `graph:sync` events also rebuild the PreToolUse aware-cache so hooks
 * fired immediately after a sync see the latest tool set without the TTL.
 */
export function broadcastEvent(event: object) {
  broadcast(event)
  if ((event as any)?.type === 'graph:sync') {
    void refreshAwareCache().catch(() => {
      // best-effort — hooks fall back to API or skip if cache misses
    })
    void refreshCodegraphCache().catch(() => {
      // best-effort — hook falls back to TTL'd cache or skips
    })
  }
}

/**
 * Read newly-written lines for a session and emit `session:append` plus a
 * fresh `session:state` (which carries up-to-date metadata, not just the
 * live tier — the client wants turn/token counts to refresh on every
 * write).
 */
async function handleSessionWrite(projectDir: string, sessionId: string, filePath: string) {
  const key = trackerKey(projectDir, sessionId)
  let tracker = sessionTrackers.get(key)
  if (!tracker) {
    tracker = {
      projectDir,
      sessionId,
      filePath,
      lastLineSent: 0,
      lastBroadcastState: null,
      lastMtimeMs: 0,
      knownPatternIds: new Set<string>(),
      extractInFlight: false,
      extractDirty: false,
    }
    sessionTrackers.set(key, tracker)
  }

  // Fetch new lines + meta in parallel.
  const [range, meta] = await Promise.all([
    readSessionRange(projectDir, sessionId, tracker.lastLineSent, 5000).catch(() => null),
    sessionMetaFor(projectDir, sessionId).catch(() => null),
  ])

  if (range && range.lines.length > 0) {
    broadcast({
      type: 'session:append',
      id: `${projectDir}/${sessionId}`,
      projectDir,
      sessionId,
      fromLine: tracker.lastLineSent,
      lines: range.lines,
      nextLine: range.nextLine,
    } satisfies SessionAppendEvent)
    tracker.lastLineSent = range.nextLine
  }

  if (meta) {
    tracker.lastMtimeMs = meta.mtimeMs
    if (tracker.lastBroadcastState !== meta.liveState) {
      tracker.lastBroadcastState = meta.liveState
    }
    broadcast({
      type: 'session:state',
      id: `${projectDir}/${sessionId}`,
      meta,
    } satisfies SessionStateEvent)
  }

  // Pattern extraction. We need the full session — a fail line can be
  // older than `lastLineSent` while its success only appears now. The
  // tracker's `knownPatternIds` set keeps DB writes O(new patterns), not
  // O(all patterns) per append.
  void extractAndUpsertPatterns(tracker)
}

async function extractAndUpsertPatterns(tracker: SessionTracker): Promise<void> {
  // Mutex: if a run is already in flight for this tracker, just mark
  // dirty and let the in-flight run loop again when it finishes. Avoids
  // overlapping reads of the same JSONL + concurrent graph writes.
  if (tracker.extractInFlight) {
    tracker.extractDirty = true
    return
  }
  tracker.extractInFlight = true
  try {
    do {
      tracker.extractDirty = false
      try {
        const full = await readSessionRange(tracker.projectDir, tracker.sessionId, 0, 50_000)
        if (full.lines.length === 0) continue
        const candidates = extractPatterns(tracker.projectDir, tracker.sessionId, full.lines)
        let added = 0
        for (const c of candidates) {
          if (tracker.knownPatternIds.has(c.id)) continue
          const isNew = await upsertPattern(c)
          tracker.knownPatternIds.add(c.id)
          if (isNew) added++
        }
        if (added > 0) {
          broadcast({ type: 'graph:sync', source: 'pattern-extract', added })
        }
      } catch {
        // Pattern extraction is best-effort — never crash the watcher on
        // a mis-shaped JSONL or a transient graph DB hiccup.
      }
    } while (tracker.extractDirty)
  } finally {
    tracker.extractInFlight = false
  }
}

/**
 * Periodic sweep that re-evaluates each tracked session's age so live →
 * stale → idle → ancient transitions get broadcast even when the file
 * stops being written to. Runs every 10s — finer than 30s since the
 * 60s/120s thresholds want to be observed without much lag.
 */
const SWEEP_INTERVAL_MS = 10_000
let sweepTimer: NodeJS.Timeout | null = null

function startSweep() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const t of sessionTrackers.values()) {
      const next = stateForAge(now - t.lastMtimeMs)
      if (next !== t.lastBroadcastState) {
        t.lastBroadcastState = next
        broadcast({
          type: 'session:state-tier',
          id: `${t.projectDir}/${t.sessionId}`,
          liveState: next,
          mtimeMs: t.lastMtimeMs,
        } satisfies SessionStateTierEvent)
      }
    }
  }, SWEEP_INTERVAL_MS)
}

export interface SessionAppendEvent {
  type: 'session:append'
  id: string
  projectDir: string
  sessionId: string
  fromLine: number
  lines: ParsedLine[]
  nextLine: number
}

export interface SessionStateEvent {
  type: 'session:state'
  id: string
  meta: SessionMeta
}

/** Cheaper state-only update (no full meta re-read) for tier transitions. */
export interface SessionStateTierEvent {
  type: 'session:state-tier'
  id: string
  liveState: LiveState
  mtimeMs: number
}

function ensureWatcher(extraPaths: string[] = []) {
  const paths = [...DEFAULT_WATCH, ...extraPaths]
  if (watcher) {
    watcher.add(paths)
    return
  }
  watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    ignored: /(node_modules|\.git|target|dist)/,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  })

  const onChange = (kind: string) => (filePath: string) => {
    broadcast({ type: 'fs:change', kind, paths: [filePath] })
    // Memory .md change → bump the silent-layer turn-sync change-guard (#111), so the next
    // turn folds it into the graph and a quiet turn stays free. In-process, ~zero cost.
    if (isMemoryMdPath(filePath)) noteMemoryChange(Date.now())
    // Session JSONLs trigger an additional session-specific broadcast.
    const ref = sessionRefFromPath(filePath)
    if (ref) {
      void handleSessionWrite(ref.projectDir, ref.sessionId, filePath)
    }
  }

  watcher.on('add', onChange('create'))
  watcher.on('change', onChange('modify'))
  watcher.on('unlink', onChange('remove'))
  watcher.on('addDir', onChange('create'))
  watcher.on('unlinkDir', onChange('remove'))

  startSweep()
}

/**
 * WebSocket connections on /ws?type=watch receive file-change events.
 * They can also send { type:'watch', paths:[] } to add more paths.
 */
export function setupWatcher(wss: WebSocketServer) {
  ensureWatcher()

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('type') !== 'watch') return

    clients.add(ws)
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.type === 'watch' && Array.isArray(data.paths)) {
          ensureWatcher(data.paths)
        }
      } catch {}
    })
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })
}
