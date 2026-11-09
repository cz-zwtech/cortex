/**
 * Is this member's comms watcher listening? Answered from a local file the
 * watcher keeps, so no harness session id is involved.
 *
 * V1's nudge had two faults this replaces:
 *   - it reminded on every prompt while no watcher ran, so it was noise
 *     after the first time;
 *   - it could not tell "never armed" from "armed, then the 30-minute Monitor
 *     cap expired it", so it said the same thing for both.
 *
 * `cortex-role watch` writes <dataDir>/watch/<member>.json on start, refreshes
 * `beatAt` while it loops, and stamps `endedAt` when its window closes or it is
 * signalled. A killed watcher writes nothing more, so a stale `beatAt` is the
 * fallback. Reminders are recorded per lapse, so each lapse is mentioned once.
 */
import fs from 'node:fs'
import path from 'node:path'

export const WATCH_BEAT_MS = 15_000
/** Four missed beats: the watcher is gone even if it never said so. */
export const WATCH_STALE_MS = 4 * WATCH_BEAT_MS

export type WatchState = {
  member: string
  pid: number
  startedAt: number
  beatAt: number
  endedAt?: number
}

type Reminded = { lapse?: number; sessions?: string[]; blocks?: Record<string, number> }

export type WatchStatus =
  | { kind: 'never' }
  | { kind: 'live'; since: number }
  | { kind: 'lapsed'; at: number }

const file = (dir: string, member: string, suffix = '') => path.join(dir, 'watch', `${member}${suffix}.json`)

const read = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as T
  } catch {
    return null
  }
}

const write = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(v))
}

export const recordWatch = (dir: string, s: WatchState) => write(file(dir, s.member), s)

export const watchStatus = (dir: string, member: string, now = Date.now()): WatchStatus => {
  const s = read<WatchState>(file(dir, member))
  if (!s) return { kind: 'never' }
  if (s.endedAt) return { kind: 'lapsed', at: s.endedAt }
  if (now - s.beatAt > WATCH_STALE_MS) return { kind: 'lapsed', at: s.beatAt }
  return { kind: 'live', since: s.startedAt }
}

/**
 * Should this prompt carry a reminder? Once per lapse, and for a watcher that
 * was never armed, once per session. Records that it has reminded.
 */
export const takeReminder = (dir: string, member: string, sessionId: string | undefined, status: WatchStatus): boolean => {
  if (status.kind === 'live') return false
  const f = file(dir, member, '.reminded')
  const r = read<Reminded>(f) ?? {}
  if (status.kind === 'lapsed') {
    if (r.lapse === status.at) return false
    write(f, { ...r, lapse: status.at })
    return true
  }
  if (!sessionId || r.sessions?.includes(sessionId)) return false
  write(f, { ...r, sessions: [...(r.sessions ?? []).slice(-20), sessionId] })
  return true
}

export const isHeadless = (env: NodeJS.ProcessEnv): boolean => (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk')

/** How many times one lapse may stop a turn from ending. Past it the session is left alone. */
export const STOP_BLOCKS_PER_LAPSE = 2

/**
 * May the Stop hook hold this turn open for a re-arm? Counted per lapse (or per
 * session for a watcher never armed), so a session that cannot run Monitor at
 * all is not looped forever. Records the block.
 */
export const takeStopBlock = (dir: string, member: string, sessionId: string | undefined, status: WatchStatus): boolean => {
  if (status.kind === 'live') return false
  const key = status.kind === 'lapsed' ? `lapse:${status.at}` : `session:${sessionId ?? ''}`
  const f = file(dir, member, '.reminded')
  const r = read<Reminded>(f) ?? {}
  const n = r.blocks?.[key] ?? 0
  if (n >= STOP_BLOCKS_PER_LAPSE) return false
  // Keep only the current key: an old lapse's count is never consulted again.
  write(f, { ...r, blocks: { [key]: n + 1 } })
  return true
}
