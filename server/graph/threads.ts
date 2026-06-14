/**
 * The `thread` memory kind — Item-2 s2 resume surface, data layer.
 *
 * A thread is a graph entry with `kind='thread'`: a THIN anchor for an
 * in-flight workstream, NOT a task tracker (Plane owns ticketed team work).
 * It carries a lifecycle `status`, the load-bearing one-line `next_step`,
 * `[[links]]` to the detail (the node never duplicates it), and optional
 * `repo`/`branch`/`pushed?` for code threads.
 *
 * Storage maps onto the existing `entries` schema so threads ride the normal
 * memory sync (file-backed `.md` → graph, cross-machine via private-mind sync):
 *   - owner_machine  → the existing `machine` column (synced from frontmatter)
 *   - description    → the one-line human summary
 *   - everything else → a JSON object in `content`
 * The CLAIM (which live SESSION is on a thread) is runtime presence state, not
 * synced node data — it lives elsewhere (see the claim layer), so a status
 * transition rewrites the node but a claim change never does.
 *
 * The resume surface is CWD-INDEPENDENT: open threads follow you across
 * projects, unlike cwd-scoped recall — so listing filters by owner + status,
 * never by scope/cwd.
 */
import { all, get, run } from './db.js'
import { presenceStatus } from '../bus/identity.js'

export type ThreadStatus = 'open' | 'in-progress' | 'pending' | 'done' | 'blocked'

export const THREAD_STATUSES: ThreadStatus[] = ['open', 'in-progress', 'pending', 'done', 'blocked']

/** The statuses the resume surface treats as still-open (everything but done). */
export const OPEN_STATUSES: ThreadStatus[] = ['open', 'in-progress', 'pending', 'blocked']

export interface ThreadState {
  status: ThreadStatus
  /** One line — the load-bearing field for resume. */
  nextStep: string
  /** Wikilink targets to the detail (rich memories, session-output docs). */
  links: string[]
  repo?: string
  branch?: string
  pushed?: boolean
}

export interface Thread {
  id: string
  name: string
  description: string
  ownerMachine: string
  scope: string
  updatedAt: number
  state: ThreadState
}

export interface ListThreadsOpts {
  /** Restrict to threads owned by this machine. Omit for all machines. */
  ownerMachine?: string
  /** Keep only threads whose status is in this set. Omit for all statuses. */
  statuses?: ThreadStatus[]
}

const isStatus = (s: unknown): s is ThreadStatus =>
  typeof s === 'string' && (THREAD_STATUSES as string[]).includes(s)

/** Parse a thread entry's `content` JSON into structured state, defaulting safely. */
export const parseThreadState = (content: string | null | undefined): ThreadState => {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(content ?? '')
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    raw = {}
  }
  return {
    status: isStatus(raw.status) ? raw.status : 'open',
    nextStep: typeof raw.next_step === 'string' ? raw.next_step : '',
    links: Array.isArray(raw.links) ? raw.links.map((l) => String(l)) : [],
    repo: typeof raw.repo === 'string' ? raw.repo : undefined,
    branch: typeof raw.branch === 'string' ? raw.branch : undefined,
    pushed: typeof raw.pushed === 'boolean' ? raw.pushed : undefined,
  }
}

interface ThreadRow {
  id: string
  name: string
  description: string
  content: string | null
  scope: string
  updatedAt: number
  machine: string
}

const rowToThread = (row: ThreadRow): Thread => ({
  id: row.id,
  name: row.name,
  description: row.description,
  ownerMachine: row.machine,
  scope: row.scope,
  updatedAt: row.updatedAt,
  state: parseThreadState(row.content),
})

const THREAD_COLS = `id, name, description, content, scope, updatedAt, machine`

/** Fetch one thread by id. Returns null for a missing id or a non-thread entry. */
export const getThread = (id: string): Thread | null => {
  if (!id) return null
  const row = get<ThreadRow>(
    `SELECT ${THREAD_COLS} FROM entries WHERE id = ? AND kind = 'thread'`,
    id,
  )
  return row ? rowToThread(row) : null
}

/** Resolve a user-supplied thread reference to a thread. `/cortex-continue`
 *  passes whatever the user typed; the graph id may be the pretty `thread:<slug>`
 *  (from frontmatter id) or an entryId-scheme `<encoded-project>/<slug>`. Accepts
 *  in priority order: exact id → bare slug (`thread:<slug>`) → a UNIQUE
 *  entryId-suffix (`…/<slug>`) or name. Returns null when missing OR ambiguous —
 *  never guesses between two matches. */
export const resolveThreadRef = (ref: string): Thread | null => {
  if (!ref) return null
  const exact = getThread(ref)
  if (exact) return exact
  const prefixed = getThread(`thread:${ref}`)
  if (prefixed) return prefixed
  const matches = listThreads({}).filter((t) => t.id.endsWith(`/${ref}`) || t.name === ref)
  return matches.length === 1 ? matches[0] : null
}

/** List threads, most-recent first. cwd-independent — no scope filter. */
export const listThreads = (opts: ListThreadsOpts = {}): Thread[] => {
  const where = [`kind = 'thread'`]
  const params: unknown[] = []
  if (opts.ownerMachine) {
    where.push('machine = ?')
    params.push(opts.ownerMachine)
  }
  const rows = all<ThreadRow>(
    `SELECT ${THREAD_COLS} FROM entries WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC`,
    ...params,
  )
  let threads = rows.map(rowToThread)
  if (opts.statuses && opts.statuses.length > 0) {
    const keep = new Set(opts.statuses)
    threads = threads.filter((t) => keep.has(t.state.status))
  }
  return threads
}

