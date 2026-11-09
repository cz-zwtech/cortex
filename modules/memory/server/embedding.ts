/**
 * Embedding-backed similarity — the estimator the thresholds are waiting for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT DEGRADE SILENTLY, AND THAT IS THE WHOLE POINT
 *
 * V1's embedding path falls back to null when the local model fails to load,
 * and says so only in a comment. The consequence is measurable: a scope of
 * onboarding entries with ZERO embedded, beside comparable scopes that were
 * mostly or fully embedded. Nobody noticed for months, because a system with
 * embeddings off and a system with embeddings broken look identical from
 * outside.
 *
 * So this module distinguishes three states and never conflates them:
 *
 *   READY        the backend produced a vector for this text
 *   NOT WARMED   nobody asked for this text yet — a caller error, reported
 *   UNAVAILABLE  the backend cannot embed at all — reported ONCE, loudly, and
 *                every comparison returns "cannot judge"
 *
 * `cannot judge` is already a first-class answer in the ladder: it never
 * auto-folds, never treats a pair as an update, and always keeps both and links.
 * So a dead backend degrades to bias-to-split rather than to bad merges — which
 * is the safe direction, and it is safe by construction rather than by luck.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY compare() STAYS SYNCHRONOUS
 *
 * The ladder is a decision function and must not do IO: an async compare would
 * put a model load inside a per-candidate loop and make ingest latency a
 * function of corpus size. Instead the caller WARMS explicitly — one batched
 * embed for the texts it is about to compare — and `compare` is a cache lookup.
 *
 * A miss is therefore not "not similar", it is "you did not warm this", and it
 * is reported rather than absorbed. That distinction is the same one this
 * project keeps paying for: absence of evidence read as evidence of absence.
 */

import type { Estimator } from './reconcile.js'

/** A vector, or null when this text could not be embedded. */
export type Vector = Float32Array | null

/**
 * The swappable backend.
 *
 * V1 ran the model in a worker thread because a synchronous CPU-bound load
 * blocked its event loop. That was a real problem with an incidental solution:
 * what the rest of the system needs is `embed(texts) -> vectors`, and whether
 * that is a worker, a subprocess, a local ONNX session or an HTTP call is the
 * backend's business. Keeping the interface this narrow is what makes the model
 * choice reversible.
 */
export type EmbeddingBackend = {
  name: string
  dims: number
  embed(texts: string[]): Promise<Vector[]>
}

export type WarmReport = {
  requested: number
  embedded: number
  /** Texts the backend returned no vector for. Never silent. */
  failed: number
  /** Set when the backend itself is unavailable — every compare will abstain. */
  unavailable?: string
}

/** Cosine over unit-comparable vectors. Undefined for zero-length inputs. */
export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class EmbeddingEstimator {
  readonly #backend: EmbeddingBackend
  readonly #cache = new Map<string, Float32Array>()
  #unavailable: string | null = null
  #reported = false
  #misses = 0

  constructor(backend: EmbeddingBackend) {
    this.#backend = backend
  }

  /**
   * Embed these texts so `compare` can answer for them.
   *
   * Batched deliberately: per-text calls are what made V1's embedding pass the
   * dominant cost of a sync, and a backend that can amortise a batch cannot do
   * so if it is never given one.
   */
  async warm(texts: string[]): Promise<WarmReport> {
    const pending = [...new Set(texts)].filter((t) => t.trim() && !this.#cache.has(t))
    if (!pending.length) return { requested: 0, embedded: 0, failed: 0 }

    let vectors: Vector[]
    try {
      vectors = await this.#backend.embed(pending)
    } catch (e) {
      // Report ONCE, loudly, and then abstain. A backend that logs on every
      // comparison drowns the signal that it is broken at all.
      this.#unavailable = e instanceof Error ? e.message : String(e)
      return {
        requested: pending.length,
        embedded: 0,
        failed: pending.length,
        unavailable: this.#unavailable,
      }
    }

    let embedded = 0
    for (const [i, v] of vectors.entries()) {
      if (v && v.length) {
        this.#cache.set(pending[i]!, v)
        embedded++
      }
    }
    return { requested: pending.length, embedded, failed: pending.length - embedded }
  }

  /** True when the backend has failed. Surfaced in `status`, not swallowed. */
  unavailable(): string | null {
    return this.#unavailable
  }

  /**
   * Comparisons that could not be answered because nobody warmed the text.
   *
   * A caller bug, and one that would otherwise look exactly like "these two are
   * not similar" — so it is counted and reported rather than absorbed.
   */
  misses(): number {
    return this.#misses
  }

  /**
   * The estimator, carrying ITS OWN floors.
   *
   * Cosine floors are NOT the lexical ones and deliberately do not inherit
   * them: the distributions are different shapes, so a number meaning
   * near-identical under Jaccard means vaguely-related under cosine. These are
   * likewise `provisional` — chosen, not derived — pending the LongMemEval /
   * LoCoMo harness. Saying so in the type is what stops them being cited later
   * as though they were measured.
   */
  estimator(floors?: { relatedFloor?: number; nearDuplicateFloor?: number }): Estimator {
    return {
      name: `embedding:${this.#backend.name}`,
      relatedFloor: floors?.relatedFloor ?? 0.72,
      nearDuplicateFloor: floors?.nearDuplicateFloor ?? 0.92,
      provisional: true,
      compare: (a, b) => {
        if (this.#unavailable) return null // abstain, loudly-once, never guess
        const va = this.#cache.get(a)
        const vb = this.#cache.get(b)
        if (!va || !vb) {
          this.#misses++
          return null // "you did not warm this" — NOT "not similar"
        }
        return cosine(va, vb)
      },
    }
  }

  /** One line for `status`. Absent state is a state, and it is reported. */
  describe(): string {
    if (this.#unavailable) {
      return `embeddings UNAVAILABLE (${this.#backend.name}): ${this.#unavailable} — all similarity comparisons abstain, so near-duplicates will NOT be collapsed`
    }
    const miss = this.#misses ? `, ${this.#misses} unwarmed comparison(s)` : ''
    return `embeddings ready (${this.#backend.name}, ${this.#backend.dims}d, ${this.#cache.size} cached${miss})`
  }
}
