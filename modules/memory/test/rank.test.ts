import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTED_ON_WINDOW_MS,
  DEFAULT_RELEVANCE_FRACTION,
  boundedSignals,
  scoreCeiling,
  shouldExpand,
  takeRelevant,
  COLDNESS_HALF_LIFE_MS,
  GRACE_PERIOD_MS,
  INHERITED_WEIGHTS,
  STANDING_DIRECTIVE_DAMPING,
  decayPenalty,
  rankCandidates,
  recencyBonus,
  usageBonus,
  type Candidate,
  type DecayInput,
  type Signals,
} from '../server/rank.js'
import type { Memory } from '../server/types.js'

const mem = (id: string, over: Partial<Memory> = {}): Memory =>
  ({
    id,
    source: `/mem/${id}.md`,
    name: id,
    description: '',
    content: 'body',
    shape: 'reference',
    authorship: 'authored',
    scope: 'user',
    pinned: false,
    protected: false,
    contentHash: `h-${id}`,
    machine: 'node-a',
    authoredAt: 0,
    ingestedAt: 0,
    outcome: '',
    outcomeText: '',
    ...over,
  }) as Memory

const sig = (over: Partial<Signals> = {}): Signals => ({
  via: 'seed',
  hops: 0,
  usageBonus: 0,
  edgeBonus: 0,
  recencyBonus: 0,
  scopeBonus: 0,
  pinBonus: 0,
  decayPenalty: 0,
  hopPenalty: 0,
  ...over,
})

const cand = (id: string, s: Partial<Signals> = {}, m: Partial<Memory> = {}): Candidate => ({
  memory: mem(id, m),
  signals: sig(s),
})

const NOW = 1_000_000_000_000

// ── the weights carry their own provenance ───────────────────────────────────

test('EVERY INHERITED WEIGHT IS MARKED UNVALIDATED IN THE TYPE', () => {
  // A comment is documentation; a type is a thing the next person cannot walk
  // past. 138a earned this: relatedFloor 0.45 turned out to be correct, and the
  // only reason we KNOW it was correct is that it was labelled and then tested.
  // An unlabelled correct constant and an unlabelled wrong one are the same
  // artifact until someone measures them.
  assert.equal(INHERITED_WEIGHTS.unvalidated, true)
  assert.match(INHERITED_WEIGHTS.name, /inherited/)
})

// ── ordinality: the property that makes 138b possible ────────────────────────

test('UNIFORM SCALING IS ARITHMETIC, NOT EVIDENCE — recorded so it is not re-added', () => {
  // The first version of this file asserted ordinality by scaling every weight by
  // 3 and checking the order held. That is VACUOUS: scaling all weights scales
  // the whole score linearly, so order preservation is a fact about
  // multiplication, not about the ranking. It would pass against a broken
  // rankCandidates.
  //
  // Kept as a named non-test so nobody re-adds it believing it proves something.
  const cands = [cand('a', { similarity: 0.9 }), cand('b', { similarity: 0.5 })]
  const scale = (k: number) =>
    rankCandidates(cands, {
      asOf: NOW,
      weights: Object.fromEntries(
        Object.entries(INHERITED_WEIGHTS).map(([key, v]) =>
          typeof v === 'number' && key !== 'recencyHalfLifeMs' ? [key, v * k] : [key, v],
        ),
      ) as typeof INHERITED_WEIGHTS,
    }).map((s) => s.memory.id)
  assert.deepEqual(scale(3), scale(1), 'true, and it proves nothing')
})

// ── EVERY WEIGHT MUST BE LIVE ON THE FIXTURE ─────────────────────────────────
//
// A ranking test only has teeth where the signals COMPETE. On a fixture where one
// signal dominates every case, any re-weighting preserves the order, the suite
// goes green, and it has measured the fixture rather than the code.
//
// So for each weight there is a pair constructed to INVERT when that weight
// moves. A weight with no such pair is INERT on this fixture — and a value
// "validated" against a fixture where it cannot matter is unvalidated in fact
// while reading as validated.

const invertsUnder = (
  weight: keyof typeof INHERITED_WEIGHTS,
  low: number,
  high: number,
  pair: [Candidate, Candidate],
): boolean => {
  const at = (v: number) =>
    rankCandidates(pair, {
      asOf: NOW,
      weights: { ...INHERITED_WEIGHTS, [weight]: v },
    })[0]!.memory.id
  return at(low) !== at(high)
}

test('SIMILARITY is live — a pair inverts when it moves', () => {
  assert.ok(
    invertsUnder('similarity', 0, 5, [
      cand('sim', { similarity: 0.9 }),
      cand('use', { similarity: 0.1, usageBonus: 1 }),
    ]),
  )
})

