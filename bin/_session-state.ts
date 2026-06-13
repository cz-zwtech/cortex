/**
 * Per-session working memory for Cortex hooks.
 *
 * A small file-based store, keyed by Claude Code `session_id`, that lets the
 * PreToolUse (`ckn-aware`) and PostToolUse (`ckn-recall`) hooks share
 * intra-session knowledge that hasn't been distilled into a durable memory
 * yet. It is the "store it so it doesn't fail later" layer:
 *
 *   - `awareChecked` — tool-keys we've already run the (network) awareness
 *     lookup for this session. Lets us surface operational knowledge on the
 *     FIRST use of a tool/target, not on every call (the perf gate that
 *     makes broadening the aware-cache to common tools like Bash affordable).
 *   - `errors` — the last error seen per tool-key, pending recovery.
 *   - `learned` — when a tool-key errored and a later call to the SAME key
 *     succeeded, the working invocation is recorded here. The next PreToolUse
 *     for that key reminds Claude how it failed and what worked, so the same
 *     mistake isn't repeated before SessionEnd extraction turns it into a
 *     real memory.
 *
 * One file per session under ~/.local/state/ckn/sessions/<sid>.json — each
 * session writes only its own file, so the pre/post hooks never contend.
 * Files are GC'd by age on write.
 */
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'ckn', 'sessions')
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // GC session files after 7d
const MAX_LEARNED = 50 // cap per session to keep the file tiny

export interface LearnedEntry {
  /** The tool-key this lesson applies to (see {@link toolKey}). */
  key: string
  /** First line / summary of the error that preceded the fix. */
  priorError: string
  /** The invocation that worked (trimmed). */
  workingInvocation: string
  ts: number
}

interface ErrorEntry {
  errorMessage: string
  invocation: string
  ts: number
}

export interface SessionState {
  sessionId: string
  updatedAt: number
  /** toolKey -> ts of the last awareness lookup. */
  awareChecked: Record<string, number>
  /** toolKey -> last error, pending a recovery. */
  errors: Record<string, ErrorEntry>
  learned: LearnedEntry[]
}

const emptyState = (sessionId: string): SessionState => ({
  sessionId,
  updatedAt: Date.now(),
  awareChecked: {},
  errors: {},
  learned: [],
})

const statePath = (sessionId: string): string =>
  path.join(STATE_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

/**
 * Best-effort GC of stale session files. Runs on write; cheap (one readdir
 * + stat per file) and keeps the directory from growing unbounded across
 * long-running installs.
 */
const gc = (): void => {
  try {
    const now = Date.now()
    for (const f of fsSync.readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue
      const p = path.join(STATE_DIR, f)
      try {
        if (now - fsSync.statSync(p).mtimeMs > SESSION_TTL_MS) fsSync.unlinkSync(p)
      } catch {
        // skip — file may have been removed by a concurrent hook
      }
    }
  } catch {
    // dir may not exist yet — nothing to GC
  }
}

export const readSessionState = (sessionId: string): SessionState => {
  if (!sessionId) return emptyState('')
  try {
    const raw = fsSync.readFileSync(statePath(sessionId), 'utf-8')
    const s = JSON.parse(raw) as Partial<SessionState>
    return {
      sessionId,
      updatedAt: s.updatedAt ?? 0,
      awareChecked: s.awareChecked ?? {},
      errors: s.errors ?? {},
      learned: Array.isArray(s.learned) ? s.learned : [],
    }
  } catch {
    return emptyState(sessionId)
  }
}

export const writeSessionState = (state: SessionState): void => {
  if (!state.sessionId) return
  try {
    fsSync.mkdirSync(STATE_DIR, { recursive: true })
    state.updatedAt = Date.now()
    if (state.learned.length > MAX_LEARNED) {
      state.learned = state.learned.slice(-MAX_LEARNED)
    }
    fsSync.writeFileSync(statePath(state.sessionId), JSON.stringify(state), 'utf-8')
    gc()
  } catch {
    // best-effort; a missed write just means the next hook re-derives state
  }
}

/**
 * A coarse, stable key for "this kind of operation" — shared by the pre and
 * post hooks so they agree on what counts as the same tool/target.
 *
 *   - Bash is keyed by its binary (and, for ssh/scp, the target host) so
 *     `git status` and `git push` share a key but `ssh remote-host` and
 *     `ssh merit-server` don't. This is what makes "first use this session"
 *     meaningful for the catch-all shell tool.
 *   - Every other tool keys by its own name (MCP tools are already specific).
 */
export const toolKey = (tool: string, toolInput?: Record<string, unknown>): string => {
  if (tool === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    const tokens = toolInput.command.trim().split(/\s+/)
    let i = 0
    // skip leading env assignments (FOO=bar cmd ...)
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++
    const bin = (tokens[i] ?? '').split('/').pop() || 'sh'
    if ((bin === 'ssh' || bin === 'scp') && tokens.length > i + 1) {
      const host = tokens.slice(i + 1).find((t) => t && !t.startsWith('-')) ?? ''
      return `Bash:${bin}:${host}`
    }
    return `Bash:${bin}`
  }
  return tool
}

export const wasAwareChecked = (state: SessionState, key: string): boolean =>
  typeof state.awareChecked[key] === 'number'

export const markAwareChecked = (state: SessionState, key: string): void => {
  state.awareChecked[key] = Date.now()
}

/** The most recent learned lesson for a tool-key, if any. */
export const learnedFor = (state: SessionState, key: string): LearnedEntry | null => {
  for (let i = state.learned.length - 1; i >= 0; i--) {
    if (state.learned[i]!.key === key) return state.learned[i]!
  }
  return null
}

/** Record an error pending recovery for a tool-key. */
export const recordError = (
  state: SessionState,
  key: string,
  errorMessage: string,
  invocation: string,
): void => {
  state.errors[key] = {
    errorMessage: errorMessage.slice(0, 300),
    invocation: invocation.slice(0, 300),
    ts: Date.now(),
  }
}

/**
 * Record a success for a tool-key. If that key had a pending error, this is
 * a recovery: capture the working invocation as a learned lesson and clear
 * the pending error. Returns the lesson when one was recorded, else null.
 */
export const recordSuccess = (
  state: SessionState,
  key: string,
  invocation: string,
): LearnedEntry | null => {
  const pending = state.errors[key]
  if (!pending) return null
  delete state.errors[key]
  // Ignore no-op recoveries where the working call is identical to the one
  // that failed (the error wasn't about the invocation shape).
  if (invocation && invocation.trim() === pending.invocation.trim()) return null
  const lesson: LearnedEntry = {
    key,
    priorError: pending.errorMessage.split('\n')[0]!.slice(0, 200),
    workingInvocation: invocation.slice(0, 300),
    ts: Date.now(),
  }
  state.learned.push(lesson)
  return lesson
}
