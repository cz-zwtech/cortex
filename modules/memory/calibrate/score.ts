/**
 * The sweep, and the selection rule that makes a floor DERIVED rather than
 * chosen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DO NOT OPTIMISE ACCURACY OR F1. THE ERRORS ARE NOT SYMMETRIC.
 *
 * A false SAME collapses two distinct memories into one. It is irreversible, it
 * is silent, and the thing destroyed is precisely the distinction that made the
 * second memory worth writing.
 *
 * A false DIFFERENT leaves a duplicate. It is cheap, visible, correctable at any
 * later time, and the dedupe reflex never denies anyway — so at worst it costs a
 * line of injected context.
 *
 * Any balanced metric trades those one-for-one, which is wrong by orders of
 * magnitude. F1 would happily accept a false merge to buy back a duplicate.
 *
 * So the asymmetry is the OBJECTIVE FUNCTION, not a fallback behaviour:
 *
 *   pick the LOWEST floor whose false-merge rate is at or below the target,
 *   and report the duplicate rate it costs as the PRICE, not as a rival goal.
 *
 * Lowest, not highest, and the direction matters: raising a floor monotonically
 * reduces merges, so the highest floor satisfies any safety target trivially by
 * merging nothing — and needs no instrument to find. The floor that needs
 * measuring is the most permissive one that is still safe. Collapse as many real
 * duplicates as possible SUBJECT TO the false-merge ceiling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRADICTIONS COUNT AS FALSE MERGES, AND WORSE
 *
 * A `contradicts` pair merged is not one memory lost — it is a surviving memory
 * that asserts the opposite of a fact the corpus also held, with nothing marking
 * the disagreement. It is scored as a false merge and reported separately, so a
 * floor cannot buy its safety margin by being lucky about ordinary duplicates
 * while folding the contradictions.
 */

import type { Estimator } from '../server/reconcile.js'
import type { PairLabel, PairMeta, SheetRow } from './pairs.js'

export type LabelledPair = {
  key: string
  label: PairLabel
  score: number | null
  control?: boolean
}

/**
 * Join a labelled sheet to its scores.
 *
 * Rows without a label are DROPPED and counted rather than defaulted. A missing
 * label is "nobody decided", and treating it as `different` would silently pad
 * the safe class with every pair the labeller skipped — which is exactly the
 * class the objective function is protecting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTROLS ARE THE EXCEPTION, AND OMITTING THIS MADE THEM INERT
 *
 * Control rows are mined natural pairs: same slug, same scope, different body,
 * i.e. a re-save. They ship UNLABELLED on purpose — that is what makes them
 * independent of the hand labels. But "unlabelled" here does not mean "nobody
 * decided", it means **the corpus already decided**: a control is a `same` pair
 * by construction.
 *
 * The first version dropped them under the rule above, so `checkControl` ran
 * over an empty array and reported `total: 0` — a held-out check that silently
 * checked nothing. Two mechanisms, each correct alone, contradicting each other
 * at the seam. Caught only because the first real run printed the zero.
 */
export const joinLabels = (
  sheet: SheetRow[],
  meta: PairMeta[],
): { pairs: LabelledPair[]; unlabelled: number; unscored: number; controls: number } => {
  const byKey = new Map(meta.map((m) => [m.key, m]))
  const pairs: LabelledPair[] = []
  let unlabelled = 0
  let unscored = 0
  let controls = 0

  for (const row of sheet) {
    // A control's label comes from the corpus, not from a labeller.
    const label = row.label ?? (row.control ? ('same' as const) : null)
    if (!label) {
      unlabelled++
      continue
    }
    const m = byKey.get(row.key)
    if (!m) {
      unscored++
      continue
    }
    if (row.control) controls++
    pairs.push({ key: row.key, label, score: m.score, control: row.control })
  }

  return { pairs, unlabelled, unscored, controls }
}

export type FloorResult = {
  floor: number
  /** Labelled `same` and judged same. The benefit. */
  truePositives: number
  /** Labelled `different` or `contradicts` and judged same. The unrecoverable harm. */
  falseMerges: number
  /** Of those, the ones that were outright contradictions. */
  contradictionMerges: number
  /** Labelled `same` and NOT judged same. The price. */
  duplicatesLeft: number
  /** falseMerges / (pairs judged same). NaN when nothing was judged same. */
  falseMergeRate: number
  /** truePositives / (labelled same). How much duplication it actually removes. */
  duplicateCatchRate: number
  /** Pairs the estimator could not score at all, at any floor. */
  cannotJudge: number
}

/**
 * Sweep a floor across a labelled set.
 *
 * `cannot judge` is never counted as a merge — it is the abstention the whole
 * ladder is built to preserve, and folding it into either class here would make
 * the harness disagree with the system it is calibrating.
 */
export const sweep = (pairs: LabelledPair[], floors: number[]): FloorResult[] =>
  floors.map((floor) => {
    let tp = 0
    let fm = 0
    let cm = 0
    let dl = 0
    let cj = 0

    for (const p of pairs) {
      if (p.score === null) {
        cj++
        if (p.label === 'same') dl++ // an unjudgeable duplicate is still left behind
        continue
      }
      const judgedSame = p.score >= floor
      if (p.label === 'same') {
        if (judgedSame) tp++
        else dl++
      } else if (judgedSame) {
        fm++
        if (p.label === 'contradicts') cm++
      }
    }

    const judgedSame = tp + fm
    const labelledSame = tp + dl
    return {
      floor,
      truePositives: tp,
      falseMerges: fm,
      contradictionMerges: cm,
      duplicatesLeft: dl,
      falseMergeRate: judgedSame === 0 ? NaN : fm / judgedSame,
      duplicateCatchRate: labelledSame === 0 ? NaN : tp / labelledSame,
      cannotJudge: cj,
    }
  })

