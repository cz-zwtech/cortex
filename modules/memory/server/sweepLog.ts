/**
 * Every sweep leaves a line in <data>/memory/sweeps.jsonl: when, what started
 * it, what it ingested and declined, and which directories it SKIPPED when its
 * budget ran out. Hook output goes to stderr, which nobody sees at exit, so a
 * sweep that silently skipped (or never ran) used to be invisible.
 */
import fs from 'node:fs'
import path from 'node:path'

export type SweepLine = {
  at: string
  trigger: 'session-start' | 'session-end' | 'cli'
  dirs: number
  ingested: number
  declined: number
  skipped: string[]
  budgetExhausted: boolean
  consume: boolean
}

const file = (dataDir: string) => path.join(dataDir, 'sweeps.jsonl')

export const logSweep = (dataDir: string, line: SweepLine): void => {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.appendFileSync(file(dataDir), JSON.stringify(line) + '\n')
  } catch {
    /* a log failure never fails a sweep */
  }
}

export const lastSweep = (dataDir: string): SweepLine | undefined => {
  try {
    const lines = fs.readFileSync(file(dataDir), 'utf-8').trim().split('\n')
    return JSON.parse(lines[lines.length - 1]!) as SweepLine
  } catch {
    return undefined
  }
}
