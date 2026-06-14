/**
 * Pure helpers for session-bus identity + presence. No I/O — unit-testable
 * standalone (test/bus/identity.test.ts).
 */
import { nanoid } from 'nanoid'

export const LIVE_MS = 5 * 60 * 1000 // < 5 min since last_seen → live
export const STALE_MS = 60 * 60 * 1000 // > 60 min → presumed dead (stale)

/** Broadcast address — matches every session's alias set. */
export const BROADCAST = '*'

/** Mint a fresh durable metaId. Random (not derived from title/cwd) so a title
 * can be reused/renamed without identity collisions; the title→metaId mapping
 * (a presence query) handles reclaim. */
export const mintMetaId = (): string => `meta_${nanoid(12)}`

/**
 * The set of addresses a session answers to. A message is for this session iff
 * its `to` is in this set. The READER owns this set, so a message addressed to
 * an old name, the current name, the metaId, the sessionId, the 8-char short
 * prefix, or '*' all match — which is what makes stale-name mis-routing
 * structurally impossible. Empties are dropped so a blank field never swallows
 * blank-`to` messages.
 *
 * The short prefix is PERMANENT + rename-independent: every UI/peer display shows
 * a session as `(411f5f18)`, so peers naturally address the 8-char prefix. Before
 * this, the prefix only resolved when it happened to be the default friendly name
 * — so a /cortex-rename'd session silently black-holed prefix-addressed messages
 * (found 2026-06-09: 3 PM directives lost this way).
 */
export const aliasSetFor = (s: {
  sessionId: string
  metaId?: string
  friendlyName?: string
  nameHistory?: string[]
  // Session-ids of PRIOR incarnations sharing this metaId (compact/resume drift).
  // Each + its short prefix becomes an alias so a peer addressing ANY past id (or
  // its prefix) still reaches the current live session. The metaId is the durable
  // identity; its incarnations' ids all resolve to it. (stage 3B / decision #5)
  siblingIds?: string[]
}): Set<string> => {
  const out = new Set<string>([BROADCAST])
  const add = (v?: string) => {
    const t = (v ?? '').trim()
    if (t) out.add(t)
  }
  add(s.sessionId)
  add(s.sessionId?.slice(0, 8)) // canonical displayed short id — always an alias
  add(s.metaId)
  add(s.friendlyName)
  for (const n of s.nameHistory ?? []) add(n)
  for (const sid of s.siblingIds ?? []) {
    add(sid)
    add(sid.slice(0, 8))
  }
  return out
}

/**
 * The set of session-ids that ARE this session across incarnations: its own id
 * plus every prior id sharing its metaId. Used to (a) exclude a session's own
 * past sends from its inbox, and (b) dedupe delivery — a message delivered to ANY
 * incarnation counts as delivered, so a compact/resume doesn't re-flood. (3B)
 */
export const selfIdSet = (sessionId: string, siblingIds?: string[]): Set<string> => {
  const out = new Set<string>()
  if (sessionId) out.add(sessionId)
  for (const sid of siblingIds ?? []) if (sid) out.add(sid)
  return out
}

/** Has this message been delivered to ANY of my incarnations? (catch-up dedup —
 *  no re-flood after a session-id drift, no drop of genuinely-unseen messages.) */
export const deliveredToSelf = (deliveredTo: string[], selfIds: Set<string>): boolean =>
  deliveredTo.some((d) => selfIds.has(d))

/** A sibling row sharing a metaId. */
export interface SiblingRow {
  id: string
  rawStatus: string
  lastSeen: number
}

/**
 * Of the sessions sharing a metaId, which are genuine PRIOR INCARNATIONS of THIS
 * one (vs. concurrent voices that got over-merged onto the same metaId by a loose
 * cwd-reclaim)? A currently-LIVE sibling is a different concurrent session — never
 * merge with it (that's the cross-session inbox bleed). A prior incarnation has
 * ended (signed_off) or gone quiet (last_seen older than LIVE_MS). Defensive:
 * keeps stable-identity safe even against legacy over-merged metaIds.
 */
export const priorIncarnations = <T extends SiblingRow>(
  siblings: T[],
  now: number,
  liveMs: number = LIVE_MS,
): T[] =>
  siblings.filter((s) => s.rawStatus === 'signed_off' || now - s.lastSeen >= liveMs)

/** Parse/serialise the comma-joined name_history STRING (no list columns). */
export const splitHistory = (s: string): string[] =>
  String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
export const joinHistory = (xs: string[]): string => Array.from(new Set(xs.filter(Boolean))).join(',')

