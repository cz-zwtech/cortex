/**
 * The reconcile ladder — how ingest decides whether incoming text is a memory
 * we already hold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FRAMING RULING, WHICH EVERYTHING HERE FOLLOWS FROM
 *
 * IDENTITY IS THE GRAPH ID. It is assigned once, at first ingest, and is never
 * derived from path, slug, or content. Slug and content-hash are MATCHING
 * SIGNALS — inputs to "is this the same memory as one I already hold?" — and
 * matching is a query against the graph, which is the authority.
 *
 * A slug is a CLAIM about identity. The graph DECIDES. Those must not be the
 * same object. Replacing file-path-as-identity with slug-as-identity would have
 * been the same defect wearing a different hat.
 *
 * AND THE RULING APPLIES TO THE DECLARED ID TOO. A frontmatter `id:` is a string
 * in a file exactly like a slug. Treating it as certain makes rung 0 an
 * unauthenticated write-by-id primitive — a hallucinated id, a stale receipt, or
 * an imported corpus whose ids collide with ours each silently rewrites an
 * unrelated memory. Worse, the receipt mechanism is what makes rung 0 COMMON, so
 * the primitive would become dangerous in exact proportion to its own success.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LADDER (first hit wins)
 *
 *   0   declared graph id, alias-resolved and CORROBORATED     → update
 *   1   declared slug in scope, content RELATED                → update
 *   1c  declared slug in scope, content UNRELATED, any machine → keep both, link
 *   1x  declared slug in scope, different machine lineage      → keep both, link
 *   2   exact content hash                                     → fold
 *   3   near-duplicate                                         → link, NOT merge
 *   4   nothing matched                                        → new node
 *
 * WHY RUNG 1 NEEDS 1c. "Same machine means sequential" is false daily on a fleet
 * where concurrent sessions are the norm: two of them reusing a natural slug
 * (`deploy-process`, `notes`) for genuinely different facts means the second
 * silently destroys the first, with both legitimate and nobody seeing it. The
 * discriminator is CONTENT RELATEDNESS, not machine lineage — which collapses
 * 1, 1c and 1x into one rule at different distances: same slug plus related
 * content is an update; same slug plus unrelated content is two memories.
 *
 * WHAT RUNG 2 IS FOR, AND ONLY THIS: crash-retry idempotency. A session
 * re-saving from compacted context REGENERATES PROSE; it does not replay bytes,
 * so it never reaches rung 2 at all. Re-running ingest is safe; deduplication is
 * not solved here.
 *
 * WHY RUNG 3 LINKS AND DOES NOT MERGE. Two memories can be 0.94 apart in
 * embedding space and mean opposite things — "prefer pnpm here" and "never use
 * pnpm here". A merge is irreversible against the graph and its failure mode is
 * invisible: nothing looks broken, one of the two facts is simply gone. Never
 * buy a visible duplicate fix with an invisible data-loss risk.
 *
 * Link-not-merge is SAFE but not STABLE — the corpus grows a clique of
 * near-identical nodes. That is answered at RECALL (collapse to one
 * representative per cluster), not here. Storage records what happened; ranking
 * decides what to show.
 */

import type { Memory } from './types.js'
import type { MemoryStore } from './store.js'

export type Rung = '0' | '1' | '1c' | '1x' | '2' | '3' | '4'

export type ReconcileDecision = {
  rung: Rung
  action: 'update' | 'fold' | 'link' | 'create'
  /** The node to update, fold into, or link against. Absent only for `create`. */
  target?: string
  /** One line for the receipt and for `status`. */
  note: string
  /**
   * True when the outcome is a SETTLEABLE PAIR rather than a decision.
   *
   * Demote-and-flag must never terminate in silence: an honest rewrite that
   * trips a guard is then one settle away from correct with nothing lost, which
   * is what lets the guards afford to be conservative.
   */
  settleable?: boolean
}

export type ReconcileInput = {
  /** Frontmatter `id:` or an id carried on a receipt. A CLAIM, not an answer. */
  declaredId?: string
  /** The declared slug. In this corpus that is frontmatter `name:`. */
  slug: string
  scope: string
  content: string
  /** Normalized hash — frontmatter stripped, whitespace normalized. */
  contentHash: string
  machine: string
  /** Present when the writer's session is known; enables rung-0 corroboration. */
  sessionId?: string
  /**
   * A rule (`kind: rule`): its substance is in the front matter, which the
   * body hash leaves out, so it never folds by body text into another record.
   */
  isRule?: boolean
  /**
   * Imports (vault, team-mind) NEVER enter at rung 0 or 1. A foreign corpus
   * declaring an id is asserting ITS identity space, not ours, so imports
   * reconcile from rung 2 down inside their own scope.
   */
  imported?: boolean
}

