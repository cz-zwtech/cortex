/**
 * Pure helpers for the `ckn-bus watch` loop — extracted so the self-exit policy
 * is unit-testable without standing up the poll loop / server.
 */
import { readdirSync, readFileSync } from 'node:fs'

/** Minimal shape of a bus peer the watcher inspects (subset of ckn-bus `Peer`). */
export interface WatchedPeer {
  status?: string
}

/**
 * Consecutive `signed_off` poll observations required before the self-exit guard
 * fires (r1, #40). The poll runs every ~3s, so >=2 means the session has read
 * signed_off for ~3-6s straight. A /compact resume flips signed_off→live via the
 * self-heal `POST /touch` within a poll or two, so the debounce keeps a transient
 * signed_off (e.g. a stale-prune racing a resume) from killing a live watcher.
 */
export const SIGNED_OFF_EXIT_STREAK = 2

/**
 * Should a `ckn-bus watch` process exit because its OWN session is gone?
 *
 * The watcher is a DELIVERY CHANNEL, not the session's lifecycle owner (#40 B+):
 * it NEVER signs the session off — signoff belongs to SessionEnd (ckn-extract) for
 * a clean /exit + stale-prune/startup-reaper for abrupt deaths. The watcher only
 * RETIRES ITSELF once it observes its own session already signed_off, so an
 * orphaned subtree from a dead session stops piling up node RSS.
 *
 * Guarded three ways:
 *  - `sawSelfLive` so a watcher armed against a not-yet-registered session (or a
 *    stale prior incarnation of the id) never exits before it has ever observed
 *    itself live (startup race guard);
 *  - the `signedOffStreak` DEBOUNCE (r1) so a transient signed_off during a
 *    /compact self-heal revive doesn't kill a live watcher;
 *  - the caller resets the streak to 0 on any non-`signed_off` read.
 */
export function watcherShouldExit(
  me: WatchedPeer | undefined,
  sawSelfLive: boolean,
  signedOffStreak: number,
): boolean {
  return sawSelfLive && me?.status === 'signed_off' && signedOffStreak >= SIGNED_OFF_EXIT_STREAK
}

// ── firehose line format (provenance-bearing) ────────────────────────────────

/** The bus-message fields the watcher firehose line surfaces. `trust` is the
 *  load-bearing m2m node-trust verdict — SERVER-ASSERTED (never wire-read),
 *  present on BOTH delivery surfaces (poll `MSG_SELECT_INBOX` + SSE
 *  `MSG_SELECT_MESH` `*`). `meshVerified`/`originNode` ride along for the
 *  fail-safe derive when an older surface omits `trust`. */
export interface WatchLineMessage {
  id: string
  fromName?: string
  fromSession: string
  to: string
  body: string
  trust?: 'local' | 'mesh' | 'unverified'
  meshVerified?: boolean
  originNode?: string
  // humanProvenance (stage 2): a human directed this send. Surfaced as a `human`
  // tag — with a trusted source it marks the human's DIRECT instruction.
  humanProvenance?: boolean
}

/**
 * Format one `ckn-bus watch` firehose line. Trust is FRONT-LOADED (right after
 * `[bus`) so it survives the harness's notification-line truncation — a reader must
 * never lose the trust verdict to a long body. Uses the SAME `trust=` token as the
 * prompt-hook `<inter-session-message>` wrapper so a watcher-delivered message can
 * be node-trust-evaluated in real time, not only at the next prompt boundary.
 *   local → the human's voice (same box); mesh → the human's voice (authed fleet
 *   node `origin`); unverified → surface-only, and it leaks NO origin (untrusted).
 * Absent `trust` (older surface) derives fail-safe: mesh iff meshVerified, else
 * unverified — never `local` (proving local needs this node's id, server-side).
 *
 * The message `id` is also FRONT-LOADED (ahead of who/body, not trailing) so a
 * notification-line truncation can't strip it — a clipped preview still names the
 * message to look up. A body past PREVIEW_CLIP_AT is likely to be display-clipped,
 * so it gets a `full: ckn-bus inbox --all` pointer (also ahead of the body) telling
 * the reader the preview is partial and how to read the whole thing.
 */
