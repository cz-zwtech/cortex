/**
 * Forgetting lifecycle — staleness + stickiness, per Corey's 2026-05-28 design.
 *
 * The same model governs memories and code symbols in the singular Cortex
 * graph; this module is the store-agnostic math. All functions take `now`
 * explicitly (never call Date.now internally) so they're deterministic and
 * testable, and so a resumable/replayable sweep produces identical results.
 *
 * Decay:   relevance(t) = base·stickiness + (1−stickiness)·e^(−λ·Δdays)
 *   - stickiness → 1 flattens the curve (pinned/central never forgotten)
 *   - stickiness → 0 decays toward 0 with half-life ln(2)/λ days
 *
 * Stickiness sources mirror across node kinds:
 *   - memories: user-pin (max), reinforcement count, neighbor inheritance
 *   - symbols:  in-degree centrality (many dependents = architecturally central)
 *
 * Staleness:
 *   - symbols have a provable oracle (groundTruthValid=false → instantly stale)
 *   - memories rely on the time-decay curve + contradiction
 */
import type { Lifecycle } from './types.ts';

export interface DecayOpts {
  /** Per-day decay constant. Default 0.0495 ≈ 14-day half-life at stickiness 0. */
  lambda?: number;
}

const MS_PER_DAY = 86_400_000;
const DEFAULT_LAMBDA = Math.LN2 / 14; // ≈ 0.0495 → 14-day half-life

/**
 * Current relevance in [0,1]. A pinned node always reads 1 (it is exempt from
 * decay entirely — pinning is the hard override). A ground-truth-invalid code
 * node reads 0 (provably stale; the symbol left the source tree).
 */
export function decayedRelevance(lc: Lifecycle, now: number, opts: DecayOpts = {}): number {
  if (lc.pinned) return 1;
  if (lc.groundTruthValid === false) return 0;
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  const deltaDays = Math.max(0, (now - lc.lastSeen) / MS_PER_DAY);
  const decayed = lc.base * lc.stickiness + (1 - lc.stickiness) * Math.exp(-lambda * deltaDays);
  return clamp01(decayed);
}

/**
 * Reinforce a node: it was just accessed/re-derived/survived a contradiction.
 * Resets base to 1 and lastSeen to now. Returns a NEW lifecycle (pure).
 * Optionally nudges stickiness upward (reinforcement count → stickiness), with
 * diminishing returns so repeated touches asymptote toward 1, never exceed it.
 */
export function reinforce(lc: Lifecycle, now: number, stickinessGain = 0): Lifecycle {
  const stickiness = stickinessGain > 0
    ? clamp01(lc.stickiness + (1 - lc.stickiness) * stickinessGain)
    : lc.stickiness;
  return { ...lc, base: 1, lastSeen: now, stickiness };
}

/** Hard-pin: exempt from decay and forgetting until unpinned. */
export function pin(lc: Lifecycle): Lifecycle {
  return { ...lc, pinned: true };
}

export function unpin(lc: Lifecycle): Lifecycle {
  return { ...lc, pinned: false };
}

/** Mark a symbol absent from source — provably stale. */
export function invalidateGroundTruth(lc: Lifecycle): Lifecycle {
  return { ...lc, groundTruthValid: false };
}

/**
 * Map a symbol's in-degree (number of dependents) to a stickiness value.
 * High fan-in = architecturally central = resist forgetting even when
 * untouched for months. Saturates: stickiness = 1 − e^(−inDegree/k).
 * k=4 → in-degree 4 ≈ 0.63, in-degree 12 ≈ 0.95.
 */
export function centralityStickiness(inDegree: number, k = 4): number {
  if (inDegree <= 0) return 0;
  return clamp01(1 - Math.exp(-inDegree / k));
}

/**
 * Should this node be soft-forgotten (archived) on the current sweep?
 * - Pinned nodes: never.
 * - Ground-truth-invalid code nodes: always (immediately stale).
 * - Otherwise: relevance below threshold.
 *
 * Soft-forget = archive (recoverable), NOT delete. Callers keep edges as
 * history even after archiving the node.
 */
export function shouldForget(lc: Lifecycle, now: number, threshold: number, opts: DecayOpts = {}): boolean {
  if (lc.pinned) return false;
  if (lc.groundTruthValid === false) return true;
  return decayedRelevance(lc, now, opts) < threshold;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export const _internal = { DEFAULT_LAMBDA, MS_PER_DAY };