/**
 * Lexical relatedness, 0..1 — Jaccard over lowercased word tokens.
 *
 * A DEFAULT, not a recommendation, and labelled unvalidated per the standing
 * rule on constants: it exists so the ladder is correct before embeddings are
 * wired, not because token overlap is a good similarity measure. Inject a real
 * one via `ReconcileDeps.similarity` when the embedding pass lands.
 */
export const tokenize = (s: string): Set<string> =>
  new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])

export const lexicalSimilarity = (a: string, b: string): number => {
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.size === 0 && B.size === 0) return 1
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Below this many tokens, a lexical score is NOT EVIDENCE.
 *
 * On a three-word memory the score moves in thirds — two texts either share a
 * token or they do not — so no threshold means anything down there. The guard
 * exists because the risk is short-text instability, not because the floors are
 * mis-set.
 *
 * THE SEMANTICS MATTER MORE THAN THE NUMBER. Below the guard the verdict is
 * UNKNOWN, and unknown resolves by the recoverability rule rather than by either
 * threshold:
 *
 *   - never auto-fold on it (rung 2 still applies at any length — exact is
 *     exact, and it does not consult similarity at all);
 *   - never treat as a related update, which is an irreversible overwrite
 *     decided by a coin flip;
 *   - always keep both and link — a settleable pair, one settle from correct.
 */
export const MIN_TOKENS_FOR_SIMILARITY = 12

/**
 * A similarity estimator. `null` means CANNOT JUDGE — not "not similar".
 *
 * The guard belongs to the ESTIMATOR, not to the ladder. Short-text instability
 * is a property of token overlap; an embedding model has no such cliff, so a
 * ladder that applied a token floor to every provider would be second-guessing
 * an estimator it knows nothing about. Making "cannot judge" part of the return
 * type pushes the decision to whoever actually knows.
 */
export type SimilarityFn = (a: string, b: string) => number | null

/**
 * An estimator AND ITS CALIBRATION, as one object.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THRESHOLDS BELONG TO THE ESTIMATOR, NOT TO THE LADDER
 *
 * This is a structural answer to a failure that would otherwise arrive weeks
 * after the swap. Every threshold in the ladder and the collapse is calibrated
 * against LEXICAL JACCARD. A cosine distribution and a Jaccard distribution are
 * not the same shape, so a number that means "near-identical" under one can
 * mean "vaguely related" under the other — and nothing would fail. Recall would
 * simply get quietly worse, in a direction nobody is measuring.
 *
 * Carrying the numbers across is the easy mistake precisely because the code
 * still compiles and the tests still pass. So the numbers travel WITH the
 * estimator: swapping it necessarily swaps its calibration, and applying
 * Jaccard's floors to embeddings is not a thing you can express.
 */
export type Estimator = {
  /** Named so a trace or a bug report can say which one produced a score. */
  name: string
  compare: SimilarityFn
  /** Same slug + this much similarity = an update rather than a collision. */
  relatedFloor: number
  /** At or above this, two memories are near-duplicates. */
  nearDuplicateFloor: number
  /**
   * TRUE until these numbers are derived from a benchmark rather than chosen.
   *
   * Honest labelling, per the standing rule on unvalidated constants: a fresh
   * guess acquires false authority by being new. The instrument is the
   * LongMemEval / LoCoMo harness (task 138), which does not exist yet — and
   * hand-tuning against intuition and calling the result derived is exactly
   * what that rule exists to prevent.
   */
  provisional: boolean
}

/** The default estimator: lexical Jaccard, with the short-text guard built in. */
export const guardedLexicalSimilarity =
  (min = MIN_TOKENS_FOR_SIMILARITY): SimilarityFn =>
  (a, b) =>
    tokenize(a).size >= min && tokenize(b).size >= min ? lexicalSimilarity(a, b) : null

/**
 * The default estimator: lexical Jaccard with the short-text guard.
 *
 * Its floors are UNVALIDATED and deliberately not tuned against `seen_count` —
 * that column counts byte-identical retries, while the population that needs
 * tuning is regenerated prose, which never reaches it.
 *
 * It exists so the ladder is correct before embeddings are wired, not because
 * token overlap is a good similarity measure.
 */
