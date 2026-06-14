/**
 * Silent-layer turn-sync gate (#111). Keeps the local graph continuously fresh with the
 * memory `.md` corpus on a per-turn cadence, while making a no-change turn FREE and never
 * blocking the prompt.
 *
 * Two constraints drove the shape:
 *   - Q1 (cheap no-change turn): the watcher already sees memory-md changes in-process, so
 *     it bumps `lastChangeMs` here. A turn compares that to a fold watermark — an in-memory
 *     comparison, NOT a 2700-file read+hash — so a quiet turn costs nothing.
 *   - Q2 (never block, never drop): the HTTP route ENQUEUES the fold via triggerTurnSync and
 *     fast-acks; the heavy fold runs async here. Single-flight (`inFlight`) prevents stacking.
 *
 * The watermark is the change-time captured at fold START, so a change that lands while a
 * fold is running is newer than the watermark next turn and gets re-folded (never lost).
 * On a fresh boot nothing has folded yet (`lastFoldMs === null`) → fold once, which also
 * catches any edits made while the server was down (the watcher uses ignoreInitial).
 *
 * This layer is LOCAL ONLY — it never reaches the remote/mind-sync path.
 */
export interface TurnSyncState {
  /** newest memory-md change the watcher has observed this boot; null = none seen yet. */
  lastChangeMs: number | null
  /** change-time captured at the last fold's start; null = never folded this boot. */
  lastFoldMs: number | null
  /** a fold is currently running. */
  inFlight: boolean
}
export type TurnSyncDecision = 'in-flight' | 'skip' | 'fold'

/** Pure guard: decide what a turn should do given the current gate state. */
export function decideTurnSync(s: TurnSyncState): TurnSyncDecision {
  if (s.inFlight) return 'in-flight' // single-flight — don't stack folds
  if (s.lastFoldMs === null) return 'fold' // never folded this boot → fold once (warms watermark, catches offline edits)
  if (s.lastChangeMs === null) return 'skip' // folded already + nothing changed since boot
  if (s.lastChangeMs <= s.lastFoldMs) return 'skip' // no change since the last fold
  return 'fold'
}

// ── in-process gate state (single server process; shared by watcher + graph route) ──
let lastChangeMs: number | null = null
let lastFoldMs: number | null = null
let inFlight = false

/** Called by the file watcher when a memory `.md` file changes. */
export const noteMemoryChange = (atMs: number): void => {
  lastChangeMs = atMs
}

export const turnSyncState = (): TurnSyncState => ({ lastChangeMs, lastFoldMs, inFlight })

/**
 * Decide + (if due) kick off the fold ASYNC, returning the decision immediately so the
 * caller can fast-ack. `fold` runs in the background; the watermark advances to the
 * change-time captured at fold start, and `inFlight` is always cleared (even on error).
 */
export function triggerTurnSync(fold: () => Promise<unknown>, nowMs: number): TurnSyncDecision {
  const decision = decideTurnSync(turnSyncState())
  if (decision !== 'fold') return decision
  const watermark = lastChangeMs ?? nowMs
  inFlight = true
  void Promise.resolve()
    .then(fold)
    .catch(() => {
      /* swallow — a fold failure must not wedge the gate; next change re-triggers */
    })
    .finally(() => {
      lastFoldMs = watermark
      inFlight = false
    })
  return 'fold'
}

/** Test-only: reset the in-process gate state. */
export const _resetTurnSync = (): void => {
  lastChangeMs = null
  lastFoldMs = null
  inFlight = false
}

/**
 * A memory markdown file the graph folds — matches BOTH scopes the sync covers:
 *   user-scoped     ~/.claude/memory/<slug>.md
 *   project-scoped  ~/.claude/projects/<encoded>/memory/<slug>.md
 * The watcher calls this to decide whether a change should bump the turn-sync guard.
 * (It must NOT require /projects/ — that misses user-wide memories, e.g. the ones the
 * snapshot capture writes to ~/.claude/memory/.)
 */
const MEMORY_MD_RE = /\.claude\/(memory|projects\/[^/]+\/memory)\/[^/]+\.md$/
export const isMemoryMdPath = (p: string): boolean => MEMORY_MD_RE.test(p)
