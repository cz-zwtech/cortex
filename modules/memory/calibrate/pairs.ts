/**
 * Pair sampling — and the sampling is where this harness is won or lost.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY RANDOM PAIRS WOULD PRODUCE A USELESS INSTRUMENT
 *
 * A corpus of N memories has N(N-1)/2 pairs and essentially all of them are
 * unrelated. Sample randomly and you get a set that is ~99.9% NOT-duplicates, on
 * which a classifier answering "never a duplicate" scores 99.9% — while being
 * exactly the classifier that makes the whole feature inert.
 *
 * Worse for this purpose: a threshold lives at a DECISION BOUNDARY, and random
 * sampling puts almost no pairs there. You would be measuring, at length, a
 * region no threshold will ever occupy.
 *
 * So pairs are STRATIFIED BY SIMILARITY: the range is divided into bands, each
 * sampled to a quota. The boundary region ends up densely covered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LABEL SHEET CANNOT CONTAIN THE SCORE, AND THAT IS STRUCTURAL
 *
 * Labelling a pair after seeing its similarity score calibrates a threshold
 * against a judgement the score already influenced. It is the same circularity
 * this project has hit repeatedly, and it produces a CONFIDENT wrong number,
 * which is the worst kind.
 *
 * A rule saying "do not look at the score" is not enough — it is exactly the
 * kind of rule whose violation leaves no evidence. So the sampler emits TWO
 * artifacts: a `sheet` carrying only the texts, and a separate `meta` carrying
 * the scores, joined by pair key. The labeller opens a file that does not
 * contain the number. Prefer the version that cannot be built wrong over the
 * version documented as wrong-if-built-that-way.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CIRCULARITY THAT REMAINS, AND ITS ACTUAL EXTENT
 *
 * Stratifying uses an estimator to choose which pairs a human is SHOWN. It does
 * not touch their labels. So it cannot make a wrong pair look right; it can only
 * fail to surface pairs it scores far from the boundary that another estimator
 * would score near its own.
 *
 * A fixture is therefore estimator-relative in its SAMPLING and estimator-neutral
 * in its LABELS. Reusing a lexically-sampled fixture for an embedding estimator
 * is valid for the pairs it contains and silent about the ones it never showed.
 * WHEN THE ESTIMATOR CHANGES FAMILY, RE-SAMPLE AND LABEL THE NEW PAIRS; the old
 * labels stay valid and are kept.
 */

import type { Estimator } from '../server/reconcile.js'
import type { CorpusEntry } from './corpus.js'

export type PairLabel =
  /** One is a re-save, edit or rephrase of the other. Collapsing is correct. */
  | 'same'
  /** Genuinely different facts. Collapsing destroys one. */
  | 'different'
  /** Near-identical text, opposite meaning. Collapsing is WORST here. */
  | 'contradicts'

/** Order-independent, so a pair has one identity regardless of enumeration. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** What a labeller sees. Deliberately carries NO score. */
export type SheetRow = {
  key: string
  aText: string
  bText: string
  label: PairLabel | null
  /** Free-text reason. Worth having when a later reader disputes a label. */
  why?: string
  /**
   * Set for pairs mined as label-free positives. They ship UNLABELLED and are
   * scored as a held-out control: if a calibrated floor gets these wrong, the
   * hand labels are wrong.
   */
  control?: boolean
}

/** What the sampler knew. Kept apart from the sheet on purpose. */
export type PairMeta = {
  key: string
  score: number | null
  sampledBy: string
  band: number
}

export type SampleOptions = {
  estimator: Estimator
  bands?: number[]
  perBand?: number
  excerpt?: number
  /**
   * Cap on how many pairs in one band may share a member.
   *
   * WITHOUT THIS THE SAMPLE IS DOMINATED BY corpus[0], and the first version of
   * this file was. Naive `for i … for j>i` enumeration offers every pair
   * (corpus[0], X) before it ever advances `i`, so the low-similarity bands —
   * which fill instantly, since almost everything is dissimilar — filled
   * entirely with pairs anchored on ONE memory. The sample was perfectly
   * deterministic, perfectly stratified by score, and told you about one
   * memory's relationship to the corpus rather than about the corpus.
   *
   * Caught by reading the generated sheet, not by a test: the tests asserted
   * determinism and band coverage, and both held. Representativeness was a
   * property nobody had asserted.
   */
  maxPerAnchor?: number
}

/**
 * Band edges, denser where the floors currently sit (0.45 and 0.8 for lexical).
 *
 * A sampling decision, not a measurement — it says where we currently believe
 * the answer lies, and being wrong about that costs coverage, not correctness.
 */
export const DEFAULT_BANDS = [
  0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0,
]

export type SampleResult = {
  sheet: SheetRow[]
  meta: PairMeta[]
  report: SampleReport
}

export type SampleReport = {
  corpusSize: number
  totalPairs: number
  sampled: number
  /** Bands that never reached quota — itself a finding about the corpus. */
  underfilled: { band: string; got: number; quota: number }[]
  cannotJudge: number
}

/** Which band a score falls in. */
export const bandOf = (score: number, bands: number[]): number => {
  for (let i = bands.length - 1; i >= 0; i--) if (score >= bands[i]!) return i
  return 0
}

/**
 * Sample candidate pairs for labelling.
 *
 * DETERMINISTIC — no RNG anywhere. Pairs are enumerated in corpus order and
 * taken in that order within each band, so a re-run reproduces the sample
 * exactly. A fixture you cannot reproduce is one you cannot audit, and "the
 * sample moved" would be indistinguishable from "the corpus moved".
 *
 * `cannot judge` pairs get their own band rather than being dropped: they are a
 * real population (texts below the estimator's floor to score at all) and how
 * the ladder treats them deserves evidence too.
 */
