/**
 * Recall — the orchestrator. seed → expand → rank → collapse → cut.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE RANKING REGIME
 *
 * V1 decides a memory's final rank across five files, plus an orphaned second
 * recall engine with no production caller, plus a per-file path that ignores
 * cosine while still running the cosine-weighted composite and gates decay off
 * with a comment admitting the cost was never measured. Nobody could answer "why
 * did this surface?" because the answer existed only as the difference between
 * numbers nobody logged.
 *
 * Here there is one scorer, one traversal, one cut, and every hit carries the
 * signals it was scored on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPORTS ABOUT ITSELF, AND WHY ALL OF IT
 *
 * Four different ways this can return few or no results, and they must never
 * look alike to a caller:
 *
 *   corpusEmpty          nothing has ever been stored
 *   seed.degradedFrom    a better seed existed and could not run
 *   traversal.*          a bound stopped the walk (lossless vs lossy, marked)
 *   cut.droppedByFloor   candidates existed and were not worth the tokens
 *
 * A recall that returns two hits is a different event in each case, and the
 * caller — a human, or an injection budget — needs to know which.
 */

import { collapse, type Candidate as CollapseCandidate, type CollapsedHit } from './collapse.js'
import { expand, type ExpandReport } from './expand.js'
import {
  DEFAULT_RELEVANCE_FRACTION,
  INHERITED_WEIGHTS,
  relationStrength,
  decayPenalty,
  rankCandidates,
  recencyBonus,
  takeRelevant,
  usageBonus,
  type Candidate,
  type Cut,
  type Weights,
} from './rank.js'
import { type Estimator } from './reconcile.js'
import { clearsFloor, queryMatch, queryTerms } from './relevance.js'
import { MIN_TERM_LENGTH, runSeed, type Seed, type SeedResult } from './seed.js'
import type { Resolved } from './subjects.js'
import type { MemoryStore } from './store.js'
import type { Memory } from './types.js'

export type RecallOptions = {
  store: MemoryStore
  seeds: Seed[]
  /** Explicit, never Date.now() internally — so a past ranking is recomputable. */
  asOf: number
  k?: number
  scope?: string
  weights?: Weights
  estimator?: Estimator
  relevanceFraction?: number
  seedK?: number
  /** IDF per query term. Recall fills it from the corpus; callers need not. */
  termWeight?: (term: string) => number
  /** A memory (id or name) to account for: where it fell out of the pipeline, if it did. */
  explain?: string
  /**
   * The least query relevance a hit needs, whatever else it scores. Without it
   * the floor is only relative to the best hit, so when nothing really matches,
   * recency and usage alone carry weak hits in (node-a: hits at sim 0.00 returned
   * on recency). Unset for the CLI, which is asked on purpose; set by the hooks.
   */
  minSimilarity?: number
  /** Role words in the query, resolved to the memories stating who holds the role (subjects.ts). */
  resolved?: Resolved
  /** What the seed searches, when it differs from the query relevance is judged on (the expanded second pass). */
  seedQuery?: string
  /**
   * Other ways a query term may be written (entities.ts roleSynonyms): a memory
   * using any of them answers the term. Whole words, lower-case.
   */
  synonyms?: Map<string, string[]>
}

const wordIn = (text: string, phrase: string): boolean => new RegExp(`(^|[^a-z0-9])${phrase.replace(/[^a-z0-9 ]/g, '.')}($|[^a-z0-9])`).test(text)

/** Where one memory went in a recall: the answer to "why did it not come back?" */
export type Explanation = {
  target: string
  found: boolean
  id?: string
  /** Its place among every lexical candidate (1-based), and how many seeds were taken. */
  seedRank?: number
  seedK: number
  seeded: boolean
  reachedByEdge: boolean
  /** Its score had it been a candidate, or as ranked. */
  score?: number
  signals?: Candidate['signals']
  rank?: number
  collapsedInto?: string
  /** Why the cut dropped it: under the minimum similarity, under the relevance floor, or past k. */
  cutBy?: 'minSim' | 'floor' | 'k'
  returned: boolean
}