export const PREVIEW_CLIP_AT = 240
export function formatBusLine(m: WatchLineMessage): string {
  const who = m.fromName || m.fromSession.slice(0, 8)
  const trust = m.trust ?? (m.meshVerified ? 'mesh' : 'unverified')
  const tag = trust === 'mesh' ? `trust=mesh origin=${m.originNode || '?'}` : `trust=${trust}`
  // `human` marks humanProvenance: with a trusted source it = the human's DIRECT
  // instruction (front-loaded with trust so truncation can't strip it).
  const human = m.humanProvenance ? ' human' : ''
  const full = m.body.length > PREVIEW_CLIP_AT ? ' (full: ckn-bus inbox --all)' : ''
  return `[bus ${tag}${human}] (id ${m.id})${full} ${who} → ${m.to}: ${m.body}`
}

// ── bounded liveness heartbeat ────────────────────────────────────────────────

/** The watcher's heartbeat cadence (seconds). A consumer treats a session as
 * stale once `now - last_seen > cadence_s × N` (N is the consumer's choice). */
export const HEARTBEAT_S = 30

/**
 * Best-effort liveness heartbeat — bumps `last_seen` and records the watcher's
 * cadence (so a consumer can apply its own `N × cadence` staleness). Silent +
 * no-op when the server is down; the next interval tick retries. Never throws.
 */
export async function heartbeatTouch(
  serverUrl: string,
  sessionId: string,
  cadenceS = HEARTBEAT_S,
): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/bus/touch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, cadenceS }),
    })
  } catch {
    /* server down — the next tick retries */
  }
}

// ── orphaned-watcher reap (pure decision) ─────────────────────────────────────

/** 60 min — matches the presence `stale` cutoff. A signed_off watcher older than
 * this is definitively orphaned (a resume would have re-touched it to `live`). */
const REAP_STALE_MS = 60 * 60 * 1000

/** A `ckn-bus watch` process discovered by the /proc scan. */
export interface WatcherProc {
  pid: number
  sessionId: string
  /** /proc/<pid>/stat field 22 (starttime, clock ticks since boot); 0 if unreadable.
   *  Lets the adopt reap only PROVABLY-older survivors (mutual-kill guard, #44). */
  startTicks?: number
}

/** The presence row fields the reap decision needs. `rawStatus` is the STORED
 * status (`live`/`signed_off`/…), NOT the age-derived live/idle/stale. */
export interface ReapSession {
  sessionId: string
  rawStatus: string
  lastSeen: number
}

/**
 * Decide which orphaned-watcher pids to reap. CONSERVATIVE: reap a watcher ONLY
 * when its session row EXISTS, is raw `signed_off`, AND its last_seen is older
 * than 60 min. Never reaps:
 *   - a live/idle/resuming session (raw status not signed_off);
 *   - a signed_off-but-recent session (might be mid-resume);
 *   - a proc whose session row is ABSENT (might be registering).
 * Pure + unit-tested; the I/O wrapper (server/bus/reapOrphanedWatchers.ts) feeds
 * it the /proc scan + a session_meta snapshot.
 */
export function reapDecision(procs: WatcherProc[], sessions: ReapSession[], now: number): number[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const kill: number[] = []
  for (const p of procs) {
    const s = byId.get(p.sessionId)
    if (!s) continue
    if (s.rawStatus === 'signed_off' && now - s.lastSeen > REAP_STALE_MS) kill.push(p.pid)
  }
  return kill
}

/**
 * Parse /proc/<pid>/stat → { ppid (field 4), startTicks (field 22) }, or null when
 * unreadable. The comm field (field 2) is parenthesized and may itself contain
 * spaces/parens, so the numeric fields are read AFTER the LAST ')': in that tail,
 * index 0 = state (field 3), index 1 = ppid (field 4), index 19 = starttime (f22).
 */
function readProcStat(pid: number): { ppid: number; startTicks: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(tail[1])
    const startTicks = Number(tail[19])
    return {
      ppid: Number.isInteger(ppid) ? ppid : 0,
      startTicks: Number.isFinite(startTicks) ? startTicks : 0,
    }
  } catch {
    return null
  }
}

/** This pid's /proc/<pid>/stat starttime (clock ticks); 0 if unreadable. */
export function procStartTicks(pid: number): number {
  return readProcStat(pid)?.startTicks ?? 0
}

