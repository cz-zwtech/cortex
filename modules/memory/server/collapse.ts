/**
 * Recall-time cluster collapse — M1 deliverable A.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The ladder refuses to merge near-duplicates, and that refusal is right: two
 * memories can be 0.94 apart in embedding space and mean opposite things, and a
 * merge is irreversible with an invisible failure mode. But link-not-merge is
 * SAFE without being STABLE — a compliant session re-saving one fact in slightly
 * different words hits the near-duplicate rung every time, so every individual
 * decision is correct and the corpus still grows an unbounded clique.
 *
 * That is not untidy. Near-identical text produces near-identical embeddings, so
 * the variants RANK TOGETHER rather than ranking low: one fact spends N
 * injection slots while crowding other content out of the budget entirely.
 *
 * So the collapse moves to RANKING. Storage keeps everything — the append-only
 * charter and the link-not-merge ruling, both honoured exactly — and recall
 * returns one representative per cluster with the rest reachable behind it.
 * Choosing a representative is reversible, costs nothing if wrong, and is
 * re-decided on every query as the estimator improves.
 *
 * The precedent is deliberate: a thread is a memory, and its suppression from
 * ordinary results is a RESULTS POLICY, not a taxonomy fact. Sameness is the
 * same kind of judgement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHERE IT SITS RELATIVE TO CROSS-MODULE FAIRNESS
 *
 * The contract says a module owns the information density of its OWN
 * contribution; core allocates budget but must not curate, because knowing what
 * two blocks of text MEAN is the module's domain. This is memory discharging
 * exactly that obligation, inside its own boundary, on text it is the authority
 * on. It is not core acquiring a semantic capability. Same rule, two sides of
 * the boundary.
 */

import type { Memory } from './types.js'
import type { Estimator } from './reconcile.js'
import { LEXICAL_ESTIMATOR } from './reconcile.js'

export type Candidate = {
  memory: Memory
  /** Relevance to the query. Collapse never reorders; it only removes. */
  score: number
}

export type CollapsedHit = {
  memory: Memory
  score: number
  /**
   * Members hidden behind this representative.
   *
   * NEVER silent. A collapse the consumer cannot detect is indistinguishable
   * from a merge — the exact failure this design moved out of storage, arriving
   * through a different door.
   */
  siblings: { id: string; authoredAt: number }[]
  /**
   * Set when a hidden sibling is materially newer than the representative.
   *
   * Representative order is pinned-first, so without this a stale PINNED variant
   * silently beats the newer correction sitting behind it: `port-8080` pinned
   * hides `port-moved-to-8081` recent.
   */
  newerVariantExists?: boolean
}

export type CollapseOptions = {
  /**
   * The estimator AND its calibration. Defaults to lexical Jaccard.
   *
   * `nearDuplicateFloor` comes FROM the estimator rather than being passed
   * alongside it: a threshold calibrated against Jaccard means something
   * different under cosine, and carrying the number across a swap would degrade
   * recall silently, in a direction nobody is measuring.
   */
  estimator?: Estimator
  /** Override the estimator's near-duplicate floor. Prefer not to. */
  threshold?: number
  /** How much newer a sibling must be to be worth flagging. */
  recencyGapMs?: number
  /**
   * Pairs known to disagree, as `"idA|idB"` (order-independent via `pairKey`).
   * Sourced from CONTRADICTS edges and differing outcomes by the caller.
   */
  contradicts?: Set<string>
}

export const DEFAULT_COLLAPSE_THRESHOLD = 0.8
export const DEFAULT_RECENCY_GAP_MS = 7 * 24 * 60 * 60 * 1000

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * Collapse near-duplicates in a ranked candidate list.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STAR CLUSTERING, NEVER CONNECTED COMPONENTS
 *
 * Similarity is PAIRWISE. If a cluster were the connected component over those
 * pairs, transitive chaining would swallow non-neighbours: A~B at 0.92, B~C at
 * 0.92, but A~C at 0.75 — and C is hidden behind A's representative despite not
 * being A's near-duplicate at all. Re-save accumulation makes those chains grow,
 * so the defect worsens exactly as the corpus does.
 *
 * Here a member joins a cluster only if it is within threshold OF THE
 * REPRESENTATIVE. Nothing is transitive.
 */
