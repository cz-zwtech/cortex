/**
 * What a session should know before it starts — the injection surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT QUERY RECALL, AND CONFLATING THEM WOULD BE WRONG
 *
 * At SessionStart there is no query. Nothing has been asked. So the similarity
 * signal — the largest weight in the scorer — has no value at all, and what
 * remains is a different question: *which memories should be in front of this
 * session regardless of what it turns out to be about?*
 *
 * That is a selection over standing facts (pinned, directives, recent, in
 * scope), not a search. Reusing `recall()` with an empty query would produce a
 * ranking dominated by whichever memory happened to share tokens with "", which
 * is noise wearing the shape of relevance.
 *
 * The same scorer still does the work — `similarity: undefined` is a first-class
 * state, and the remaining signals are exactly the ones that answer this
 * question — but the ENTRY POINT is different and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUDGET IS BYTES, NOT k
 *
 * Query recall cuts at k results because the caller wants an answer list. This
 * cuts at a BYTE budget, because the constraint here is literally the context
 * window: ten short memories may be cheaper than two long ones, and a k-based
 * cut cannot see that. Core allocates the budget; this decides what fits, which
 * is the module's own obligation under the cross-module fairness rule — core
 * allocates, it must not curate.
 */

import { collapse, type Candidate as CollapseCandidate } from './collapse.js'
import { renderBlocks, renderRuleLine } from './inject.js'
import {
  INHERITED_WEIGHTS,
  decayPenalty,
  rankCandidates,
  recencyBonus,
  usageBonus,
  type Candidate,
  type Weights,
} from './rank.js'
import type { MemoryStore } from './store.js'
import type { Estimator } from './reconcile.js'
import type { Memory } from './types.js'

export type SessionContextOptions = {
  store: MemoryStore
  scope?: string
  asOf: number
  /** Memory's slice of the injection budget, in bytes. */
  budgetBytes?: number
  /** The standing rules' own budget, spent first (18 Oct 2026: they load in every session). */
  standingBudgetBytes?: number
  /** How many candidates to consider before ranking. */
  candidateLimit?: number
  weights?: Weights
  estimator?: Estimator
}

export type SessionContext = {
  /** Ready to hand to the harness. Empty string when there is nothing to say. */
  text: string
  included: string[]
  /**
   * Ranked, collapsed, and then did not fit.
   *
   * NEVER silent. A human who has 300 memories and sees 6 needs to know the
   * other 294 were considered and cut, not that they were never found.
   */
  droppedForBudget: number
  /** Standing rules that did not fit their own budget; said in the text, never silent. */
  standingDropped: number
  bytes: number
  /** True when the graph holds nothing — distinct from "nothing was relevant". */
  corpusEmpty: boolean
}

const toCandidate = (
  memory: Memory,
  opts: SessionContextOptions,
  w: Weights,
): Candidate => {
  let surfaces = 0
  let lastSurfacedAt: number | undefined
  for (const e of opts.store.observedEdges(memory.id)) {
    if (e.rel !== 'surfaced_in') continue
    surfaces += e.count
    lastSurfacedAt = lastSurfacedAt === undefined ? e.lastAt : Math.max(lastSurfacedAt, e.lastAt)
  }

  const decay = decayPenalty(
    {
      pinned: memory.pinned,
      protected: memory.protected,
      isThread: memory.shape === 'thread',
      lastSurfacedAt,
      authoredAt: memory.authoredAt,
      ingestedAt: memory.ingestedAt,
      isStandingDirective: memory.shape === 'feedback',
    },
    opts.asOf,
  )

  return {
    memory,
    signals: {
      // NO QUERY, SO NO SIMILARITY. Left undefined rather than set to 0: the
      // scorer treats absent similarity as "this signal has nothing to say",
      // which is exactly true here, whereas 0 would mean "maximally dissimilar"
      // and would penalise every memory equally for a question nobody asked.
      similarity: undefined,
      via: 'seed',
      hops: 0,
      usageBonus: usageBonus(surfaces),
      edgeBonus: 0,
      recencyBonus: recencyBonus(memory.authoredAt, opts.asOf, w.recencyHalfLifeMs),
      scopeBonus: opts.scope && memory.scope === opts.scope ? 1 : 0,
      pinBonus: memory.pinned ? 1 : 0,
      decayPenalty: decay.penalty,
      hopPenalty: 0,
    },
  }
}

