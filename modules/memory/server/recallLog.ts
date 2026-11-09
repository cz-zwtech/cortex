/**
 * The record of what recall put in front of the model, and what it left out.
 *
 * Hook-time modules log to the hook's stderr, which the harness discards, so
 * until this existed no machine kept any trace of a prompt-time decision. A
 * memory dropped for size, cut by the floor or suppressed as a repeat was
 * invisible, and a miss could only be reconstructed by hand.
 *
 * Ids, scores and reasons only. Never the prompt, a memory's text, or anything
 * the model said: this file is read to tune ranking, and nothing in tuning needs
 * the words.
 */

import fs from 'node:fs'
import path from 'node:path'

export type RecallLogRow = {
  at: number
  session?: string
  /** Which surface asked: a prompt, a write about to happen, or a reply ending in a question. */
  event: 'prompt' | 'write' | 'ask'
  /** 2 for the expanded re-query after a first pass came back empty or weak; absent for a single pass. */
  pass?: 1 | 2
  via: string
  degraded?: string
  /** How many terms the query had, and how many an alias expanded. Counts, not terms. */
  terms: number
  expanded: number
  hits: { id: string; score: number; sim?: number }[]
  shown: string[]
  trimmed: string[]
  suppressed: string[]
  belowMinSim: number
  /** Ranked hits that were left out whole because they did not fit the budget. */
  droppedForSize: number
  droppedByFloor: number
  constraints: string[]
}

export const RECALL_LOG = 'recall.jsonl'
/** One rotation at this size keeps the newest stretch without growing without bound. */
export const RECALL_LOG_MAX_BYTES = 5 * 1024 * 1024

const round = (n: number) => Math.round(n * 1000) / 1000

export const appendRecallLog = (dataDir: string, row: RecallLogRow): void => {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const file = path.join(dataDir, RECALL_LOG)
    try {
      if (fs.statSync(file).size > RECALL_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      // No file yet.
    }
    const clean = { ...row, hits: row.hits.map((h) => ({ id: h.id, score: round(h.score), ...(h.sim === undefined ? {} : { sim: round(h.sim) }) })) }
    fs.appendFileSync(file, `${JSON.stringify(clean)}\n`)
  } catch {
    // A log that can break a turn is worse than no log.
  }
}
