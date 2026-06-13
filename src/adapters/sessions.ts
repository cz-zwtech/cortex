/**
 * Client adapter for the Sessions feature.
 *
 * Wraps the REST endpoints under /api/sessions and the WebSocket bridge for
 * `session:append` / `session:state` / `session:state-tier` events. The
 * existing watcher WS at /ws?type=watch already broadcasts these alongside
 * `fs:change`, so we piggy-back on a single connection rather than opening
 * a second one.
 */
const BASE = '/api/sessions'

export type LiveState = 'live' | 'stale' | 'idle' | 'ancient'

export interface SessionMeta {
  id: string
  projectDir: string
  filePath: string
  title: string
  startTime: string
  lastTime: string
  turnCount: number
  tokenCount: number
  fileSize: number
  lineCount: number
  mtimeMs: number
  liveState: LiveState
  model?: string
}

export interface ParsedLine {
  line: number
  timestamp: string
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'meta' | 'other'
  text: string
  tool?: string
  isError?: boolean
  toolUseId?: string
  model?: string
}

export const sessionKey = (m: { projectDir: string; id: string }): string =>
  `${m.projectDir}/${m.id}`

export const listSessions = async (): Promise<SessionMeta[]> => {
  const res = await fetch(`${BASE}/list`)
  const data = await res.json()
  return data.sessions ?? []
}

export const fetchSessionRange = async (
  projectDir: string,
  sessionId: string,
  sinceLine = 0,
  limit = 5000,
): Promise<{ lines: ParsedLine[]; nextLine: number; eof: boolean }> => {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}?sinceLine=${sinceLine}&limit=${limit}`,
  )
  if (!res.ok) return { lines: [], nextLine: sinceLine, eof: true }
  return res.json()
}

// ── WS bridge ────────────────────────────────────────────────────────────────

export type SessionWsEvent =
  | {
      type: 'session:append'
      id: string
      projectDir: string
      sessionId: string
      fromLine: number
      lines: ParsedLine[]
      nextLine: number
    }
  | { type: 'session:state'; id: string; meta: SessionMeta }
  | { type: 'session:state-tier'; id: string; liveState: LiveState; mtimeMs: number }
  | { type: 'graph:sync'; source: string; [k: string]: unknown }

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(ev: SessionWsEvent) => void>()

const wsUrl = (): string => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws?type=watch`
}

const ensureWs = () => {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }
  try {
    ws = new WebSocket(wsUrl())
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as SessionWsEvent | { type: string }
        if (
          data.type === 'session:append' ||
          data.type === 'session:state' ||
          data.type === 'session:state-tier' ||
          data.type === 'graph:sync'
        ) {
          for (const cb of listeners) cb(data as SessionWsEvent)
        }
      } catch {}
    }
    ws.onclose = () => {
      ws = null
      // Auto-reconnect with a small backoff. Browser may close the socket
      // when the dev server bounces; we want the Sessions view to recover
      // without a manual reload.
      if (listeners.size > 0 && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          ensureWs()
        }, 1500)
      }
    }
    ws.onerror = () => {
      // close handler will fire too — let it own reconnection.
    }
  } catch {
    // window.WebSocket may not be available; sessions silently won't tail.
  }
}

/**
 * Subscribe to session WS events. Returns an unsubscribe function. The
 * connection is opened lazily on the first subscriber and closed when the
 * last unsubscribes (with a small grace window so view-flips don't churn
 * the socket).
 */
export const subscribeSessions = (cb: (ev: SessionWsEvent) => void): (() => void) => {
  listeners.add(cb)
  ensureWs()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && ws) {
      try {
        ws.close()
      } catch {}
      ws = null
    }
  }
}
