/**
 * Recall scoring — the pure half, extracted so ranking is testable without a DB.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY WEIGHT HERE IS UNVALIDATED INHERITANCE, AND SAYS SO IN THE TYPE
 *
 * V1's numbers are carried across deliberately rather than replaced with fresher
 * guesses. The reasoning is PM's and it is not intuitive: a number you KNOW is
 * unvalidated is safer than one you have quietly re-guessed, because only the
 * first one ever gets revisited. Re-deriving by eye produces someone else's
 * afternoon with new digits.
 *
 * What turns a tuning constant into a measured one is an evaluation harness —
 * task 138b for these, as 138a was for the estimator floors. Until it exists,
 * `unvalidated: true` travels WITH the weights, in the type, where a caller sees
 * it. 138a is the argument for bothering: `relatedFloor = 0.45` turned out to be
 * exactly right, and we only know that because it was flagged rather than
 * silently trusted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCORE IS ORDINAL. That is a correctness property, not a disclaimer.
 *
 * Recall returns a RANKING. Any monotone combination of the same signals induces
 * the same order for the decisions that matter, so these weights are tuning and
 * never correctness — which is exactly why 138b can measure ranking quality
 * end-to-end instead of justifying twenty constants individually.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE IS AN ADDITIVE PRIOR, NEVER A FILTER
 *
 * A memory from another project ranks lower; it is never excluded. This is what
 * makes the system ONE MIND rather than per-folder notebooks, and it is a
 * product decision rather than a tuning constant — so it is expressed as a bonus
 * that cannot be configured into a filter.
 */

import type { Memory } from './types.js'

/**
 * Where a candidate came from, and what it scored on.
 *
 * OBSERVABILITY BY CONSTRUCTION: every hit carries its signals. V1 decides a
 * memory's final rank across five files, which is why nobody can answer "why did
 * this surface?" — the answer exists only as the difference between two numbers
 * nobody logged.
 */
export type Signals = {
  /** Similarity to the query, when a semantic seed produced one. */
  similarity?: number
  /** What the coverage rests on: query terms matched, and whether one was in the head (relevance.ts clearsFloor). */
  matched?: { terms: number; inHead: boolean; topical: boolean }
  /** How this candidate entered the result set. */
  via: 'seed' | 'edge'
  /** Hops from a seed. 0 for seeds themselves. */
  hops: number
  /** The edge relation traversed to reach it, when via === 'edge'. */
  relation?: string
  usageBonus: number
  /**
   * Credit for having been REACHED BY A TYPED EDGE, independent of text.
   *
   * Without this, expansion is pointless. A memory reached across a
   * `mentions_file` or `occurred_in` edge is evidence-of-relevance in its own
   * right, but if it scores only on its own wording it lands near zero and the
   * relevance floor discards it immediately — so the traversal does work whose
   * results can never survive the cut. Measured: a neighbour one hop away scored
   * below 0.4x the seed and was dropped by the floor every time.
   */
  edgeBonus: number
  recencyBonus: number
  scopeBonus: number
  pinBonus: number
  decayPenalty: number
  hopPenalty: number
}

export type Candidate = {
  memory: Memory
  signals: Signals
}

export type Scored = Candidate & { score: number }

/**
 * Recall weights, carrying their own provenance.
 *
 * Bound together in one object for the same reason estimator floors are bound to
 * their estimator: a weight is only meaningful alongside the others it was
 * balanced against, and passing them individually invites a caller to mix a
 * tuned value into an untuned set without anything noticing.
 */
export type Weights = {
  name: string
  similarity: number
  usage: number
  edge: number
  recency: number
  scope: number
  pin: number
  decay: number
  hop: number
  /** Recency half-life, ms. Bigger = recency matters for longer. */
  recencyHalfLifeMs: number
  /**
   * TRUE until an evaluation harness has measured them. Never a comment: a
   * caller reading a comment is a caller who already trusted the number.
   */
  unvalidated: boolean
}

/**
 * V1's numbers, carried across UNCHANGED and labelled.
 *
 * Deliberately not "improved" on the way over. The design ruling is that porting
 * them honestly beats re-guessing them plausibly, because the honest version is
 * the one that gets revisited.
 */
/**
 * ⚠ DELIBERATE DIVERGENCE FROM V1, NAMED SO A LATER DELTA IS INTERPRETABLE.
 *
 * The weights below are V1's, unchanged, specifically so that when 138b measures
 * this engine any movement can be attributed to the ENGINE rather than to a
 * silently retuned constant.
 *
 * But the decay SEMANTICS are intentionally different: V1 multiplies coldness by
 * rarity; this uses recency-of-surfacing only (see `decayPenalty`). So V2 and V1
 * do NOT compute the same function even given identical weights.
 *
 * That has to be written here rather than only in a commit message, because the
 * first V1-vs-V2 comparison will show a delta, and an unrecorded intentional
 * divergence gets attributed to whatever the comparison was actually testing —
 * noise that reads as signal. Same numbers, deliberately different decay, one
 * named reason: V1 double-counts the event log.
 *
 * Name the reference you measured against, or the number means nothing.
 */