test('USAGE is live', () => {
  assert.ok(
    invertsUnder('usage', 0, 5, [
      cand('use', { usageBonus: 1 }),
      cand('sim', { similarity: 0.5 }),
    ]),
  )
})

test('RECENCY is live', () => {
  assert.ok(
    invertsUnder('recency', 0, 5, [
      cand('new', { recencyBonus: 1 }),
      cand('sim', { similarity: 0.5 }),
    ]),
  )
})

test('SCOPE is live', () => {
  assert.ok(
    invertsUnder('scope', 0, 5, [
      cand('in', { scopeBonus: 1 }),
      cand('sim', { similarity: 0.5 }),
    ]),
  )
})

test('PIN is live', () => {
  assert.ok(
    invertsUnder('pin', 0, 5, [cand('pin', { pinBonus: 1 }), cand('sim', { similarity: 0.5 })]),
  )
})

test('DECAY is live', () => {
  assert.ok(
    invertsUnder('decay', 0, 5, [
      cand('fresh', { similarity: 0.5 }),
      cand('stale', { similarity: 0.6, decayPenalty: 1 }),
    ]),
  )
})

test('HOP is live', () => {
  assert.ok(
    invertsUnder('hop', 0, 20, [
      cand('near', { similarity: 0.5 }),
      cand('far', { similarity: 0.55, hops: 3, hopPenalty: 3, via: 'edge' }),
    ]),
  )
})

test('WHAT ORDINALITY ACTUALLY BUYS — decay order survives any monotone transform', () => {
  // The real property, and the one that lets 138b measure ranking end-to-end:
  // decay's ABSOLUTE value is meaningless, only its ordering of memories by
  // staleness. So replacing the decay sub-score with any monotone function of
  // itself must not reorder candidates that differ only in decay.
  const raw = [0.1, 0.4, 0.9]
  const order = (f: (x: number) => number) =>
    rankCandidates(
      raw.map((d, i) => cand(`m${i}`, { similarity: 0.5, decayPenalty: f(d) })),
      { asOf: NOW },
    ).map((s) => s.memory.id)

  assert.deepEqual(order((x) => x * x), order((x) => x), 'squaring is monotone on [0,1]')
  assert.deepEqual(order(Math.sqrt), order((x) => x))
})

test('ranking is STABLE — ties break by id, not by arrival order', () => {
  // Candidate arrival order varies with the query plan, so an unstable sort makes
  // a ranking irreproducible and a regression impossible to pin down.
  const a = rankCandidates([cand('x'), cand('y')], { asOf: NOW }).map((s) => s.memory.id)
  const b = rankCandidates([cand('y'), cand('x')], { asOf: NOW }).map((s) => s.memory.id)
  assert.deepEqual(a, b)
})

test('rankCandidates is PURE — same inputs, same output, no clock read', () => {
  const cands = [cand('a', { similarity: 0.4 }), cand('b', { similarity: 0.6 })]
  assert.deepEqual(
    rankCandidates(cands, { asOf: NOW }),
    rankCandidates(cands, { asOf: NOW }),
  )
})

// ── usage: cold-start fairness ───────────────────────────────────────────────

test('USAGE IS POSITIVE-ONLY — a never-surfaced memory is not penalised', () => {
  // Penalising zero-usage freezes the ranking around whatever was popular first
  // and nothing new can ever surface.
  assert.equal(usageBonus(0), 0)
  assert.equal(usageBonus(-3), 0)
  assert.ok(usageBonus(1) > 0)
})

test('usage SATURATES — one much-used memory cannot dominate every query', () => {
  const a = usageBonus(10) - usageBonus(1)
  const b = usageBonus(1000) - usageBonus(991)
  assert.ok(b < a, 'the same 9 extra surfacings are worth less when already popular')
})

// ── decay: the ladder is data ────────────────────────────────────────────────

const base = (over: Partial<DecayInput> = {}): DecayInput => ({
  pinned: false,
  protected: false,
  isThread: false,
  authoredAt: NOW - 10 * GRACE_PERIOD_MS,
  isStandingDirective: false,
  ...over,
})

test('each exemption rung is testable IN ISOLATION — that is why it is data', () => {
  for (const [field, name] of [
    ['pinned', 'pinned'],
    ['protected', 'protected'],
    ['isThread', 'live-thread'],
  ] as const) {
    const out = decayPenalty(base({ [field]: true }), NOW)
    assert.equal(out.penalty, 0, `${name} must be exempt`)
    assert.equal(out.exemption, name, 'and must SAY which rung exempted it')
  }
  assert.equal(decayPenalty(base({ actedOnAt: NOW - 1 }), NOW).exemption, 'recently-acted-on')
  assert.equal(decayPenalty(base({ authoredAt: NOW - 1 }), NOW).exemption, 'within-grace')
})

