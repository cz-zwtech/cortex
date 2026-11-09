/**
 * Recording that a memory was SURFACED — the write half of a log three things
 * were already reading and nobody was writing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS INERT WITHOUT THIS
 *
 * `surfaced_in` observed edges are read in three places. They were written in
 * none. The consequences were silent and each looked like ordinary behaviour:
 *
 *   1. `usageBonus` was ALWAYS ZERO, so the entire usage weight (0.2, the second
 *      largest) contributed nothing to any ranking, ever.
 *   2. `decayPenalty` never found a `lastSurfacedAt`, so "coldness" measured
 *      from `authoredAt` — decay was really AGE wearing coldness's name, and no
 *      memory could ever be warmed by being used.
 *   3. RUNG 0 OF THE RECONCILE LADDER WAS UNREACHABLE. Its second corroboration
 *      route — "the graph knows what it surfaced to this session", which exists
 *      precisely to cover resolve-then-heavily-edit, the case where an honest
 *      rewrite is least similar — could never fire in production.
 *
 * The third is the sharpest, because there IS a passing test for it. The test
 * calls `store.observe(...)` itself to create the precondition, so it proves the
 * rung works while the system that would have to reach it never could. A test
 * that manufactures a state production cannot produce is green and worthless —
 * the same family as verifying an emitter and calling the consumer proven.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SURFACED MEANS SHOWN, NOT RETURNED
 *
 * Only memories actually injected are recorded. Candidates that ranked, and hits
 * dropped by the budget or the relevance floor, are NOT surfaced — they were
 * never in front of anyone. Recording them would inflate usage for memories
 * nobody saw and, worse, would warm them against decay for losing.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { MemoryStore } from './store.js'

/**
 * Record that these memories were shown to this session.
 *
 * The session hub is upserted first because an edge needs somewhere to land —
 * hubs exist so edges have a destination, carry no authored content, never
 * decay, and are never a search result.
 *
 * Best-effort by construction: surfacing is a usage signal, and failing to
 * record it must never break the recall that produced it. A memory shown but
 * not logged is a slightly stale ranking; an exception here would be a broken
 * session.
 */
export const recordSurfacing = (
  store: MemoryStore,
  memoryIds: string[],
  sessionId: string | undefined,
  at: number,
): number => {
  if (!sessionId || !memoryIds.length) return 0

  try {
    store.upsertHub({ id: sessionId, kind: 'session', name: sessionId })
  } catch {
    return 0
  }

  let recorded = 0
  for (const id of memoryIds) {
    try {
      store.observe(id, sessionId, 'surfaced_in', at)
      recorded++
    } catch {
      // One bad edge must not lose the rest.
    }
  }
  return recorded
}

// ── shown is not used ───────────────────────────────────────────────────────
//
// Counting every injection as usage made a feedback loop: a memory shown once
// ranked higher, so it was shown again (one off-topic memory could be injected
// over and over into one session). Usage now counts `used_in`, written at Stop when
// the reply used what was shown; `surfaced_in` still records what was shown,
// and suppresses a repeat while it is still in the session's context.

/** A memory shown to a session this recently is still in its context: showing it again only spends the slot. */
export const REPEAT_WINDOW_MS = 30 * 60 * 1000

export const shownRecently = (store: MemoryStore, id: string, sessionId: string | undefined, now: number): boolean =>
  !!sessionId && store.observedEdges(id).some((e) => e.rel === 'surfaced_in' && e.dst === sessionId && now - e.lastAt < REPEAT_WINDOW_MS)

export type Shown = { at: number; memories: { id: string; name: string; text: string }[] }

const shownFile = (dataDir: string, session: string) => path.join(dataDir, 'shown', `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

/** What this turn showed, for Stop to grade. Overwritten each prompt: Stop grades the turn it ends. */
export const rememberShown = (dataDir: string, session: string | undefined, s: Shown): void => {
  if (!session || !s.memories.length) return
  try {
    fs.mkdirSync(path.join(dataDir, 'shown'), { recursive: true })
    fs.writeFileSync(shownFile(dataDir, session), JSON.stringify(s))
  } catch {
    // Grading is a refinement: losing it never costs a turn.
  }
}

export const takeShown = (dataDir: string, session: string): Shown | undefined => {
  const f = shownFile(dataDir, session)
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf-8')) as Shown
    fs.rmSync(f, { force: true })
    return s
  } catch {
    return undefined
  }
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
/** Runs this long are not shared by chance. */
const RUN = 6

/**
 * Whether a reply used a shown memory: it names it, or repeats a run of six of
 * the words it was shown. Conservative on purpose: a false `used` feeds the
 * loop this replaced.
 */
export const memoryUsed = (reply: string, m: { name: string; text: string }): boolean => {
  if (m.name.length >= 6 && reply.toLowerCase().includes(m.name.toLowerCase())) return true
  const r = ` ${words(reply).join(' ')} `
  for (const line of m.text.split('\n')) {
    if (/^- \*\*|^\s*\(excerpt;/.test(line)) continue
    const w = words(line)
    for (let i = 0; i + RUN <= w.length; i++) if (r.includes(` ${w.slice(i, i + RUN).join(' ')} `)) return true
  }
  return false
}

/** Grade what the turn showed against the reply; returns the ids recorded as used. */
export const gradeShown = (store: MemoryStore, dataDir: string, sessionId: string, reply: string, at: number): string[] => {
  const shown = takeShown(dataDir, sessionId)
  if (!shown || !reply) return []
  const used = shown.memories.filter((m) => memoryUsed(reply, m)).map((m) => m.id)
  for (const id of used) {
    try {
      store.observe(id, sessionId, 'used_in', at)
    } catch {
      // One bad edge must not lose the rest.
    }
  }
  return used
}