export const INHERITED_WEIGHTS: Weights = {
  name: 'v1-inherited',
  similarity: 0.55,
  usage: 0.2,
  edge: 0.25,
  recency: 0.1,
  scope: 0.15,
  pin: 0.3,
  decay: 0.3,
  hop: 0.05,
  recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  unvalidated: true,
}

/**
 * Usage bonus: POSITIVE-ONLY, log-shaped, and CLAMPED TO 1.
 *
 * Positive-only is cold-start fairness — a memory nobody has used yet must not
 * be PENALISED for it, or nothing new can ever surface and the ranking freezes
 * around whatever was popular first.
 *
 * THE CLAMP IS A BUG FIX, not tidiness. The log shape was described as
 * "saturation" and is not saturating: `log1p(n)/log1p(100)` passes 1.0 at n=100
 * and keeps climbing — 1.50 at 1,000, 2.00 at 10,000. Weighted at 0.2 that is
 * 0.40, against 0.55 for a PERFECT similarity match. So a heavily-surfaced
 * memory really could dominate every query, which is the exact thing the
 * original comment claimed the log prevented.
 *
 * It also makes the score's ceiling computable, which is what lets traversal
 * stop provably losslessly rather than at a tuned depth — see `scoreCeiling`.
 * An unbounded signal makes an admissible bound impossible, so this was
 * load-bearing in two directions at once.
 */
export const usageBonus = (surfaceCount: number): number =>
  surfaceCount <= 0 ? 0 : Math.min(1, Math.log1p(surfaceCount) / Math.log1p(100))

/** Exponential recency, on AUTHORED time — the clock the user thinks in. */
export const recencyBonus = (authoredAt: number, asOf: number, halfLifeMs: number): number => {
  const age = Math.max(0, asOf - authoredAt)
  return Math.pow(0.5, age / halfLifeMs)
}

/**
 * Decay — a de-prioritisation, never an exclusion, and never a deletion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXEMPTION LADDER IS DATA, NOT AN if-CHAIN
 *
 * V1 spreads it across a hardcoded chain over four different sources, so nobody
 * can see the policy in one place or test a rung in isolation. Here each rung is
 * a named predicate and the ladder is a list, which makes "why was this exempt?"
 * answerable and makes adding a rung a data change.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND IT NO LONGER DOUBLE-COUNTS SURFACING
 *
 * V1 multiplies coldness by rarity. Both are functions of the SAME event log —
 * last-surfaced-at and surface-count move together — so one surfacing halves the
 * score regardless of how long ago it was. The fix is to use recency of
 * surfacing alone for coldness and let the usage BONUS carry frequency, so each
 * fact about the event log is counted exactly once.
 */
export type DecayInput = {
  pinned: boolean
  protected: boolean
  isThread: boolean
  actedOnAt?: number
  lastSurfacedAt?: number
  authoredAt: number
  /**
   * When Cortex first held it. Coldness counts from the LATER of this and
   * authoredAt: decay means "unused while Cortex could have surfaced it", and a
   * memory migrated in today has had no chance yet. Counting from authoredAt
   * made a whole migrated corpus arrive cold, and a perfect match 400 days old
   * lost to one-word matches written last week (laptop Stage A).
   */
  ingestedAt?: number
  isStandingDirective: boolean
}

const knownSince = (d: DecayInput): number => Math.max(d.authoredAt, d.ingestedAt ?? 0)

export type DecayExemption =
  | 'pinned'
  | 'protected'
  | 'live-thread'
  | 'recently-acted-on'
  | 'within-grace'

export const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000
export const ACTED_ON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const COLDNESS_HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000

/** Standing directives sink slower. A real field, never a regex over prose. */
export const STANDING_DIRECTIVE_DAMPING = 0.4

const LADDER: { name: DecayExemption; test: (d: DecayInput, asOf: number) => boolean }[] = [
  { name: 'pinned', test: (d) => d.pinned },
  { name: 'protected', test: (d) => d.protected },
  { name: 'live-thread', test: (d) => d.isThread },
  {
    name: 'recently-acted-on',
    test: (d, asOf) => d.actedOnAt !== undefined && asOf - d.actedOnAt < ACTED_ON_WINDOW_MS,
  },
  { name: 'within-grace', test: (d, asOf) => asOf - knownSince(d) < GRACE_PERIOD_MS },
]