export type RecallResult = {
  hits: Cut['hits']
  /** True when the graph holds nothing at all. Not the same as "no matches". */
  corpusEmpty: boolean
  seed: Pick<SeedResult, 'via' | 'degradedFrom' | 'truncated'>
  traversal: Omit<ExpandReport, 'reached'> & { reached: number }
  cut: Omit<Cut, 'hits'> & { belowMinSim: number }
  explain?: Explanation
}

/**
 * How often this memory has been surfaced, and when it last was.
 *
 * Read from `surfaced_in` observed edges, which is the same event log decay
 * consults — deliberately, so the two cannot drift into disagreeing about the
 * same history. Counted ONCE: frequency feeds the usage bonus, recency feeds
 * decay, and neither reads the other's half. That separation is the V1
 * double-count fix, enforced here at the point the data is read rather than
 * only inside the scorer.
 */
// Usage is what replies USED, not what was shown: counting every injection made a
// memory shown once rank higher and be shown again (surfacing.ts).
const surfacing = (store: MemoryStore, id: string): { count: number; lastAt?: number } => {
  let count = 0
  let lastAt: number | undefined
  for (const e of store.observedEdges(id)) {
    if (e.rel !== 'used_in') continue
    count += e.count
    lastAt = lastAt === undefined ? e.lastAt : Math.max(lastAt, e.lastAt)
  }
  return { count, lastAt }
}

const toCandidate = (
  memory: Memory,
  query: string,
  opts: RecallOptions,
  via: 'seed' | 'edge',
  hops: number,
  relation: string | undefined,
): Candidate => {
  const w = opts.weights ?? INHERITED_WEIGHTS
  const { count, lastAt } = surfacing(opts.store, memory.id)

  // QUERY RELEVANCE, NOT SAMENESS. The calibrated estimator answers a symmetric
  // question between two comparable documents; this is asymmetric and the texts
  // are deliberately different lengths. Jaccard's CEILING for a short query
  // against a paragraph is |Q|/|M| — it penalises the memory for being
  // informative — and its token guard returns cannot-judge for short text, which
  // a query is by nature. See relevance.ts.
  //
  // `null` stays undefined rather than becoming 0: "there was nothing to look
  // for" is a different claim from "contains none of it".
  // Name and description are what the writer chose to summarise the memory
  // with; scoring the body alone missed "globex admins role" against a memory
  // named globex-admins-role whose body says "administer".
  const match = queryMatch(query, memory.content, {
    // Facet terms are what consolidation said the memory is about: they count as its head too.
    head: `${memory.name.replace(/[-_]+/g, ' ')}\n${memory.description}\n${opts.store.facetTermsOf(memory.id).join(' ')}`,
    weight: opts.termWeight,
    answers:
      opts.resolved || opts.synonyms
        ? (t) => {
            if (opts.resolved?.byTerm.get(t)?.has(memory.id)) return true
            const alts = opts.synonyms?.get(t)
            if (!alts?.length) return false
            const text = `${memory.name.replace(/[-_]+/g, ' ')}\n${memory.description}\n${memory.content}`.toLowerCase()
            return alts.some((a) => wordIn(text, a))
          }
        : undefined,
  })
  const sim = match?.score ?? null

  const decay = decayPenalty(
    {
      pinned: memory.pinned,
      protected: memory.protected,
      isThread: memory.shape === 'thread',
      lastSurfacedAt: lastAt,
      authoredAt: memory.authoredAt,
      ingestedAt: memory.ingestedAt,
      // A real field, never a regex over prose — V1 recovers this with
      // /^\s*(ALWAYS|NEVER)\b/ against the body.
      isStandingDirective: memory.shape === 'feedback',
    },
    opts.asOf,
  )

  return {
    memory,
    signals: {
      similarity: sim ?? undefined,
      ...(match ? { matched: { terms: match.matched, inHead: match.inHead, topical: match.topical } } : {}),
      via,
      hops,
      relation,
      usageBonus: usageBonus(count),
      edgeBonus: via === 'edge' ? relationStrength(relation) : 0,
      recencyBonus: recencyBonus(memory.authoredAt, opts.asOf, w.recencyHalfLifeMs),
      // SCOPE IS AN ADDITIVE PRIOR, NEVER A FILTER — an out-of-scope memory
      // ranks lower and is never excluded. That is what makes this one mind
      // rather than per-folder notebooks.
      //
      // ⚠ THE GUARANTEE IS ABOUT RANKING, AND THE CUT CAN STILL EXCLUDE.
      // Measured while testing: an out-of-scope memory on the same subject
      // scored below the relevance floor and was dropped — not because scope
      // filtered it, but because scope lowered its score and the floor cuts on
      // score. So the two mechanisms compose into something that CAN behave like
      // a soft filter at the edge.
      //
      // Stated rather than hidden, because the alternative is someone later
      // asking why their other project's memory vanished and finding two
      // individually-correct rules. If that turns out to be wrong in practice
      // the fix is the FLOOR (exempt out-of-scope hits, or floor within scope),
      // not the prior — the prior is a product decision.
      scopeBonus: opts.scope && memory.scope === opts.scope ? 1 : 0,
      pinBonus: memory.pinned ? 1 : 0,
      decayPenalty: decay.penalty,
      hopPenalty: hops,
    },
  }
}