export const collapse = (candidates: Candidate[], opts: CollapseOptions = {}): CollapsedHit[] => {
  const est = opts.estimator ?? LEXICAL_ESTIMATOR
  const similarity = est.compare
  const threshold = opts.threshold ?? est.nearDuplicateFloor
  const recencyGap = opts.recencyGapMs ?? DEFAULT_RECENCY_GAP_MS
  const contradicts = opts.contradicts ?? new Set<string>()

  const out: CollapsedHit[] = []
  const taken = new Set<string>()

  for (const c of candidates) {
    if (taken.has(c.memory.id)) continue

    const hit: CollapsedHit = { memory: c.memory, score: c.score, siblings: [] }
    taken.add(c.memory.id)

    for (const other of candidates) {
      if (taken.has(other.memory.id)) continue

      // ── CONTRADICTION EXEMPTION — collapse only what AGREES. ──────────────
      //
      // The sharp one, and the ladder's own argument proves it: "prefer pnpm
      // here" and "never use pnpm here" are near-identical in embedding space
      // and opposite in meaning. So near-duplicate clusters WILL contain
      // contradictions, and hiding one side of one is a merge IN EFFECT for
      // that query — nothing looks broken, one of the two facts is simply not
      // shown.
      if (disagree(c.memory, other.memory, contradicts)) continue

      const sim = similarity(c.memory.content, other.memory.content)
      if (sim === null || sim < threshold) continue // cannot-judge is not "same"

      taken.add(other.memory.id)
      hit.siblings.push({ id: other.memory.id, authoredAt: other.memory.authoredAt })

      if (other.memory.authoredAt - c.memory.authoredAt > recencyGap) {
        hit.newerVariantExists = true
      }
    }

    out.push(hit)
  }

  return out
}

/**
 * Do these two disagree?
 *
 * Three signals, any of which exempts the pair:
 *   - a declared CONTRADICTS relation between them;
 *   - different `outcome` values — the field that exists precisely to record
 *     that one approach worked and another did not;
 *   - one negates the other lexically.
 */
const disagree = (a: Memory, b: Memory, contradicts: Set<string>): boolean => {
  if (contradicts.has(pairKey(a.id, b.id))) return true
  if (a.outcome && b.outcome && a.outcome !== b.outcome) return true
  return negates(a.content, b.content)
}

/**
 * Deliberately excludes BARE `not`, and that exclusion was measured rather than
 * assumed: with `not` in the list, "NODE_ENV is unset" and "NODE_ENV is not set"
 * read as a contradiction. They are a PARAPHRASE — and they are the single most
 * common re-save pair, so including `not` exempted exactly the population this
 * whole feature exists to collapse.
 *
 * The entries here are negations that carry an instruction reversal, which is
 * what a contradiction between two memories actually looks like.
 */
const NEGATORS =
  /\b(never|no longer|don'?t|do not|must not|should not|avoid|stop using|instead of|rather than)\b/i

/**
 * A crude lexical negation check, and deliberately crude.
 *
 * It only has to catch the case the exemption exists for — two texts that are
 * near-identical except that one of them reverses the instruction. Anything
 * cleverer would be a semantic claim.
 *
 * On the error asymmetry: a false NEGATIVE hides a contradiction, a false
 * POSITIVE leaves one duplicate un-collapsed. That argues for being liberal —
 * but only up to the point where liberality starts exempting ordinary
 * paraphrases, which is a false positive that disables the feature rather than
 * merely degrading it. Hence the narrower list above.
 */
const negates = (a: string, b: string): boolean => {
  const na = NEGATORS.test(a)
  const nb = NEGATORS.test(b)
  return na !== nb
}

/**
 * Collapse, THEN cut to k.
 *
 * THE ORDERING IS THE WHOLE POINT and it is why this helper exists rather than
 * leaving callers to compose the two steps.
 *
 * Cut first and collapse second is the degenerate implementation: three variants
 * of one fact fill the top three slots, the collapse leaves one result, and the
 * two genuinely different memories that should have been second and third were
 * already discarded. The symptom disappears and the loss remains — and from
 * outside it looks identical to the correct version, which is why there is a
 * test asserting the order rather than a comment asking for it.
 */
export const collapseThenTake = (
  candidates: Candidate[],
  k: number,
  opts: CollapseOptions = {},
): CollapsedHit[] => collapse(candidates, opts).slice(0, k)