/**
 * How much this memory should sink. 0 = not at all.
 *
 * `asOf` is an explicit PARAMETER and never `Date.now()` internally, so any past
 * instant's ranking is recomputable — which is what makes a ranking regression
 * debuggable at all.
 */
export const decayPenalty = (
  d: DecayInput,
  asOf: number,
): { penalty: number; exemption?: DecayExemption } => {
  for (const rung of LADDER) {
    if (rung.test(d, asOf)) return { penalty: 0, exemption: rung.name }
  }

  // Coldness ONLY. Frequency is the usage bonus's job; counting it here too is
  // the double-count this replaces.
  const since = asOf - (d.lastSurfacedAt ?? knownSince(d))
  const coldness = 1 - Math.pow(0.5, Math.max(0, since) / COLDNESS_HALF_LIFE_MS)

  return { penalty: coldness * (d.isStandingDirective ? STANDING_DIRECTIVE_DAMPING : 1) }
}


/**
 * The highest score ANY candidate at this depth could possibly achieve.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS WHAT TURNS THE HOP PENALTY FROM A DISCOUNT INTO A STOPPING RULE
 *
 * The concern, and it is the right one: a graph query should not simply keep
 * traversing — something derived from the results already read should decide
 * whether one more hop is worth it. A static depth cap does not do that. It
 * traverses to the bound whether hop 1 already answered the query or not, and
 * the hop penalty is applied at SCORING, which is after the work is already
 * paid for. A post-hoc discount changes the ranking; it does not save the
 * traversal.
 *
 * Because every positive signal is in [0,1] and the hop penalty is monotone
 * increasing in depth, the best attainable score at depth d is:
 *
 *   Σ(positive weights) − w.hop × d
 *
 * (Decay only ever subtracts, so its best case is 0 and it drops out.)
 *
 * Once that ceiling falls below the k-th best score already in hand, NO deeper
 * hop can change the output — so expansion stops, and stops **provably
 * losslessly**: the result is exactly what unbounded traversal would have
 * returned.
 *
 * STRICTLY BETTER THAN A FIXED CAP IN BOTH DIRECTIONS, which is why it beats a
 * tuned cutoff:
 *   - dense, well-connected query → terminates EARLY, saving work a cap spends;
 *   - sparse query → free to go DEEPER than a cap allows, because nothing is
 *     dominating yet, so recall improves exactly where a cap silently truncates.
 *
 * A heuristic cutoff trades quality for cost. An admissible bound trades
 * nothing — it declines to compute what cannot matter.
 *
 * ⚠ THE CONTRACT THIS RESTS ON: every positive signal must be in [0,1]. If any
 * becomes unbounded the ceiling is wrong and the pruning silently stops being
 * lossless — it would drop real results while reporting a complete traversal.
 * `usageBonus` violated this until it was clamped; `boundedSignals` guards it.
 */
export const scoreCeiling = (depth: number, w: Weights = INHERITED_WEIGHTS): number =>
  w.similarity + w.usage + w.edge + w.recency + w.scope + w.pin - w.hop * depth

/**
 * Does this candidate honour the [0,1] contract the ceiling depends on?
 *
 * Checked rather than assumed, because the failure is silent: an out-of-range
 * signal does not throw, it just makes the bound unsound, and unsound pruning
 * looks identical to correct pruning from outside.
 */
export const boundedSignals = (s: Signals): boolean =>
  [
    s.similarity ?? 0,
    s.usageBonus,
    s.edgeBonus,
    s.recencyBonus,
    s.scopeBonus,
    s.pinBonus,
    s.decayPenalty,
  ].every(
    (v) => v >= 0 && v <= 1,
  )

/**
 * Should expansion continue to `nextDepth`?
 *
 * `kthBest` is the k-th best score currently held — AFTER collapse, because
 * collapse removes candidates and the surviving k-th is what actually has to be
 * beaten. Using the pre-collapse k-th would be a HIGHER threshold and would stop
 * too early, which is the one way this optimisation could quietly lose results.
 */
export const shouldExpand = (
  nextDepth: number,
  kthBest: number | undefined,
  w: Weights = INHERITED_WEIGHTS,
): boolean => kthBest === undefined || scoreCeiling(nextDepth, w) >= kthBest

/**
 * Rank candidates. PURE — no DB, no clock, no IO.
 *
 * Everything time-dependent arrives as `asOf`, and everything corpus-dependent
 * arrives as candidates, so a ranking is a function of its inputs and a
 * regression can be reproduced from a fixture.
 */
