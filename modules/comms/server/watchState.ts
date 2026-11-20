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
 * `beatAt` while it loops, and stamps `endedAt` and `endedBy` when its window
 * closes or it is signalled. A killed watcher writes nothing more, so a stale
 * `beatAt` is the fallback. Reminders are recorded per lapse, so each lapse is
 * mentioned once.
 *
 * Beside it, the comms prompt hook records when the member's last prompt came
 * (<member>.prompt.json), and `cortex-role standdown` records a deliberate stop
 * (<member>.standdown.json). They are separate files because the watcher
 * rewrites its own state on every beat.
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
  endedBy?: 'window' | 'signal'
}

export type StandDown = { member: string; sessionId?: string; at: number }

type Reminded = { lapse?: number; sessions?: string[]; blocks?: Record<string, number> }

export type WatchStatus =
  | { kind: 'never' }
  | { kind: 'live'; since: number }
  // stale: no clean end was written; `at` is then the last beat, not the end.
  | { kind: 'lapsed'; at: number; endedBy?: 'window' | 'signal'; stale?: true }

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

export const recordPrompt = (dir: string, member: string, at = Date.now()) => write(file(dir, member, '.prompt'), { at })
export const lastPromptAt = (dir: string, member: string): number | undefined => read<{ at: number }>(file(dir, member, '.prompt'))?.at

export const recordStandDown = (dir: string, s: StandDown) => write(file(dir, s.member, '.standdown'), s)
export const standDown = (dir: string, member: string): StandDown | null => read<StandDown>(file(dir, member, '.standdown'))
export const clearStandDown = (dir: string, member: string) => fs.rmSync(file(dir, member, '.standdown'), { force: true })

/** Long enough to cover an exit after a stand-down; after it a dead watcher is held for again. */
export const STAND_DOWN_MS = 10 * 60_000

export const watchStatus = (dir: string, member: string, now = Date.now()): WatchStatus => {
  const s = read<WatchState>(file(dir, member))
  if (!s) return { kind: 'never' }
  if (s.endedAt) return { kind: 'lapsed', at: s.endedAt, ...(s.endedBy ? { endedBy: s.endedBy } : {}) }
  if (now - s.beatAt > WATCH_STALE_MS) return { kind: 'lapsed', at: s.beatAt, stale: true }
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

const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`

/** How a watcher that is not live came to stop, said so nobody reads a chosen stop as a failure or the reverse. */
export const lapseText = (dir: string, member: string, status: Extract<WatchStatus, { kind: 'lapsed' }>, now = Date.now()): string => {
  const sd = standDown(dir, member)
  if (sd) {
    const old = now - sd.at >= STAND_DOWN_MS ? ', more than ten minutes ago' : ''
    return `your watcher was stood down at ${hhmm(sd.at)} by ${sd.sessionId ?? sd.member}${old}`
  }
  if (status.endedBy === 'window') return `your watcher's window ended at ${hhmm(status.at)}`
  return `your watcher stopped at ${hhmm(status.at)}`
}

export const isHeadless = (env: NodeJS.ProcessEnv): boolean => (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk')

/** How many times one lapse may stop a turn from ending. Past it the session is left alone. */
export const STOP_BLOCKS_PER_LAPSE = 2

/**
 * A Monitor-ended notice can arrive mid-turn with no prompt; if the model ignores it and ends the
 * turn, nothing wakes the session again. A lapse older than this at Stop is held for whenever it came.
 */
export const LAPSE_GRACE_MS = 2 * 60_000

/**
 * Is this the lapse the Stop hold is for? A watcher never armed, one that was
 * already down at the turn's prompt (the session was told and did not re-arm),
 * or one down past LAPSE_GRACE_MS. A lapse inside the current turn is left to
 * the Monitor-ended notice and the next prompt's reminder.
 */
export const stopShouldHold = (status: WatchStatus, promptAt: number | undefined, now = Date.now()): boolean => {
  if (status.kind === 'live') return false
  if (status.kind === 'never') return true
  // A silent death may have come up to a beat after the last one written: down only from then.
  const downBy = status.stale ? status.at + WATCH_BEAT_MS : status.at
  return (promptAt !== undefined && downBy < promptAt) || now - status.at > LAPSE_GRACE_MS
}

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