/**
 * The full ancestor chain from `startPid` up to pid 1, INCLUDING startPid. The
 * compact-survivor adopt MUST exclude this whole chain: a watcher is armed as a
 * Monitor `bash -c '… npx tsx bin/ckn-bus.ts watch'` tree, so its OWN shell/npx/tsx
 * ancestors all match scanWatcherProcs (cmdline has `ckn-bus`+`watch` + the session
 * env). Excluding only the leaf pid made a fresh watcher SIGTERM its own parents on
 * startup (the live-dogfood SELF-ANCESTOR-KILL). Bounded walk (cycle/runaway-safe);
 * returns just `[startPid]` where /proc is unreadable.
 */
export function selfAncestryPids(startPid = process.pid): number[] {
  const chain: number[] = [startPid]
  let pid = startPid
  for (let i = 0; i < 64 && pid > 1; i++) {
    const stat = readProcStat(pid)
    if (!stat) break
    const ppid = stat.ppid
    if (!Number.isInteger(ppid) || ppid <= 0 || chain.includes(ppid)) break
    chain.push(ppid)
    pid = ppid
  }
  return chain
}

/**
 * Scan /proc for `ckn-bus watch` processes and bind each to its session id.
 * Linux-only; returns [] on any other platform or read error (never throws). Lives
 * here (the watcher-helpers module) so BOTH the server's startup reaper and the
 * watch command's compact-survivor adopt can use it without the CLI pulling in the
 * graph DB.
 *
 * Session-id resolution: the watcher is armed either with a `--session <id>` arg OR
 * (the common case) with only `CLAUDE_CODE_SESSION_ID=<id>` in its environ. cmdline
 * is NUL-delimited (`\0`), not space-delimited.
 */
export function scanWatcherProcs(): WatcherProc[] {
  const out: WatcherProc[] = []
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return [] // not Linux / no /proc
  }
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmd.includes('ckn-bus') || !cmd.includes('watch')) continue
      const args = cmd.split('\0')
      let sessionId = ''
      const i = args.indexOf('--session')
      if (i >= 0 && args[i + 1]) {
        sessionId = args[i + 1]!
      } else {
        // Fall back to the environ-bound session id (the arming command sets
        // CLAUDE_CODE_SESSION_ID and omits --session).
        try {
          const environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
          const m = environ.split('\0').find((e) => e.startsWith('CLAUDE_CODE_SESSION_ID='))
          if (m) sessionId = m.slice('CLAUDE_CODE_SESSION_ID='.length)
        } catch {
          /* environ unreadable — skip this proc (can't bind it to a session) */
        }
      }
      if (sessionId) out.push({ pid: Number(pid), sessionId, startTicks: procStartTicks(Number(pid)) })
    } catch {
      /* proc vanished / unreadable — skip */
    }
  }
  return out
}

/**
 * compact-survivor adopt (#40 B+): which OTHER `ckn-bus watch` pids bound to MY
 * session should be reaped so a session never runs two watchers? A pre-compact
 * watcher survives `/compact`, so a resume can otherwise end up with two — the
 * two-watcher situation that (with the old signoff-on-teardown) cascaded a live
 * session to signed_off. Safe to act on now that bail() no longer signs off.
 *
 * Two guards, both learned from the live dogfood:
 *  - `excludePids` is MY FULL ANCESTOR CHAIN (selfAncestryPids), not just my leaf
 *    pid — the Monitor `bash -c`/`npx`/`tsx` ancestors all match scanWatcherProcs,
 *    so excluding only the leaf made a fresh watcher SIGTERM its own parents
 *    (SELF-ANCESTOR-KILL). Note starttime-ordering does NOT cover this: ancestors
 *    are OLDER than me, so "reap older" would still target them.
 *  - reap only procs PROVABLY OLDER than me (`myStartTicks`): a genuine survivor is
 *    older by definition, and this stops two watchers arming at the same instant
 *    from reaping each other to zero (#44). Where either starttime is unknown (0),
 *    err toward NOT reaping — a benign duplicate beats zero watchers.
 */
export function survivorAdoptPids(
  excludePids: Iterable<number>,
  myStartTicks: number,
  mySessionId: string,
  procs: WatcherProc[],
): number[] {
  const exclude = new Set(excludePids)
  if (myStartTicks <= 0) return [] // can't prove anyone is older — adopt nothing
  return procs
    .filter((p) => p.sessionId === mySessionId && !exclude.has(p.pid))
    .filter((p) => (p.startTicks ?? 0) > 0 && (p.startTicks as number) < myStartTicks)
    .map((p) => p.pid)
}
