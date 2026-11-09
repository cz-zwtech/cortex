/**
 * Query relevance — a DIFFERENT question from sameness, needing a different
 * measure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CALIBRATED ESTIMATOR IS THE WRONG TOOL HERE
 *
 * `LEXICAL_ESTIMATOR` answers "are these two memories the same fact?" — a
 * SYMMETRIC question between two documents of comparable length. Task 138a
 * calibrated its floors against exactly that population.
 *
 * Recall asks something else: "does this memory answer this query?" That is
 * ASYMMETRIC, and the two texts are deliberately different lengths — a query is
 * a handful of words, a memory is a paragraph.
 *
 * Jaccard on that pair is structurally wrong, and the numbers are stark. For a
 * real 8-token query against an 18-token memory sharing 6 terms:
 *
 *   Jaccard  0.300   ← what sameness computes
 *   Coverage 0.750   ← what the query actually asks
 *
 * And worse than a low number: Jaccard's CEILING for that pair is 0.444. Even a
 * query whose every term appears in the memory cannot score above |Q|/|M|,
 * because the denominator counts every word the memory has and the query does
 * not. The metric penalises the memory for being informative.
 *
 * On top of that, the estimator's token-count guard returns `cannot judge` for
 * anything short — and a query is short BY NATURE. So in practice the largest
 * weight in the scorer (0.55) was contributing NOTHING to most queries, and
 * ranking fell through to recency and pins. Observed directly: two unrelated
 * memories scoring identically at 0.100 with `sim=n/a`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAMENESS ESTIMATOR IS STILL USED — FOR SAMENESS
 *
 * Collapse asks whether two HITS are the same fact, which is genuinely symmetric
 * and genuinely between two memories. That keeps the calibrated estimator and
 * its derived floor. One module, two questions, two measures, and saying which
 * is which is the whole point.
 *
 * This is the same failure class as reading `content_hash` as "the text
 * differs", `dim` as "the model is the same", and `authorship` as "this is
 * scaffolding": a signal only answers the question it was derived for. The
 * difference is that this one was mine.
 */

/**
 * Terms worth matching on.
 *
 * Very short tokens are dropped for the same reason the lexical seed drops them:
 * they appear everywhere, so they inflate coverage without carrying meaning.
 */
const MIN_TERM = 3

export const terms = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (t.length >= MIN_TERM) out.add(t)
    // `globex_admins` must also answer "admins": the compound stays, its parts join it.
    if (/[_-]/.test(t)) for (const p of t.split(/[_-]+/)) if (p.length >= MIN_TERM) out.add(p)
  }
  return out
}

/**
 * Words that say nothing about what a query is ABOUT.
 *
 * "who are Globex engineers" matched a style memory at full coverage because
 * "who" and "are" counted as much as "globex" (laptop Stage A).
 */
export const STOPWORDS = new Set(
  ('the and for are was were who whom whose what when where why how which that this these those with ' +
    'from have has had not but you your yours our ours its they them their there been being will would ' +
    'should could can does did doing about into onto any all some each other than then also just only ' +
    'very more most such per via out off over under again once here she her his him one get got use ' +
    // Chat filler: without these, "ok, lets compact" would match a thread on "lets".
    'lets let okay yes yeah please now need want think know like make sure going thing things really ' +
    'still well back though just able also maybe something anything everything both too yet ever').split(' '),
)

/** A query's content terms. All of them when the query is nothing but stopwords. */
export const queryTerms = (query: string): Set<string> => {
  const all = terms(query)
  const content = new Set([...all].filter((t) => !STOPWORDS.has(t)))
  return content.size ? content : all
}

/**
 * Query terms written as proper nouns: capitalised, and not the query's first
 * word (which is capitalised by grammar, not meaning).
 *
 * "who are Globex engineers" asks about Globex the company. A memory that used
 * the name only as an ordinary lower-case word matched it at full coverage and
 * ranked first (laptop Stage A). In a body, a proper-noun term only
 * counts where the body capitalises it too. Names and descriptions are slugs
 * and lower-case by convention, so they are not held to this.
 */
