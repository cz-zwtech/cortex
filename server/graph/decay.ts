/**
 * s4 — decay / forgetting. A PURE, compute-on-demand RELEVANCE signal.
 *
 * Charter (Corey, cortex-decay-philosophy-mark-not-delete): "memories never go
 * away, they become irrelevant." Decay MARKS a memory more/less stale so recall
 * can de-prioritize it (never filter it out) and a review surface can list
 * candidates for the human to keep/pin/archive — it NEVER deletes. This is
 * corroborate-not-authorize applied to forgetting, the exact line s3 was built
 * not to cross; the mark-not-delete guard test pins it.
 *
 * `score` = coldness × rarity, ORDINAL (any monotone combo is correct — ranking
 * and the review surface need ORDER only, so the weights are pure TUNING, never
 * correctness; Fable Q2). FLOORED by acted-on (s3 reinforcement = "this matters",
 * the whole point of s3 feeding s4). Exemptions never decay. `type:feedback`
 * standing directives decay SLOWER and carry a badge (Q6 — supersession applied
 * to directives, not silent fade, not permanent exemption).
 *
 * v0 lays a clean seam for the s4.x self-correcting loop: review keep/pin IS the
 * manual reinforcement now; automatic friction→relevance-up + personality-index
 * is the follow-up. See /personal/docs/cortex/s4-decay-proposal.md.
 */
import { all, get } from './db.js'
import { reinforcementFor } from './actedOn.js'
import { recordSurfacings } from './surfacings.js'
import { parseThreadState } from './threads.js'

const DAY = 86_400_000

/** The synthetic session id a 'keep' (manual reinforcement) records its curation
 *  surfacing under. A NAMED const (not a raw literal) so the s4.x friction loop
 *  and any consumer reference the SAME provenance marker — curation reinforcement
 *  stays distinguishable from organic recall surfacing by this dst. */
export const CURATION_KEEP_SESSION = 'curation:keep'

/** Tunable decay knobs (config-driven — a setup questionnaire tunes these in
 *  s4.x; for now env-overridable with sane defaults). */
export interface DecayConfig {
  /** Memories younger than this (on updatedAt) are exempt — not yet had a chance to surface. */
  graceDays: number
  /** Coldness curve scale: coldnessNorm = 1 - exp(-ageSinceLastSurface / halfLife). */
  coldnessHalfLifeDays: number
  /** type:feedback directives multiply the half-life by this → decay slower (Q6). */
  directiveSlowFactor: number
  /** Ordinal score at/above which a memory is flagged `stale` (review/ranking cutoff). */
  staleThreshold: number
}

const numEnv = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && v > 0 ? v : d
}

export function getDecayConfig(): DecayConfig {
  return {
    graceDays: numEnv('CKN_DECAY_GRACE_DAYS', 10),
    coldnessHalfLifeDays: numEnv('CKN_DECAY_HALFLIFE_DAYS', 45),
    directiveSlowFactor: numEnv('CKN_DECAY_DIRECTIVE_SLOW', 4),
    staleThreshold: numEnv('CKN_DECAY_STALE_THRESHOLD', 0.4),
  }
}

export interface DecayResult {
  memoryId: string
  /** Ordinal staleness in [0,1] — higher = more decayed. 0 when exempt. */
  score: number
  /** score >= staleThreshold AND not exempt. */
  stale: boolean
  /** Exempt from decay (never stale). */
  exempt: boolean
  /** Why: 'open-thread'|'pinned'|'engagement'|'acted-on'|'grace'|'non-memory'|'missing', else ''. */
  reason: string
  /** Which acted-on reinforcement floored it (Q5 badge): 'D3' causal > 'D1' co-occurrence > null. */
  reinforcement: 'D1' | 'D3' | null
  /** type:feedback standing directive — decays slower, badged in review (Q6). */
  isDirective: boolean
  /** Total SURFACED_IN weight (recall count). */
  surfacings: number
  /** ms since last surfaced (or since updatedAt when never surfaced). */
  coldnessMs: number
}

/**
 * Compute the decay signal for one memory AS OF `asOf` (ms). PURE + read-only
 * (writes nothing — MARK, never delete). Time is an EXPLICIT parameter, never
 * Date.now() internally: every input is a timestamp/count, so the score is
 * RECOMPUTABLE AT ANY PAST MOMENT. That IS the s4.x seam — the friction-
 * reinforcement loop asks "was this memory surfaced WHILE decayed?" =
 * decayScore(M, asOf=thatSurfacingTime), needing no event log and no stored decay
 * state (Fable's pre-build catch). Exemptions are checked cheap-first; the
 * acted-on floor (and its badge) only when no cheaper exemption applies.
 */