export const samplePairs = (corpus: CorpusEntry[], opts: SampleOptions): SampleResult => {
  const bands = opts.bands ?? DEFAULT_BANDS
  const perBand = opts.perBand ?? 12
  const excerpt = opts.excerpt ?? 240
  const est = opts.estimator
  const CANNOT_JUDGE_BAND = bands.length

  const maxPerAnchor = opts.maxPerAnchor ?? 2

  const buckets: { row: SheetRow; meta: PairMeta }[][] = Array.from(
    { length: bands.length + 1 },
    () => [],
  )
  /** Per band, how many pairs each member already appears in. */
  const anchorUse: Map<string, number>[] = Array.from(
    { length: bands.length + 1 },
    () => new Map(),
  )

  // DIAGONAL ENUMERATION: for each gap g, walk every i. This visits pairs
  // spread across the whole corpus before it revisits any anchor, where the
  // nested-loop order exhausts anchor 0 against everything first. Still fully
  // deterministic — the order is a function of the corpus alone.
  for (let g = 1; g < corpus.length; g++) {
    for (let i = 0; i + g < corpus.length; i++) {
      const a = corpus[i]!
      const b = corpus[i + g]!
      const score = est.compare(a.body, b.body)
      const band = score === null ? CANNOT_JUDGE_BAND : bandOf(score, bands)
      if (buckets[band]!.length >= perBand) continue

      const use = anchorUse[band]!
      if ((use.get(a.id) ?? 0) >= maxPerAnchor || (use.get(b.id) ?? 0) >= maxPerAnchor) continue
      use.set(a.id, (use.get(a.id) ?? 0) + 1)
      use.set(b.id, (use.get(b.id) ?? 0) + 1)

      const key = pairKey(a.id, b.id)
      buckets[band]!.push({
        row: { key, aText: a.body.slice(0, excerpt), bText: b.body.slice(0, excerpt), label: null },
        meta: { key, score, sampledBy: est.name, band },
      })
    }
  }

  const flat = buckets.flat()
  const counts = buckets.map((b) => b.length)

  // THE SHEET IS ORDERED BY KEY, NOT BY BAND — and that closes a leak of exactly
  // the information the two-artifact split exists to withhold.
  //
  // Bucket order is band order, so emitting `buckets.flat()` puts the sheet in
  // ascending similarity. A labeller working top to bottom would then infer each
  // pair's band from its position, which is the score arriving by the back door.
  // The key is a content hash, so sorting by it is deterministic and independent
  // of similarity.
  const sheet = flat.map((f) => f.row).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    sheet,
    meta: flat.map((f) => f.meta),
    report: {
      corpusSize: corpus.length,
      totalPairs: (corpus.length * (corpus.length - 1)) / 2,
      sampled: flat.length,
      cannotJudge: counts[CANNOT_JUDGE_BAND] ?? 0,
      underfilled: counts
        .map((got, i) => ({
          band: i === CANNOT_JUDGE_BAND ? 'cannot-judge' : `${bands[i]}–${bands[i + 1] ?? 1}`,
          got,
          quota: perBand,
        }))
        .filter((b) => b.got < b.quota),
    },
  }
}

/**
 * Mine same-fact pairs nobody had to judge.
 *
 * Two memories sharing a slug in the same scope, with DIFFERENT body text, are a
 * re-save or an edit — a positive that arrived without a labeller.
 *
 * MEASURED CAVEAT, and it is why these are a control rather than a corpus: on
 * the live V1 graph this yields about a dozen usable pairs, not the ~900 the
 * same-name count suggests. Grouping by name and counting distinct
 * `content_hash` reads as ~900 variant clusters; deduplicating on actual CONTENT
 * leaves twelve, because the hash covers name and description as well as body.
 * A count of distinct hashes is not a count of distinct texts.
 *
 * They ship UNLABELLED and are used as a held-out control: a floor that gets
 * these wrong indicts the hand labels.
 */
export const mineNaturalPairs = (
  corpus: CorpusEntry[],
  excerpt = 240,
  /**
   * Scoring the controls is REQUIRED, not optional.
   *
   * A control with no score is dropped by `joinLabels` as unscored, which is how
   * the held-out check first came to run over an empty array and report zero. The
   * scores go in the META artifact, never the sheet, so scoring them costs
   * nothing in labelling independence.
   */
  estimator?: Estimator,
): { sheet: SheetRow[]; meta: PairMeta[] } => {
  const bySlug = new Map<string, CorpusEntry[]>()
  for (const e of corpus) {
    if (!e.slug) continue
    const k = `${e.scope} ${e.slug}`
    const list = bySlug.get(k)
    if (list) list.push(e)
    else bySlug.set(k, [e])
  }

  const out: SheetRow[] = []
  const outMeta: PairMeta[] = []
  const seen = new Set<string>()

  for (const group of bySlug.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        if (a.body === b.body) continue // replication, not a re-save
        const key = pairKey(a.id, b.id)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          key,
          aText: a.body.slice(0, excerpt),
          bText: b.body.slice(0, excerpt),
          label: null,
          control: true,
        })
        if (estimator) {
          outMeta.push({
            key,
            score: estimator.compare(a.body, b.body),
            sampledBy: `${estimator.name}:natural`,
            band: -1,
          })
        }
      }
    }
  }

  return { sheet: out, meta: outMeta }
}