export const properNouns = (query: string): Set<string> => {
  const out = new Set<string>()
  query
    .split(/[^A-Za-z0-9_-]+/)
    .filter(Boolean)
    .forEach((tok, i) => {
      if (i > 0 && /^[A-Z]/.test(tok)) out.add(tok.toLowerCase())
    })
  return out
}

const capitalisedIn = (text: string, term: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9])${term[0]!.toUpperCase()}${term.slice(1).replace(/[^a-z0-9]/g, '.')}`).test(text)

/**
 * A term the memory has only in its body counts for less than one in its name
 * or description: the head is where the writer said what the memory is about.
 */
export const BODY_ONLY = 0.7

/**
 * What fraction of the query's terms this memory contains. [0,1], asymmetric.
 *
 * Returns `null` — CANNOT JUDGE, never 0 — when the query has no usable terms.
 * Zero would mean "contains none of them", which is a different claim from
 * "there was nothing to look for", and the ladder's whole discipline is that
 * those two must not collapse into one value.
 *
 * UNVALIDATED as a ranking input: coverage is a defensible shape for the
 * question, but its contribution alongside the other weights has not been
 * measured. 138b.
 */
export type RelevanceOptions = {
  /** The memory's name and description: what its writer said it is about. */
  head?: string
  /** How much a term counts (IDF from the corpus). Uniform when absent. */
  weight?: (term: string) => number
  /**
   * A term the memory answers without containing it: the query named a role
   * and the memory states who holds it (subjects.ts). Counts as a head match,
   * because it is what the memory states, not a word it happens to use.
   */
  answers?: (term: string) => boolean
}

/** Coverage, and the evidence behind it: how many query terms matched, and whether one matched the head. */
/** `topical` is false when the query had no content terms and stopwords stood in for them. */
export type QueryMatch = { score: number; matched: number; inHead: boolean; topical: boolean }

export const queryMatch = (query: string, content: string, opts: RelevanceOptions = {}): QueryMatch | null => {
  const q = queryTerms(query)
  if (q.size === 0) return null
  const topical = [...q].some((t) => !STOPWORDS.has(t))
  const proper = properNouns(query)
  const body = terms(content)
  const head = terms(opts.head ?? '')
  let total = 0
  let got = 0
  let matched = 0
  let inHead = false
  for (const t of q) {
    const w = opts.weight?.(t) ?? 1
    total += w
    if (head.has(t) || opts.answers?.(t)) {
      got += w
      matched++
      inHead = true
    } else if (body.has(t) && (!proper.has(t) || capitalisedIn(content, t))) {
      got += opts.head === undefined ? w : w * BODY_ONLY
      matched++
    }
  }
  return total > 0 ? { score: got / total, matched, inHead, topical } : null
}

export const queryRelevance = (query: string, content: string, opts: RelevanceOptions = {}): number | null =>
  queryMatch(query, content, opts)?.score ?? null

/**
 * Whether a hit clears the prompt-time floor: enough coverage, and evidence
 * rather than chance. Coverage alone cannot tell: "ok, both are in" can cover a
 * short memory completely on the one word "both".
 *
 *   - a query of stopwords alone is never evidence;
 *   - at `min` coverage, two matched terms or one in the head will do;
 *   - a long query dilutes coverage, so half of `min` will do when the head
 *     matched and so did another term ("check linear for anything waiting on
 *     me..." against a memory named for Linear sat at 0.14).
 */
export const clearsFloor = (m: Pick<QueryMatch, 'score' | 'matched' | 'inHead' | 'topical'>, min: number): boolean =>
  m.topical && ((m.score >= min && (m.matched >= 2 || m.inHead)) || (m.score >= min / 2 && m.inHead && m.matched >= 2))
