/**
 * The ckn-aware "operational" recall bucket — the user's own native-scope memories
 * that describe how to correctly operate a tool/system, surfaced proactively before
 * first use (#119 Part 2).
 *
 * Two corrections over the old inline bucketing:
 *  (i)  EXCLUDE session-state snapshots (precompact dumps, handoffs) — they're
 *       kind='memory' and can pass the cosine gate, so they used to occupy slots and
 *       crowd out real rules.
 *  (ii) PULL STANDING rules (ALWAYS/NEVER / "standing rule") to the FRONT so a rule
 *       like "ALWAYS ssh the -claude host" isn't pushed out of the top-N by
 *       stronger-cosine but lower-priority hits (the exact miss: an ssh + sudo +
 *       cortex/systemctl command out-cosine'd the standing ssh rule).
 *
 * Still cosine-gated (relevance preserved) — the boost only reorders within the
 * already-relevant set; it never surfaces an irrelevant rule.
 */
import type { RecallHit } from './recall.js'

export const OPERATIONAL_MIN_COSINE = 0.45

/** Session-state snapshots are not operational rules — exclude from the bucket. */
export const isSessionState = (h: Pick<RecallHit, 'name'>): boolean =>
  /^(precompact|session-handoff)/i.test(h.name)

/** A standing operational rule — a must-always-surface directive. Matches the real
 *  corpus vocabulary: an ALWAYS/NEVER-led directive, an uppercase PINNED/STANDING
 *  marker (the dominant convention), or an explicit "standing (operational) rule".
 *  PINNED/STANDING are matched case-sensitively so prose like "long-standing" or a
 *  lowercase "pinned" doesn't false-positive. Read off the deliberate description. */
export const isStandingRule = (h: Pick<RecallHit, 'description'>): boolean =>
  /^\s*(ALWAYS|NEVER)\b/.test(h.description) ||
  /\b(PINNED|STANDING)\b/.test(h.description) ||
  /\bstanding (operational )?rule\b/i.test(h.description)

/**
 * Build the operational bucket from composite-sorted recall hits: native-scope
 * memory hits that semantically match (cosine-gated), session-state excluded,
 * standing rules pulled to the front, composite order preserved within each group,
 * capped.
 */
export const bucketOperational = (all: RecallHit[], cap = 5): RecallHit[] => {
  const eligible = all.filter(
    (h) =>
      h.source === 'memory' &&
      !isSessionState(h) &&
      h.signals.cosine != null &&
      h.signals.cosine >= OPERATIONAL_MIN_COSINE,
  )
  const standing = eligible.filter(isStandingRule)
  const normal = eligible.filter((h) => !isStandingRule(h))
  return [...standing, ...normal].slice(0, cap)
}