test('an exemption REPORTS ITSELF — "why was this exempt?" must be answerable', () => {
  // V1 spreads the ladder across a hardcoded chain over four sources, so the
  // policy exists nowhere in one piece and the answer is the difference between
  // two numbers nobody logged.
  const out = decayPenalty(base({ pinned: true }), NOW)
  assert.equal(out.exemption, 'pinned')
  assert.equal(decayPenalty(base(), NOW).exemption, undefined, 'and is absent when it decayed')
})

test('DECAY NO LONGER DOUBLE-COUNTS SURFACING — the V1 defect, asserted', () => {
  // V1 multiplies coldness by rarity. Both are functions of the SAME event log,
  // so one surfacing halves the score regardless of how long ago it happened.
  // Here coldness depends on WHEN it was last surfaced and nothing else;
  // frequency is the usage bonus's job, counted exactly once.
  const longAgo = decayPenalty(base({ lastSurfacedAt: NOW - 10 * COLDNESS_HALF_LIFE_MS }), NOW)
  const recent = decayPenalty(base({ lastSurfacedAt: NOW - 1 }), NOW)
  assert.ok(longAgo.penalty > recent.penalty, 'coldness tracks recency of surfacing')

  // And the count does not appear in the decay input at all — structurally, it
  // CANNOT be double-counted here.
  assert.ok(!('surfaceCount' in base()), 'frequency is not an input to decay')
})

test('a standing directive sinks SLOWER, and it is a field rather than a regex', () => {
  // V1 recovers "standing directive" with /^\s*(ALWAYS|NEVER)\b/ over prose.
  const plain = decayPenalty(base({ lastSurfacedAt: NOW - COLDNESS_HALF_LIFE_MS }), NOW)
  const standing = decayPenalty(
    base({ lastSurfacedAt: NOW - COLDNESS_HALF_LIFE_MS, isStandingDirective: true }),
    NOW,
  )
  assert.ok(standing.penalty < plain.penalty)
  assert.equal(standing.penalty, plain.penalty * STANDING_DIRECTIVE_DAMPING)
})

test('DECAY IS DE-PRIORITISATION, NEVER EXCLUSION — a decayed memory still ranks', () => {
  const decayed = cand('old', { similarity: 0.9, decayPenalty: 1 })
  const fresh = cand('new', { similarity: 0.1 })
  const out = rankCandidates([decayed, fresh], { asOf: NOW })
  assert.equal(out.length, 2, 'nothing is dropped')
  assert.equal(out[0]!.memory.id, 'old', 'and a strong-enough match still wins')
})

test('asOf is a PARAMETER — any past instant is recomputable', () => {
  // Never Date.now() internally, or a ranking regression cannot be reproduced.
  const d = base({ authoredAt: NOW - GRACE_PERIOD_MS * 2 })
  const early = decayPenalty(d, d.authoredAt + 1)
  const late = decayPenalty(d, NOW)
  assert.equal(early.exemption, 'within-grace')
  assert.equal(late.exemption, undefined)
})

test('the acted-on window expires rather than exempting forever', () => {
  assert.equal(decayPenalty(base({ actedOnAt: NOW - 1 }), NOW).exemption, 'recently-acted-on')
  assert.equal(
    decayPenalty(base({ actedOnAt: NOW - ACTED_ON_WINDOW_MS - 1 }), NOW).exemption,
    undefined,
  )
})

// ── scope: a prior, never a filter ───────────────────────────────────────────

test('SCOPE IS AN ADDITIVE PRIOR — an out-of-scope memory ranks lower, never absent', () => {
  // This is what makes it ONE MIND rather than per-folder notebooks, and it is a
  // product decision expressed as a bonus so it CANNOT be configured into a
  // filter.
  const inScope = cand('in', { similarity: 0.5, scopeBonus: 1 }, { scope: 'proj' })
  const out = cand('out', { similarity: 0.5, scopeBonus: 0 }, { scope: 'other' })
  const ranked = rankCandidates([out, inScope], { asOf: NOW })
  assert.equal(ranked.length, 2, 'the other project is present')
  assert.equal(ranked[0]!.memory.id, 'in', 'and merely outranked')
})