export const DEFAULT_SESSION_BUDGET_BYTES = 4_000
export const DEFAULT_STANDING_BUDGET_BYTES = 8_000
export const STANDING_HEADING = '## Cortex: standing rules (loaded in every session)'
export const STANDING_NOTE = 'One line each; the full text of any rule: cortex-memory show <name>'
/** Description lengths tried in turn, so a long set shortens every rule before it drops one. */
export const STANDING_LINE_CHARS = [240, 160, 100]

/** Every standing rule as one line, shortened as far as needed to fit; dropped only past the last length. */
export const renderStanding = (rules: Memory[], budgetBytes: number) => {
  let lines: string[] = []
  for (const chars of STANDING_LINE_CHARS) {
    lines = rules.map((m) => renderRuleLine(m, chars))
    if (lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf-8') + 1, 0) <= budgetBytes) break
  }
  const kept: string[] = []
  const included: string[] = []
  let bytes = 0
  rules.forEach((m, i) => {
    const size = Buffer.byteLength(lines[i]!, 'utf-8') + 1
    if (bytes + size > budgetBytes) return
    kept.push(lines[i]!)
    included.push(m.id)
    bytes += size
  })
  return {
    text: kept.length ? `${STANDING_HEADING}\n${STANDING_NOTE}\n\n${kept.join('\n')}` : '',
    included,
    dropped: rules.length - kept.length,
    bytes,
  }
}
export const DEFAULT_CANDIDATE_LIMIT = 200

export const buildSessionContext = (opts: SessionContextOptions): SessionContext => {
  const w = opts.weights ?? INHERITED_WEIGHTS
  const budget = opts.budgetBytes ?? DEFAULT_SESSION_BUDGET_BYTES
  const limit = opts.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT

  if (opts.store.count() === 0) {
    return { text: '', included: [], droppedForBudget: 0, standingDropped: 0, bytes: 0, corpusEmpty: true }
  }

  // Scope is a PRIOR and not a filter here either: candidates are drawn across
  // scopes and the in-scope ones merely rank higher. Drawing only from `scope`
  // would make this per-folder notebooks, which is the thing the prior exists to
  // prevent.
  //
  // STANDING ONLY. With no query, the only memories that belong in front of every
  // session are the ones that apply regardless of topic: pinned, directives and
  // preferences (feedback), and open threads. An ops note is answered by recall
  // when it is asked about; injecting it here because it is recent spent the
  // budget on whatever happened to be written last.
  // STANDING RULES FIRST, all of them, in their own budget: they apply to every session whatever
  // it is about, so they are not ranked against anything. A memory is standing when it is marked
  // so (front matter `standing: true`, or cortex-memory standing <id> on).
  // Rule memories load through rules.md (the user's CLAUDE.md imports it) or fire on their trigger,
  // so they are never injected here as well.
  const ruleIds = new Set(opts.store.rules().map((r) => r.id))
  const rules = opts.store.standing().filter((m) => !ruleIds.has(m.id))
  const ruled = renderStanding(rules, opts.standingBudgetBytes ?? DEFAULT_STANDING_BUDGET_BYTES)
  const ruledText = ruled.dropped
    ? `${ruled.text}\n\n(${ruled.dropped} more standing rule(s) did not fit; list them all with: cortex-memory standing list)`
    : ruled.text
  const isRule = new Set(rules.map((m) => m.id))

  const standing = (m: Memory) =>
    !isRule.has(m.id) && !ruleIds.has(m.id) && m.authorship !== 'extracted' && (m.shape === 'feedback' || m.shape === 'thread')
  const pool = new Map<string, Memory>()
  for (const m of opts.store.recent(opts.scope ?? 'user', limit)) if (standing(m)) pool.set(m.id, m)
  if (opts.scope) for (const m of opts.store.recent('user', limit)) if (standing(m)) pool.set(m.id, m)

  const ranked = rankCandidates(
    [...pool.values()].map((m) => toCandidate(m, opts, w)),
    { weights: w, asOf: opts.asOf },
  )

  // COLLAPSE BEFORE THE BUDGET, for the same reason recall collapses before the
  // cut: variants of one fact would otherwise spend the budget several times
  // over and crowd out genuinely different memories.
  const collapsed = collapse(
    ranked.map((r) => ({ memory: r.memory, score: r.score }) as CollapseCandidate),
    { estimator: opts.estimator },
  )

  const out = renderBlocks(
    collapsed.map((c) => c.memory),
    budget,
    '## Cortex — memories for this session',
  )

  return {
    text: [ruledText, out.text].filter(Boolean).join('\n\n'),
    included: [...ruled.included, ...out.included],
    droppedForBudget: out.dropped,
    standingDropped: ruled.dropped,
    bytes: ruled.bytes + out.bytes,
    corpusEmpty: false,
  }
}
