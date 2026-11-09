/**
 * Overrides for rules that deny: the user's, and only the user's.
 *
 * A deny that the session could lift itself would be a reminder with extra
 * steps. `cortex-rules allow` writes an override only from a terminal (stdin
 * and stdout are TTYs), which an agent's tool call never is; the deny reason
 * says to ask him. An override is for one call (--once) or a stretch (--for),
 * is logged when used, and expires by itself.
 */

import fs from 'node:fs'
import path from 'node:path'

export type Override = { rule: string; at: number; once?: boolean; until?: number }

export const OVERRIDES = 'rule-overrides.json'

const file = (dataDir: string) => path.join(dataDir, OVERRIDES)

export const readOverrides = (dataDir: string): Override[] => {
  try {
    const all = JSON.parse(fs.readFileSync(file(dataDir), 'utf-8')) as Override[]
    return Array.isArray(all) ? all : []
  } catch {
    return []
  }
}

const write = (dataDir: string, all: Override[]) => {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file(dataDir), JSON.stringify(all, null, 2))
}

/** Live overrides only: an expired one is gone, and so is a used --once. */
const live = (all: Override[], now: number) => all.filter((o) => (o.until === undefined || o.until > now) && (o.once || o.until !== undefined))

export const addOverride = (dataDir: string, o: Override, now = Date.now()): void => write(dataDir, [...live(readOverrides(dataDir), now), o])

/** Whether a rule is overridden now; a --once override is spent by asking. */
export const takeOverride = (dataDir: string, rule: string, now = Date.now()): Override | undefined => {
  const all = live(readOverrides(dataDir), now)
  const hit = all.find((o) => o.rule === rule)
  if (hit?.once) write(dataDir, all.filter((o) => o !== hit))
  return hit
}

/** "30m", "2h", "1d" in milliseconds; undefined when it is not one of those. */
export const parseDuration = (s: string): number | undefined => {
  const m = s.match(/^(\d+)\s*([mhd])$/)
  if (!m) return undefined
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
}
