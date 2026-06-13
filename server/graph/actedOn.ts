/**
 * s3 — the acted-on detector. A PURE FUNCTION, no materialized `ACTED_ON_IN`
 * edge (Q3): its inputs are written at different times (SURFACED_IN at recall,
 * EDITED_IN at sync), so a sync-scoped recompute would structurally miss
 * corroborations; materializing would force a recall-path write — the cost we
 * rejected. s4 (decay) and the read-only debug verb call this; recall NEVER does.
 *
 * **Corroborate-not-authorize**: this is a signal. It performs NO graph writes
 * and never gates recall — a miss is tolerated, a false *hit* is the thing to
 * avoid (hence the specificity floor below).
 *
 * D1: actedOn(M,S) iff  M --SURFACED_IN--> S  AND  ∃ file F:
 *     M --MENTIONS_FILE--> F_prose  AND  F_edit --EDITED_IN--> S
 *     where F_prose and F_edit `pathSuffixMatch`.
 *
 * See /personal/docs/cortex/s3-acted-on-correlation-proposal.md (Locked spec) +
 * cortex-s3-acted-on-design-locked. D3 (firstAt time-order) is a fast-follow;
 * D2 (codegraph blast) deferred.
 */
import { all, get } from './db.js'

/**
 * The r3 join. MENTIONS_FILE stores prose paths VERBATIM (relative/partial,
 * fileMentions.ts) while EDITED_IN stores the ABSOLUTE transcript path, so the two
 * file nodes have DIFFERENT ids — id-equality can't bridge them, and id-level
 * canonicalization to one form needs a repo-root registry that breaks
 * cross-machine memories + deleted files. Instead: the shorter path must be a
 * `/`-BOUNDARY suffix of the longer, sharing ≥2 path segments.
 *
 * - Separators are normalized (\ → /) first, so a memory authored on Windows
 *   joins a WSL transcript's forward-slash path.
 * - The ≥2-segment floor kills the bare-basename collision class (`sync.ts` alone
 *   must NOT match every `sync.ts`).
 * - RESIDUAL, KNOWN-ACCEPTED margin: a common 2-segment suffix (e.g.
 *   `src/index.ts`) can match the WRONG file in a monorepo — but only when that
 *   file is ALSO edited in the SAME session M surfaced in (a narrow conjunction),
 *   and corroborate-not-authorize tolerates it. 2 is the right floor; 3 would
 *   reject too many true 2-segment prose mentions. Do NOT tighten this without
 *   evidence of real false positives (see acted-on.test.ts KNOWN-ACCEPTED cases).
 */
export function pathSuffixMatch(a: string, b: string): boolean {
  const segs = (p: string): string[] => p.replace(/\\/g, '/').split('/').filter(Boolean)
  const A = segs(a)
  const B = segs(b)
  const shorter = A.length <= B.length ? A : B
  const longer = A.length <= B.length ? B : A
  if (shorter.length < 2) return false // specificity floor — a bare basename never matches
  const offset = longer.length - shorter.length
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[offset + i]) return false
  }
  return true
}

/** A corroborating file pair: a path the memory mentions that suffix-matches a
 *  path edited in the session. */
export interface ActedOnMatch {
  /** verbatim prose path on the MENTIONS_FILE side */
  mentioned: string
  /** verbatim (absolute) path on the EDITED_IN side */
  edited: string
  /** EDITED_IN.notedAt — last-edit time of the edited file in the session
   *  (the lastEditAt for the D3 time-order check). */
  editedAt: number
}

/** Per-session acted-on verdict for `actedOnReport`. */
export interface ActedOnSession {
  session: string
  acted: boolean
  matches: ActedOnMatch[]
}

/**
 * firstSurfacedAt(M,S) = SURFACED_IN.firstAt (set-on-insert, never bumped), or
 * null when M never surfaced in S. D3 compares against this — NOT notedAt
 * (lastSurfacedAt), which bumps on every recall and would make the most-recalled
 * (most acted-on) memories fail the order check (s3 doc: D3-on-lastAt FORBIDDEN;
 * the lastAt-inversion regression pins it).
 */
const surfacedFirstAt = (memoryId: string, sessionId: string): number | null => {
  const row = get<{ firstAt: number }>(
    `SELECT firstAt FROM edges WHERE src = ? AND dst = ? AND rel = 'SURFACED_IN' LIMIT 1`,
    memoryId,
    sessionId,
  )
  return row ? row.firstAt : null
}

/**
 * The corroborating (mentioned ⋈ edited) file pairs for a (memory, session). The
 * file nodes' VERBATIM paths are their `name` (the id is lossily encoded, so we
 * read the name) — the r3 join is `pathSuffixMatch` over those names. `editedAt`
 * is the EDITED_IN.notedAt (last edit of that file in S), carried for the D3
 * time-order. Does NOT check SURFACED_IN (the caller decides if surfacing is required).
 */