export function decayScore(memoryId: string, asOf: number, cfg: DecayConfig = getDecayConfig()): DecayResult {
  const base = memoryId.split('/').pop() ?? memoryId
  const isDirective = base.startsWith('feedback-') // v0 heuristic for type:feedback (robust subtype column = s4.x)
  const mk = (o: Partial<DecayResult>): DecayResult => ({
    memoryId, score: 0, stale: false, exempt: false, reason: '', reinforcement: null,
    isDirective, surfacings: 0, coldnessMs: 0, ...o,
  })

  const e = get<{ kind: string; pinned: number; engagement: number; updatedAt: number; content: string | null }>(
    `SELECT kind, pinned, engagement, updatedAt, content FROM entries WHERE id = ? LIMIT 1`,
    memoryId,
  )
  if (!e) return mk({ exempt: true, reason: 'missing' })
  if (e.kind === 'session' || e.kind === 'file' || e.kind === 'tool' || e.kind === 'agent') {
    return mk({ exempt: true, reason: 'non-memory' })
  }
  if (e.kind === 'thread' && parseThreadState(e.content).status !== 'done') {
    return mk({ exempt: true, reason: 'open-thread' }) // pending work — never decay (retired/done threads can)
  }
  if (e.pinned) return mk({ exempt: true, reason: 'pinned' })
  if (e.engagement) return mk({ exempt: true, reason: 'engagement' })
  const reinforcement = reinforcementFor(memoryId)
  if (reinforcement) return mk({ exempt: true, reason: 'acted-on', reinforcement }) // s3 floor
  if (asOf - e.updatedAt < cfg.graceDays * DAY) return mk({ exempt: true, reason: 'grace' })

  // ── scored ──────────────────────────────────────────────────────────────────
  const surf = get<{ wsum: number | null; lastAt: number | null }>(
    `SELECT sum(weight) wsum, max(notedAt) lastAt FROM edges WHERE src = ? AND rel = 'SURFACED_IN'`,
    memoryId,
  )
  const surfacings = Math.round(surf?.wsum ?? 0)
  const lastSurfacedAt = surf?.lastAt ?? e.updatedAt // never surfaced → age from updatedAt
  const coldnessMs = Math.max(0, asOf - lastSurfacedAt)
  const halfLifeMs = cfg.coldnessHalfLifeDays * DAY * (isDirective ? cfg.directiveSlowFactor : 1)
  const coldnessNorm = 1 - Math.exp(-coldnessMs / halfLifeMs) // [0,1), rises with age
  const rarityNorm = 1 / (1 + surfacings) // 1 when never surfaced → 0 as recalls pile up
  const score = coldnessNorm * rarityNorm
  return mk({ score, stale: score >= cfg.staleThreshold, surfacings, coldnessMs })
}

export interface DecayReview {
  /** Non-exempt memories, score-descending, capped at `limit` — the decay candidates. */
  candidates: DecayResult[]
  /** How many memory entries were scored. */
  scanned: number
  /** Why the exempt ones are exempt (the badge data for the review surface). */
  exemptByReason: Record<string, number>
}

/**
 * The review surface (slice B): score the whole memory corpus AS OF `asOf` and
 * return the top non-exempt decay candidates plus a tally of why the rest are
 * exempt. Read-only — MARK never delete. Bounded by the corpus size; `decayScore`
 * is a cheap per-memory traversal (the s3-Q3 on-demand discipline), and the
 * review surface is a human-invoked CLI, not a hot path.
 */
export function decayReview(asOf: number, opts: { limit?: number; cfg?: DecayConfig } = {}): DecayReview {
  const cfg = opts.cfg ?? getDecayConfig()
  const limit = opts.limit ?? 20
  const rows = all<{ id: string }>(
    `SELECT id FROM entries WHERE kind NOT IN ('session', 'file', 'tool', 'agent')`,
  )
  const candidates: DecayResult[] = []
  const exemptByReason: Record<string, number> = {}
  for (const { id } of rows) {
    const r = decayScore(id, asOf, cfg)
    if (r.exempt) exemptByReason[r.reason] = (exemptByReason[r.reason] ?? 0) + 1
    else candidates.push(r)
  }
  candidates.sort((a, b) => b.score - a.score)
  return { candidates: candidates.slice(0, limit), scanned: rows.length, exemptByReason }
}

/**
 * Manual reinforcement — the review-surface 'keep'/'touch' (Fable's lens: keep
 * must BUMP the memory, never just dismiss the row). Records a CURATION surfacing
 * so the memory's coldness resets and its surfacing count rises, dropping it out
 * of the candidate list. Reuses s1 SURFACED_IN (a dedicated 'curation:keep'
 * session) — no new state, and `decayScore(M, asOf=keepTime)` later sees it
 * through the same asOf lens. This is the v0 MANUAL half of the self-correcting
 * loop; s4.x automates it from friction (re-search / failures → relevance up).
 * Bumps, never deletes.
 */
export function keepMemory(memoryId: string, asOf: number): void {
  recordSurfacings(CURATION_KEEP_SESSION, [memoryId], asOf)
}