export const LEXICAL_ESTIMATOR: Estimator = {
  name: 'lexical-jaccard',
  compare: guardedLexicalSimilarity(),
  relatedFloor: 0.45,
  nearDuplicateFloor: 0.8,
  provisional: true,
}

/** @deprecated Read the floors from an {@link Estimator}; they are not portable. */
export const DEFAULT_RELATED_FLOOR = LEXICAL_ESTIMATOR.relatedFloor
/** @deprecated Read the floors from an {@link Estimator}; they are not portable. */
export const DEFAULT_NEAR_DUPLICATE_FLOOR = LEXICAL_ESTIMATOR.nearDuplicateFloor

export type ReconcileDeps = {
  store: MemoryStore
  /**
   * The estimator AND its calibration. Defaults to lexical Jaccard.
   *
   * There is deliberately no separate threshold parameter: floors are a
   * property of the estimator that produced them, and a ladder that accepted
   * them independently would let Jaccard's numbers be applied to embeddings.
   */
  estimator?: Estimator
  /** Candidates for the rung-3 scan. Injected so ingest owns the shortlist. */
  candidates?: (input: ReconcileInput) => Memory[]
}

/**
 * Corroborate a declared id, in order of authority.
 *
 * An earlier design guarded rung 0 with a similarity floor. That was wrong twice
 * over: it puts a STRING JUDGEMENT in charge of an identity operation, which is
 * what the framing forbids, and it rejects the writes you most want to accept —
 * an honest full rewrite is SUPPOSED to be dissimilar to what it replaces, so a
 * floor tuned to catch nonsense also catches the best-case update.
 *
 * The ordering moves from what the writer DECLARED, to what the system OBSERVED,
 * to what the text merely RESEMBLES. Resemblance is the weakest, so it goes last
 * and only when the other two are unavailable.
 */
const estimatorOf = (deps: ReconcileDeps): Estimator => deps.estimator ?? LEXICAL_ESTIMATOR

const corroborate = (
  node: Memory,
  input: ReconcileInput,
  deps: ReconcileDeps,
): { ok: boolean; how: string } => {
  // 1. Slug agreement — an EXACT test, not a similarity one. An honest rewrite
  //    keeps its slug even when every word of the body changes.
  if (input.slug && node.name === input.slug) return { ok: true, how: 'slug agreement' }

  // 2. Behavioural — the graph knows what it surfaced to this session. This
  //    covers resolve-then-heavily-edit, which is exactly where honest rewrites
  //    are most dissimilar. It asks the graph, not the text.
  if (input.sessionId) {
    const surfaced = deps.store
      .observedEdges(node.id)
      .some((e) => e.rel === 'surfaced_in' && e.dst === input.sessionId)
    if (surfaced) return { ok: true, how: 'surfaced to this session' }
  }

  // 3. Resemblance — last resort, reached only when an id arrives with no slug
  //    and no surfacing record, which the receipt format makes rare.
  //
  //    `null` from the estimator means CANNOT JUDGE, and an unjudgeable signal
  //    must never authorise a write. It falls through to uncorroborated, whose
  //    outcome is a settleable pair — not a silent overwrite on a coin flip.
  const est = estimatorOf(deps)
  const sim = est.compare(node.content, input.content)
  if (sim !== null && sim >= est.relatedFloor) {
    return { ok: true, how: 'content resemblance' }
  }

  return { ok: false, how: 'uncorroborated' }
}