export type Recommendation = {
  floor: number | null
  /** Why this floor, in one line, for the write-up. */
  rationale: string
  chosen?: FloorResult
  /** What it costs: duplicates left uncollapsed at that floor. */
  price?: { duplicatesLeft: number; duplicateCatchRate: number }
  /**
   * Set when NO floor met the target. A null recommendation is a real result and
   * must not be rendered as "use the highest floor" — it means this estimator
   * cannot separate these classes on this corpus at the required safety level.
   */
  unattainable?: boolean
}

/**
 * The default false-merge ceiling.
 *
 * ZERO, and deliberately so on this corpus size. A merge is irreversible and
 * silent; on a few hundred labelled pairs, "one false merge is acceptable" is
 * not a calibrated risk appetite, it is a rounding error being promoted to a
 * policy. If a corpus large enough to make a nonzero rate meaningful ever
 * exists, this becomes an argument worth having with data.
 */
export const DEFAULT_MAX_FALSE_MERGE_RATE = 0

/**
 * Recommend a floor.
 *
 * Scans ascending and takes the FIRST floor meeting the ceiling — the most
 * permissive safe setting, which is the one that collapses the most duplicates
 * without buying it with an unrecoverable error.
 *
 * A floor that judged NOTHING the same is skipped even though its false-merge
 * rate is vacuously fine: a threshold that never fires satisfies the constraint
 * by doing nothing, and recommending it would be the same degenerate answer as
 * picking the highest floor.
 */
export const recommend = (
  results: FloorResult[],
  maxFalseMergeRate = DEFAULT_MAX_FALSE_MERGE_RATE,
): Recommendation => {
  const ascending = [...results].sort((a, b) => a.floor - b.floor)

  for (const r of ascending) {
    if (r.truePositives + r.falseMerges === 0) continue // never fires — not a floor
    if (r.falseMerges === 0 && maxFalseMergeRate === 0) return chose(r, maxFalseMergeRate)
    if (!Number.isNaN(r.falseMergeRate) && r.falseMergeRate <= maxFalseMergeRate) {
      return chose(r, maxFalseMergeRate)
    }
  }

  return {
    floor: null,
    unattainable: true,
    rationale:
      `no floor reaches a false-merge rate of ${maxFalseMergeRate} while still collapsing ` +
      `anything — this estimator cannot separate same from different on this corpus at the ` +
      `required safety level. That is a result about the ESTIMATOR, not a missing number: ` +
      `raising the floor further only buys safety by never firing.`,
  }
}

const chose = (r: FloorResult, target: number): Recommendation => ({
  floor: r.floor,
  chosen: r,
  price: { duplicatesLeft: r.duplicatesLeft, duplicateCatchRate: r.duplicateCatchRate },
  rationale:
    `lowest floor with false-merge rate ≤ ${target} (observed ${r.falseMerges} false merge(s), ` +
    `${r.contradictionMerges} of them contradictions); it collapses ` +
    `${(r.duplicateCatchRate * 100).toFixed(0)}% of labelled duplicates and leaves ` +
    `${r.duplicatesLeft} uncollapsed, which is the price paid for irreversibility.`,
})

/**
 * How the recommended floor treats the held-out natural pairs.
 *
 * These were mined, never labelled — same slug, same scope, different body, so a
 * re-save by construction. They are a check on the LABELS rather than on the
 * floor: a floor that splits pairs the corpus itself says are the same fact
 * means the hand labels and the corpus disagree, and the labels are the part a
 * human made up.
 *
 * Reported, never folded into the objective — scoring against them too would
 * make them a second training signal instead of an independent check.
 */
export const checkControl = (
  controls: { key: string; score: number | null }[],
  floor: number,
): { total: number; judgedSame: number; split: number; cannotJudge: number } => {
  let judgedSame = 0
  let split = 0
  let cannotJudge = 0
  for (const c of controls) {
    if (c.score === null) cannotJudge++
    else if (c.score >= floor) judgedSame++
    else split++
  }
  return { total: controls.length, judgedSame, split, cannotJudge }
}

/** Floors to sweep. Fine-grained: a floor is reported to two decimals. */
export const defaultFloors = (steps = 101): number[] =>
  Array.from({ length: steps }, (_, i) => Math.round((i / (steps - 1)) * 100) / 100)

/**
 * Run the whole thing for one estimator.
 *
 * Returns the curve AND the recommendation, because a recommendation without the
 * curve behind it is another unexaminable constant — the exact thing this
 * harness exists to stop producing.
 */
export const calibrate = (
  pairs: LabelledPair[],
  opts: { floors?: number[]; maxFalseMergeRate?: number; estimator?: Estimator } = {},
): { curve: FloorResult[]; recommendation: Recommendation; control: ReturnType<typeof checkControl> | null } => {
  const scored = pairs.filter((p) => !p.control)
  const controls = pairs.filter((p) => p.control)

  const curve = sweep(scored, opts.floors ?? defaultFloors())
  const recommendation = recommend(curve, opts.maxFalseMergeRate ?? DEFAULT_MAX_FALSE_MERGE_RATE)
  const control =
    recommendation.floor === null ? null : checkControl(controls, recommendation.floor)

  return { curve, recommendation, control }
}