test('a strong out-of-scope match beats a weak in-scope one', () => {
  const weakIn = cand('in', { similarity: 0.1, scopeBonus: 1 })
  const strongOut = cand('out', { similarity: 0.95, scopeBonus: 0 })
  assert.equal(rankCandidates([weakIn, strongOut], { asOf: NOW })[0]!.memory.id, 'out')
})

// ── signals: observability by construction ───────────────────────────────────

test('EVERY HIT CARRIES ITS SIGNALS — "why did this surface?" is answerable', () => {
  // V1 decides a memory's final rank across five files, so the answer exists only
  // as the difference between two numbers nobody logged.
  const out = rankCandidates([cand('a', { via: 'edge', hops: 2, relation: 'MENTIONS_FILE' })], {
    asOf: NOW,
  })
  assert.equal(out[0]!.signals.via, 'edge')
  assert.equal(out[0]!.signals.hops, 2)
  assert.equal(out[0]!.signals.relation, 'MENTIONS_FILE')
  assert.equal(typeof out[0]!.score, 'number')
})

test('recency decays on AUTHORED time, by half-lives', () => {
  const h = INHERITED_WEIGHTS.recencyHalfLifeMs
  assert.equal(recencyBonus(NOW, NOW, h), 1)
  assert.ok(Math.abs(recencyBonus(NOW - h, NOW, h) - 0.5) < 1e-9)
  assert.ok(recencyBonus(NOW - 4 * h, NOW, h) < 0.1)
})

// ── the admissible stopping bound ────────────────────────────────────────────

test('USAGE ACTUALLY SATURATES NOW — it did not, and that was a real defect', () => {
  // log1p(n)/log1p(100) passes 1.0 at n=100 and keeps climbing: 1.50 at 1,000,
  // 2.00 at 10,000. Weighted at 0.2 that is 0.40 against 0.55 for a PERFECT
  // similarity match — so a heavily-surfaced memory could dominate every query,
  // which is exactly what the "log saturation" comment claimed it prevented.
  assert.equal(usageBonus(100), 1)
  assert.equal(usageBonus(1_000), 1, 'was 1.497')
  assert.equal(usageBonus(10_000), 1, 'was 1.996')
  assert.ok(usageBonus(10) < 1, 'and still discriminates below the clamp')
})

test('the ceiling DECREASES with depth — otherwise there is no stopping rule', () => {
  assert.ok(scoreCeiling(1) > scoreCeiling(2))
  assert.ok(scoreCeiling(2) > scoreCeiling(3))
})

test('THE BOUND IS ADMISSIBLE — no real candidate can exceed its depth ceiling', () => {
  // The property the whole optimisation rests on. If a candidate could beat the
  // ceiling, pruning would drop real results while reporting a complete
  // traversal — unsound pruning looks identical to correct pruning from outside.
  const best = cand('max', {
    similarity: 1,
    usageBonus: 1,
    edgeBonus: 1,
    recencyBonus: 1,
    scopeBonus: 1,
    pinBonus: 1,
    decayPenalty: 0,
    hopPenalty: 2,
    hops: 2,
    via: 'edge',
  })
  const [scored] = rankCandidates([best], { asOf: NOW })
  assert.ok(
    scored!.score <= scoreCeiling(2) + 1e-9,
    `a maximal candidate at depth 2 scored ${scored!.score}, ceiling ${scoreCeiling(2)}`,
  )
})

test('boundedSignals CATCHES a contract violation rather than trusting it', () => {
  assert.equal(boundedSignals(sig({ usageBonus: 1 })), true)
  assert.equal(boundedSignals(sig({ usageBonus: 1.5 })), false, 'the pre-clamp usage bug')
  assert.equal(boundedSignals(sig({ similarity: -0.2 })), false, 'cosine can go negative')
})

test('EXPANSION STOPS WHEN NO DEEPER HOP COULD MATTER', () => {
  // Holding a k-th best of 0.9, a depth whose ceiling is below that cannot
  // produce anything that enters the top k — so the traversal is over.
  const deep = 100
  assert.ok(scoreCeiling(deep) < 0.9)
  assert.equal(shouldExpand(deep, 0.9), false)
})

test('and it goes DEEPER than a fixed cap when nothing is dominating yet', () => {
  // The direction a tuned cutoff gets wrong: on a sparse query the held scores
  // are weak, so the bound permits depth a fixed cap would have refused. Recall
  // improves exactly where a cap silently truncates.
  assert.equal(shouldExpand(5, 0.01), true)
  assert.equal(shouldExpand(5, undefined), true, 'nothing held yet ⇒ never stop early')
})