/**
 * Fold a (possibly new) friendly name into a name-history list: the PRIOR name
 * is retained so messages to the old name still resolve after a rename. Returns
 * the deduped history INCLUDING the prior name but EXCLUDING the current one
 * (the current name is a live alias via friendlyName, not history).
 */
export const foldNameHistory = (
  history: string[],
  priorName: string,
  currentName: string,
): string[] => {
  const next = new Set(history.filter(Boolean))
  const prior = (priorName ?? '').trim()
  const cur = (currentName ?? '').trim()
  if (prior && prior !== cur) next.add(prior)
  if (cur) next.delete(cur) // current name lives as friendlyName, not history
  return Array.from(next)
}

export type PresenceStatus = 'live' | 'idle' | 'stale' | 'signed_off'

/** Durable address: explicit title → auto-derived name → short session id. */
export const resolveFriendlyName = (s: {
  title?: string
  autoName?: string
  sessionId: string
}): string => {
  const title = (s.title ?? '').trim()
  if (title) return title
  const auto = (s.autoName ?? '').trim()
  if (auto) return auto
  return s.sessionId.slice(0, 8)
}

/**
 * Derive live/idle/stale from last_seen age. `signed_off` is a sticky event
 * (SessionEnd fired) and overrides age-based derivation.
 */
export const presenceStatus = (
  row: { lastSeen: number; rawStatus: string },
  now: number,
): PresenceStatus => {
  if (row.rawStatus === 'signed_off') return 'signed_off'
  const age = now - row.lastSeen
  if (age < LIVE_MS) return 'live'
  if (age < STALE_MS) return 'idle'
  return 'stale'
}

/** A new SessionStart rebinds a prior session when name+cwd match, the id
 * differs, and the prior session was live — EXCEPT a transcript-less incoming
 * (a bootstrap phantom) never supersedes a transcript-backed prior (the real,
 * transcript-anchored session deterministically wins the name tie). The
 * `hasTranscript` flags are optional; when both are omitted the original
 * name+cwd+live behavior is preserved (back-compat). */
export const shouldRebind = (
  incoming: { friendlyName: string; cwd: string; sessionId: string; hasTranscript?: boolean },
  prior: { friendlyName: string; cwd: string; sessionId: string; status: string; hasTranscript?: boolean },
): boolean =>
  !!incoming.friendlyName &&
  incoming.friendlyName === prior.friendlyName &&
  incoming.cwd === prior.cwd &&
  incoming.sessionId !== prior.sessionId &&
  prior.status === 'live' &&
  !(prior.hasTranscript === true && incoming.hasTranscript === false)

/** Same-machine scope for supersede: a register on machine A must never sign off
 *  a machine-B live session (the mesh resolves cross-machine identity by metaId,
 *  not by signing each other off). An UNSTAMPED prior — machine '' (the
 *  session_meta.machine column default) or NULL (legacy) — is treated as
 *  same-machine so a pre-stamp stale row still gets cleaned. ACCEPTED RESIDUAL:
 *  the wildcard also lets a local register sign off an unstamped REMOTE legacy
 *  row; rare (unstamped AND status=live), and drained as rows get a machine stamp
 *  on every write going forward. */
const sameMachineScope = (
  incomingMachine: string | null | undefined,
  priorMachine: string | null | undefined,
): boolean => {
  const pm = (priorMachine ?? '').trim()
  return pm === '' || pm === (incomingMachine ?? '').trim()
}

/**
 * Which prior live rows (already fetched by the SAME effective friendly_name +
 * cwd) an incoming register supersedes. registerSession passes the EFFECTIVE
 * (post-floor) name, so a floored post-compact session supersedes its stale
 * real-name twin (the #86 fix) instead of scanning the bare id and missing it.
 * Same-machine scoped (sameMachineScope) and gated by shouldRebind (so a phantom
 * cannot sign off a real, transcript-backed prior). Pure: the caller does the
 * name+cwd+live SQL fetch and the row writes.
 */
export const supersedeScan = (
  incoming: {
    effectiveName: string
    cwd: string
    sessionId: string
    machine?: string | null
    hasTranscript?: boolean
  },
  priors: Array<{ id: string; machine?: string | null; hasTranscript?: boolean }>,
): string[] =>
  priors
    .filter((p) => sameMachineScope(incoming.machine, p.machine))
    .filter((p) =>
      shouldRebind(
        {
          friendlyName: incoming.effectiveName,
          cwd: incoming.cwd,
          sessionId: incoming.sessionId,
          hasTranscript: incoming.hasTranscript,
        },
        {
          friendlyName: incoming.effectiveName,
          cwd: incoming.cwd,
          sessionId: p.id,
          status: 'live',
          hasTranscript: p.hasTranscript,
        },
      ),
    )
    .map((p) => p.id)