const passes = (s: Candidate['signals'], min: number): boolean =>
  !!s.matched && clearsFloor({ score: s.similarity ?? 0, matched: s.matched.terms, inHead: s.matched.inHead, topical: s.matched.topical }, min)

export const recall = (query: string, opts: RecallOptions): RecallResult => {
  // Rare terms carry the meaning: "globex" in 40 memories says more than
  // "engineers" in 400. Uniform weights let any common word tie a real match.
  const n = opts.store.count()
  const idf = new Map<string, number>()
  const termWeight =
    opts.termWeight ??
    ((t: string) => {
      if (!idf.has(t)) idf.set(t, Math.log(1 + n / (1 + opts.store.documentFrequency(t))))
      return idf.get(t)!
    })
  const o = { ...opts, termWeight }
  const k = o.k ?? 10
  const seedK = o.seedK ?? Math.max(k * 2, 20)

  const corpusEmpty = o.store.count() === 0

  const lexical = runSeed(o.seeds, o.seedQuery ?? query, seedK)
  // A memory that states who holds a role the query named is a seed whatever words it shares.
  const resolvedIds = new Set([...(o.resolved?.byTerm.values() ?? [])].flatMap((ids) => [...ids]))
  const extra = [...resolvedIds].filter((id) => !lexical.memories.some((m) => m.id === id)).map((id) => o.store.get(id)).filter((m): m is Memory => !!m)
  const seeded = extra.length ? { ...lexical, memories: [...extra, ...lexical.memories] } : lexical

  // Rank the seeds first: the traversal's stopping threshold has to come from
  // something, and until a hop has happened the seeds are all the evidence there
  // is.
  const seedCandidates = seeded.memories.map((m) => toCandidate(m, query, o, 'seed', 0, undefined))
  const kthOf = (cands: Candidate[]): number | undefined => {
    const ranked = rankCandidates(cands, { weights: o.weights, asOf: o.asOf })
    // AFTER collapse: collapse removes candidates, so the surviving k-th is
    // lower than the raw k-th, and the higher number would stop the traversal
    // early and silently lose results.
    const collapsed = collapse(
      ranked.map((r) => ({ memory: r.memory, score: r.score }) as CollapseCandidate),
      { estimator: o.estimator },
    )
    const scores = collapsed
      .map((c) => ranked.find((r) => r.memory.id === c.memory.id)?.score ?? -Infinity)
      .sort((a, b) => b - a)
    return scores.length >= k ? scores[k - 1] : undefined
  }

  const walked = expand(seeded.memories, {
    store: o.store,
    weights: o.weights,
    kthBest: kthOf(seedCandidates),
    // The threshold tightens from what each depth actually returned — the
    // strongest evidence for stopping is the evidence just produced.
    onDepth: (reached) =>
      kthOf([
        ...seedCandidates,
        ...reached.map((r) => toCandidate(r.memory, query, o, 'edge', r.hops, r.relation)),
      ]),
  })

  const all = [
    ...seedCandidates,
    ...walked.reached.map((r) => toCandidate(r.memory, query, o, 'edge', r.hops, r.relation)),
  ]

  const ranked = rankCandidates(all, { weights: o.weights, asOf: o.asOf })

  // COLLAPSE BEFORE THE CUT, never after: cut-first lets three variants of one
  // fact fill the top three slots, and the two genuinely different memories that
  // should have been second and third are already gone.
  const collapsed = collapse(
    ranked.map((r) => ({ memory: r.memory, score: r.score }) as CollapseCandidate),
    { estimator: o.estimator },
  )
  const byId = new Map(ranked.map((r) => [r.memory.id, r]))
  const collapsedSurvivors = collapsed.map((c) => byId.get(c.memory.id)!).filter(Boolean)
  const min = o.minSimilarity
  const relevant = (r: Candidate) => passes(r.signals, min!)
  const survivors = min === undefined ? collapsedSurvivors : collapsedSurvivors.filter(relevant)
  const belowMinSim = collapsedSurvivors.length - survivors.length

  const cut = takeRelevant(survivors, k, { relevanceFraction: o.relevanceFraction })

  const explain = o.explain ? explainOne(o.explain, { query, o, seedK, seeded: seeded.memories, all, ranked, collapsed, survivors, hits: cut.hits }) : undefined

  return {
    ...(explain ? { explain } : {}),
    hits: cut.hits,
    corpusEmpty,
    seed: { via: seeded.via, degradedFrom: seeded.degradedFrom, truncated: seeded.truncated },
    traversal: {
      reached: walked.reached.length,
      depthExplored: walked.depthExplored,
      breadthTruncatedAt: walked.breadthTruncatedAt,
      stoppedByBound: walked.stoppedByBound,
    },
    cut: {
      droppedByFloor: cut.droppedByFloor,
      droppedByK: cut.droppedByK,
      floorApplied: cut.floorApplied,
      belowMinSim,
    },
  }
}

