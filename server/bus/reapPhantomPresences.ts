import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { all, run } from '../graph/db.js'
import { localTranscriptIds } from '../../bin/_session-id.js'

/**
 * Server-side phantom-presence reaping (Part 3 of the session-identity fix).
 *
 * A continue/compact bootstrap mints a PHANTOM session id that receives a blank
 * bus presence (and SessionStart artifacts) but NEVER a transcript — splitting a
 * session's presence from its real, transcript-backed id. This retires those
 * phantom rows so name-addressing resolves to the one real row.
 *
 * Discriminator = SAME-MACHINE TRANSCRIPT EXISTENCE ONLY. Blank cwd/name is NOT
 * a reliable signal (a post-rebind phantom carried name+cwd+machine). A fresh
 * session has no transcript at SessionStart, so a grace window protects it.
 */

const DEFAULT_GRACE_MS = 5 * 60 * 1000

export interface PhantomPresenceRow {
  sessionId: string
  machine: string
  rawStatus: string
  startedAt: number
}

export interface PhantomReapInput {
  rows: PhantomPresenceRow[]
  transcriptIds: Set<string>
  thisMachine: string
  now: number
  graceMs?: number
}

/**
 * Pure decision: which session ids to retire. Reap a row iff it is
 * same-machine, NOT already signed_off, has NO local `<id>.jsonl` transcript,
 * and is past the fresh-session grace window. NEVER reaps a transcript-backed
 * row, a within-grace fresh session, or a mesh-remote row (its transcript lives
 * on another machine, so local absence proves nothing).
 */
export function phantomReapDecision(inp: PhantomReapInput): string[] {
  const grace = inp.graceMs ?? DEFAULT_GRACE_MS
  return inp.rows
    .filter(
      (r) =>
        r.machine === inp.thisMachine &&
        r.rawStatus !== 'signed_off' &&
        !inp.transcriptIds.has(r.sessionId) &&
        inp.now - r.startedAt > grace,
    )
    .map((r) => r.sessionId)
}

const thisMachineId = (): string => {
  try {
    return readFileSync(path.join(os.homedir(), '.config', 'ckn', 'machine-id'), 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * Best-effort retire of phantom presences. Retire = status→`signed_off` (NOT a
 * delete — `bus_messages` rows are KEPT for audit, same as the m1 purge). Never
 * throws; returns the count retired. Safe to call at startup and periodically.
 */
export function reapPhantomPresences(now = Date.now(), graceMs = DEFAULT_GRACE_MS): number {
  let retired = 0
  try {
    const thisMachine = thisMachineId()
    if (!thisMachine) return 0 // can't scope same-machine safely → do nothing
    const rows = all<PhantomPresenceRow>(
      `SELECT id AS sessionId, machine, status AS rawStatus, started_at AS startedAt FROM session_meta`,
    )
    const transcriptIds = localTranscriptIds()
    const ids = phantomReapDecision({ rows, transcriptIds, thisMachine, now, graceMs })
    for (const id of ids) {
      run(`UPDATE session_meta SET status = 'signed_off', last_seen = ? WHERE id = ?`, now, id)
      retired++
    }
    if (retired) console.log(`[bus] retired ${retired} phantom presence row(s) (no transcript, past grace)`)
  } catch {
    /* never block startup */
  }
  return retired
}
