/**
 * Cortex usage-scores sidecar — Phase 5.
 *
 * Tracks how many times each Entry has been surfaced by the recall
 * pipeline. Per the Phase 5 design decisions:
 *   - Sidecar storage at ~/.config/ckn/usage-scores.json (not in the graph DB)
 *   - No time decay — a working pattern stays valuable indefinitely.
 *     If you used SSH four times last year and found a working fifth
 *     attempt, that lesson is just as valid today as the day it was
 *     captured.
 *   - Positive-only signals — every surface counts as evidence the
 *     memory was relevant to a query. We don't penalize unused memories.
 *
 * Storage shape:
 *   {
 *     "version": 1,
 *     "entries": {
 *       "<entry-id>": {
 *         "shown": 12,           // total times returned by /api/recall
 *         "lastShownAt": <ms>    // most recent surface — display only
 *       }
 *     }
 *   }
 *
 * In-memory map loaded lazily on first call. Mutations are debounced
 * to disk via a 1s timer so a 25-hit recall response doesn't fsync 25
 * times. Reads return live values regardless of pending flush.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const STORE_PATH = path.join(os.homedir(), '.config', 'ckn', 'usage-scores.json')
const FLUSH_DEBOUNCE_MS = 1000
/** When a memory is shown N times, normalize the score to ~1.0 around
 *  this threshold. log(1+10)/log(1+10) = 1.0 — beyond 10 surfaces, the
 *  bonus saturates. The first few surfaces matter most. */
const SATURATION_COUNT = 10

interface UsageEntry {
  shown: number
  lastShownAt: number
}

interface State {
  version: 1
  entries: Record<string, UsageEntry>
}

let _state: State | null = null
let _flushTimer: NodeJS.Timeout | null = null
let _dirty = false

const loadState = async (): Promise<State> => {
  if (_state) return _state
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<State>
    if (parsed.version === 1 && parsed.entries) {
      _state = parsed as State
      return _state
    }
  } catch {
    // missing or corrupt — start fresh
  }
  _state = { version: 1, entries: {} }
  return _state
}

const flush = async (): Promise<void> => {
  if (!_state || !_dirty) return
  await fsp.mkdir(path.dirname(STORE_PATH), { recursive: true })
  // Atomic via tempfile + rename so a crash mid-write can't corrupt
  // the store.
  const tmp = STORE_PATH + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(_state, null, 2), 'utf-8')
  await fsp.rename(tmp, STORE_PATH)
  _dirty = false
}

const scheduleFlush = (): void => {
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    void flush()
  }, FLUSH_DEBOUNCE_MS)
}

/**
 * Record one surface event for an entry. Increments shown and updates
 * lastShownAt to now. Called by /api/recall for every hit it returns.
 */
export const recordSurface = async (entryIds: string[]): Promise<void> => {
  if (entryIds.length === 0) return
  const state = await loadState()
  const now = Date.now()
  for (const id of entryIds) {
    const existing = state.entries[id] ?? { shown: 0, lastShownAt: 0 }
    state.entries[id] = {
      shown: existing.shown + 1,
      lastShownAt: now,
    }
  }
  _dirty = true
  scheduleFlush()
}

/**
 * Lookup the raw count for an entry. Returns 0 when never surfaced.
 * Synchronous — uses the in-memory map. Caller must have called
 * `loadState()` once via any other API first; we call it lazily on
 * the first read to avoid bookkeeping.
 */
export const getShown = async (entryId: string): Promise<number> => {
  const state = await loadState()
  return state.entries[entryId]?.shown ?? 0
}

/**
 * Normalized usage bonus in [0, 1]. log(1 + count) / log(1 + saturation).
 * Capped at 1.0 so a memory used 1000 times doesn't dominate one used
 * 10 times — diminishing returns, not exponential.
 *
 *   shown=0   → 0.00
 *   shown=1   → 0.29
 *   shown=5   → 0.75
 *   shown=10  → 1.00 (saturated)
 *   shown=100 → 1.00 (capped)
 */
export const usageBonus = async (entryId: string): Promise<number> => {
  const shown = await getShown(entryId)
  if (shown <= 0) return 0
  const raw = Math.log(1 + shown) / Math.log(1 + SATURATION_COUNT)
  return Math.min(1, raw)
}

/**
 * Bulk lookup. Returns a map of id → normalized bonus. Used by
 * graphRecall to fold usage into the composite score in a single pass.
 */
export const usageBonuses = async (
  entryIds: string[],
): Promise<Map<string, number>> => {
  const state = await loadState()
  const out = new Map<string, number>()
  for (const id of entryIds) {
    const shown = state.entries[id]?.shown ?? 0
    if (shown <= 0) {
      out.set(id, 0)
      continue
    }
    const raw = Math.log(1 + shown) / Math.log(1 + SATURATION_COUNT)
    out.set(id, Math.min(1, raw))
  }
  return out
}

/** Force-flush — used on shutdown / explicit fsync. */
export const flushUsageScores = async (): Promise<void> => {
  if (_flushTimer) {
    clearTimeout(_flushTimer)
    _flushTimer = null
  }
  await flush()
}

/** Total entries with non-zero usage. Used by status endpoints. */
export const usageEntryCount = async (): Promise<number> => {
  const state = await loadState()
  return Object.keys(state.entries).length
}