export const reconcile = (input: ReconcileInput, deps: ReconcileDeps): ReconcileDecision => {
  const { store } = deps
  const est = estimatorOf(deps)
  const similarity = est.compare
  const relatedFloor = est.relatedFloor
  const nearFloor = est.nearDuplicateFloor

  // ── Rung 0 — declared id, alias-resolved and corroborated ──────────────────
  if (input.declaredId && !input.imported) {
    // Aliases FIRST: an id that lost a settle must resolve forward, or a write
    // against it resurrects the node that was settled away.
    const resolved = store.resolveId(input.declaredId)
    const node = store.get(resolved)

    if (node && node.scope === input.scope) {
      const { ok, how } = corroborate(node, input, deps)
      if (ok) return { rung: '0', action: 'update', target: node.id, note: `id, ${how}` }

      // Never write, and never merely reject. A rejection that terminates in
      // the settle mechanism is cheap; one that terminates in silence is not.
      return {
        rung: '0',
        action: 'link',
        target: node.id,
        note: 'declared id could not be corroborated',
        settleable: true,
      }
    }
    // A declared id that does not exist, or that names another scope, is simply
    // not evidence. Fall through — it is not an error, and it must not write.
  }

  // ── Rung 1 / 1c / 1x — declared slug in scope ──────────────────────────────
  //
  // The lookup returns N, not one. `name` has no uniqueness constraint, and 1c
  // and 1x DELIBERATELY create same-slug pairs — so code that assumed a scalar
  // would go ambiguous the moment the ladder created its first pair, and would
  // then silently match an arbitrary member.
  if (input.slug && !input.imported) {
    const matches = store.bySlug(input.scope, input.slug)
    if (matches.length) {
      const identical = matches.find((m) => m.contentHash === input.contentHash)
      if (identical) {
        return { rung: '1', action: 'update', target: identical.id, note: 'slug, unchanged' }
      }

      // A rule is a named thing: rewritten under the same name it is the same rule, however much its
      // when, do or why changed. Judged by text it would become a second rule beside the old one
      // (say, a rule rewritten from `when: tool:Write` to `when: always`).
      if (input.isRule) {
        const rules = new Set(store.rules().map((r) => r.id))
        const same = matches.find((m) => rules.has(m.id))
        if (same) return { rung: '1', action: 'update', target: same.id, note: 'slug, the same rule rewritten' }
      }

      // Score EVERY candidate; the best above the floor is the update target.
      let best: { node: Memory; score: number } | null = null
      let anyMeasurable = false
      for (const m of matches) {
        const score = similarity(m.content, input.content)
        if (score === null) continue // cannot judge — not "not similar"
        anyMeasurable = true
        if (!best || score > best.score) best = { node: m, score }
      }

      if (best && best.score >= relatedFloor) {
        return { rung: '1', action: 'update', target: best.node.id, note: 'slug, related content' }
      }

      // Nothing above the floor — or nothing measurable at all. Both resolve the
      // same way, and that is the point: an unmeasurable verdict must not borrow
      // the disposition of a measured one. Keep both, link, settle later.
      const anchor = best?.node ?? matches[0]!
      const crossMachine = anchor.machine !== input.machine
      return {
        rung: crossMachine ? '1x' : '1c',
        action: 'link',
        target: anchor.id,
        note: !anyMeasurable
          ? 'same slug, texts too short to compare — kept both rather than guessing'
          : crossMachine
            ? 'same slug, different machine lineage — concurrent writes'
            : 'same slug, unrelated content — slug collision',
        settleable: true,
      }
    }
  }

  // ── Rung 2 — exact content hash ────────────────────────────────────────────
  // Only into a node that still exists: a forgotten memory keeps its ledger row, and folding into it
  // reported "ingested" while the text went nowhere (20 Oct). Written back, it is a memory again.
  // Never for a rule: two rules may share a body (otherwise several rules with one body fold into one).
  const folded = input.isRule ? null : store.consumedAs(input.contentHash)
  const node = folded ? store.get(folded) : undefined
  if (folded && node) {
    // A fold must ADD provenance, not discard it. The same text legitimately
    // saved in two projects would otherwise keep only the first scope, and under
    // scope-as-prior it ranks down in the second forever with nothing recording
    // that it was ever relevant there.
    const crossScope = !!node && node.scope !== input.scope
    return {
      rung: '2',
      action: 'fold',
      target: folded,
      note: crossScope ? `identical text, also relevant in ${input.scope}` : 'identical text',
    }
  }

  // ── Rung 3 — near-duplicate: LINK, never merge ─────────────────────────────
  const candidates = deps.candidates?.(input) ?? []
  let nearest: { id: string; score: number } | null = null
  for (const c of candidates) {
    // Cannot-judge is NOT "not similar" — but rung 3's outcome and rung 4's
    // both keep the incoming text as its own node, so the only thing lost is a
    // link. Better than a link asserting a similarity nobody measured.
    const score = similarity(c.content, input.content)
    if (score === null) continue
    if (score >= nearFloor && (!nearest || score > nearest.score)) nearest = { id: c.id, score }
  }
  if (nearest) {
    return {
      rung: '3',
      action: 'link',
      target: nearest.id,
      note: `near-duplicate (${nearest.score.toFixed(2)}) — linked, not merged`,
    }
  }

  return { rung: '4', action: 'create', note: 'no match' }
}