export const rankCandidates = (
  candidates: Candidate[],
  opts: { weights?: Weights; asOf: number; queryScope?: string },
): Scored[] => {
  const w = opts.weights ?? INHERITED_WEIGHTS

  const scored = candidates.map((c) => {
    const s = c.signals
    const score =
      (s.similarity ?? 0) * w.similarity +
      s.usageBonus * w.usage +
      s.edgeBonus * w.edge +
      s.recencyBonus * w.recency +
      s.scopeBonus * w.scope +
      s.pinBonus * w.pin -
      s.decayPenalty * w.decay -
      s.hopPenalty * w.hop
    return { ...c, score }
  })

  // Stable: ties break by id so a ranking is reproducible rather than depending
  // on candidate arrival order, which varies with query plan.
  return scored.sort((a, b) => b.score - a.score || (a.memory.id < b.memory.id ? -1 : 1))
}

/**
 * Cut the ranked list — and RETURN FEWER THAN k when the rest are padding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUND AND THE CUT CONTROL DIFFERENT COSTS. BOTH ARE WORTH DOING.
 *
 *   TRAVERSAL cost is CPU and latency, local, paid at query time → the bound.
 *   TOKEN cost is what gets INJECTED into the model's context → the cut.
 *
 * They are routinely conflated and they are not the same fix; doing one does not
 * discharge the other. A fixed `take(k)` returns k results whether or not k of
 * them are any good, so a query with three strong hits gets padded with whatever
 * happened to rank fourth. **That padding is pure token cost** — it displaces
 * nothing useful into the window and buys nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FLOOR IS RELATIVE, NOT ABSOLUTE
 *
 * An absolute score floor is tied to the weight scale, so it silently changes
 * meaning the moment any weight moves — the same portability failure that made
 * estimator thresholds travel WITH their estimator. A fraction of the best score
 * survives re-weighting, because both sides move together.
 *
 * The fraction is `unvalidated` like every other tuned number here. 138b derives
 * it; until then it is labelled rather than trusted.
 */
export type Cut = {
  hits: Scored[]
  /** Dropped because they fell below the relevance floor. The token saving. */
  droppedByFloor: number
  /** Dropped because k was reached. The ordinary cut. */
  droppedByK: number
  /**
   * True when the floor bit — i.e. fewer than k were returned BECAUSE they were
   * padding, not because there were no more candidates. Reported so a caller
   * cannot read a short result as an empty corpus.
   */
  floorApplied: boolean
}

/**
 * Fraction of the top score a hit must reach to be worth injecting.
 *
 * UNVALIDATED. Chosen, not measured — it is the one number here that directly
 * trades tokens against recall, so it is exactly the kind that must not be
 * quietly trusted.
 */
export const DEFAULT_RELEVANCE_FRACTION = 0.4

export const takeRelevant = (
  ranked: Scored[],
  k: number,
  opts: { relevanceFraction?: number } = {},
): Cut => {
  if (!ranked.length) return { hits: [], droppedByFloor: 0, droppedByK: 0, floorApplied: false }

  const fraction = opts.relevanceFraction ?? DEFAULT_RELEVANCE_FRACTION
  const best = ranked[0]!.score

  // A non-positive best score makes the ratio meaningless (and sign-flipped), so
  // the floor stands down rather than producing nonsense. Reported as not
  // applied, because "the floor did not bite" and "the floor could not be
  // computed" must not look the same to a caller.
  const floor = best > 0 ? best * fraction : -Infinity

  const kept: Scored[] = []
  let droppedByFloor = 0
  for (const hit of ranked) {
    if (kept.length >= k) break
    if (hit.score < floor) {
      droppedByFloor++
      continue
    }
    kept.push(hit)
  }

  // Everything past the k-th that was not already counted against the floor.
  const considered = kept.length + droppedByFloor
  return {
    hits: kept,
    droppedByFloor,
    droppedByK: Math.max(0, ranked.length - considered),
    floorApplied: droppedByFloor > 0,
  }
}

/**
 * How much each relation counts as evidence of relevance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIFORM ON PURPOSE, AND THAT IS THE HONEST DEFAULT
 *
 * V1 carries eight distinct edge-bonus values. Those numbers are not reproduced
 * here, because I do not have them and inventing eight plausible ones would be
 * precisely the failure the inherited-weights rule exists to prevent: someone
 * else's afternoon with fresh digits, indistinguishable from a measurement.
 *
 * So every relation is worth the same until something measures otherwise. That
 * is a KNOWN-WRONG simplification rather than a guess — `occurred_in` and
 * `contradicts` are obviously not equally strong evidence — and it is written
 * down as such so 138b differentiates them rather than a later reader assuming
 * uniformity was a finding.
 */
export const RELATION_STRENGTH: Record<string, number> = {}

/** Strength of a relation, defaulting to the uniform 1.0 above. */
export const relationStrength = (relation: string | undefined): number =>
  relation === undefined ? 0 : (RELATION_STRENGTH[relation] ?? 1)