const explainOne = (
  target: string,
  x: {
    query: string
    o: RecallOptions & { termWeight: (t: string) => number }
    seedK: number
    seeded: Memory[]
    all: Candidate[]
    ranked: { memory: Memory; score: number }[]
    collapsed: CollapsedHit[]
    survivors: { memory: Memory; score: number }[]
    hits: { memory: Memory }[]
  },
): Explanation => {
  const m = x.o.store.get(x.o.store.resolveId(target)) ?? x.o.store.byName(target)[0] ?? null
  if (!m) return { target, found: false, seedK: x.seedK, seeded: false, reachedByEdge: false, returned: false }
  const terms = [...queryTerms(x.query)].filter((t) => t.length >= MIN_TERM_LENGTH)
  const lexical = terms.length ? x.o.store.searchTerms(terms, Number.MAX_SAFE_INTEGER) : []
  const seedIndex = lexical.findIndex((c) => c.id === m.id)
  const inAll = x.all.find((c) => c.memory.id === m.id)
  const cand = inAll ?? toCandidate(m, x.query, x.o, 'seed', 0, undefined)
  const asRanked = rankCandidates([...x.all.filter((c) => c.memory.id !== m.id), cand], { weights: x.o.weights, asOf: x.o.asOf })
  const at = asRanked.findIndex((r) => r.memory.id === m.id)
  const holder = x.collapsed.find((c) => c.siblings.some((s) => s.id === m.id))
  const survived = x.survivors.some((s) => s.memory.id === m.id)
  const returned = x.hits.some((h) => h.memory.id === m.id)
  const best = x.survivors[0]?.score ?? 0
  return {
    target,
    found: true,
    id: m.id,
    ...(seedIndex >= 0 ? { seedRank: seedIndex + 1 } : {}),
    seedK: x.seedK,
    seeded: x.seeded.some((s) => s.id === m.id),
    reachedByEdge: !!inAll && inAll.signals.via === 'edge',
    score: asRanked[at]?.score,
    signals: cand.signals,
    rank: at + 1,
    ...(holder ? { collapsedInto: holder.memory.id } : {}),
    ...(!survived && !holder && x.o.minSimilarity !== undefined && !passes(cand.signals, x.o.minSimilarity) ? { cutBy: 'minSim' as const } : {}),
    ...(survived && !returned ? { cutBy: (asRanked[at]?.score ?? 0) < best * (x.o.relevanceFraction ?? DEFAULT_RELEVANCE_FRACTION) ? ('floor' as const) : ('k' as const) } : {}),
    returned,
  }
}