test('a HEURISTIC cutoff trades quality; this trades nothing — same output', () => {
  // Simulate: candidates exist at depth 3 but all are dominated. Pruning at 3
  // must return what full traversal returns.
  const held = [cand('a', { similarity: 0.9 }), cand('b', { similarity: 0.85 })]
  const deepOnes = [cand('d', { similarity: 0.2, hops: 9, hopPenalty: 9, via: 'edge' })]
  const full = rankCandidates([...held, ...deepOnes], { asOf: NOW }).slice(0, 2)
  const pruned = rankCandidates(held, { asOf: NOW }).slice(0, 2)
  assert.deepEqual(
    pruned.map((s) => s.memory.id),
    full.map((s) => s.memory.id),
  )
})

// ── the cut: tokens, not latency ─────────────────────────────────────────────

test('THE CUT RETURNS FEWER THAN k RATHER THAN PADDING — the token lever', () => {
  // Three strong hits and a tail of noise: a fixed take(k) returns k anyway and
  // the padding is pure token cost.
  const ranked = rankCandidates(
    [
      cand('s1', { similarity: 1 }),
      cand('s2', { similarity: 0.9 }),
      cand('s3', { similarity: 0.85 }),
      cand('n1', { similarity: 0.05 }),
      cand('n2', { similarity: 0.02 }),
    ],
    { asOf: NOW },
  )
  const cut = takeRelevant(ranked, 5)
  assert.equal(cut.hits.length, 3, 'the noise is not injected')
  assert.equal(cut.droppedByFloor, 2)
  assert.equal(cut.floorApplied, true, 'and a short result is not mistaken for an empty corpus')
})

test('k still bites when everything is relevant', () => {
  const ranked = rankCandidates(
    Array.from({ length: 6 }, (_, i) => cand(`m${i}`, { similarity: 0.9 - i * 0.01 })),
    { asOf: NOW },
  )
  const cut = takeRelevant(ranked, 3)
  assert.equal(cut.hits.length, 3)
  assert.equal(cut.droppedByFloor, 0)
  assert.equal(cut.droppedByK, 3)
  assert.equal(cut.floorApplied, false)
})

test('THE FLOOR IS RELATIVE — it survives a re-weighting, an absolute one would not', () => {
  // An absolute floor is tied to the weight scale and silently changes meaning
  // the moment any weight moves — the same portability failure that made
  // estimator thresholds travel WITH their estimator.
  const cands = [
    cand('top', { similarity: 1 }),
    cand('mid', { similarity: 0.5 }),
    cand('low', { similarity: 0.1 }),
  ]
  const halved = { ...INHERITED_WEIGHTS, similarity: INHERITED_WEIGHTS.similarity / 2 }
  const a = takeRelevant(rankCandidates(cands, { asOf: NOW }), 10)
  const b = takeRelevant(rankCandidates(cands, { weights: halved, asOf: NOW }), 10)
  assert.deepEqual(
    a.hits.map((h) => h.memory.id),
    b.hits.map((h) => h.memory.id),
    'the same hits survive a uniform scale change of the dominant signal',
  )
})

test('a non-positive best score STANDS THE FLOOR DOWN rather than inverting it', () => {
  // Ratio math on a negative best would flip the comparison and drop the good
  // hits. "The floor did not bite" and "the floor could not be computed" must
  // not look the same, so floorApplied stays false.
  const ranked = rankCandidates([cand('a', { decayPenalty: 1 }), cand('b', { decayPenalty: 1 })], {
    asOf: NOW,
  })
  assert.ok(ranked[0]!.score < 0)
  const cut = takeRelevant(ranked, 5)
  assert.equal(cut.hits.length, 2, 'nothing dropped')
  assert.equal(cut.floorApplied, false)
})

test('the relevance fraction is UNVALIDATED and named as such', () => {
  assert.equal(typeof DEFAULT_RELEVANCE_FRACTION, 'number')
  assert.ok(DEFAULT_RELEVANCE_FRACTION > 0 && DEFAULT_RELEVANCE_FRACTION < 1)
})

test('a memory migrated in today is not cold, however old it is', () => {
  // Decay counts unused time while Cortex could surface it, not since authoring.
  const asOf = Date.UTC(2026, 9, 13)
  const old = asOf - 400 * 86_400_000
  const base = { pinned: false, protected: false, isThread: false, isStandingDirective: false, authoredAt: old }
  assert.equal(decayPenalty({ ...base, ingestedAt: asOf - 1000 }, asOf).penalty, 0)
  assert.ok(decayPenalty({ ...base, ingestedAt: old }, asOf).penalty > 0.9, 'known for 400 days and never used is cold')
})