function corroboratingFiles(memoryId: string, sessionId: string): ActedOnMatch[] {
  const mentioned = all<{ name: string }>(
    `SELECT e.name AS name FROM edges mf JOIN entries e ON e.id = mf.dst
       WHERE mf.src = ? AND mf.rel = 'MENTIONS_FILE'`,
    memoryId,
  )
  if (mentioned.length === 0) return []
  const edited = all<{ name: string; editedAt: number }>(
    `SELECT e.name AS name, ei.notedAt AS editedAt FROM edges ei JOIN entries e ON e.id = ei.src
       WHERE ei.dst = ? AND ei.rel = 'EDITED_IN'`,
    sessionId,
  )
  if (edited.length === 0) return []
  const out: ActedOnMatch[] = []
  for (const m of mentioned) {
    for (const f of edited) {
      if (pathSuffixMatch(m.name, f.name)) {
        out.push({ mentioned: m.name, edited: f.name, editedAt: f.editedAt })
      }
    }
  }
  return out
}

/**
 * The acted-on detector. TWO DISTINCT CLAIMS — do not conflate them:
 *
 * - DEFAULT (D1) = **CO-OCCURRENCE**: M surfaced in S AND a file M mentions was
 *   also edited in S. This is the WEAKER claim — "the memory is about a file this
 *   session happened to touch". It is NOT the charter's causal "acted on"; a
 *   caller wanting the causal signal must pass `afterSurface`.
 * - `afterSurface: true` (D3) = **CAUSAL acted-on**: additionally the edit is
 *   at/after the memory's FIRST surfacing (`lastEditAt >= firstSurfacedAt`) — the
 *   surfacing plausibly drove the edit (surfaced THEN acted). This is what the
 *   charter means by "acted on"; s4 opts into it for the strong signal.
 *
 * GRACEFUL DEGRADATION (not a bug): legacy SURFACED_IN rows written before the
 * firstAt column carry firstAt=0, so the D3 gate (`editedAt >= 0`) is always true
 * on them — D3 collapses to D1 until real firstAt accrues (live SURFACED_IN is 0
 * until the power-cycle loads HEAD). The strict causal signal sharpens as the
 * corpus fills; "D3 does nothing on old rows" is expected, not broken.
 *
 * Read-only — never writes (corroborate-not-authorize).
 */
export function actedOn(
  memoryId: string,
  sessionId: string,
  opts?: { afterSurface?: boolean },
): boolean {
  const firstSurfacedAt = surfacedFirstAt(memoryId, sessionId)
  if (firstSurfacedAt === null) return false
  const matches = corroboratingFiles(memoryId, sessionId)
  if (!opts?.afterSurface) return matches.length > 0
  return matches.some((m) => m.editedAt >= firstSurfacedAt)
}

/**
 * Read-only inspection backing the debug verb (`bin/ckn-acted-on.ts`): for each
 * session M surfaced in, report whether it was acted-on and the corroborating
 * file pairs. Pure read — no writes, no recall side-effects (corroborate-not-
 * authorize). Lets a human see WHY a memory is/isn't corroborated.
 */
export function actedOnReport(memoryId: string): ActedOnSession[] {
  const sessions = all<{ dst: string }>(
    `SELECT dst FROM edges WHERE src = ? AND rel = 'SURFACED_IN'`,
    memoryId,
  )
  return sessions.map((s) => {
    const matches = corroboratingFiles(memoryId, s.dst)
    return { session: s.dst, acted: matches.length > 0, matches }
  })
}

/** Cap reinforcementFor's scan to the K most-recently-surfaced sessions. SEMANTIC,
 *  not just perf: RECENT corroboration is what reinforcement MEANS — a long-ago
 *  acted-on memory with nothing since SHOULD fade (Corey's "memories become
 *  irrelevant"), and if it matters again a fresh surfacing re-bumps it into the
 *  recent-K (the self-correcting loop). It also bounds decayScore's per-candidate
 *  cost at corpus scale (Fable measured 528ms→~26ms), keeping compute-on-demand
 *  viable — bounded, not materialized (vindicates s3-Q3). Env-tunable. */
const REINFORCE_RECENT_K = Number(process.env.CKN_REINFORCE_RECENT_K) || 10

/**
 * The strongest acted-on reinforcement across the K MOST-RECENT sessions M surfaced
 * in: 'D3' (CAUSAL — an edit at/after the first surfacing) beats 'D1' (CO-OCCURRENCE)
 * beats null (not acted-on). s4 reads this to EXEMPT acted-on memories from decay and
 * to BADGE which reinforcement fired (the silent D1→D3 sharpening as firstAt fills).
 * Read-only.
 */
export function reinforcementFor(memoryId: string): 'D1' | 'D3' | null {
  // Most-recent K surfaced sessions only (ORDER BY notedAt DESC LIMIT K) — recent
  // corroboration IS reinforcement, and the bound keeps decayScore cheap on the
  // recall path at corpus scale (see REINFORCE_RECENT_K).
  const sessions = all<{ dst: string }>(
    `SELECT dst FROM edges WHERE src = ? AND rel = 'SURFACED_IN' ORDER BY notedAt DESC LIMIT ?`,
    memoryId,
    REINFORCE_RECENT_K,
  )
  let d1 = false
  for (const s of sessions) {
    if (actedOn(memoryId, s.dst, { afterSurface: true })) return 'D3' // strongest — short-circuit
    if (actedOn(memoryId, s.dst)) d1 = true
  }
  return d1 ? 'D1' : null
}