// ── claim-on-presence ──────────────────────────────────────────────────────
// A CLAIM = (thread, the SESSION working it). Distinct from owner_machine (which
// MACHINE owns the work). A claim is ACTIVE only while its session is present on
// the bus (live | idle); it LAPSES to pending when the session goes stale or
// signs off. Append-only — lineage preserved (claimed_at / released_at, never
// overwritten). The graceful hand-off (s2b) layers on top.

export type ThreadClaimState = 'pending' | 'claimed-mine' | 'claimed-other'

/** Open a claim on a thread for a session. No-op if this session already holds
 *  an open claim on it (idempotent); appends a new lineage row otherwise. */
export const claimThread = (threadId: string, sessionId: string, now: number): void => {
  if (!threadId || !sessionId) return
  const open = get<{ x: number }>(
    `SELECT 1 AS x FROM thread_claims WHERE thread_id = ? AND session_id = ? AND released_at = 0`,
    threadId,
    sessionId,
  )
  if (open) return
  run(
    `INSERT INTO thread_claims (thread_id, session_id, claimed_at, released_at) VALUES (?, ?, ?, 0)`,
    threadId,
    sessionId,
    now,
  )
}

/** Release this session's open claim on a thread (sets released_at; the row stays
 *  for lineage). No-op if there is no open claim by this session. */
export const releaseThread = (threadId: string, sessionId: string, now: number): void => {
  run(
    `UPDATE thread_claims SET released_at = ? WHERE thread_id = ? AND session_id = ? AND released_at = 0`,
    now,
    threadId,
    sessionId,
  )
}

/** Set the work mode on this session's OPEN claim of a thread (mode-on-claim, #89):
 *  'working' | 'quiesced' | 'waiting-on:<predicate>'. No-op without an open claim. */
export const setClaimMode = (threadId: string, sessionId: string, mode: string): void => {
  if (!threadId || !sessionId || !mode) return
  run(
    `UPDATE thread_claims SET mode = ? WHERE thread_id = ? AND session_id = ? AND released_at = 0`,
    mode,
    threadId,
    sessionId,
  )
}

/** This session's OPEN claim (most recent) + its mode — the PostCompact resume read. */
export const getOpenClaimForSession = (
  sessionId: string,
): { threadId: string; mode: string } | null => {
  if (!sessionId) return null
  const row = get<{ thread_id: string; mode: string }>(
    `SELECT thread_id, mode FROM thread_claims WHERE session_id = ? AND released_at = 0 ORDER BY claimed_at DESC LIMIT 1`,
    sessionId,
  )
  return row ? { threadId: row.thread_id, mode: row.mode } : null
}

/** Compute a thread's claim state for `mySessionId`. The open claim only counts
 *  while its session is present (live | idle); a stale/signed-off claimer — or a
 *  vanished one — lapses the claim back to pending. */
export const threadClaimState = (
  threadId: string,
  mySessionId: string,
  now: number,
): ThreadClaimState => {
  const open = get<{ session_id: string }>(
    `SELECT session_id FROM thread_claims WHERE thread_id = ? AND released_at = 0 ORDER BY claimed_at DESC LIMIT 1`,
    threadId,
  )
  if (!open) return 'pending'
  const sess = get<{ last_seen: number; status: string }>(
    `SELECT last_seen, status FROM session_meta WHERE id = ?`,
    open.session_id,
  )
  if (!sess) return 'pending' // claimer vanished from presence → lapsed
  const status = presenceStatus({ lastSeen: sess.last_seen, rawStatus: sess.status }, now)
  if (status === 'stale' || status === 'signed_off') return 'pending'
  return open.session_id === mySessionId ? 'claimed-mine' : 'claimed-other'
}

export interface ThreadWithClaim extends Thread {
  /** Claim state relative to the asking session at the time of the call. */
  claimState: ThreadClaimState
}

/** List threads (same filters as `listThreads`) annotated with each thread's
 *  claim state relative to `mySessionId` at `now` — the data behind
 *  `/cortex-threads`. */
export const listThreadsWithClaim = (
  mySessionId: string,
  now: number,
  opts: ListThreadsOpts = {},
): ThreadWithClaim[] =>
  listThreads(opts).map((t) => ({ ...t, claimState: threadClaimState(t.id, mySessionId, now) }))

/** Resume candidates for `/cortex-continue`: OPEN threads NOT held by another
 *  live session — i.e. pending (free, or a lapsed stale-claimer) or already
 *  claimed-mine. A thread a present peer is actively working (claimed-other) is
 *  withheld so two sessions don't collide on the same resume. Most-recent first.
 *  `statuses` is forced to the open set; pass `ownerMachine` to scope by box. */
export const resumableThreads = (
  mySessionId: string,
  now: number,
  opts: Omit<ListThreadsOpts, 'statuses'> = {},
): ThreadWithClaim[] =>
  listThreadsWithClaim(mySessionId, now, { ...opts, statuses: OPEN_STATUSES }).filter(
    (t) => t.claimState !== 'claimed-other',
  )
